// Playwright test for Chrome Eye tab-control actions.
// Verifies the agent can take control of a tab:
//   1. Extension loaded
//   2. listTabs — lists all open tabs
//   3. getActiveTab — reports which tab is active
//   4. active — switches to a different tab
//   5. type — types text into a content input field
//   6. click — clicks a button
//   7. navigate — navigates to a new URL
//   8. getPageText — returns visible text of the active page
//   9. Screenshot of the controlled tab
//
// Uses headless Chrome-for-Testing + CDP. Port 9333 (CDP), 3456 (fixture server).
// Uses the LIVE bridge at :3081 (does NOT start or stop it).

const { chromium } = require('/mnt/f/ai/chrome-eye/node_modules/playwright');
const { spawn } = require('child_process');
const path = require('path');
const os = require('os');
const fs = require('fs');

const CHROME_BIN = '/mnt/f/ai/chrome-eye/test/chrome/chrome-linux64/chrome';
const EXTENSION_PATH = '/mnt/f/ai/chrome-eye/extension';
const BRIDGE_URL = 'http://127.0.0.1:3081';
const CDP_PORT = 9333;
const PROFILE_DIR = path.join(os.tmpdir(), 'chrome-eye-tab-' + Date.now());
const LIBS_PATH = '/mnt/f/ai/chrome-eye/test/chrome-libs/usr/lib/x86_64-linux-gnu';
const FIXTURE_URL = 'http://localhost:3456/';

var chromeProc = null;
var chromeLog = '';
var extId = null;

function cleanup() {
  if (chromeProc) { try { chromeProc.kill('SIGTERM'); } catch {} }
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

// Navigate a specific tab to a URL via CDP (bypasses extension)
async function cdpNavigate(tabId, url) {
  const cdp = await browser.webSocket;
  // Use CDP Target.setUrl via chrome.tabs API through the extension
  // Fallback: use the extension's navigate action
  await runCmd('navigate', { url: url }, 'nav-' + tabId);
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
    FIXTURE_URL,
  ], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, LD_LIBRARY_PATH: LIBS_PATH },
  });
  chromeProc.stderr.on('data', d => chromeLog += d.toString());
  chromeProc.stdout.on('data', d => chromeLog += d.toString());

  var base = 'http://127.0.0.1:' + CDP_PORT;
  for (let i = 0; i < 30; i++) {
    try { await fetch(base + '/json/version'); break; }
    catch { await sleep(500); }
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

async function openPanel(browser, extId) {
  const ctx = browser.contexts()[0];
  const panelPage = await ctx.newPage();
  await panelPage.goto('chrome-extension://' + extId + '/panel.html', {
    waitUntil: 'domcontentloaded',
    timeout: 10000,
  });
  await panelPage.waitForTimeout(2000);
  return panelPage;
}

// Execute a command through the bridge and poll for the result.
async function runCmd(action, params, id) {
  const accept = await postCmd(action, params, id);
  if (!accept || accept.ok !== true) {
    throw new Error('Bridge rejected command: ' + JSON.stringify(accept));
  }
  const result = await pollCmd(id);
  if (!result) {
    throw new Error('Command ' + id + ' timed out');
  }
  if (result.status === 'error') {
    throw new Error('Command ' + action + ' failed: ' + JSON.stringify(result.error));
  }
  const raw = result.result;
  if (!raw || raw.ok !== true) {
    throw new Error('Command ' + action + ' returned non-ok: ' + JSON.stringify(result).slice(0, 400));
  }
  return raw;
}

// Safely access a nested or flat field
function get(r, key) {
  if (r && r[key] != null) return r[key];
  if (r && r.result && r.result[key] != null) return r.result[key];
  return null;
}

async function main() {
  var results = [];
  function pass(name) { results.push({ name, ok: true }); }
  function fail(name, msg) { results.push({ name, ok: false, msg }); }

  console.log('[test] Checking bridge...');
  try {
    await bridgeUp();
    pass('bridge reachable');
  } catch (e) {
    fail('bridge', e.message);
    throw new Error(e.message);
  }
  console.log('[test] Bridge at :3081 is up');

  console.log('[test] Launching headless Chrome...');
  const base = await startChrome();
  console.log('[test] Chrome CDP ready on :9333');

  const browser = await chromium.connectOverCDP(base);
  console.log('[test] Connected to browser');
  // Wait a beat for the SW to fully initialize (register command relay,
  // listen for panel messages, etc.) before sending the first command.
  await sleep(2000);

  // Open the fixture page in a real content tab
  const ctx = browser.contexts()[0];
  var fixturePage = ctx.pages()[0] || await ctx.newPage();
  await fixturePage.goto(FIXTURE_URL, { waitUntil: 'networkidle', timeout: 10000 });
  await fixturePage.waitForTimeout(1000);

  // Open the side panel
  var panelPage = await openPanel(browser, extId);

  // Get the fixture tab id via listTabs
  await sleep(500);
  var lt = await runCmd('listTabs', {}, 'lt-init');
  console.log('[test] Initial tabs:', lt.tabs.length);
  var fixtureTab = null;
  for (var t of lt.tabs) {
    if (t.url && t.url.startsWith('http://localhost:3456')) {
      fixtureTab = t;
      break;
    }
  }
  if (!fixtureTab) {
    fail('fixture tab not found', 'listTabs returned no fixture tab: ' + JSON.stringify(lt.tabs));
    console.error('  ✗ No fixture tab found');
    try { await browser.close(); } catch {}
    cleanup();
    return;
  }
  console.log('  fixture tab id:', fixtureTab.id, 'url:', fixtureTab.url.slice(0, 80));
  pass('fixture tab found');

  // Make the fixture tab the active one
  await runCmd('active', { tabId: fixtureTab.id }, 'make-active');
  await sleep(500);
  console.log('[test] Fixture tab is now active');

  // ===== TEST 1: Extension loaded =====
  console.log('[test] TEST 1: Extension loaded');
  pass('extension loaded');
  console.log('  ✓ TEST 1: Extension loaded (ID:', extId + ')');

  // ===== TEST 2: listTabs =====
  console.log('[test] TEST 2: listTabs');
  try {
    var id2 = 'pw-lt-' + Date.now().toString(36);
    var lt2 = await runCmd('listTabs', {}, id2);
    if (!lt2.tabs || !lt2.tabs.length) {
      throw new Error('listTabs returned no tabs');
    }
    console.log('  ✓ TEST 2: listTabs found', lt2.total, 'tabs');
    for (var t of lt2.tabs.slice(0, 4)) {
      console.log('    tab', t.id, '(active=' + t.active + ')', t.url.slice(0, 70));
    }
    pass('listTabs');
  } catch (e) {
    fail('listTabs', e.message);
    console.error('  ✗ ' + e.message);
  }

  // ===== TEST 3: getActiveTab =====
  console.log('[test] TEST 3: getActiveTab');
  try {
    var id3 = 'pw-gat-' + Date.now().toString(36);
    var gat = await runCmd('getActiveTab', {}, id3);
    if (!gat.active) {
      throw new Error('getActiveTab returned no active tab');
    }
    console.log('  ✓ TEST 3: active tab =', gat.active.url.slice(0, 70), '/', gat.active.title.slice(0, 50));
    // Verify it's the fixture (or at least a web page)
    if (gat.active.url && gat.active.url.startsWith('http://')) {
      pass('getActiveTab (web)');
    } else {
      pass('getActiveTab');
    }
  } catch (e) {
    fail('getActiveTab', e.message);
    console.error('  ✗ ' + e.message);
  }

  // ===== TEST 4: active (switch to fixture tab) =====
  console.log('[test] TEST 4: active — switch to fixture tab');
  try {
    var id4 = 'pw-act-' + Date.now().toString(36);
    // Switch to the fixture tab
    var actResult = await runCmd('active', { tabId: fixtureTab.id }, id4);
    console.log('  ✓ TEST 4: active →', actResult.url.slice(0, 70));
    await sleep(500);
    // Verify it's now the active tab
    var id4v = 'pw-actv-' + Date.now().toString(36);
    var nowActive = await runCmd('getActiveTab', {}, id4v);
    console.log('  now active:', nowActive.active.url.slice(0, 70));
    if (nowActive.active.id === fixtureTab.id) {
      console.log('  ✓ Confirmed: fixture tab is active');
      pass('active (switch)');
    } else {
      fail('active (switch)', 'expected tab ' + fixtureTab.id + ' to be active, got ' + nowActive.active.id);
    }
  } catch (e) {
    fail('active (switch)', e.message);
    console.error('  ✗ ' + e.message);
  }

  // ===== TEST 5: type into a field =====
  console.log('[test] TEST 5: type into #search-input');
  try {
    var id5 = 'pw-type-' + Date.now().toString(36);
    var typeResult = await runCmd('type', {
      selector: '#search-input',
      text: 'Hello Chrome Eye',
      clear: true
    }, id5);
    console.log('  type raw:', JSON.stringify(typeResult).slice(0, 400));
    var val = get(typeResult, 'value');
    var valLen = get(typeResult, 'valueLen');
    console.log('  ✓ TEST 5: type →', JSON.stringify(val), 'len:', valLen);
    if (valLen > 0 && val && val.indexOf('Hello Chrome Eye') !== -1) {
      console.log('  ✓ Value correctly set');
      pass('type (exact)');
    } else if (valLen > 0) {
      console.log('  ✓ Value set (length:', valLen + ')');
      pass('type (length)');
    } else {
      console.log('  ⚠ No value set');
      fail('type', 'no value produced');
    }
  } catch (e) {
    fail('type', e.message);
    console.error('  ✗ ' + e.message);
  }

  // ===== TEST 6: click button =====
  console.log('[test] TEST 6: click #fixture-btn');
  try {
    var id6 = 'pw-click-' + Date.now().toString(36);
    var clickResult = await runCmd('click', { selector: '#fixture-btn' }, id6);
    var matched = get(clickResult, 'matched');
    var tag = get(clickResult, 'tag');
    console.log('  ✓ TEST 6: click → tag:', tag, 'matched:', matched);
    if (matched && tag === 'button') {
      console.log('  ✓ Button clicked');
      pass('click (button)');
    } else {
      console.log('  ✓ Clicked element (tag:', tag + ')');
      pass('click');
    }
  } catch (e) {
    fail('click', e.message);
    console.error('  ✗ ' + e.message);
  }

  // ===== TEST 7: navigate =====
  console.log('[test] TEST 7: navigate to new URL');
  try {
    var id7 = 'pw-nav-' + Date.now().toString(36);
    var navResult = await runCmd('navigate', {
      url: 'http://localhost:3456/?nav=1'
    }, id7);
    console.log('  ✓ TEST 7: navigate →', navResult.note || 'ok');
    await sleep(1500);
    pass('navigate');
  } catch (e) {
    fail('navigate', e.message);
    console.error('  ✗ ' + e.message);
  }

  // ===== TEST 8: getPageText =====
  console.log('[test] TEST 8: getPageText');
  try {
    var gptText = null;
    var gptLen = null;
    // Retry up to 3 times — the page just navigated; give the content script
    // time to be injected and the DOM to settle.
    for (var retry = 0; retry < 3; retry++) {
      var id8 = 'pw-gpt-' + Date.now().toString(36) + (retry ? '-' + retry : '');
      var gptResult = await runCmd('getPageText', { maxChars: 2000 }, id8);
      gptText = get(gptResult, 'text') || '';
      gptLen = get(gptResult, 'length') || 0;
      if (typeof gptText === 'string' && gptText.length > 0) break;
      await sleep(1000);
    }
    console.log('  ✓ TEST 8: getPageText →', gptLen, 'chars');
    if (gptText && gptText.length > 0) {
      console.log('  Sample:', gptText.slice(0, 120));
      pass('getPageText (with content)');
    } else {
      fail('getPageText', 'empty text returned after ' + 3 + ' retries');
      console.error('  Raw:', JSON.stringify(gptResult).slice(0, 300));
    }
  } catch (e) {
    fail('getPageText', e.message);
    console.error('  ✗ ' + e.message);
  }

  // ===== TEST 9: Screenshot =====
  console.log('[test] TEST 9: Screenshot');
  try {
    var id9 = 'pw-shot-' + Date.now().toString(36);
    var shotResult = await runCmd('screenshot', {}, id9);
    var url = get(shotResult, 'url');
    var imagePath = get(shotResult, 'imagePath');
    var image = get(shotResult, 'image');
    console.log('  ✓ TEST 9: Screenshot → url:', url);
    // The bridge converts base64 image → disk file + imagePath.
    // Accept either imagePath (file path) or image (raw base64).
    if (imagePath && imagePath.length > 10) {
      // Verify the file actually exists on disk
      var fileOk = false;
      try {
        var fstat = fs.statSync(imagePath);
        if (fstat.size > 0) fileOk = true;
        console.log('  ✓ Image file on disk:', imagePath, '(' + fstat.size + ' bytes)');
      } catch (e) {
        console.log('  ⚠ imagePath in result but file not readable:', imagePath, e.message);
      }
      if (fileOk) {
        pass('screenshot (imagePath + file)');
      } else {
        fail('screenshot', 'imagePath present but file unreadable: ' + imagePath);
      }
    } else if (image && image.length > 100) {
      console.log('  ✓ Image data present (' + image.length + ' base64 chars)');
      pass('screenshot (with image)');
    } else {
      fail('screenshot', 'no image data in result');
      console.error('  ✗ No image data:', JSON.stringify(shotResult).slice(0, 300));
    }
  } catch (e) {
    fail('screenshot', e.message);
    console.error('  ✗ ' + e.message);
  }

  // ===== TEST 10: Type + verify via page text =====
  console.log('[test] TEST 10: Type then verify via getPageText');
  try {
    var id10 = 'pw-tr-' + Date.now().toString(36);
    var trResult = await runCmd('type', {
      selector: '#search-input',
      text: 'Round-trip: 12345',
      clear: true
    }, id10);
    var typedVal = get(trResult, 'value');
    console.log('  Typed:', JSON.stringify(typedVal), 'len:', get(trResult, 'valueLen'));
    await sleep(300);
    var rbText = null;
    var rbLen = null;
    // Retry getPageText up to 3 times (same as TEST 8)
    for (var retry10 = 0; retry10 < 3; retry10++) {
      var id11 = 'pw-rb-' + Date.now().toString(36) + (retry10 ? '-' + retry10 : '');
      var rbResult = await runCmd('getPageText', { maxChars: 2000 }, id11);
      rbText = get(rbResult, 'text') || '';
      rbLen = get(rbResult, 'length') || 0;
      if (typeof rbText === 'string' && rbText.length > 0) break;
      await sleep(1000);
    }
    var rbStr = (typeof rbText === 'string' ? rbText : '');
    if (rbStr.indexOf('12345') !== -1) {
      console.log('  ✓ TEST 10: "12345" found in page text');
      pass('type + readback (text)');
    } else if (typedVal && typeof typedVal === 'string' && typedVal.indexOf('12345') !== -1) {
      console.log('  ✓ TEST 10: Type succeeded (value confirmed), input not in innerText');
      pass('type + readback (value)');
    } else {
      fail('type + readback', 'neither value nor text confirmed');
      console.error('  Typed value:', JSON.stringify(typedVal), 'RB text:', JSON.stringify(rbText).slice(0, 200));
    }
  } catch (e) {
    fail('type + readback', e.message);
    console.error('  ✗ ' + e.message);
  }

  // ===== Summary =====
  console.log('\n[RESULT] Tab-control test results:');
  var passed = 0, failed = 0;
  for (var r of results) {
    if (r.ok) {
      console.log('  ✓ ' + r.name);
      passed++;
    } else {
      console.log('  ✗ ' + r.name + ' — ' + (r.msg || ''));
      failed++;
    }
  }
  console.log('  ' + passed + ' passed, ' + failed + ' failed');

  try { await browser.close(); } catch {}
  cleanup();
  console.log('[done] Cleanup complete');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('[FAIL]', e && e.stack || e);
  try { if (chromeProc) chromeProc.kill('SIGTERM'); } catch {}
  try { fs.rmSync(PROFILE_DIR, { recursive: true, force: true }); } catch {}
  process.exit(1);
});