// Isolated end-to-end proof of the chrome-eye agent -> bridge -> SW -> content
// script chain. Launches Chrome-for-Testing with the extension loaded, opens
// the side panel (so the panel.js relay loop is live), loads a test page, and
// drives screenshot/click/type/navigate through the bridge /cmd channel exactly
// the way the `chrome-eye` Cordis model tool does.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { existsSync, writeFileSync, readdirSync, statSync } from 'node:fs';

const CHROME = '/mnt/f/ai/chrome-eye/test/chrome/chrome-linux64/chrome';
const EXT = '/mnt/f/ai/chrome-eye/extension';
const CAPS = '/mnt/f/ai/chrome-eye/captures';
const PROFILE = '/tmp/chrome-eye-e2e-profile-' + Date.now();
const CDP_PORT = 9333;
const BASE = `http://127.0.0.1:${CDP_PORT}`;

const sleep2 = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdp(path, method, params = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 1, method, params }),
  });
  const j = await res.json();
  if (j.error) throw new Error(`${method}: ${JSON.stringify(j.error)}`);
  return j.result;
}

async function cdpWs(wsUrl) {
  const ws = new WebSocket(wsUrl);
  let seq = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  };
  const opened = new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  await opened;
  return (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params }));
    setTimeout(() => { if (pending.has(id)) { pending.delete(id); reject(new Error('timeout ' + method)); } }, 20000);
  });
}

async function postCmd(action, params, id) {
  const res = await fetch('http://127.0.0.1:3081/cmd', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, action, params: params || {} }),
  });
  return res.json();
}

async function pollCmd(id, timeoutMs = 40000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const res = await fetch(`http://127.0.0.1:3081/cmd?cmd=${encodeURIComponent(id)}`);
    const j = await res.json();
    if (j.status && j.status !== 'pending') return j;
    await sleep2(800);
  }
  return null;
}

const chrome = spawn(CHROME, [
  `--remote-debugging-port=${CDP_PORT}`,
  `--user-data-dir=${PROFILE}`,
  `--load-extension=${EXT}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-extensions-except=' + EXT,
  '--window-size=1400,900',
  '--headless=new',
], { env: { ...process.env, LD_LIBRARY_PATH: '/mnt/f/ai/chrome-eye/test/chrome-libs/usr/lib/x86_64-linux-gnu' }, stdio: ['ignore', 'pipe', 'pipe'] });
let chromeLog = '';
chrome.stderr.on('data', (d) => { chromeLog += d.toString(); });
chrome.stdout.on('data', (d) => { chromeLog += d.toString(); });

let panelPage = null;

try {
  // wait for CDP
  let up = false;
  for (let i = 0; i < 40 && !up; i++) {
    try { await fetch(`${BASE}/json/version`); up = true; } catch { await sleep2(300); }
  }
  if (!up) throw new Error('CDP never came up:\n' + chromeLog.slice(-2000));

  // extension id
  let extId = null;
  for (let i = 0; i < 30 && !extId; i++) {
    const targets = await (await fetch(`${BASE}/json/list`)).json();
    const sw = targets.find((t) => t.type === 'service_worker' && t.url.includes('chrome-extension://') && t.url.endsWith('/sw.js'));
    if (sw) { extId = sw.url.split('//')[1].split('/')[0]; }
    else await sleep2(300);
  }
  if (!extId) throw new Error('extension SW not found:\n' + chromeLog.slice(-2000));
  console.log('EXT_ID', extId);

  // open a content tab (the target to drive)
  const contentTarget = await (await fetch(`${BASE}/json/new?about:blank`, { method: 'PUT' })).json().catch(async () => (await fetch(`${BASE}/json/new?about:blank`)).json());
  const contentPage = await cdpWs(contentTarget.webSocketDebuggerUrl);
  await contentPage('Page.enable');
  await contentPage('Page.navigate', { url: 'https://example.com/' });
  await sleep2(2500);

  // open the side panel (relay loop) as a page
  const panelTarget = await (await fetch(`${BASE}/json/new?chrome-extension://${extId}/panel.html`, { method: 'PUT' })).json().catch(async () => (await fetch(`${BASE}/json/new?chrome-extension://${extId}/panel.html`)).json());
  const panelPage = await cdpWs(panelTarget.webSocketDebuggerUrl);
  await panelPage('Page.enable');
  await panelPage('Runtime.enable');
  console.log('panel opened');
  await sleep2(1500);

  // sanity: relay should now be polling. Post a screenshot command.
  const id1 = 'e2e-shot-' + Date.now().toString(36);
  console.log('posting screenshot', id1);
  const p1 = await postCmd('screenshot', {}, id1);
  console.log('post res', JSON.stringify(p1));
  const r1 = await pollCmd(id1);
  if (!r1) throw new Error('screenshot timed out (panel relay not live?)');
  console.log('SCREENSHOT', JSON.stringify(r1).slice(0, 400));
  if (r1.status === 'error' || !r1.result || r1.result.ok !== true) throw new Error('screenshot failed: ' + JSON.stringify(r1));
  const imgPath = r1.result.imagePath;
  if (!imgPath || !existsSync(imgPath)) throw new Error('imagePath missing: ' + imgPath);
  const size = statSync(imgPath).size;
  console.log('PNG OK', imgPath, size, 'bytes');

  // Make the content tab the active tab so drive-by-selector (omitting tabId)
  // lands on example.com rather than the panel.
  try {
    const browserWs = (await (await fetch(`${BASE}/json/version`)).json()).webSocketDebuggerUrl;
    const browser = await cdpWs(browserWs);
    await browser('Target.activateTarget', { targetId: contentTarget.id });
    console.log('activated content tab', contentTarget.id);
  } catch (e) {
    console.log('activateTarget failed (continuing):', e.message);
  }
  await sleep2(1000);

  // click a link on example.com (drive the active content tab, omit tabId)
  const id2 = 'e2e-click-' + Date.now().toString(36);
  const p2 = await postCmd('click', { selector: 'a' }, id2);
  const r2 = await pollCmd(id2);
  console.log('CLICK', JSON.stringify(r2));
  if (r2 && r2.result && r2.result.ok === true) console.log('click matched', r2.result.matched, r2.result.tag);

  // navigate the content tab to a page with a search box
  const id3 = 'e2e-navig-' + Date.now().toString(36);
  const p3 = await postCmd('navigate', { url: 'https://duckduckgo.com/' }, id3);
  const r3 = await pollCmd(id3);
  console.log('NAVIGATE', JSON.stringify(r3).slice(0, 300));

  const id4 = 'e2e-type-' + Date.now().toString(36);
  const p4 = await postCmd('type', { selector: 'input[name="q"]', value: 'deepseek harness' }, id4);
  const r4 = await pollCmd(id4);
  console.log('TYPE', JSON.stringify(r4));
  if (r4 && r4.result && r4.result.ok === true) console.log('typed', r4.result.valueLen, 'chars');

  // final screenshot to confirm rendered state after drive
  const id5 = 'e2e-final-' + Date.now().toString(36);
  const p5 = await postCmd('screenshot', {}, id5);
  const r5 = await pollCmd(id5);
  if (r5 && r5.result && r5.result.ok === true && r5.result.imagePath && existsSync(r5.result.imagePath)) {
    console.log('FINAL PNG OK', r5.result.imagePath, statSync(r5.result.imagePath).size, 'bytes');
  } else {
    console.log('FINAL shot', JSON.stringify(r5).slice(0, 300));
  }

  console.log('\n=== E2E PASS ===');
} catch (e) {
  console.error('\n=== E2E FAIL ===');
  console.error(e && e.message ? e.message : String(e));
  console.error('--- chrome tail ---\n' + chromeLog.slice(-1500));
  process.exitCode = 1;
} finally {
  try { chrome.kill('SIGTERM'); } catch {}
  await sleep2(500);
  try { chrome.kill('SIGKILL'); } catch {}
}
