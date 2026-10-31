#!/usr/bin/env node
// Focused repro: why did the FIRST "#stage-row" click not open the
// dropdown? Sample the dropdown state at 50 ms and log every relevant
// document/window event with a stack snippet for 4 seconds after click.
const BASE = 'http://127.0.0.1:9222';
const EXT_ID = 'mlolgaoijponghgfnlcljlohnhlpnhkd';

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    const cdp = new Cdp(ws);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
    ws.onmessage = (m) => {
      let msg; try { msg = JSON.parse(typeof m.data === 'string' ? m.data : m.data.toString()); } catch { return; }
      if (msg.id && cdp.pending.has(msg.id)) {
        const p = cdp.pending.get(msg.id); clearTimeout(p.timer); cdp.pending.delete(msg.id);
        msg.error ? p.reject(new Error('CDP ' + msg.error.message)) : p.resolve(msg.result);
      }
    };
    return cdp;
  }
  send(method, params = {}, sessionId, timeoutMs = 30000) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('timeout ' + method)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(payload));
    });
  }
  close() { try { this.ws.close(); } catch {} }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ver = await (await fetch(BASE + '/json/version')).json();
const cdp = await Cdp.connect(ver.webSocketDebuggerUrl);
const evIn = (sess, expr, timeoutMs = 30000) => cdp.send('Runtime.evaluate',
  { expression: expr, returnByValue: true, awaitPromise: true }, sess, timeoutMs)
  .then((r) => (r.exceptionDetails
    ? { __exception: (r.exceptionDetails.exception && r.exceptionDetails.exception.description) || 'exception' }
    : r.result.value));

const panelTarget = (await cdp.send('Target.createTarget', { url: 'chrome-extension://' + EXT_ID + '/panel.html' })).targetId;
const panelSess = (await cdp.send('Target.attachToTarget', { targetId: panelTarget, flatten: true })).sessionId;
await cdp.send('Runtime.enable', {}, panelSess);
for (let i = 0; i < 40 && (await evIn(panelSess, 'document.readyState').catch(() => '')) !== 'complete'; i++) await sleep(500);

// instrument BEFORE the click
await evIn(panelSess, `
  window.__trace = [];
  const t0 = performance.now();
  const log = (kind, extra) => window.__trace.push({ ms: Math.round(performance.now() - t0), kind, extra: extra || null });
  window.__t0 = t0;
  ['mousedown', 'mouseup', 'click', 'keydown'].forEach((k) =>
    document.addEventListener(k, (e) => log(k, (e.target && (e.target.id || e.target.tagName)) || String(e.target)), true));
  window.addEventListener('blur', () => log('window-blur'), true);
  window.addEventListener('focus', () => log('window-focus'), true);
  // spy on the dropdown's hidden attribute changes
  const dd = document.querySelector('#ts-dropdown');
  new MutationObserver((muts) => {
    muts.forEach((m) => log('dd-attr:' + m.attributeName, dd.hasAttribute('hidden') ? 'hidden' : 'visible'));
  }).observe(dd, { attributes: true, attributeFilter: ['hidden'] });
  'instrumented'
`);

const sample = `(() => {
  const dd = document.querySelector('#ts-dropdown');
  return { hidden: dd.hasAttribute('hidden'), rows: document.querySelector('#ts-dd-body') ? document.querySelector('#ts-dd-body').children.length : -1,
           status: (document.querySelector('#ts-dd-status') || {}).textContent || null };
})()`;

console.log('state before click:', JSON.stringify(await evIn(panelSess, sample)));
console.log('clicking #stage-row ...');
await evIn(panelSess, `document.querySelector('#stage-row').click(); true`);

const samples = [];
for (let i = 0; i < 80; i++) {
  samples.push({ ms: i * 50, ...(await evIn(panelSess, sample).catch(() => ({ err: 1 }))) });
  await sleep(50);
}
const trace = await evIn(panelSess, `window.__trace`);
console.log('event trace:', JSON.stringify(trace, null, 1));
// compact samples: only transitions
let prev = '';
for (const s of samples) {
  const key = s.hidden + '|' + s.rows + '|' + (s.status || '');
  if (key !== prev) { console.log('  t+' + s.ms + 'ms:', JSON.stringify(s)); prev = key; }
}
await cdp.send('Target.closeTarget', { targetId: panelTarget }).catch(() => {});
cdp.close();
