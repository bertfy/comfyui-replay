#!/usr/bin/env node

/**
 * ComfyUI Cursor Replay — Automated Visual Workflow Build
 *
 * Uses Playwright to drive a real browser with visible mouse cursor,
 * building a ComfyUI workflow step-by-step from a JSON file.
 * Perfect for screen recording tutorials.
 *
 * Usage:
 *   node cursor-replay.js <workflow.json> [options]
 *
 * Options:
 *   --url <url>         ComfyUI URL (default: http://127.0.0.1:8188)
 *   --delay <ms>        Pause between steps (default: 800)
 *   --output <dir>      Video output directory (default: ./recordings)
 *   --viewport <WxH>    Browser viewport size (default: 1920x1080)
 *   --no-record         Disable video recording
 *   --slow-mo <ms>      Playwright slow motion (default: 50)
 */

const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

// ─── CLI Args ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
let inputFile = null;
let comfyUrl = "http://127.0.0.1:8188";
let delay = 800;
let outputDir = "./recordings";
let viewportW = 1920;
let viewportH = 1080;
let recordVideo = true;
let slowMo = 50;

for (let i = 0; i < args.length; i++) {
  if (args[i] === "--url" && args[i + 1]) {
    comfyUrl = args[i + 1];
    i++;
  } else if (args[i] === "--delay" && args[i + 1]) {
    delay = parseInt(args[i + 1], 10);
    i++;
  } else if (args[i] === "--output" && args[i + 1]) {
    outputDir = args[i + 1];
    i++;
  } else if (args[i] === "--viewport" && args[i + 1]) {
    const [w, h] = args[i + 1].split("x").map(Number);
    viewportW = w || 1920;
    viewportH = h || 1080;
    i++;
  } else if (args[i] === "--no-record") {
    recordVideo = false;
  } else if (args[i] === "--slow-mo" && args[i + 1]) {
    slowMo = parseInt(args[i + 1], 10);
    i++;
  } else if (!args[i].startsWith("--")) {
    inputFile = args[i];
  }
}

if (!inputFile) {
  console.error(`
╔══════════════════════════════════════════════════════════════╗
║  ComfyUI Cursor Replay — Automated Visual Build            ║
╠══════════════════════════════════════════════════════════════╣
║                                                              ║
║  Usage:                                                      ║
║    node cursor-replay.js <workflow.json> [options]            ║
║                                                              ║
║  Options:                                                    ║
║    --url <url>       ComfyUI URL (default: localhost:8188)   ║
║    --delay <ms>      Pause between steps (default: 800)      ║
║    --output <dir>    Video output dir (default: ./recordings)║
║    --viewport <WxH>  Browser size (default: 1920x1080)       ║
║    --no-record       Disable video recording                 ║
║    --slow-mo <ms>    Playwright slow motion (default: 50)    ║
║                                                              ║
║  Example:                                                    ║
║    node cursor-replay.js my_workflow.json --delay 1000       ║
║                                                              ║
║  Prerequisites:                                              ║
║    npm install                                               ║
║    npx playwright install chromium                           ║
║    ComfyUI running at the specified URL                      ║
║                                                              ║
╚══════════════════════════════════════════════════════════════╝
`);
  process.exit(1);
}

// ─── Parse Workflow ────────────────────────────────────────────────────────────

const raw = fs.readFileSync(path.resolve(inputFile), "utf-8");
const workflow = JSON.parse(raw);

const nodes = workflow.nodes || [];
const links = workflow.links || [];

if (nodes.length === 0) {
  console.error("Error: No nodes found in workflow JSON.");
  process.exit(1);
}

// ─── Topological Sort ──────────────────────────────────────────────────────────

const nodeMap = new Map();
nodes.forEach((n) => nodeMap.set(n.id, n));

const inDegree = new Map();
const adjacency = new Map();

nodes.forEach((n) => {
  inDegree.set(n.id, 0);
  adjacency.set(n.id, []);
});

links.forEach((link) => {
  const [, srcId, , tgtId] = link;
  if (nodeMap.has(srcId) && nodeMap.has(tgtId)) {
    adjacency.get(srcId).push(tgtId);
    inDegree.set(tgtId, (inDegree.get(tgtId) || 0) + 1);
  }
});

const queue = [];
inDegree.forEach((deg, id) => {
  if (deg === 0) queue.push(id);
});

const sorted = [];
while (queue.length > 0) {
  queue.sort((a, b) => {
    const na = nodeMap.get(a);
    const nb = nodeMap.get(b);
    const posA = na.pos || [0, 0];
    const posB = nb.pos || [0, 0];
    return posA[0] - posB[0] || posA[1] - posB[1];
  });
  const current = queue.shift();
  sorted.push(current);
  for (const neighbor of adjacency.get(current) || []) {
    inDegree.set(neighbor, inDegree.get(neighbor) - 1);
    if (inDegree.get(neighbor) === 0) queue.push(neighbor);
  }
}
nodes.forEach((n) => {
  if (!sorted.includes(n.id)) sorted.push(n.id);
});

// Group connections by target node
const connectionsByTarget = new Map();
links.forEach((link) => {
  const [linkId, srcId, srcSlot, tgtId, tgtSlot, linkType] = link;
  if (!connectionsByTarget.has(tgtId))
    connectionsByTarget.set(tgtId, []);
  connectionsByTarget.get(tgtId).push({ linkId, srcId, srcSlot, tgtId, tgtSlot, linkType });
});

// All connections in topological order
const connectionsInOrder = [];
sorted.forEach((nodeId) => {
  const conns = connectionsByTarget.get(nodeId) || [];
  conns.forEach((c) => connectionsInOrder.push(c));
});

// ─── Smooth Mouse Movement ────────────────────────────────────────────────────

/**
 * Moves the mouse cursor along a smooth curve from current position to target.
 * Uses quadratic easing for natural feel.
 */
async function smoothMove(page, fromX, fromY, toX, toY, duration = 600) {
  const steps = Math.max(20, Math.floor(duration / 16)); // ~60fps
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    // Ease in-out cubic
    const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const x = fromX + (toX - fromX) * ease;
    const y = fromY + (toY - fromY) * ease;
    await page.mouse.move(x, y);
  }
}

/**
 * Smoothly drags from one point to another (mouse down → move → mouse up).
 */
async function smoothDrag(page, fromX, fromY, toX, toY, duration = 800) {
  await smoothMove(page, cursorX, cursorY, fromX, fromY, 400);
  cursorX = fromX;
  cursorY = fromY;
  await sleep(100);
  await page.mouse.down();
  await sleep(50);

  const steps = Math.max(25, Math.floor(duration / 16));
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const ease = t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
    const x = fromX + (toX - fromX) * ease;
    const y = fromY + (toY - fromY) * ease;
    await page.mouse.move(x, y);
  }

  await sleep(50);
  await page.mouse.up();
  cursorX = toX;
  cursorY = toY;
}

// Track cursor position globally
let cursorX = 0;
let cursorY = 0;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(step, total, msg) {
  const pct = Math.round((step / total) * 100);
  console.log(`[${step}/${total}] (${pct}%) ${msg}`);
}

// ─── Main ──────────────────────────────────────────────────────────────────────

(async () => {
  const totalSteps = sorted.length + connectionsInOrder.length;
  let currentStep = 0;

  console.log(`\n🎬 ComfyUI Cursor Replay`);
  console.log(`   Workflow: ${path.basename(inputFile)}`);
  console.log(`   Nodes: ${nodes.length} | Links: ${links.length}`);
  console.log(`   Delay: ${delay}ms | Viewport: ${viewportW}x${viewportH}`);
  console.log(`   ComfyUI: ${comfyUrl}`);
  console.log(`   Recording: ${recordVideo ? outputDir : "disabled"}\n`);

  // Ensure output directory exists
  if (recordVideo) {
    fs.mkdirSync(path.resolve(outputDir), { recursive: true });
  }

  // Launch browser
  const browser = await chromium.launch({
    headless: false,
    slowMo: slowMo,
    args: [
      `--window-size=${viewportW},${viewportH}`,
      "--disable-blink-features=AutomationControlled",
    ],
  });

  const context = await browser.newContext({
    viewport: { width: viewportW, height: viewportH },
    ...(recordVideo
      ? {
          recordVideo: {
            dir: path.resolve(outputDir),
            size: { width: viewportW, height: viewportH },
          },
        }
      : {}),
  });

  const page = await context.newPage();

  try {
    // Navigate to ComfyUI
    console.log("🌐 Navigating to ComfyUI...");
    await page.goto(comfyUrl, { waitUntil: "networkidle", timeout: 30000 });
    await sleep(2000); // Wait for LiteGraph canvas to fully init

    // Inject helper functions
    await page.evaluate(() => {
      window.__replayHelpers = {
        /**
         * Convert LiteGraph canvas coordinates to screen pixel coordinates.
         */
        canvasToScreen(canvasX, canvasY) {
          const canvasEl = document.querySelector("canvas.graph-canvas-container") 
            || document.querySelector("canvas");
          const rect = canvasEl.getBoundingClientRect();
          const ds = app.canvas.ds;
          const screenX = (canvasX + ds.offset[0]) * ds.scale + rect.left;
          const screenY = (canvasY + ds.offset[1]) * ds.scale + rect.top;
          return { x: screenX, y: screenY };
        },

        /**
         * Get the screen position of a node's connection slot.
         */
        getSlotScreenPos(nodeId, isInput, slotIndex) {
          const node = app.graph.getNodeById(nodeId);
          if (!node) return null;
          const pos = new Float32Array(2);
          node.getConnectionPos(isInput, slotIndex, pos);
          return this.canvasToScreen(pos[0], pos[1]);
        },

        /**
         * Get the screen center of a node.
         */
        getNodeScreenCenter(nodeId) {
          const node = app.graph.getNodeById(nodeId);
          if (!node) return null;
          const cx = node.pos[0] + (node.size[0] || 200) / 2;
          const cy = node.pos[1] + (node.size[1] || 150) / 2;
          return this.canvasToScreen(cx, cy);
        },

        /**
         * Get the screen position of a widget
         */
        getWidgetScreenPos(nodeId, widgetIndex) {
          const node = app.graph.getNodeById(nodeId);
          if (!node || !node.widgets || !node.widgets[widgetIndex]) return null;
          const w = node.widgets[widgetIndex];
          const wy = (w.last_y !== undefined) ? w.last_y + 10 : (30 + widgetIndex * 20);
          const cx = node.pos[0] + (node.size ? node.size[0] / 2 : 100);
          const cy = node.pos[1] + wy;
          return this.canvasToScreen(cx, cy);
        },

        /**
         * Get the screen position for a target canvas position (for placing nodes).
         */
        getScreenPos(canvasX, canvasY) {
          return this.canvasToScreen(canvasX, canvasY);
        },
      };
    });

    // Verify helpers work
    const helpersReady = await page.evaluate(() => !!window.__replayHelpers);
    if (!helpersReady) {
      throw new Error("Failed to inject replay helpers");
    }
    console.log("✅ Helpers injected\n");

    // Initialize cursor position to center of viewport
    cursorX = viewportW / 2;
    cursorY = viewportH / 2;
    await page.mouse.move(cursorX, cursorY);

    // ── Clear Canvas ────────────────────────────────────────────
    console.log("🧹 Clearing canvas...");
    // Ctrl+A to select all, then Delete
    await page.keyboard.down("Control");
    await page.keyboard.press("a");
    await page.keyboard.up("Control");
    await sleep(300);
    await page.keyboard.press("Delete");
    await sleep(500);

    // Also try the API clear in case the keyboard shortcut didn't work
    await page.evaluate(() => {
      app.graph.clear();
      app.canvas.setDirty(true, true);
    });
    await sleep(delay);

    // ── Add Nodes ───────────────────────────────────────────────

    // We'll add nodes using inject + LiteGraph API, then visually
    // simulate the cursor moving to each node position.
    // This is more reliable than the search menu approach (which
    // varies across ComfyUI versions), and we can show a nice
    // "cursor places node" animation.

    const createdNodeIds = {}; // Maps original ID → LiteGraph runtime ID

    for (const origId of sorted) {
      const node = nodeMap.get(origId);
      if (!node) continue;

      currentStep++;
      const title = node.title || node.type;
      log(currentStep, totalSteps, `➕ Adding: ${title} (${node.type})`);

      // Get the target screen position for this node
      const pos = node.pos || [100, 100];
      const posX = Array.isArray(pos) ? pos[0] : pos.x || 100;
      const posY = Array.isArray(pos) ? pos[1] : pos.y || 100;

      // First, move cursor to where the node will appear
      const targetScreen = await page.evaluate(
        ({ x, y }) => window.__replayHelpers.getScreenPos(x, y),
        { x: posX + (node.size ? node.size[0] / 2 : 100), y: posY + (node.size ? node.size[1] / 2 : 75) }
      );

      if (targetScreen) {
        await smoothMove(page, cursorX, cursorY, targetScreen.x, targetScreen.y, 500);
        cursorX = targetScreen.x;
        cursorY = targetScreen.y;
      }
      await sleep(200);

      // Double-click to open search menu at this position
      await page.mouse.dblclick(cursorX, cursorY);
      await sleep(400);

      // Try to find and interact with the search input
      // ComfyUI's search box can be in different selectors depending on version
      const searchSelectors = [
        '.litegraph .dialog input',
        '.litegraph-search input',
        'dialog input[type="text"]',
        '.comfy-modal input',
        'input.search',
        '.litecontextmenu input',
        // New frontend selectors
        '.p-dialog input',
        '.node-search-box input',
        'input[placeholder*="Search"]',
        'input[placeholder*="search"]',
      ];

      let searchFound = false;
      for (const sel of searchSelectors) {
        try {
          const input = await page.waitForSelector(sel, { timeout: 1000 });
          if (input) {
            // Move cursor to the search input
            const inputBox = await input.boundingBox();
            if (inputBox) {
              await smoothMove(
                page,
                cursorX,
                cursorY,
                inputBox.x + inputBox.width / 2,
                inputBox.y + inputBox.height / 2,
                300
              );
              cursorX = inputBox.x + inputBox.width / 2;
              cursorY = inputBox.y + inputBox.height / 2;
            }
            await input.click();
            await sleep(100);
            // Type the node type to search
            await page.keyboard.type(node.type, { delay: 40 });
            await sleep(400);

            // Try to find and click the matching result
            const resultSelectors = [
              `.litegraph .dialog .helper-list .item`,
              `.litegraph-search .helper .item`,
              `dialog .result-item`,
              `.comfy-modal .result`,
              `.litecontextmenu .litemenu-entry`,
              `.p-dialog .result-item`,
              `.node-search-results .item`,
              // Try generic matches
              `[class*="result"] [class*="item"]`,
              `[class*="helper"] [class*="item"]`,
            ];

            let resultClicked = false;
            for (const rSel of resultSelectors) {
              try {
                const results = await page.$$(rSel);
                for (const r of results) {
                  const text = await r.textContent();
                  if (text && text.includes(node.type)) {
                    const rBox = await r.boundingBox();
                    if (rBox) {
                      await smoothMove(
                        page,
                        cursorX,
                        cursorY,
                        rBox.x + rBox.width / 2,
                        rBox.y + rBox.height / 2,
                        250
                      );
                      cursorX = rBox.x + rBox.width / 2;
                      cursorY = rBox.y + rBox.height / 2;
                    }
                    await r.click();
                    resultClicked = true;
                    break;
                  }
                }
                if (resultClicked) break;
              } catch (e) {
                continue;
              }
            }

            if (!resultClicked) {
              // Press Enter to select first result
              await page.keyboard.press("Enter");
            }

            searchFound = true;
            break;
          }
        } catch (e) {
          continue;
        }
      }

      // Dismiss any open menus with Escape
      await page.keyboard.press("Escape");
      await sleep(200);

      if (!searchFound) {
        // Fallback: create node via JS injection
        console.log(`   ⚙️  Using API fallback for ${node.type}`);
      }

      // Regardless of the search approach, ensure the node exists
      // via the API and set its properties precisely
      const runtimeId = await page.evaluate(
        ({ nodeType, posX, posY, sizeW, sizeH, title, widgetValues, properties, origId }) => {
          // Check if a node of this type was just created near this position
          let existingNode = null;
          const allNodes = app.graph._nodes;
          for (let i = allNodes.length - 1; i >= 0; i--) {
            const n = allNodes[i];
            if (n.type === nodeType) {
              // Use the most recently added one
              existingNode = n;
              break;
            }
          }

          let node;
          if (existingNode && !existingNode.__replayTagged) {
            node = existingNode;
          } else {
            // Create via API
            node = LiteGraph.createNode(nodeType);
            if (!node) return null;
            app.graph.add(node);
          }

          node.__replayTagged = true;
          node.__replayOrigId = origId;
          node.pos = [posX, posY];
          if (sizeW && sizeH) node.size = [sizeW, sizeH];
          if (title && title !== nodeType) node.title = title;

          // Set properties
          if (properties) {
            Object.assign(node.properties, properties);
          }

          app.canvas.setDirty(true, true);
          return node.id;
        },
        {
          nodeType: node.type,
          posX,
          posY,
          sizeW: node.size ? node.size[0] : null,
          sizeH: node.size ? node.size[1] : null,
          title: node.title || null,
          properties: node.properties || null,
          origId: origId,
        }
      );

      if (runtimeId !== null) {
        createdNodeIds[origId] = runtimeId;

        // Animate setting widget values
        if (node.widgets_values) {
          for (let i = 0; i < node.widgets_values.length; i++) {
            const val = node.widgets_values[i];
            if (val === null || val === undefined) continue;
            
            // Get widget info from the page to determine interaction
            const wInfo = await page.evaluate(({nodeId, idx, v}) => {
              const n = app.graph.getNodeById(nodeId);
              if(!n || !n.widgets || !n.widgets[idx]) return null;
              const w = n.widgets[idx];
              const t = (w.type || "").toLowerCase();
              let isText = t === "text" || t === "string" || t === "customtext" || w.options?.multiline;
              if (typeof v === "string" && v.length > 20) isText = true;
              return { type: t, isText };
            }, {nodeId: runtimeId, idx: i, v: val});

            if (!wInfo) continue;

            const wPos = await page.evaluate(
              ({nodeId, idx}) => window.__replayHelpers.getWidgetScreenPos(nodeId, idx),
              {nodeId: runtimeId, idx: i}
            );

            if (wPos) {
              await smoothMove(page, cursorX, cursorY, wPos.x, wPos.y, 300);
              cursorX = wPos.x;
              cursorY = wPos.y;
              
              if (wInfo.isText) {
                // Click text widgets to focus
                await page.mouse.click(cursorX, cursorY);
                await sleep(200);
                
                // Try clearing existing text by Ctrl+A Delete
                await page.keyboard.down("Control");
                await page.keyboard.press("a");
                await page.keyboard.up("Control");
                await page.keyboard.press("Delete");
                await sleep(50);
                
                // Type only enough to be visible for tutorial purposes,
                // then paste the rest so we don't sit typing a 500-char prompt.
                const TYPE_VISIBLE_CHARS = 60;
                const fullVal = String(val);
                const typedPart = fullVal.slice(0, TYPE_VISIBLE_CHARS);
                const remainder = fullVal.slice(TYPE_VISIBLE_CHARS);
                await page.keyboard.type(typedPart, {delay: 15 + Math.random() * 20});
                if (remainder) {
                  // Inject remainder directly into the focused element and
                  // dispatch input/change so Comfy picks it up.
                  await page.evaluate((rest) => {
                    const el = document.activeElement;
                    if (!el) return;
                    if ('value' in el) {
                      el.value = (el.value || '') + rest;
                    } else if (el.isContentEditable) {
                      el.textContent = (el.textContent || '') + rest;
                    }
                    el.dispatchEvent(new Event('input',  { bubbles: true }));
                    el.dispatchEvent(new Event('change', { bubbles: true }));
                  }, remainder);
                }
                await sleep(100);
                
                // Click slightly away to remove focus
                await page.mouse.click(cursorX - 50, cursorY - 50);
                cursorX -= 50;
                cursorY -= 50;
                await sleep(100);
              } else {
                // For combos/numbers: click widget, then set value manually via API 
                // to avoid complex dropdown handling while still showing interaction
                await page.mouse.click(cursorX, cursorY);
                await sleep(100);
                if (Math.random() > 0.5) await sleep(100); // slight random delay
                
                await page.evaluate(({nodeId, idx, v}) => {
                  const n = app.graph.getNodeById(nodeId);
                  if(n && n.widgets && n.widgets[idx]) {
                    n.widgets[idx].value = v;
                    try { n.widgets[idx].callback?.(v); } catch(e) {}
                    app.canvas.setDirty(true, true);
                  }
                }, {nodeId: runtimeId, idx: i, v: val});
              }
              await sleep(200);
            }
          }
        }
      } else {
        console.warn(`   ⚠️  Failed to create node: ${node.type}`);
      }

      await sleep(delay);
    }

    // ── Connect Nodes ───────────────────────────────────────────

    if (connectionsInOrder.length > 0) {
      console.log("\n🔗 Connecting nodes...\n");
      await sleep(delay);

      for (const conn of connectionsInOrder) {
        const srcRuntimeId = createdNodeIds[conn.srcId];
        const tgtRuntimeId = createdNodeIds[conn.tgtId];

        if (!srcRuntimeId || !tgtRuntimeId) {
          console.warn(`   ⚠️  Skipping connection: missing node`);
          continue;
        }

        const srcNode = nodeMap.get(conn.srcId);
        const tgtNode = nodeMap.get(conn.tgtId);
        const srcName = srcNode ? srcNode.title || srcNode.type : `?`;
        const tgtName = tgtNode ? tgtNode.title || tgtNode.type : `?`;

        currentStep++;
        log(
          currentStep,
          totalSteps,
          `🔗 ${srcName}[${conn.srcSlot}] → ${tgtName}[${conn.tgtSlot}]`
        );

        // Get screen coordinates for source output slot and target input slot
        const positions = await page.evaluate(
          ({ srcId, srcSlot, tgtId, tgtSlot }) => {
            const srcNode = app.graph.getNodeById(srcId);
            const tgtNode = app.graph.getNodeById(tgtId);
            if (!srcNode || !tgtNode) return null;

            const srcPos = new Float32Array(2);
            const tgtPos = new Float32Array(2);
            srcNode.getConnectionPos(false, srcSlot, srcPos); // false = output
            tgtNode.getConnectionPos(true, tgtSlot, tgtPos); // true = input

            const h = window.__replayHelpers;
            return {
              src: h.canvasToScreen(srcPos[0], srcPos[1]),
              tgt: h.canvasToScreen(tgtPos[0], tgtPos[1]),
            };
          },
          {
            srcId: srcRuntimeId,
            srcSlot: conn.srcSlot,
            tgtId: tgtRuntimeId,
            tgtSlot: conn.tgtSlot,
          }
        );

        if (positions && positions.src && positions.tgt) {
          // Drag from source output to target input
          await smoothDrag(
            page,
            positions.src.x,
            positions.src.y,
            positions.tgt.x,
            positions.tgt.y,
            700
          );
        } else {
          // Fallback: make the connection via API
          console.log(`   ⚙️  Using API fallback for connection`);
          await page.evaluate(
            ({ srcId, srcSlot, tgtId, tgtSlot }) => {
              const srcNode = app.graph.getNodeById(srcId);
              const tgtNode = app.graph.getNodeById(tgtId);
              if (srcNode && tgtNode) {
                srcNode.connect(srcSlot, tgtNode, tgtSlot);
                app.canvas.setDirty(true, true);
              }
            },
            {
              srcId: srcRuntimeId,
              srcSlot: conn.srcSlot,
              tgtId: tgtRuntimeId,
              tgtSlot: conn.tgtSlot,
            }
          );
        }

        await sleep(delay * 0.6);
      }
    }

    // ── Finish ──────────────────────────────────────────────────

    console.log(`\n✅ Workflow replay complete!`);
    console.log(`   ${nodes.length} nodes, ${links.length} connections\n`);

    // Move cursor to center and pause for a nice ending
    await smoothMove(page, cursorX, cursorY, viewportW / 2, viewportH / 2, 600);
    await sleep(2000);

    // Fit the graph to view
    await page.evaluate(() => {
      app.canvas.ds.reset();
      app.graph.setDirtyCanvas(true, true);
    });
    await sleep(1000);

  } catch (error) {
    console.error(`\n❌ Error during replay: ${error.message}`);
    console.error(error.stack);
  } finally {
    // Close and save video
    const videoPath = await page.video()?.path();
    await context.close();
    await browser.close();

    if (videoPath) {
      console.log(`\n🎥 Recording saved to: ${videoPath}`);
    }
    console.log("🏁 Done!\n");
  }
})();
