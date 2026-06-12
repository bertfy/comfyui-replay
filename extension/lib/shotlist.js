// Shot-list planner — turns a graph survey (from bg.js 'survey-graph') into
// an ordered list of camera shots for the tour runner.
//
// Pure module: no chrome.*, no DOM. Import from panel.js; also runnable in
// Node for dry-run tests against workflow-template JSON fixtures.
//
// Shot shape:
//   { id, kind, label, bbox: [x,y,w,h]|null, targetScale: number|null,
//     voId, minDwellMs, cursorAction: {type, ...}|null }
// kinds: overview | group | node | overview2 | run | executing | result

// ── Topological ranks (Kahn) ──────────────────────────────────────────────
function topoRanks(nodes, links) {
  const rank = new Map(nodes.map(n => [n.id, 0]));
  const indeg = new Map(nodes.map(n => [n.id, 0]));
  const out = new Map(nodes.map(n => [n.id, []]));
  for (const l of links) {
    if (!indeg.has(l.target) || !out.has(l.origin)) continue;
    indeg.set(l.target, indeg.get(l.target) + 1);
    out.get(l.origin).push(l.target);
  }
  const q = nodes.filter(n => indeg.get(n.id) === 0).map(n => n.id);
  let head = 0;
  while (head < q.length) {
    const id = q[head++];
    for (const t of out.get(id) || []) {
      rank.set(t, Math.max(rank.get(t), rank.get(id) + 1));
      indeg.set(t, indeg.get(t) - 1);
      if (indeg.get(t) === 0) q.push(t);
    }
  }
  return rank; // cycles keep rank 0 — fine for ordering purposes
}

// ── Geometry helpers ──────────────────────────────────────────────────────
const center = n => [n.pos[0] + n.size[0] / 2, n.pos[1] + n.size[1] / 2];
const inBBox = (pt, b) => pt[0] >= b[0] && pt[0] <= b[0] + b[2] && pt[1] >= b[1] && pt[1] <= b[1] + b[3];

function unionBBox(items) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const it of items) {
    const [x, y, w, h] = it;
    x0 = Math.min(x0, x); y0 = Math.min(y0, y);
    x1 = Math.max(x1, x + w); y1 = Math.max(y1, y + h);
  }
  if (!isFinite(x0)) return [0, 0, 100, 100];
  return [x0, y0, x1 - x0, y1 - y0];
}

const nodeBBox = n => [n.pos[0], n.pos[1], n.size[0], n.size[1]];

// ── Key-node scoring ──────────────────────────────────────────────────────
// Heuristic: which nodes deserve a close-up? Prompt nodes (long string
// widget), preview/output nodes (image present or terminal type), nodes
// the author bothered to retitle, big nodes.
const TERMINAL_TYPE_RE = /save|preview|videocombine|video_combine|output/i;
// Documentation stickies — long text but never tour-worthy close-ups
const NOTE_TYPE_RE = /^(Note|MarkdownNote)$/i;

// ── Result-node ranking ───────────────────────────────────────────────────
// "The result" should be the SAVED OUTPUT (Video Combine / Save*), never a
// scratch PreviewImage that happens to hold media. Shared by the coldopen
// hero pick and the result-shot fallback (tour.js mirrors it live).
const SAVE_TYPE_RE = /combine|savevideo|saveanimated|saveimage|save/i;
const PREVIEW_TYPE_RE = /^PreviewImage$|preview/i;
export function resultScore(n) {
  let s = 0;
  if (SAVE_TYPE_RE.test(n.type)) s += 3;
  if (n.outDeg === 0) s += 2;
  if (PREVIEW_TYPE_RE.test(n.type)) s -= 2;
  return s;
}
export function pickResultNode(nodes) {
  const media = nodes.filter(n => n.hasImage && !NOTE_TYPE_RE.test(n.type));
  if (!media.length) return null;
  return media.sort((a, b) =>
    (resultScore(b) - resultScore(a)) ||
    ((b.size[0] * b.size[1]) - (a.size[0] * a.size[1])))[0];
}

export function scoreNode(n, areaThreshold) {
  if (NOTE_TYPE_RE.test(n.type)) return 0;
  let score = 0;
  const longStr = (n.widgets || []).some(w =>
    typeof w.value === 'string' && w.value.length >= 25 &&
    !/\.(safetensors|ckpt|pt|pth|bin|mp4|png|jpg|webm|gguf)$/i.test(w.value));
  if (longStr) score += 3;
  if (n.hasImage) score += 3;
  if (n.outDeg === 0 || TERMINAL_TYPE_RE.test(n.type)) score += 2;
  if (n.title && n.title !== n.type) score += 1;
  if (n.size[0] * n.size[1] >= areaThreshold) score += 1;
  return score;
}

// ── Main planner ──────────────────────────────────────────────────────────
export function buildShotList(survey, opts = {}) {
  const {
    // 1 close-up per group by default — 2 made the camera "move around a lot"
    // (user feedback); the group fit-shot already shows the rest.
    maxKeyNodesPerGroup = 1,
    keyNodeThreshold = 3,
    includeRun = true, // legacy knob — superseded by `ending`
    // How the tour closes:
    //   'prerun' (default) — the workflow was already run; end on the saved
    //             output that's sitting in the graph. No live Run, no waiting.
    //   'live'   — click Run, wait for the cloud job, show the fresh result.
    //   'none'   — end at the pull-back overview.
    ending = includeRun ? 'prerun' : 'none',
    // Floor 0.30: pull back without going microscopic — huge graphs crop at
    // the edges rather than shrinking to postage stamps (reference behavior).
    overviewScaleRange = [0.30, 0.40],
    nodeScaleRange = [0.9, 1.1],
  } = opts;

  const nodes = (survey.nodes || []).filter(n => !n.collapsed || true); // collapsed still counts for bboxes
  const links = survey.links || [];
  const groups = (survey.groups || []).slice();
  const ranks = topoRanks(nodes, links);

  // 90th-percentile node area for the "large node" score
  const areas = nodes.map(n => n.size[0] * n.size[1]).sort((a, b) => a - b);
  const areaThreshold = areas.length ? areas[Math.floor(areas.length * 0.9)] : Infinity;

  // Group membership by node-center-in-bbox (group._nodes is unreliable)
  const members = new Map(groups.map(g => [g.id, []]));
  const grouped = new Set();
  for (const n of nodes) {
    const c = center(n);
    for (const g of groups) {
      if (inBBox(c, g.bounding)) { members.get(g.id).push(n); grouped.add(n.id); break; }
    }
  }

  // Group order: if the author numbered the titles ("Step1 - …", "2. Load"),
  // trust those numbers outright. Otherwise: mean topo rank of members,
  // tie-break mean x then y.
  const groupStats = groups.map(g => {
    const ms = members.get(g.id);
    const mean = arr => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0;
    const numMatch = (g.title || '').match(/\d+/);
    return {
      g, ms,
      num: numMatch ? parseInt(numMatch[0], 10) : null,
      rank: mean(ms.map(n => ranks.get(n.id) || 0)),
      mx: mean(ms.map(n => center(n)[0])),
      my: mean(ms.map(n => center(n)[1])),
    };
  }).filter(s => s.ms.length > 0);
  const numbered = groupStats.filter(s => s.num != null);
  const useNumbers = numbered.length >= 2 &&
    new Set(numbered.map(s => s.num)).size === numbered.length &&
    numbered.length === groupStats.length;
  groupStats.sort((a, b) => useNumbers
    ? (a.num - b.num)
    : (a.rank - b.rank) || (a.mx - b.mx) || (a.my - b.my));

  // Key nodes per group (top 1–2 above threshold), in topo order
  function keyNodesIn(list) {
    return list
      .map(n => ({ n, score: scoreNode(n, areaThreshold) }))
      .filter(s => s.score >= keyNodeThreshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxKeyNodesPerGroup)
      .sort((a, b) => (ranks.get(a.n.id) || 0) - (ranks.get(b.n.id) || 0))
      .map(s => s.n);
  }

  // Overall graph bbox: union of node boxes and group boxes
  const allBoxes = nodes.map(nodeBBox).concat(groups.map(g => g.bounding));
  const graphBBox = unionBBox(allBoxes);

  const shots = [];
  const clampRange = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));

  // Viewport for scale estimation (tour runner refines with live rect)
  const vp = survey.viewport || { w: 1920, h: 1080 };
  const fitScale = (b, margin) => Math.min(vp.w / Math.max(b[2], 1), vp.h / Math.max(b[3], 1)) * margin;

  // section: groups beats that belong together so the runner knows where a
  // deliberate breath belongs (only at section CHANGES) vs. where lines should
  // overlap into each other (within a section).

  // Cold-open on the result (the reference videos' hook): if the loaded graph
  // already shows a rendered output, start tight on it — "here's what we're
  // making" — then pull out to the overview. Ranked so the SAVED output
  // (Video Combine / Save*) wins over scratch previews.
  const heroNode = pickResultNode(nodes);
  if (heroNode) {
    shots.push({
      id: 'coldopen', kind: 'coldopen', label: 'The result', section: 'overview',
      bbox: nodeBBox(heroNode),
      targetScale: clampRange(fitScale(nodeBBox(heroNode), 0.55), nodeScaleRange),
      voId: 'coldopen', minDwellMs: 3000,
      cursorAction: { type: 'hover-node', nodeId: heroNode.id, widget: null },
    });
  }

  shots.push({
    id: 'overview', kind: 'overview', label: 'Overview', section: 'overview',
    bbox: graphBBox,
    targetScale: clampRange(fitScale(graphBBox, 0.9), overviewScaleRange),
    voId: 'overview', minDwellMs: 2600, cursorAction: null,
  });

  if (groupStats.length) {
    for (const { g, ms } of groupStats) {
      const gid = 'group_' + g.id;
      shots.push({
        id: gid, kind: 'group', label: g.title, section: 'tour',
        bbox: g.bounding,
        targetScale: Math.min(fitScale(g.bounding, 0.82), 1.0),
        voId: gid, minDwellMs: 2200,
        cursorAction: { type: 'sweep' },
      });
      for (const n of keyNodesIn(ms)) {
        const nid = 'node_' + n.id;
        const promptWidget = (n.widgets || []).find(w => typeof w.value === 'string' && w.value.length >= 25);
        shots.push({
          id: nid, kind: 'node', label: n.title, section: 'tour',
          bbox: nodeBBox(n),
          targetScale: clampRange(fitScale(nodeBBox(n), 0.55), nodeScaleRange),
          voId: nid, minDwellMs: 2800,
          cursorAction: { type: 'hover-node', nodeId: n.id, widget: promptWidget ? promptWidget.name : null },
        });
      }
    }
  } else {
    // No groups: tour the top key nodes across the whole graph in topo order
    for (const n of keyNodesIn(nodes).concat(
      nodes.filter(n => scoreNode(n, areaThreshold) >= keyNodeThreshold).slice(0, 5)
    ).filter((n, i, a) => a.findIndex(m => m.id === n.id) === i).slice(0, 5)) {
      const nid = 'node_' + n.id;
      shots.push({
        id: nid, kind: 'node', label: n.title, section: 'tour',
        bbox: nodeBBox(n),
        targetScale: clampRange(fitScale(nodeBBox(n), 0.55), nodeScaleRange),
        voId: nid, minDwellMs: 2800,
        cursorAction: { type: 'hover-node', nodeId: n.id, widget: null },
      });
    }
  }

  shots.push({
    id: 'overview2', kind: 'overview2', label: 'Full picture', section: 'tour',
    bbox: graphBBox,
    targetScale: clampRange(fitScale(graphBBox, 0.9), overviewScaleRange),
    voId: 'overview2', minDwellMs: 2000, cursorAction: null,
  });

  if (ending === 'live') {
    shots.push({
      id: 'run', kind: 'run', label: 'Run', section: 'run',
      bbox: null, targetScale: null,
      voId: 'run', minDwellMs: 1200,
      cursorAction: { type: 'click-run' },
    });
    shots.push({
      id: 'executing', kind: 'executing', label: 'Generating…', section: 'run',
      bbox: graphBBox, targetScale: null,
      voId: 'executing', minDwellMs: 4000, cursorAction: null,
    });
    // Result bbox is resolved live post-run by the tour runner (re-survey);
    // ranked fallback: saved-output node, else any terminal.
    const terminals = nodes.filter(n => n.outDeg === 0 || TERMINAL_TYPE_RE.test(n.type));
    const fallback = pickResultNode(nodes) || terminals[terminals.length - 1] || nodes[nodes.length - 1];
    shots.push({
      id: 'result', kind: 'result', label: 'Result', section: 'result',
      bbox: fallback ? nodeBBox(fallback) : graphBBox,
      targetScale: 1.1,
      voId: 'result', minDwellMs: 3500,
      cursorAction: fallback ? { type: 'hover-node', nodeId: fallback.id, widget: null } : null,
    });
  } else if (ending === 'prerun' && heroNode) {
    // The workflow was already run — close on the saved output that's sitting
    // in the graph. No Run click, no cloud wait.
    shots.push({
      id: 'result', kind: 'result', label: 'Result', section: 'result',
      bbox: nodeBBox(heroNode),
      targetScale: 1.1,
      voId: 'result', minDwellMs: 3500,
      cursorAction: { type: 'hover-node', nodeId: heroNode.id, widget: null },
    });
  }

  return shots;
}

// Short text description of a shot list — for the panel log / dry-run button.
export function describeShotList(shots) {
  return shots.map((s, i) =>
    `${String(i + 1).padStart(2)}. [${s.kind}] ${s.label}` +
    (s.targetScale ? ` @ ${s.targetScale.toFixed(2)}×` : '') +
    ` · dwell ${s.minDwellMs}ms`
  ).join('\n');
}
