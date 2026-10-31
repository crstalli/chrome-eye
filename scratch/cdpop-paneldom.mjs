const J = (url) => fetch(url, { signal: AbortSignal.timeout(5000) }).then((r) => r.json());
const targets = await J('http://127.0.0.1:9222/json');
const panel = targets.find((t) => t.type === 'page' && t.url.includes('panel.html'));
if (!panel) throw new Error('no panel target');
const ws = new WebSocket(panel.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
let id = 0; const pending = new Map();
ws.onmessage = (m) => { const msg = JSON.parse(m.data); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
function call(method, params = {}, timeoutMs = 10000) {
  return new Promise((res, rej) => {
    const mid = ++id;
    const t = setTimeout(() => { pending.delete(mid); rej(new Error('timeout: ' + method)); }, timeoutMs);
    pending.set(mid, (msg) => { clearTimeout(t); msg.error ? rej(new Error(method + ': ' + JSON.stringify(msg.error))) : res(msg.result); });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });
}
const probe = await call('Runtime.evaluate', {
  expression: "JSON.stringify({href: location.href, title: document.title, iframes: document.querySelectorAll('iframe').length, dsh: !!document.getElementById('dsh-iframe'), bodyLen: (document.body && document.body.innerHTML.length) || 0, ready: document.readyState})",
  returnByValue: true,
});
console.log('PANEL_DOM=' + probe.result.value);
ws.close();
