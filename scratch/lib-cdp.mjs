// Zero-dep raw-CDP helpers (Node 24 globals: fetch, WebSocket).
// Sequential use only; every HTTP fetch has a timeout; every CDP call has a timeout.
// Used by test-panel-only.mjs / test-real-tab.mjs / test-nocookie.mjs.

export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const CDP_HTTP = 'http://127.0.0.1:9222';

export async function cdpFetchJson(url, timeoutMs = 4000) {
  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  return res.json();
}

export function listTargets() { return cdpFetchJson(CDP_HTTP + '/json/list'); }

export async function waitForTarget(pred, timeoutMs = 20000, label = 'target', intervalMs = 400) {
  const t0 = Date.now();
  for (;;) {
    let ts = null;
    try { ts = await listTargets(); } catch { ts = null; }
    if (ts) {
      const hit = ts.find(pred);
      if (hit) return hit;
    }
    if (Date.now() - t0 > timeoutMs) throw new Error('timeout waiting for ' + label);
    await sleep(intervalMs);
  }
}

export class Cdp {
  constructor(wsUrl, label) {
    this.wsUrl = wsUrl;
    this.label = label || 'cdp';
    this.seq = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.ws = new WebSocket(wsUrl);
  }
  ready() {
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error(this.label + ': ws connect timeout')), 6000);
      this.ws.addEventListener('open', () => { clearTimeout(to); resolve(); }, { once: true });
      this.ws.addEventListener('error', () => { clearTimeout(to); reject(new Error(this.label + ': ws connect error')); }, { once: true });
      this.ws.addEventListener('message', (ev) => {
        let m;
        try { m = JSON.parse(ev.data); } catch { return; }
        if (m.id != null && this.pending.has(m.id)) {
          const p = this.pending.get(m.id);
          this.pending.delete(m.id);
          if (m.error) p.reject(new Error(this.label + ': ' + m.error.message));
          else p.resolve(m.result);
        } else if (m.method && this.handlers.has(m.method)) {
          for (const h of this.handlers.get(m.method)) h(m.params, m);
        }
      });
    });
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(this.label + ': timeout on ' + method));
        }
      }, 20000);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(to); resolve(v); },
        reject: (e) => { clearTimeout(to); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(method, cb) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(cb);
  }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails.exception && r.exceptionDetails.exception.description;
      throw new Error(this.label + ': evaluate exception: ' + (d || r.exceptionDetails.text));
    }
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

export async function attach(target, label) {
  const c = new Cdp(target.webSocketDebuggerUrl, label || target.type + '@' + String(target.id).slice(0, 8));
  await c.ready();
  return c;
}

// Console capture. `markers()` returns events carrying the content.js
// injection marker 'Chrome Eye content script active'.
export function makeConsoleSink() {
  const arr = [];
  function hook(cdp) {
    cdp.on('Runtime.consoleAPICalled', (ev) => {
      const text = (ev.args || [])
        .map((a) => (a.value != null ? String(a.value) : a.description || a.type || ''))
        .join(' ');
      arr.push({ t: Date.now(), type: ev.type, text });
    });
  }
  return {
    arr,
    hook,
    markers: () => arr.filter((e) => e.text.indexOf('Chrome Eye content script active') !== -1),
  };
}

// Panel tree dropdown state (panel.js DOM ids).
export const TREE_STATE_EXPR = `(function () {
  var dd = document.getElementById('ws-dropdown');
  var st = document.getElementById('ws-dd-status');
  var body = document.getElementById('ws-dd-body');
  return JSON.stringify({
    hidden: dd ? dd.hasAttribute('hidden') : 'no-dd',
    status: st ? st.textContent : '',
    statusColor: st ? getComputedStyle(st).color : '',
    body: body ? body.innerText : ''
  });
})()`;

// Panel bottom-bar share/status span.
export const SHARE_STATUS_EXPR = `(function () {
  var s = document.getElementById('share-status');
  if (!s) return JSON.stringify({ text: '', color: '' });
  return JSON.stringify({ text: s.textContent, color: getComputedStyle(s).color });
})()`;

// Poll until the panel tree dropdown has settled (open, not 'loading…').
export async function waitTreeSettled(cPanel, timeoutMs = 12000) {
  const t0 = Date.now();
  for (;;) {
    const s = JSON.parse(await cPanel.evaluate(TREE_STATE_EXPR));
    if (s.hidden !== true && s.status !== '' && s.status.indexOf('loading') !== 0) return s;
    if (Date.now() - t0 > timeoutMs) throw new Error('tree dropdown did not settle; last: ' + JSON.stringify(s));
    await sleep(400);
  }
}
