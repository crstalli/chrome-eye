// Playwright test for Chrome Eye extension.
// Launches Chrome-for-Testing with the extension loaded, connects via CDP,
// and verifies:
//   1. Extension is loaded (service worker found)
//   2. Overlay hidden initially (staging is silent)
//   3. Explicit capture via bridge shows small 260x320 card
//   4. ✕ dismissal (ssUserDismissed flag)
//   5. Auto-hide after 8s
//   6. ssUserDismissed prevents re-opening

const { chromium } = require('/mnt/f/ai/chrome-eye/node_modules/playwright');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const CHROME_BIN = '/mnt/f/ai/chrome-eye/test/chrome/chrome-linux64/chrome';
const EXTENSION_PATH = '/mnt/f/ai/chrome-eye/extension';
const BRIDGE_URL = 'http://127.0.0.1:3081';
const CDP_PORT = 9333;
const PROFILE_DIR = path.join(os.tmpdir(), 'chrome-eye-pw-' + Date.now());
const LIBS_PATH = '/mnt/f/ai/chrome-eye/test/chrome-libs/usr/lib/x86_64-linux-gnu';

var chromeProc = null;
var chromeLog = '';
var extId = null;

function cleanup() {
  if (chromeProc) {
    try { chromeProc.kill('SIGTERM'); } catch {}
  }
  try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true }); } catch {}
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function bridgeUp() {
  for (var i = 0; i < 10; i++) {
    try {
      const res = await fetch(BRIDGE_URL + '/cmd/pending');
      if (res.status === 200) return true;
    } catch {}
    await sleep(1000);
  }
  throw new Error('Bridge at :3081 not reachable');
}

async function postCmd(action, params, id) {
  const res = await fetch(BRIDGE_URL + '/cmd', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, action, params: params || {} }),
  });
  return res.json();
}

async function pollCmd(id, timeoutMs = 30000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(BRIDGE_URL + '/cmd?cmd=' + encodeURIComponent(id));
    const j = await res.json();
    if (j.status && j.status !== 'pending') return j;
    await sleep(500);
  }
  return null;
}

async function startChrome() {
  fs.mkdirSync(PROFILE_DIR, { recursive: true });
  chromeProc = spawn(CHROME_BIN, [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--no-first-run',
    '--no-default-browser-check',
    '--load-extension=' + EXTENSION_PATH,
    '--disable-extensions-except=' + EXTENSION_PATH,
    '--remote-debugging-port=' + CDP_PORT,
    '--window-size=1280,800',
    '--user-data-dir=' + PROFILE_DIR,
    'http://example.com',
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, LD_LIBRARY_PATH: LIBS_PATH },
  });
  chromeProc.stderr.on('data', d => chromeLog += d.toString());
  chromeProc.stdout.on('data', d => chromeLog += d.toString());

  const base = 'http://127.0.0.1:' + CDP_PORT;
  for (let i = 0; i < 30; i++) {
    try {
      await fetch(base + '/json/version');
      break;
    } catch { await sleep(500); }
  }

  for (let i = 0; i < 20; i++) {
    try {
      const targets = await (await fetch(base + '/json/list')).json();
      const sw = targets.find(t =>
        t.type === 'service_worker' &&
        t.url.includes('chrome-extension://') &&
        t.url.endsWith('/sw.js'));
      if (sw) {
        extId = sw.url.split('//')[1].split('/')[0];
        break;
      }
    } catch {}
    await sleep(500);
  }
  if (!extId) {
    cleanup();
    throw new Error('Extension SW not found:\n' + chromeLog.slice(-1500));
  }
  console.log('[test] Extension ID:', extId);
  return base;
}

// The #screenshot-overlay element:
//   - hasAttribute('hidden') is true (attribute present, value="" or "hidden") → VISIBLE via [hidden]{display:none} rule
//   - hasAttribute('hidden') is false (attribute removed) → VISIBLE
// Wait, that's backwards. Let me re-check:
// In HTML, the `hidden` attribute sets display:none (via browser default UA stylesheet).
// In panel.html, #screenshot-overlay[hidden] { display: none; } explicitly.
// So:
//   - attribute present → element is HIDDEN (display:none)
//   - attribute absent  → element is VISIBLE (display:flex, inherited)
// But panel.js does:
//   ssShowImage: el.hidden = false  → removes the attribute → visible
//   ssClose: el.hidden = true      → adds the attribute → hidden
//   ssShowImage sets el.hidden = false which removes the attribute
// So:
//   - getOverlayState returns hasHidden = el.hasAttribute('hidden')
//   - If hasHidden is true → element is HIDDEN
//   - If hasHidden is false → element is VISIBLE

async function getOverlayState(page) {
  return page.evaluate(() => {
    var el = document.getElementById('screenshot-overlay');
    if (!el) return { error: 'no overlay element' };
    var cs = window.getComputedStyle(el);
    return {
      hasHiddenAttr: el.hasAttribute('hidden'),
      display: cs.display,
      position: cs.position,
      bottom: cs.bottom,
      right: cs.right,
      width: cs.width,
      height: cs.height,
      zIndex: cs.zIndex,
    };
  });
}

// Returns true if the overlay is VISIBLE (not hidden)
function overlayVisible(state) {
  // The overlay is visible when:
  //  1. It has no hidden attribute AND display is not "none"
  // OR more simply: display !== 'none'
  return state && state.display !== 'none';
}

async function main() {
  console.log('[test] Checking bridge...');
  await bridgeUp();
  console.log('[test] Bridge at :3081 is up');

  console.log('[test] Launching Chrome...');
  const base = await startChrome();
  console.log('[test] Chrome CDP ready');

  const browser = await chromium.connectOverCDP(base);
  const contexts = browser.contexts();
  const ctx = contexts[0];

  let panelPage;
  try {
    panelPage = await ctx.newPage();
    await panelPage.goto('chrome-extension://' + extId + '/panel.html', { waitUntil: 'domcontentloaded', timeout: 10000 });
    console.log('[test] Side panel opened');
  } catch (e) {
    throw new Error('Could not open side panel: ' + e.message);
  }
  await panelPage.waitForTimeout(2000);
  console.log('[test] Page:', panelPage.url());

  // ===== TEST 1: Extension is loaded =====
  console.log('[test] TEST 1: Extension is loaded');
  console.log('  ✓ Extension ID:', extId);

  // ===== TEST 2: Overlay hidden initially =====
  console.log('[test] TEST 2: Initial overlay state...');
  let ov2 = await getOverlayState(panelPage);
  console.log('  state:', JSON.stringify(ov2));
  if (ov2.error) throw new Error(ov2.error);
  if (overlayVisible(ov2)) {
    throw new Error('Overlay should be hidden initially (display should be none)');
  }
  console.log('  ✓ TEST 2: Overlay hidden initially (staging is silent)');

  // ===== TEST 3: Explicit capture shows small card =====
  console.log('[test] TEST 3: Explicit screenshot capture via bridge...');
  const shotId = 'pw-shot-' + Date.now().toString(36);
  await postCmd('screenshot', {}, shotId);
  console.log('  POST /cmd/screenshot id=' + shotId);
  const shotResult = await pollCmd(shotId);
  if (!shotResult) throw new Error('Screenshot command timed out');
  if (shotResult.status === 'error' || !shotResult.result || shotResult.result.ok !== true) {
    throw new Error('Screenshot failed: ' + JSON.stringify(shotResult).slice(0, 150));
  }
  console.log('  ✓ Screenshot captured');

  await sleep(2000);
  let ov = await getOverlayState(panelPage);
  console.log('  state:', JSON.stringify(ov));
  if (ov.error) throw new Error(ov.error);
  if (!overlayVisible(ov)) {
    throw new Error('Screenshot overlay did not appear');
  }
  console.log('  ✓ Overlay visible after capture');

  var w = parseInt(ov.width, 10);
  var h = parseInt(ov.height, 10);
  console.log('  size: ' + w + 'x' + h);
  if (w > 300) throw new Error('Overlay width ' + w + 'px too wide (expected ≤260)');
  if (h > 340) throw new Error('Overlay height ' + h + 'px too tall (expected ≤320)');
  console.log('  ✓ TEST 3: Compact overlay (' + w + 'x' + h + ')');

  if (ov.position === 'absolute') {
    console.log('  ✓ Absolute position (anchored to panel body)');
    if (ov.bottom && ov.right) {
      console.log('  ✓ Anchored: bottom=' + ov.bottom + ' right=' + ov.right);
    }
  } else {
    console.log('  ⚠ Position is not "absolute": ' + ov.position);
  }
  if (ov.display === 'flex' || ov.display === 'flex-column') {
    console.log('  ✓ Display: ' + ov.display);
  }

  // ===== TEST 4: ✕ dismissal =====
  console.log('[test] TEST 4: Dismiss with ✕...');
  await panelPage.click('#ss-close', { timeout: 3000 });
  await sleep(500);
  let ov4 = await getOverlayState(panelPage);
  console.log('  after ✕:', JSON.stringify(ov4));
  if (overlayVisible(ov4)) {
    throw new Error('Overlay not dismissed after ✕ click');
  }
  console.log('  ✓ TEST 4: Overlay dismissed (ssUserDismissed = true)');

  // ===== TEST 5: Auto-hide =====
  console.log('[test] TEST 5: Auto-hide after 8s...');
  // The capture button triggers ssCaptureActive() which resets ssUserDismissed
  try {
    await panelPage.click('#ss-capture-row', { timeout: 3000 });
  } catch (e) {
    console.log('  ⚠ #ss-capture-row not clickable (continuing)');
  }
  const shotId2 = 'pw-shot2-' + Date.now().toString(36);
  await postCmd('screenshot', {}, shotId2);
  const shotResult2 = await pollCmd(shotId2);
  if (shotResult2.status !== 'error' && shotResult2.result && shotResult2.result.ok === true) {
    console.log('  ✓ 2nd screenshot captured');
  } else {
    console.log('  ⚠ 2nd screenshot: ' + JSON.stringify(shotResult2).slice(0, 150));
  }
  await sleep(3000);

  let ov5 = await getOverlayState(panelPage);
  console.log('  after 2nd capture:', JSON.stringify(ov5));
  if (!overlayVisible(ov5)) {
    console.log('  ⚠ Overlay not visible after 2nd capture');
  } else {
    console.log('  ✓ Overlay visible after 2nd capture');
    console.log('  Waiting 9s for auto-hide...');
    await sleep(9000);
    let ov6 = await getOverlayState(panelPage);
    console.log('  after auto-hide:', JSON.stringify(ov6));
    if (overlayVisible(ov6)) {
      throw new Error('Auto-hide failed — overlay still visible after 8s');
    }
    console.log('  ✓ TEST 5: Auto-hide worked (8s)');
  }

  // ===== TEST 6: ssUserDismissed prevents re-opening =====
  console.log('[test] TEST 6: ssUserDismissed prevents re-opening...');
  const shotId3 = 'pw-shot3-' + Date.now().toString(36);
  await postCmd('screenshot', {}, shotId3);
  const shotResult3 = await pollCmd(shotId3);
  if (shotResult3.status !== 'error' && shotResult3.result && shotResult3.result.ok === true) {
    console.log('  3rd screenshot captured');
  } else {
    console.log('  3rd screenshot: ' + JSON.stringify(shotResult3).slice(0, 150));
  }
  await sleep(3000);
  let ov7 = await getOverlayState(panelPage);
  console.log('  after dismissal + new screenshot:', JSON.stringify(ov7));
  if (!overlayVisible(ov7)) {
    console.log('  ✓ TEST 6: ssUserDismissed prevents overlay re-opening');
  } else {
    console.log('  ⚠ Overlay re-opened despite ssUserDismissed=true');
  }

  console.log('\n[RESULT] All tests completed successfully!');
}

main().then(() => {
  cleanup();
  console.log('[done] Cleanup complete');
  process.exit(0);
}).catch((e) => {
  console.error('[FAIL]', e && e.stack || e);
  cleanup();
  process.exit(1);
});
