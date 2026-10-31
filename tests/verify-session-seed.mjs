// Headless verification of the chrome-eye T2 session-seed fix against the LIVE bridge (:3081).
// Loads the real unpacked extension, opens the panel (iframe → :3081), and confirms the
// injected /session-seed script writes dsh.sessions.current into the panel iframe's :3081 origin.
// Also exercises the panel→content postMessage round-trip (seed-check) if content.js attached.
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const EXT = '/mnt/f/ai/chrome-eye/extension';
const CHROME = '/mnt/f/ai/chrome-eye/test/chrome/chrome-linux64/chrome';
const LIBS = '/mnt/f/ai/chrome-eye/test/chrome-libs/usr/lib/x86_64-linux-gnu';
const PORT = 9333;
const EXTID = 'mlolgaoijponghgfnlcljlohnhlpnhkd'; // stable unpacked id
const PANEL = `chrome-extension://${EXTID}/panel.html`;

const proc = spawn(CHROME, [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=/tmp/ce-test-profile-seed-${Date.now()}`,
  `--load-extension=${EXT}`,
  `--disable-extensions-except=${EXT}`,
  '--headless',
  '--no-first-run',
  '--no-default-browser-check',
  '--window-size=360,600',
], { env: { ...process.env, LD_LIBRARY_PATH: LIBS } });

let browser, cdp, ctx, page;
let ok = 0, fail = 0;
function pass(m){ console.log('  ✓ ' + m); ok++; }
function failx(m){ console.log('  ✗ ' + m); fail++; }
async function waitFor(fn, ms, label){
  const t0 = Date.now();
  while (Date.now() - t0 < ms){
    let v; try { v = await fn(); } catch {}
    if (v) return v;
    await sleep(300);
  }
  throw new Error('timeout: ' + label);
}
try {
  // wait for CDP endpoint
  await waitFor(async () => {
    const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
    return r.ok ? r.json() : null;
  }, 30000, 'CDP /json/version');

  browser = await chromium.connectOverCDP(`http://127.0.0.1:${PORT}`);
  ctx = browser.contexts()[0];
  const probe = ctx.pages()[0] || await ctx.newPage();
  cdp = await ctx.newCDPSession(probe);

  // open panel via CDP Target.createTarget (page.goto to chrome-extension:// is blocked in headless)
  await cdp.send('Target.createTarget', { url: PANEL });
  page = await waitFor(async () => ctx.pages().find(p => p.url() === PANEL), 25000, 'panel page');
  await page.waitForLoadState('domcontentloaded').catch(()=>{});
  console.log('panel loaded:', page.url());

  // 1) the panel's GUI iframe should be on the :3081 origin (bridge)
  const frames = page.frames();
  const gui = frames.find(f => /127\.0\.0\.1:3081/.test(f.url()));
  if (gui) pass('GUI iframe present on :3081 origin (' + gui.url() + ')');
  else { failx('no GUI iframe on :3081'); }

  // 2) wait for the GUI app to hydrate, then read dsh.sessions.current from the iframe origin
  let seeded = null;
  try {
    seeded = await waitFor(async () => {
      const v = await gui.evaluate(() => localStorage.getItem('dsh.sessions.current'));
      return v || null;
    }, 25000, 'dsh.sessions.current in iframe origin');
  } catch {}
  if (seeded) {
    pass('dsh.sessions.current seeded in :3081 origin: ' + seeded);
    try { pass('seed payload parses as {sessionId}: ' + JSON.stringify(JSON.parse(seeded))); } catch {}
  } else {
    failx('dsh.sessions.current NOT seeded in iframe origin (would be the user\'s "blank session" symptom)');
  }

  // 3) panel→content postMessage round-trip: ask the frame to report its own id (seed-check).
  // content.js replies with { source:'chrome-eye-hook', type:'chrome-eye:seed-check:result', value:id }
  // The content script attaches slightly after page load; retry the probe (like panel.js does).
  try {
    let id = 'TIMEOUT';
    for (let attempt = 1; attempt <= 5; attempt++) {
      id = await page.evaluate(async () => {
        return await new Promise((resolve) => {
          const ifr = document.getElementById('dsh-iframe');
          if (!ifr || !ifr.contentWindow) return 'NO_IFRAME';
          const to = setTimeout(() => resolve('TIMEOUT'), 3000);
          const h = (e) => {
            if (e.data && e.data.source === 'chrome-eye-hook' && e.data.type === 'chrome-eye:seed-check:result') {
              clearTimeout(to); window.removeEventListener('message', h); resolve(e.data.value || null);
            }
          };
          window.addEventListener('message', h);
          ifr.contentWindow.postMessage({ source: 'chrome-eye-hook', type: 'chrome-eye:seed-check' }, '*');
        });
      });
      if (id !== 'TIMEOUT' && id !== 'NO_IFRAME') break;
      await sleep(1500);
    }
    if (id === 'TIMEOUT') failx('seed-check postMessage got no reply after 5 retries (content.js may not attach in headless)');
    else pass(`seed-check postMessage reply after ${attempt} attempt(s) (frame-reported id): ${id || '(empty)'}`);
  } catch (e) { failx('seed-check postMessage error: ' + e.message); }

  // 4) sanity: the bridge HTML still has exactly one seed tag (idempotent)
  const html = await (await fetch('http://127.0.0.1:3081/')).text();
  const n = (html.match(/session-seed/g) || []).length;
  if (n === 1) pass('bridge HTML has exactly 1 session-seed tag (idempotent)');
  else failx('bridge HTML session-seed tag count = ' + n);

} finally {
  try { browser && await browser.close(); } catch {}
  try { proc.kill(); } catch {}
}
console.log(`\nRESULT: ${ok} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
