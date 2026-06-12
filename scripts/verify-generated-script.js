#!/usr/bin/env node
/**
 * Drives index.html via Playwright to:
 *   1. Drop example-workflow.json
 *   2. Toggle "AI Voice Over Timing" ON
 *   3. Click "AI Script" so the pre-baked example narrations populate
 *   4. Read the generated replay script
 *   5. node --check it for syntax validity
 *   6. Spot-check key VO integration points are present
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const { spawn, execFileSync } = require('child_process');

const REPO = path.resolve(__dirname, '..');
const PORT = 8765;
const SERVER_URL = `http://localhost:${PORT}`;

(async () => {
  // Start static server
  const server = spawn('node', [path.join(REPO, 'scripts/serve-static.js'), '--port', String(PORT)], {
    stdio: ['ignore', 'pipe', 'inherit'],
  });
  await new Promise(r => server.stdout.on('data', d => /serving/.test(d.toString()) && r()));
  console.log(`▶ static server up on ${SERVER_URL}`);

  let exitCode = 0;
  try {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('console', msg => {
      if (msg.type() === 'error') console.log('  [page error]', msg.text());
    });

    await page.goto(SERVER_URL);
    console.log('▶ index.html loaded');

    // The file input is hidden behind a styled drop zone — wait for attached, not visible.
    await page.waitForSelector('input[type="file"]', { state: 'attached', timeout: 10000 });

    // Drop the example workflow
    const examplePath = path.join(REPO, 'example-workflow.json');
    const fileInput = await page.$('input[type="file"]');
    await fileInput.setInputFiles(examplePath);
    console.log('▶ example-workflow.json dropped');

    // Enable AI Voice Over Timing (input is hidden behind a styled label)
    await page.waitForSelector('#ai-timing-toggle', { state: 'attached', timeout: 5000 });
    await page.evaluate(() => {
      const cb = document.getElementById('ai-timing-toggle');
      cb.checked = true;
      cb.dispatchEvent(new Event('change', { bubbles: true }));
    });
    console.log('▶ AI Voice Over Timing toggled ON');

    // Wait for the file to render in the queue, then click "AI Script" (which
    // loads the pre-baked example narrations when no API key configured).
    await page.waitForSelector('button.btn-gen-vo[title*="Load pre-written"]', { timeout: 10000 });
    await page.click('button.btn-gen-vo[title*="Load pre-written"]');
    console.log('▶ AI Script button clicked → pre-baked narrations loaded');

    // Give the script regeneration a moment
    await page.waitForTimeout(800);

    // `files` is closure-scoped, but window.copyScript(name) reads from it and
    // writes to the clipboard. We intercept the clipboard write to capture.
    const script = await page.evaluate(async () => {
      let captured = null;
      const orig = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = async (txt) => { captured = txt; };
      try {
        // Find the first copy button on the page and trigger its onclick.
        const btn = document.querySelector('button[onclick^="copyScript"]');
        if (btn) btn.click();
        await new Promise(r => setTimeout(r, 200));
      } finally {
        navigator.clipboard.writeText = orig;
      }
      return captured;
    });
    if (!script) throw new Error('no generated script captured from copy button');

    const outFile = path.join(REPO, 'recordings', 'verify-generated.js');
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, script, 'utf-8');
    console.log(`▶ generated script: ${script.length} bytes → ${path.relative(REPO, outFile)}`);

    // node --check it
    try {
      execFileSync('node', ['--check', outFile], { stdio: 'pipe' });
      console.log('✓ node --check PASS');
    } catch (e) {
      console.log('✗ node --check FAIL:');
      console.log((e.stderr || '').toString().split('\n').slice(0, 10).join('\n'));
      exitCode = 2;
    }

    // Spot-check key VO integration points
    const checks = [
      ['VO_AUDIO map declared',           /const VO_AUDIO = \{\}/],
      ['waitForComfyReady defined',       /async function waitForComfyReady/],
      ['prefetchVO defined',              /async function prefetchVO/],
      ['playVO defined',                  /function playVO/],
      ['waitForComfyReady awaited',       /await waitForComfyReady\(\)/],
      ['prefetchVO awaited',              /await prefetchVO\(\)/],
      ['VO_AUDIO used in per-node hold',  /Math\.max\(DLY, vo\.durationMs\)/],
      ['Per-link VO id constructed',      /'link_'\+lk\.srcId/],
      ['recStep accepts voId',            /function recStep\(name, voId\)/],
      ['audioKey attached to step evt',   /evt\.audioKey = VO_AUDIO\[voId\]\.audioKey/],
      ['NARRATIONS const present',        /const NARRATIONS = \{/],
      ['USE_AI_TIMING true in template',  /const USE_AI_TIMING = true/],
      ['Single-instance guard present',   /window\.__replayRunning/],
      ['Stops prior run audio',           /audio\[data-comfy-vo\]/],
      ['Pre-narration delay REMOVED',     /no pre-padding — so it tracks the action|Audio starts immediately/],
      ['Post-padding reduced to 150ms',   /await slp\(150\)/],
      ['Record-off warning present',      /AI Voice Over Timing is ON but Record Video is OFF/],
      ['__replayRunning released at end', /window\.__replayRunning = false;\n\}\)\(\);/],
    ];
    console.log(`\n▶ Spot-checks:`);
    let chkPass = 0, chkFail = 0;
    for (const [name, re] of checks) {
      const ok = re.test(script);
      console.log(`  ${ok ? '✓' : '✗'} ${name}`);
      if (ok) chkPass++; else chkFail++;
    }
    console.log(`\n${chkFail === 0 ? '✅' : '❌'} ${chkPass}/${checks.length} spot-checks passed`);

    if (chkFail > 0) exitCode = 3;

    await browser.close();
  } catch (e) {
    console.error('FATAL:', e.message);
    exitCode = 1;
  } finally {
    server.kill();
  }
  process.exit(exitCode);
})();
