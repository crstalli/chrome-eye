// scratch/diag-popover.mjs — live probe: does clicking the 🗁 badge in the
// GUI iframe actually open the hook popover? Dumps every styled div after
// the click. Run: node scratch/diag-popover.mjs
const BASE = 'http://127.0.0.1:9222';
const EXT_ID = 'mlolgaoijponghgfnlcljlohnhlpnhkd';
const ver = await (await fetch(BASE + '/json/version')).json();
const ws = new WebSocket(ver.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0; const pend = new Map();
const send = (m, p = {}, s) => {
  const id = ++seq; const msg = { id, method: m, params: p }; if (s) msg.sessionId = s;
  ws.send(JSON.stringify(msg));
  return new Promise((res, rej) => pend.set(id, { res, rej }));
};
ws.onmessage = (e) => {
  const d = JSON.parse(e.data);
  if (d.id && pend.has(d.id)) { const p = pend.get(d.id); pend.delete(d.id); d.error ? p.rej(new Error(d.error.message)) : p.res(d.result); }
};
const evIn = (s, expr, ms = 8000) => send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, timeout: ms }, s)
  .then((r) => { if (r.exceptionDetails) throw new Error(r.exceptionDetails.text + ' ' + JSON.stringify(r.exceptionDetails.exception || {}).slice(0, 200)); return r.result.value; });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const listTargets = () => send('Target.getTargets').then((r) => r.targetInfos);

const pageTarget = (await send('Target.createTarget', { url: 'https://example.com/' })).targetId;
const pageSess = (await send('Target.attachToTarget', { targetId: pageTarget, flatten: true })).sessionId;
for (let i = 0; i < 30 && (await evIn(pageSess, 'document.readyState').catch(() => '')) !== 'complete'; i++) await sleep(500);

const panelTarget = (await send('Target.createTarget', { url: 'chrome-extension://' + EXT_ID + '/panel.html' })).targetId;
const panelSess = (await send('Target.attachToTarget', { targetId: panelTarget, flatten: true })).sessionId;
await send('Runtime.enable', {}, panelSess);
for (let i = 0; i < 30 && (await evIn(panelSess, 'document.readyState').catch(() => '')) !== 'complete'; i++) await sleep(500);
await evIn(panelSess, `chrome.runtime.sendMessage({type:'chrome-eye:panel-state'}).then(()=>1).catch(()=>0)`, 5000).catch(() => {});

let swTarget = null;
for (let i = 0; i < 20 && !swTarget; i++) {
  swTarget = (await listTargets()).find((t) => t.type === 'service_worker') || null;
  if (!swTarget) {
    // nudge the SW awake again while we wait
    await evIn(panelSess, `chrome.runtime.sendMessage({type:'chrome-eye:panel-state'}).then(()=>1).catch(()=>0)`, 5000).catch(() => {});
    await sleep(500);
  }
}
const swSess = (await send('Target.attachToTarget', { targetId: swTarget.targetId, flatten: true })).sessionId;
await send('Runtime.enable', {}, swSess);
const tabs = await evIn(swSess, 'chrome.tabs.query({url:"https://example.com/*"}).then(ts=>JSON.stringify(ts.map(t=>({id:t.id,url:t.url}))))');
console.log('SW tabs:', tabs);
const tid = JSON.parse(tabs)[0].id;
const stg = await evIn(panelSess, `new Promise((res,rej)=>chrome.runtime.sendMessage({type:'chrome-eye:stage-tab',tabId:${tid}},(r)=>chrome.runtime.lastError?rej(new Error(chrome.runtime.lastError.message)):res(r)))`);
console.log('stage:', JSON.stringify(stg));

let gui = null;
for (let i = 0; i < 20 && !gui; i++) {
  gui = (await listTargets()).find((x) => x.type === 'iframe' && x.url && x.url.indexOf('127.0.0.1:3081') !== -1 && x.parentId === panelTarget) || null;
  if (!gui) await sleep(500);
}
const iframeSess = (await send('Target.attachToTarget', { targetId: gui.targetId, flatten: true })).sessionId;
await send('Runtime.enable', {}, iframeSess);
let badgeSeen = false;
for (let i = 0; i < 16 && !badgeSeen; i++) {
  badgeSeen = await evIn(iframeSess, `Array.from(document.querySelectorAll('button')).some(x=>/staged page/.test(x.title||''))`).catch(() => false);
  if (!badgeSeen) await sleep(500);
}
console.log('badge seen:', badgeSeen);

const clickRes = await evIn(iframeSess, `new Promise((res)=>{
  const b=Array.from(document.querySelectorAll('button')).find(x=>/^\\d+ staged pages? — attached/.test(x.title||''));
  if(!b){res({err:'no badge'});return;}
  b.click();
  setTimeout(()=>{
    const divs=Array.from(document.querySelectorAll('div')).map(d=>({w:d.style.width,z:d.style.zIndex,display:d.style.display,css:d.style.cssText.slice(0,120)})).filter(d=>d.w||d.z);
    res({clicked:true,styledDivs:divs});
  },500);
})`);
console.log('after click:', JSON.stringify(clickRes, null, 1).slice(0, 1500));

// try the property-based query the fixed E2E would use
const popRes = await evIn(iframeSess, `(() => {
  const p = Array.from(document.querySelectorAll('div')).find((d) => d.style.width === '340px' && d.style.zIndex === '2147483001');
  return p ? { found: true, display: p.style.display, text: (p.textContent || '').slice(0, 80) } : { found: false };
})()`);
console.log('property-based popQuery:', JSON.stringify(popRes));

await send('Target.closeTarget', { targetId: pageTarget }).catch(() => {});
await send('Target.closeTarget', { targetId: panelTarget }).catch(() => {});
ws.close();
