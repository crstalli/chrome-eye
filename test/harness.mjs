#!/usr/bin/env node
// Chrome Eye headless test harness (runs on WSL; Chrome runs in a podman container
// with --network=host, so 127.0.0.1 here is the same loopback the container sees).
//
// Checks:
//   1. extension service worker target exists        → extension loaded
//   2. content script console marker on fixture page → content script injected
//   3. sw↔content capture round-trip vs expected.json→ PASS/FAIL (SKIP while stubs)
//   4. panel.html at 400px: bottom bar, real GUI iframe (:3080), no h-scroll, PNG
//
// Exit 0 = zero FAILs (SKIPs allowed). Artifacts in ./out (report.json, PNGs).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listTargets, Cdp } from './cdp.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, dflt) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : dflt; };
const DEBUG = flag('debug', 'http://127.0.0.1:9222');
const FIXTURE_URL = flag('fixture-url', 'http://127.0.0.1:3456/page.html');
const OUT = path.join(here, 'out');
fs.mkdirSync(OUT, { recursive: true });

const results = [];
const log = (s) => console.log(`[harness] ${s}`);
const check = (name, ok, detail = '') => {
  results.push({ name, status: ok ? 'PASS' : 'FAIL', detail: String(detail) });
  log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ' — ' + detail : ''}`);
};
const skip = (name, detail = '') => {
  results.push({ name, status: 'SKIP', detail: String(detail) });
  log(`SKIP  ${name}${detail ? ' — ' + detail : ''}`);
};
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function waitFor(fn, timeoutMs, what) {
  const t0 = Date.now();
  for (;;) {
    try { const v = await fn(); if (v) return v; } catch { /* retry */ }
    if (Date.now() - t0 > timeoutMs) throw new Error(`timeout waiting for ${what}`);
    await sleep(300);
  }
}
const deepEq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

async function main() {
  // 0. CDP endpoint up
  await waitFor(() => listTargets(DEBUG), 30000, 'CDP endpoint');
  log('CDP endpoint reachable');

  // T11.5 — the extension's SW target can register ~100–200 ms AFTER the
  // page target (extension install completes after first navigation). A
  // one-shot enumeration here flaked check 1 ~1 in 4 runs; retry up to ~1 s
  // (same 300 ms cadence as waitFor above) before accepting whatever is
  // present (checks still report FAIL as before when a target is missing).
  let pageTarget = null;
  let swTarget = null;
  const targetDeadline = Date.now() + 1000;
  for (;;) {
    const targets = await listTargets(DEBUG);
    pageTarget = targets.find(t => t.type === 'page' && t.url.includes('127.0.0.1:3456'));
    swTarget = targets.find(t => t.type === 'service_worker' && t.url.endsWith('/sw.js'));
    if ((pageTarget && swTarget) || Date.now() >= targetDeadline) break;
    await sleep(300);
  }
  log(`targets: page=${pageTarget?.url ?? 'none'} sw=${swTarget?.url ?? 'none'}`);
  const extId = swTarget ? new URL(swTarget.url).host : null;

  // 1. extension loaded
  check('extension service worker loaded', !!swTarget,
    swTarget ? swTarget.url : 'no service_worker target — extension did not load');

  // 2+3. fixture page
  if (pageTarget) {
    const page = await Cdp.connect(pageTarget.webSocketDebuggerUrl);
    const consoleHits = [];
    page.on('Runtime.consoleAPICalled', (p) => {
      const txt = (p.args ?? []).map(a => a.value ?? a.description ?? '').join(' ');
      consoleHits.push(txt);
    });
    await page.send('Runtime.enable');
    await page.send('Page.enable');
    await page.send('Page.navigate', { url: FIXTURE_URL });
    await waitFor(async () => {
      const r = await page.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
      return r.result?.value === 'complete';
    }, 20000, 'fixture page load');
    await sleep(1000); // let content script + console settle
    const marker = consoleHits.find(s => s.includes('Chrome Eye content script active'));
    check('content script ran on fixture page', !!marker,
      marker ? `console: "${marker}"` : `console events seen: ${JSON.stringify(consoleHits.slice(0, 5))}`);

    // 3. sw↔content capture round-trip (SKIP until T6.x extractor lands)
    if (swTarget) {
      const sw = await Cdp.connect(swTarget.webSocketDebuggerUrl);
      await sw.send('Runtime.enable');
      const expr = `
        (async () => {
          const tabs = await chrome.tabs.query({});
          const tab = tabs.find(t => t.url === ${JSON.stringify(FIXTURE_URL)});
          if (!tab) return { error: 'fixture tab not found', urls: tabs.map(t => t.url) };
          let resp;
          try { resp = await chrome.tabs.sendMessage(tab.id, { type: 'chrome-eye:capture' }); }
          catch (e) { return { tabId: tab.id, url: tab.url, sendError: String(e) }; }
          return { tabId: tab.id, url: tab.url, resp };
        })()
      `;
      let capture = null, err = null;
      try {
        const r = await sw.send('Runtime.evaluate',
          { expression: expr, awaitPromise: true, returnByValue: true, timeout: 15000 });
        capture = r.result?.value ?? null;
        if (r.exceptionDetails) err = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text;
      } catch (e) { err = String(e); }

      if (capture?.resp && typeof capture.resp === 'object' && 'title' in capture.resp) {
        const expected = JSON.parse(fs.readFileSync(path.join(here, 'fixture', 'expected.json'), 'utf8'));
        const c = capture.resp;
        check('capture: url', c.url === FIXTURE_URL, String(c.url));
        check('capture: title', c.title === expected.title, JSON.stringify(c.title));
        check('capture: headings', deepEq(c.headings, expected.headings), JSON.stringify(c.headings ?? null));
        check('capture: links', deepEq(c.links, expected.links), JSON.stringify(c.links ?? null));
        check('capture: text', typeof c.text === 'string' && c.text.length > 0 &&
          expected.mustContain.every(s => c.text.includes(s)),
          `textLen=${typeof c.text === 'string' ? c.text.length : 'n/a'}`);
        fs.writeFileSync(path.join(OUT, 'capture.json'), JSON.stringify(capture, null, 2));
      } else {
        skip('capture round-trip (CP-6 T6.1–T6.9)',
          `no extraction response yet (stub content.js): ${JSON.stringify(capture ?? { error: err })}`.slice(0, 400));
      }
      await sw.close();
    }

    // fixture screenshot
    try {
      const shot = await page.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(OUT, 'fixture.png'), Buffer.from(shot.data, 'base64'));
    } catch (e) { log(`fixture screenshot failed: ${e}`); }
    await page.close();
  } else {
    check('fixture page target', false, 'no page target for ' + FIXTURE_URL);
  }

  // 4. panel render test
  if (!extId) {
    skip('panel render test (CP-5)', 'no extension id (extension did not load)');
  } else {
    const panelUrl = `chrome-extension://${extId}/panel.html`;
    let newTarget = null;
    try {
      const r = await fetch(`${DEBUG}/json/new?${encodeURIComponent(panelUrl)}`, { method: 'PUT' });
      if (r.ok) newTarget = await r.json();
      else log(`json/new -> ${r.status}`);
    } catch (e) { log(`json/new failed: ${e}`); }
    if (!newTarget) {
      check('panel page opened', false, 'CDP /json/new failed');
      await finish(); return;
    }
    log(`panel target: ${newTarget.id} (${panelUrl})`);
    const panel = await Cdp.connect(newTarget.webSocketDebuggerUrl);
    await panel.send('Page.enable');
    await panel.send('Emulation.setDeviceMetricsOverride',
      { width: 400, height: 800, deviceScaleFactor: 2, mobile: false });
    await waitFor(async () => {
      const r = await panel.send('Runtime.evaluate', { expression: 'document.readyState', returnByValue: true });
      return r.result?.value === 'complete';
    }, 20000, 'panel load');

    const bar = await panel.send('Runtime.evaluate', { expression: `(() => {
        const b = document.getElementById('bottom-bar');
        const r = b ? b.getBoundingClientRect() : null;
        return b ? { h: r.height, w: r.width } : null;
      })()`, returnByValue: true });
    check('panel bottom bar rendered', !!(bar.result?.value?.h), JSON.stringify(bar.result?.value));

    // real GUI iframe = separate CDP target (cross-origin)
    let guiTarget = null;
    try {
      guiTarget = await waitFor(async () =>
        (await listTargets(DEBUG)).find(t => t.url.includes('127.0.0.1:3080')),
        30000, 'GUI iframe target');
    } catch { /* stays null */ }
    check('panel iframe loads real DSH GUI (:3080)', !!guiTarget, guiTarget?.url ?? 'no iframe target for :3080');

    if (guiTarget) {
      const gui = await Cdp.connect(guiTarget.webSocketDebuggerUrl);
      const dims = await gui.send('Runtime.evaluate', { expression:
        'JSON.stringify({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth })',
        returnByValue: true });
      let d = null; try { d = JSON.parse(dims.result.value); } catch { /* ignore */ }
      check('no horizontal scroll at 400px (T5.2)', !!d && d.sw <= 402, JSON.stringify(d));
      await gui.close();
    }

    await sleep(2500); // let GUI settle for the screenshot
    try {
      const shot = await panel.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(OUT, 'panel-400.png'), Buffer.from(shot.data, 'base64'));
    } catch (e) { log(`panel screenshot failed: ${e}`); }
    await panel.close();
  }

  await finish();
}

async function finish() {
  const pass = results.filter(r => r.status === 'PASS').length;
  const fail = results.filter(r => r.status === 'FAIL').length;
  const skipN = results.filter(r => r.status === 'SKIP').length;
  const report = {
    at: new Date().toISOString(),
    fixtureUrl: FIXTURE_URL,
    debug: DEBUG,
    results,
    summary: { pass, fail, skip: skipN },
  };
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify(report, null, 2));
  log(`summary: ${pass} pass, ${fail} fail, ${skipN} skip → ${path.join(OUT, 'report.json')}`);
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('[harness] fatal:', e); process.exit(2); });
