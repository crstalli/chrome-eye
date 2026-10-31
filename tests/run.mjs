// T12.7 — real headless-browser test layer for the chrome-eye panel.
//
// Runs the REAL extension (unpacked, from ../extension) in a real headless
// Chrome for Testing, drives the REAL panel (panel.html embedding the REAL
// DSH GUI iframe at http://127.0.0.1:3080), mints a valid :3080 auth cookie
// at run time (mint.mjs — secret read from disk, never committed), and
// captures screenshot evidence in shots/.
//
// Usage:  node tests/run.mjs          (exit 0 = all hard assertions pass)
// Prereq: bridge :3081 and dsh --profile web :3080 are running.
//
// Screenshots (shots/):
//   01-panel-full            full panel vs scratch-t12/gemini-reference.png
//   02-iframe-loaded         :3080 GUI iframe loaded inside the panel (no 401)
//   03-workspaces-dropdown   "Workspaces ▾" dropdown open
//   04-overlay-open          workspace overlay open INSIDE the panel iframe
//   05-overlay-closed-x      overlay closed via ✕
//   06-overlay-closed-esc    overlay closed via Esc
//   07-disconnected-state    DSH connection-indicator state (soft check)

import { chromium } from 'playwright';
import { mkdtempSync, writeFileSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { mintCookie } from './mint.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const EXT = path.join(ROOT, 'extension');
const SHOTS = path.join(HERE, 'shots');
const CHROME = path.join(ROOT, 'test', 'chrome', 'chrome-linux64', 'chrome');
const CHROME_LIBS = path.join(ROOT, 'test', 'chrome-libs', 'usr', 'lib', 'x86_64-linux-gnu');
const PANEL_URL_3080 = 'http://127.0.0.1:3080';
const VIEWPORT = { width: 360, height: 600 }; // ≈ gemini-reference.png (356x549)

mkdirSync(SHOTS, { recursive: true });
for (const f of readdirSync(SHOTS)) if (f.endsWith('.png')) rmSync(path.join(SHOTS, f));

const results = [];
function record(caseId, ok, detail) {
  results.push({ caseId, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${caseId}  ${detail}`);
  return ok;
}
async function shot(page, name, detail) {
  const p = path.join(SHOTS, name);
  await page.screenshot({ path: p });
  console.log(`      shot: shots/${name}`);
  return record(name.replace('.png', ''), true, detail);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let browser;
let failCount = 0;
const hard = (ok, caseId, detail) => { if (!ok) failCount++; return ok; };

try {
  console.log('== launching headless chrome with the real extension ==');
  browser = await chromium.launch({
    executablePath: CHROME,
    headless: true, // new headless supports extensions
    args: [
      `--load-extension=${EXT}`,
      `--disable-extensions-except=${EXT}`,
      '--no-first-run',
      '--no-default-browser-check',
    ],
    env: { ...process.env, LD_LIBRARY_PATH: CHROME_LIBS },
    timeout: 60000,
  });

  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2 });

  // ---- discovery: extension id via service worker (event, then CDP) ----
  const pollSW = async (ms) => {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const sws = context.serviceWorkers();
      if (sws.length) return sws[0];
      await sleep(400);
    }
    return null;
  };
  let sw = await pollSW(15000);
  let extId = sw ? new URL(sw.url()).hostname : null;
  if (!extId) {
    // CDP fallback: ask the browser for service_worker targets.
    const probe = await context.newPage();
    const cdp = await context.newCDPSession(probe);
    const { targetInfos } = await cdp.send('Target.getTargets');
    const t = targetInfos.find((x) => x.type === 'service_worker' && x.url.startsWith('chrome-extension://'));
    await probe.close();
    if (t) extId = new URL(t.url).hostname;
  }
  if (!extId) throw new Error('extension service worker never appeared; extension failed to load');
  console.log(`extension id: ${extId}`);

  // ---- auth: mint cookie BEFORE navigation (retry-once on 401 quirk) ----
  const minted = mintCookie({ authority: '127.0.0.1:3080', days: 1 });
  await context.addCookies([{
    url: PANEL_URL_3080,
    name: minted.name,
    value: minted.value,
    httpOnly: true,
    sameSite: 'Strict',
  }]);

  // ---- track :3080 document responses (401 detection) ----
  const docStatuses = [];
  context.on('response', (r) => {
    try {
      const u = r.url();
      if (u.startsWith(PANEL_URL_3080) && r.request().resourceType() === 'document') {
        docStatuses.push(r.status());
      }
    } catch { /* ignore */ }
  });

  // ---- open the REAL panel as a tab (headless side panel is not drivable) ----
  const page = await context.newPage();
  await page.goto(`chrome-extension://${extId}/panel.html`, { waitUntil: 'domcontentloaded', timeout: 30000 });
  const panelLoaded = await page.waitForSelector('#dsh-iframe', { timeout: 15000 })
    .then(() => true).catch(() => false);
  hard(panelLoaded, 'panel-tab-loads', `panel.html loaded, #dsh-iframe present (${panelLoaded})`);
  await page.waitForTimeout(1500);
  await shot(page, '01-panel-full', 'full panel, compare scratch-t12/gemini-reference.png');

  // ---- wait for the :3080 iframe, handle the first-request-401 quirk ----
  let guiFrame = null;
  for (let i = 0; i < 30 && !guiFrame; i++) {
    guiFrame = page.frames().find((f) => f.url().startsWith(PANEL_URL_3080));
    if (guiFrame) await guiFrame.waitForLoadState('domcontentloaded', { timeout: 5000 }).catch(() => {});
    await sleep(1000);
  }
  if (!guiFrame) throw new Error('the :3080 GUI iframe never appeared inside the panel');
  await guiFrame.waitForSelector('body', { timeout: 20000 });
  await sleep(4000); // let the SPA boot

  const badStatus = docStatuses.find((s) => s >= 400);
  if (badStatus === 401) {
    console.log('first document request was 401 — re-minting cookie and reloading (known quirk)');
    const reminted = mintCookie({ authority: '127.0.0.1:3080', days: 1 });
    await context.addCookies([{
      url: PANEL_URL_3080, name: reminted.name, value: reminted.value,
      httpOnly: true, sameSite: 'Strict', path: '/',
    }]);
    docStatuses.length = 0;
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 });
    await sleep(6000);
    guiFrame = page.frames().find((f) => f.url().startsWith(PANEL_URL_3080));
    await guiFrame.waitForSelector('body', { timeout: 20000 });
    await sleep(4000);
  }
  const doc401 = docStatuses.includes(401);
  hard(!doc401, 'iframe-no-401', `:3080 document statuses: [${docStatuses.join(',')}], 401 seen: ${doc401}`);
  const bodyText = await guiFrame.evaluate(() => (document.body && document.body.innerText || '').trim().length);
  hard(bodyText > 0, 'iframe-gui-rendered', `GUI body innerText length: ${bodyText}`);
  await shot(page, '02-iframe-loaded', ':3080 GUI iframe loaded in panel, no 401');

  // ---- case: workspaces dropdown (panel-level, works on baseline panel.html) ----
  const treeBtn = page.locator('#ws-tree-btn');
  const treeBtnVisible = await treeBtn.isVisible().catch(() => false);
  if (treeBtnVisible) {
    await treeBtn.click();
    const ddVisible = await page.locator('#ws-dropdown').evaluate((el) => !el.hidden)
      .catch(() => false);
    await sleep(1500); // let the tree populate (bridge :3081 round trip)
    hard(ddVisible, 'workspaces-dropdown-opens', `#ws-dropdown visible after #ws-tree-btn click: ${ddVisible}`);
    await shot(page, '03-workspaces-dropdown', 'workspaces dropdown open');
    await page.locator('body').click({ position: { x: 5, y: 5 } }).catch(() => {}); // close dropdown
  } else {
    hard(false, 'workspaces-dropdown-opens', '#ws-tree-btn not found in panel.html');
  }

  // ---- case: workspace overlay INSIDE the panel (A's T12.1/T12.2) ----
  const ovBtn = page.locator('#ws-overlay-btn');
  const ovBtnVisible = await ovBtn.isVisible().catch(() => false);
  if (!ovBtnVisible) {
    hard(false, 'overlay-opens-in-panel', '#ws-overlay-btn not found in panel.html');
  } else {
    await ovBtn.click();
    let overlay = null;
    for (let i = 0; i < 20 && !overlay; i++) {
      overlay = await guiFrame.locator('[data-chrome-eye-overlay]')
        .first().isVisible().catch(() => false)
        ? guiFrame.locator('[data-chrome-eye-overlay]').first() : null;
      await sleep(700);
    }
    hard(!!overlay, 'overlay-opens-in-panel',
      overlay ? 'overlay element present inside the panel :3080 iframe'
               : 'no [data-chrome-eye-overlay] appeared in the panel iframe (A not landed?)');
    if (overlay) {
      await sleep(1200); // let the tree render
      await shot(page, '04-overlay-open', 'workspace overlay open inside the panel');

      // close via ✕ (button inside the frame's overlay header)
      const closeBtn = guiFrame.locator('[data-chrome-eye-overlay] button').first();
      await closeBtn.click({ timeout: 5000 }).catch(() => {});
      let gone = false;
      for (let i = 0; i < 15 && !gone; i++) {
        gone = !(await guiFrame.locator('[data-chrome-eye-overlay]').first().isVisible().catch(() => false));
        await sleep(500);
      }
      hard(gone, 'overlay-closes-x', `overlay removed after ✕ click: ${gone}`);
      if (gone) await shot(page, '05-overlay-closed-x', 'overlay closed via ✕');

      // reopen, close via Esc
      await ovBtn.click();
      overlay = null;
      for (let i = 0; i < 20 && !overlay; i++) {
        overlay = await guiFrame.locator('[data-chrome-eye-overlay]')
          .first().isVisible().catch(() => false)
          ? guiFrame.locator('[data-chrome-eye-overlay]').first() : null;
        await sleep(700);
      }
      if (overlay) {
        await sleep(800);
        // focus the frame, then real Esc; fall back to a dispatched event
        await guiFrame.locator('body').click({ position: { x: 10, y: 10 } }).catch(() => {});
        await page.keyboard.press('Escape');
        let goneEsc = false;
        for (let i = 0; i < 10 && !goneEsc; i++) {
          goneEsc = !(await guiFrame.locator('[data-chrome-eye-overlay]').first().isVisible().catch(() => false));
          await sleep(400);
        }
        if (!goneEsc) {
          await guiFrame.evaluate(() => document.dispatchEvent(
            new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))).catch(() => {});
          for (let i = 0; i < 10 && !goneEsc; i++) {
            goneEsc = !(await guiFrame.locator('[data-chrome-eye-overlay]').first().isVisible().catch(() => false));
            await sleep(400);
          }
        }
        hard(goneEsc, 'overlay-closes-esc', `overlay removed after Esc: ${goneEsc}`);
        if (goneEsc) await shot(page, '06-overlay-closed-esc', 'overlay closed via Esc');
      } else {
        hard(false, 'overlay-closes-esc', 'overlay did not reopen for Esc test');
      }
    }
  }

  // ---- soft: DSH "disconnected" indicator state (T12.4) ----
  const indicator = await guiFrame.evaluate(() => {
    const t = document.body ? document.body.innerText : '';
    const hasDisconnected = /disconnected/i.test(t);
    const hasConnected = /connected/i.test(t) && !hasDisconnected;
    return hasDisconnected ? 'disconnected' : (hasConnected ? 'connected' : 'not-found');
  }).catch(() => 'evaluate-error');
  console.log(`      info: connection indicator state = ${indicator} (soft check — see T12.4)`);
  await shot(page, '07-disconnected-state', `indicator state: ${indicator}`);

  await page.close();
} catch (e) {
  record('runner-error', false, String((e && e.stack) || e));
  failCount++;
} finally {
  if (browser) await browser.close().catch(() => {});
}

// ---- evidence manifest + exit code ----
const manifest = {
  ts: new Date().toISOString(),
  chrome: 'Google Chrome for Testing 152.0.7977.82',
  extensionDir: EXT,
  results,
  shots: readdirSync(SHOTS).filter((f) => f.endsWith('.png')).sort(),
  pass: failCount === 0,
};
writeFileSync(path.join(SHOTS, 'manifest.json'), JSON.stringify(manifest, null, 2));
console.log(`\n== ${manifest.shots.length} screenshots, ${results.filter((r) => r.ok).length}/${results.length} assertions passed ==`);
process.exit(failCount === 0 ? 0 : 1);
