// Two decisive probes:
//   M1) Is the :3081 GUI document reused across panel targets?
//       (set window.__probe in main world, close panel, open new panel, re-read)
//   M2) Does chrome.runtime.sendMessage work from the hook's ISOLATED world?
//       (find the isolated execution context, send chrome-eye:panel-state,
//        print response + lastError; also read window.__ceComposerHook)
const BASE = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ver = await (await fetch(BASE + '/json/version')).json();
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0;
const pending = new Map();
const cdp = {
  onEvent: null,
  send(method, params = {}, sessionId) {
    const id = ++seq;
    const msg = { id, method, params };
    if (sessionId) msg.sessionId = sessionId;
    ws.send(JSON.stringify(msg));
    return new Promise((res, rej) => pending.set(id, { res, rej }));
  },
  close() { ws.close(); },
};
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) {
    const p = pending.get(d.id);
    pending.delete(d.id);
    d.error ? p.rej(new Error(d.error.message)) : p.res(d.result);
  } else if (d.method && cdp.onEvent) cdp.onEvent(d);
};
const listTargets = async () => (await cdp.send('Target.getTargets')).targetInfos;
const evIn = async (sess, expr, timeout = 8000) => {
  const r = await cdp.send('Runtime.evaluate', {
    expression: expr, returnByValue: true, awaitPromise: true, timeout,
  }, sess);
  if (r.exceptionDetails) throw new Error('eval: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
};

// find extension id
const extTarget = (await listTargets()).find((t) => t.url && t.url.startsWith('chrome-extension://'));
const EXT_ID = extTarget ? extTarget.url.split('//')[1].split('/')[0] : 'mlolgaoijponghgfnlcljlohnhlpnhkd';
console.log('ext id:', EXT_ID);

// ---------- open panel #1, probe the :3081 document
const openPanel = async (label) => {
  const id = (await cdp.send('Target.createTarget', { url: 'chrome-extension://' + EXT_ID + '/panel.html' })).targetId;
  const sess = (await cdp.send('Target.attachToTarget', { targetId: id, flatten: true })).sessionId;
  await cdp.send('Runtime.enable', {}, sess);
  for (let i = 0; i < 40; i++) {
    if ((await evIn(sess, 'document.readyState').catch(() => '')) === 'complete') break;
    await sleep(500);
  }
  await sleep(1500);
  let gui = null;
  for (let i = 0; i < 20 && !gui; i++) {
    gui = (await listTargets()).find((x) => x.type === 'iframe' && x.url && x.url.indexOf('127.0.0.1:3081') !== -1) || null;
    if (!gui) await sleep(500);
  }
  const gsess = (await cdp.send('Target.attachToTarget', { targetId: gui.targetId, flatten: true })).sessionId;
  await cdp.send('Runtime.enable', {}, gsess);
  console.log(label, 'iframe target:', gui.targetId, 'url:', gui.url.slice(0, 60));
  return { id, sess, gui, gsess };
};

const p1 = await openPanel('P1');
const docInfo = async (gsess, label) => {
  const info = await evIn(gsess, `JSON.stringify({
    probe: window.__ceProbe || null,
    to: performance.timeOrigin,
    title: document.title,
    hookFlag: !!window.__ceComposerHook,
    badge: (() => {
      const b = Array.from(document.querySelectorAll('button'))
        .find((x) => /^\\d+ staged pages? — attached to your next prompt/.test(x.title || ''));
      return b ? { text: b.textContent, display: b.style.display } : null;
    })(),
  })`).catch((e) => 'ERR ' + e.message);
  console.log(label, 'doc:', info);
  return info;
};
await docInfo(p1.gsess, 'P1 doc');
// set probe + wait for hook to create a badge if armed (give polls a few s)
await evIn(p1.gsess, 'window.__ceProbe = "P1-"' + Date.now());
await sleep(3000);
await docInfo(p1.gsess, 'P1 doc after probe');

// isolated-world contexts on P1's iframe
const ctxs = [];
cdp.onEvent = (d) => {
  if (d.method === 'Runtime.executionContextCreated' && d.sessionId === p1.gsess) {
    ctxs.push(d.params.context);
  }
};
// re-attach to receive context-created for the existing contexts
await cdp.send('Target.detachFromTarget', { sessionId: p1.gsess }).catch(() => {});
const gsess2 = (await cdp.send('Target.attachToTarget', { targetId: p1.gui.targetId, flatten: true })).sessionId;
await cdp.send('Runtime.enable', {}, gsess2);
const ctxs2 = [];
cdp.onEvent = (d) => {
  if (d.method === 'Runtime.executionContextCreated' && d.sessionId === gsess2) ctxs2.push(d.params.context);
};
await sleep(2000);
console.log('P1 iframe execution contexts:', JSON.stringify(ctxs2.map((c) => ({ id: c.id, origin: c.origin, name: c.name, aux: c.auxData }))));

const isoProbe = async (gsess, ctx, label) => {
  const r = await cdp.send('Runtime.evaluate', {
    expression: `(async () => {
      const out = { hookFlag: !!window.__ceComposerHook };
      try {
        out.panelState = await new Promise((res) => {
          const t = setTimeout(() => res('TIMEOUT'), 5000);
          chrome.runtime.sendMessage({ type: 'chrome-eye:panel-state' }, (resp) => {
            clearTimeout(t);
            res({ resp: resp, err: chrome.runtime.lastError ? chrome.runtime.lastError.message : null });
          });
        });
      } catch (e) { out.panelState = 'THREW: ' + e.message; }
      return out;
    })()`,
    returnByValue: true, awaitPromise: true, uniqueContext: ctx.id, timeout: 10000,
  }, gsess);
  const v = r.exceptionDetails ? 'EVAL-ERR: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text) : r.result.value;
  console.log(label, 'iso:', v);
};
for (const c of ctxs2) await isoProbe(gsess2, c, 'ctx' + c.id);

// ---------- close panel #1, open panel #2, check probe persistence
await cdp.send('Target.closeTarget', { targetId: p1.id }).catch(() => {});
await cdp.send('Target.detachFromTarget', { sessionId: gsess2 }).catch(() => {});
await sleep(1000);
const p2 = await openPanel('P2');
await docInfo(p2.gsess, 'P2 doc (was probe P1-… kept? if yes, document reused)');
await evIn(p2.gsess, 'window.__ceProbe = "P2-"' + Date.now());

// cleanup
await cdp.send('Target.closeTarget', { targetId: p2.id }).catch(() => {});
cdp.close();
