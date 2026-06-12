// Preset bundles — one knob that sets many.
//
// Two kinds of settings live behind a preset:
//   1. Storage-backed (chrome.storage.sync): capture quality (`capture`) and
//      tour-engine options (`tour`). applyPreset() writes these directly.
//   2. Generator-iframe options (Build mode): the iframe is the single source
//      of truth for those, so `build` is a map of generator element ids →
//      bridge ops that the PANEL dispatches (set-toggle/set-range/set-value)
//      and then re-syncs its accordion mirrors from. This module never talks
//      to the bridge itself.
//
// `tourVo` / `buildVo` are the voice-source select values for each pane.

export const PRESETS = {
  'polished-demo': {
    label: 'Polished Demo',
    description: '1080p · 12 Mbps · clean macOS cursor · cinematic camera · AI narration + ElevenLabs',
    capture: { bitrateMbps: 12, fps: 30, width: 1920, height: 1080 },
    tour: { cursorSize: 20, ending: 'prerun', arc: true },
    tourVo: 'elevenlabs',
    buildVo: 'elevenlabs',
    build: {
      'cursor-style':       { kind: 'value',  value: 'macos' },
      'cursor-size':        { kind: 'range',  value: 20 },
      'click-fx-toggle':    { kind: 'toggle', value: false },
      'captions-toggle':    { kind: 'toggle', value: false },
      'camera-pan-toggle':  { kind: 'toggle', value: true },
      'camera-zoom-toggle': { kind: 'toggle', value: true },
      'ai-timing-toggle':   { kind: 'toggle', value: true },
    },
  },

  'fast-draft': {
    label: 'Fast Draft',
    description: '8 Mbps · direct camera moves (no arc) · no narration — quick iteration passes',
    capture: { bitrateMbps: 8, fps: 30, width: 1920, height: 1080 },
    tour: { cursorSize: 20, ending: 'prerun', arc: false },
    tourVo: 'none',
    buildVo: 'none',
    build: {
      'cursor-style':       { kind: 'value',  value: 'macos' },
      'cursor-size':        { kind: 'range',  value: 20 },
      'click-fx-toggle':    { kind: 'toggle', value: false },
      'ai-timing-toggle':   { kind: 'toggle', value: false },
    },
  },

  // Build-only: the v0.6 look, for regression comparisons and anyone who
  // liked the ripples.
  'classic-build': {
    label: 'Classic Build',
    description: 'v0.6 behavior — click ripples, 24px cursor, 6 Mbps, bundled example VO',
    capture: { bitrateMbps: 6, fps: 30, width: 1920, height: 1080 },
    tour: null,
    buildVo: 'bundled',
    build: {
      'cursor-style':       { kind: 'value',  value: 'macos' },
      'cursor-size':        { kind: 'range',  value: 24 },
      'click-fx-toggle':    { kind: 'toggle', value: true },
      'camera-pan-toggle':  { kind: 'toggle', value: true },
      'camera-zoom-toggle': { kind: 'toggle', value: false },
      'ai-timing-toggle':   { kind: 'toggle', value: true },
    },
  },
};

export function getPreset(id) {
  return PRESETS[id] || null;
}

// Write the preset's storage-backed knobs and remember the selection for
// `mode` ('tour' | 'build'). Returns the preset so the caller can dispatch
// the generator-side `build` ops and update voice selects.
export async function applyPreset(id, mode) {
  const p = getPreset(id);
  if (!p) throw new Error('unknown preset: ' + id);
  const patch = { ['preset_' + mode]: id };
  if (p.capture) patch.capture = { ...p.capture };
  if (mode === 'tour' && p.tour) patch.tour = { ...p.tour };
  await chrome.storage.sync.set(patch);
  return p;
}
