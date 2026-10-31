// CDP-OP: read-only tab list + SW staged-state read. No persistent new tabs.
const J = (url) => fetch(url, { signal: AbortSignal.timeout(5000) }).then((r) => r.json());
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const EXT = 'mlolgaoijponghgfnlcljlohnhlpnhkd';
const STAGE_EXPR = "JSON.stringify({n: stagedTabs.length, tabs: stagedTabs.map(function(t){return {tabId: t.id, url: t.url, title: t.title};})})";

function connect(wsUrl) {
  return new Promise((res, rej) => {
    const ws = new WebSocket(wsUrl);
    const t = setTimeout(() => rej(new Error('ws connect timeout')), 10000);
    ws.onopen = () => { clearTimeout(t); res(ws); };
    ws.onerror = () => { clearTimeout(t); rej(new Error('ws error')); };
  });
}
function makeRpc(ws) {
  let id = 0; const pending = new Map();
  ws.onmessage = (m) => { const msg = JSON.parse(typeof m.data === 'string' ? m.data : m.data.toString()); if (msg.id && pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); } };
  return {
    call(method, params = {}, sessionId, timeoutMs = 12000) {
      return new Promise((res, rej) => {
        const mid = ++id;
        const t = setTimeout(() => { pending.delete(mid); rej(new Error(`timeout: ${method}`)); }, timeoutMs);
        const p = { id: mid, method, params };
        if (sessionId) p.sessionId = sessionId;
        pending.set(mid, (msg) => { clearTimeout(t); msg.error ? rej(new Error(`${method}: ${JSON.stringify(msg.error)}`)) : res(msg.result); });
        ws.send(JSON.stringify(p));
      });
    },
    close: () => ws.close(),
  };
}

// --- 1) List all page tabs ---
const targets = await J('http://127.0.0.1:9222/json');
const pages = targets.filter((t) => t.type === 'page');
console.log('PAGES=' + JSON.stringify(pages.map((t) => ({ id: t.id, title: t.title, url: t.url }))));

// --- 2) SW staged state ---
let sw = targets.find((t) => t.type === 'service_worker' && t.url.includes(EXT));
let stageResult = null;
const cleanup = [];

if (sw) {
  const rpc = makeRpc(await connect(sw.webSocketDebuggerUrl));
  const r = await rpc.call('Runtime.evaluate', { expression: STAGE_EXPR, returnByValue: true });
  stageResult = r.result.value;
  rpc.close();
  console.log('WAKE=not-needed(sw-alive)');
} else {
  // Try nudging from the pre-existing (broken) panel tab first — no new tab.
  const oldPanel = targets.find((t) => t.type === 'page' && t.url.includes('panel.html'));
  let nudged = false;
  if (oldPanel) {
    const rpc = makeRpc(await connect(oldPanel.webSocketDebuggerUrl));
    try {
      const probe = await rpc.call('Runtime.evaluate', { expression: "typeof chrome !== 'undefined' && typeof chrome.runtime !== 'undefined' && typeof chrome.runtime.sendMessage === 'function' ? 1 : 0", returnByValue: true }, undefined, 8000);
      if (probe.result.value === 1) {
        for (let i = 0; i < 60 && !nudged; i++) {
          try {
            await rpc.call('Runtime.evaluate', { expression: "chrome.runtime.sendMessage({type:'chrome-eye:panel-state'}).then(()=>1).catch(()=>0)", awaitPromise: true }, undefined, 6000);
          } catch (e) { /* keep trying */ }
          const tg = await J('http://127.0.0.1:9222/json');
          sw = tg.find((t) => t.type === 'service_worker' && t.url.includes(EXT));
          if (sw) nudged = true;
          if (!nudged) await sleep(500);
        }
        console.log('WAKE=nudge-old-panel');
      }
    } finally { rpc.close(); }
  }

  // Fallback: the recipe's ephemeral panel page (closed immediately after).
  if (!nudged) {
    const ver = await J('http://127.0.0.1:9222/json/version');
    const br = makeRpc(await connect(ver.webSocketDebuggerUrl));
    const created = await br.call('Target.createTarget', { url: `chrome-extension://${EXT}/panel.html` });
    const myId = created.targetId;
    cleanup.push(async () => { try { await br.call('Target.closeTarget', { targetId: myId }); } catch (e) {} });
    console.log('EPHEMERAL_PANEL=' + myId);
    for (let i = 0; i < 60 && !sw; i++) {
      // nudge via the ephemeral panel page
      const t = (await J('http://127.0.0.1:9222/json')).find((x) => x.id === myId);
      if (t && t.webSocketDebuggerUrl) {
        const pr = makeRpc(await connect(t.webSocketDebuggerUrl));
        try {
          await pr.call('Runtime.evaluate', { expression: "chrome.runtime.sendMessage({type:'chrome-eye:panel-state'}).then(()=>1).catch(()=>0)", awaitPromise: true }, undefined, 6000);
        } catch (e) { /* not ready yet */ }
        pr.close();
      }
      const tg = (await J('http://127.0.0.1:9222/json'));
      sw = tg.find((x) => x.type === 'service_worker' && x.url.includes(EXT));
      if (!sw) await sleep(500);
    }
    if (!sw) { for (const c of cleanup) await c(); br.close(); throw new Error('SW did not appear within 30s'); }
    console.log('WAKE=ephemeral-panel-recipe');
    for (const c of cleanup) await c();
    cleanup.length = 0;
    br.close();
  }

  const rpc = makeRpc(await connect(sw.webSocketDebuggerUrl));
  const r = await rpc.call('Runtime.evaluate', { expression: STAGE_EXPR, returnByValue: true });
  stageResult = r.result.value;
  rpc.close();
}
console.log('STAGED=' + stageResult);
console.log('DONE');
