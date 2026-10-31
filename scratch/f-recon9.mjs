#!/usr/bin/env node
// Diagnostic: walk the React fiber tree of the iframe root to find the app's
// session list state (byId, workspace sessionIds) — proves whether data is in memory.
const BASE = 'http://127.0.0.1:9222';
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
  send(method, params = {}, sessionId, timeoutMs = 30000) {
    const id = ++this.id;
    const e = { id, method, params };
    if (sessionId) e.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error('timeout ' + method)); }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify(e));
    });
  }
  close() { try { this.ws.close(); } catch {} }
}
const ver = await fetch(`${BASE}/json/version`, { signal: AbortSignal.timeout(3000) });
const cdp = await Cdp.connect((await ver.json()).webSocketDebuggerUrl);
await cdp.send('Target.setDiscoverTargets', { discover: true });
const t = await cdp.send('Target.getTargets');
const iframe = t.targetInfos.find((x) => x.type === 'iframe' && x.url && x.url.indexOf('3081') !== -1);
const att = await cdp.send('Target.attachToTarget', { targetId: iframe.targetId, flatten: true });
const s = att.sessionId;
await cdp.send('Runtime.enable', {}, s);
const r = await cdp.send('Runtime.evaluate', { expression: `
(function(){
  var out = { found: false };
  var root = document.getElementById('root');
  if (!root) return 'NO ROOT';
  var key = Object.keys(root).find(function(k){ return k.indexOf('__reactContainer') !== -1; });
  if (!key) return 'NO FIBER KEY';
  var fiber = root[key];
  var seen = 0, hits = [];
  function walk(f, depth) {
    if (!f || depth > 200 || seen > 60000) return;
    seen++;
    try {
      var st = f.memoizedState;
      while (st && st.memoizedState !== undefined && seen < 60000) {
        var v = st.memoizedState;
        if (v && typeof v === 'object') {
          if (v.byId && typeof v.byId === "object" && !Array.isArray(v.byId)) {
            var ids = Object.keys(v.byId); out.byIdsKeySeen = true;
            if (ids.length > 0) {
              if (!out.allByIds) out.allByIds = [];
              out.allByIds.push({ count: ids.length, firstId: ids[0].substring(0,16) });
              if (!out.found) {
              out.found = true;
              out.byIdsCount = ids.length;
              out.samples = ids.slice(0, 6).map(function(id){
                var s = v.byId[id];
                return { id: id.substring(0, 12), title: (s.title || s.displayTitle || '').substring(0, 30), blank: s.blank === true, origin: s.origin, archived: s.archived, ws: s.workspace || s.cwd || '' };
              });
              var blankCount = 0, visibleNonBlank = 0;
              for (var i = 0; i < ids.length; i++) {
                var ss = v.byId[ids[i]];
                if (ss.blank) blankCount++;
                else visibleNonBlank++;
              }
              out.blankCount = blankCount;
              out.visibleNonBlank = visibleNonBlank;
              }
            }
          }
          if (v.workspaces && Array.isArray(v.workspaces) && !out.workspaces) {
            out.workspaces = v.workspaces.map(function(w){ return { id: (w.workspaceId || '').substring(0, 12), title: w.title, sessionIds: (w.sessionIds || []).length }; });
          }
          if (v.ids && Array.isArray(v.ids) && v.byId) { /* same as above */ }
        }
        st = st.next;
      }
      // hooks stored in memoizedProps are rare; check child/sibling
      if (f.child) walk(f.child, depth + 1);
      if (f.sibling) walk(f.sibling, depth);
    } catch (e) { if (!out.walkErr) out.walkErr = e.message; }
  }
  walk(fiber, 0);
  out.nodesSeen = seen; out.byIdsKeySeen = !!out.byIdsKeySeen;
  return out;
})()
`, returnByValue: true }, s, 30000);
console.log(JSON.stringify(r.result.value, null, 1));
cdp.close();
process.exit(0);
