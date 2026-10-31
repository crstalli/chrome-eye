// Probe SW liveness from the options page (extension page main world).
import http from 'node:http';
function jget(path) {
  return new Promise((res, rej) => {
    http.get('http://127.0.0.1:9222' + path, (r) => {
      let d = '';
      r.on('data', (c) => { d += c; });
      r.on('end', () => { try { res(JSON.parse(d)); } catch (e) { rej(e); } });
    }).on('error', rej);
  });
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const inst = new Cdp(ws);
      const t = setTimeout(() => reject(new Error('ws timeout')), 8000);
      ws.onopen = () => { clearTimeout(t); resolve(inst); };
      ws.onerror = () => { clearTimeout(t); reject(new Error('ws error')); };
      ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.id && inst.pending.has(m.id)) {
          const p = inst.pending.get(m.id); inst.pending.delete(m.id);
          m.error ? p.reject(new Error(m.error.message)) : p.resolve(m.result);
        }
      };
    });
  }
  send(method, params = {}, timeoutMs = 15000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => { this.pending.delete(id); reject(new Error('timeout ' + method)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, t });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() { try { this.ws.close(); } catch (e) {} }
}
(async () => {
  const ts = await jget('/json/list');
  const opt = ts.find((t) => t.url.includes('options.html'));
  if (!opt) throw new Error('no options tab');
  const c = await Cdp.connect(opt.webSocketDebuggerUrl);
  await c.send('Runtime.enable');
  const r = await c.send('Runtime.evaluate', {
    expression: `(function(){return new Promise(function(resolve){
      try {
        chrome.runtime.sendMessage({type:'chrome-eye:panel-state'},function(resp){
          resolve('RESP:' + JSON.stringify(resp));
        });
        setTimeout(function(){ resolve('TIMEOUT-no-response (SW dead?)'); },6000);
      } catch(e) { resolve('ERR:' + e.message); }
    })})()`,
    returnByValue: true, awaitPromise: true, timeout: 15000
  });
  console.log('panel-state from options page:', r.result && r.result.value);
  if (r.exceptionDetails) console.log('exception:', JSON.stringify(r.exceptionDetails).slice(0, 400));
  c.close();
  await sleep(800);
  const ts2 = await jget('/json/list');
  console.log('SW targets now:', ts2.filter((t) => t.type === 'service_worker').map((t) => t.url).join(' | ') || 'NONE');
  process.exit(0);
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
