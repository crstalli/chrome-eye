#!/usr/bin/env node
// Diagnostic recon: inspect the live 3081 iframe sidebar state.
import fs from 'node:fs';
const BASE = 'http://127.0.0.1:9222';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    const cdp = new Cdp(ws);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); });
    ws.onmessage = (m) => {
      let msg; try { msg = JSON.parse(typeof m.data === 'string' ? m.data : m.data.toString()); } catch { return; }
      if (msg.id && cdp.pending.has(msg.id)) {
        const p = cdp.pending.get(msg.id);
        clearTimeout(p.timer); cdp.pending.delete(msg.id);
        msg.error ? p.reject(new Error('CDP ' + msg.error.message)) : p.resolve(msg.result);
      }
    };
    return cdp;
  }
  send(method, params = {}, sessionId, timeoutMs = 15000) {
    const id = ++this.id;
    const envelope = { id, method, params };
    if (sessionId) envelope.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('timeout ' + method)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(envelope));
    });
  }
  close() { try { this.ws.close(); } catch {} }
}
async function browserWs() {
  const r = await fetch(`${BASE}/json/version`, { signal: AbortSignal.timeout(3000) });
  return (await r.json()).webSocketDebuggerUrl;
}
const cdp = await Cdp.connect(await browserWs());
await cdp.send('Target.setDiscoverTargets', { discover: true });
const t = await cdp.send('Target.getTargets');
const panel = t.targetInfos.find((x) => x.type === 'page' && x.url && x.url.indexOf('panel.html') !== -1);
const iframe = t.targetInfos.find((x) => x.type === 'iframe' && x.url && x.url.indexOf('3081') !== -1);
console.log('panel:', panel && panel.url);
console.log('iframe:', iframe && iframe.url);
if (!iframe) { console.log('NO IFRAME'); process.exit(1); }
const att = await cdp.send('Target.attachToTarget', { targetId: iframe.targetId, flatten: true });
const s = att.sessionId;
await cdp.send('Runtime.enable', {}, s);
const ev = async (expr, timeoutMs = 15000) => {
  const r = await cdp.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, s, timeoutMs);
  if (r.exceptionDetails) throw new Error('eval exc: ' + (r.exceptionDetails.exception?.description || r.exceptionDetails.text));
  return r.result.value;
};
const info = await ev(`(function(){
  var count = function(sel){ return document.querySelectorAll(sel).length; };
  var groups = document.querySelectorAll('[class*="_groupSection"]');
  var groupInfo = [];
  for (var i = 0; i < groups.length; i++) {
    var g = groups[i];
    var pr = g.querySelector('[class*="_projectRow"]');
    var nameEl = pr ? pr.querySelector('[class*="_projectText"] [class*="_title"]') : null;
    groupInfo.push({
      name: nameEl ? nameEl.textContent.trim() : '(no projectRow name)',
      ariaExpanded: pr ? pr.getAttribute('aria-expanded') : '(no projectRow)',
      rows: g.querySelectorAll('[class*="_sessionRow"]').length,
      overflowBtn: !!g.querySelector('[class*="_sessionOverflowButton"]')
    });
  }
  var cur = '';
  try { cur = localStorage.getItem('dsh.sessions.current') || '(null)'; } catch(e) { cur = 'ERR ' + e.message; }
  return {
    title: document.title,
    bodyLen: document.body ? document.body.innerText.length : -1,
    groupSections: groups.length,
    flatSessionRows: count('[class*="_sessionRow"]'),
    searchResultRows: count('[class*="_searchResultRow"]'),
    centerCol: !!document.querySelector('[class*="_centerCol"]'),
    groups: groupInfo,
    dshCurrent: cur.substring(0, 200)
  };
})()`);
console.log(JSON.stringify(info, null, 2));
cdp.close();
process.exit(0);
