// One-shot: (1) dump panel.js bytes around 'loading' as Chrome reads them,
// (2) toggle dropdown to open state and catch the loading codepoints.
import { listTargets, attach, sleep } from './lib-cdp.mjs';

const ts = await listTargets();
const panel = ts.find((t) => t.type === 'page' && t.url.indexOf('panel.html') !== -1);
if (!panel) throw new Error('no panel target');
const c = await attach(panel, 'probe');

const bytes = await c.evaluate(`(function(){
  return fetch(chrome.runtime.getURL('panel.js')).then(function(r){ return r.arrayBuffer(); }).then(function(buf){
    var a = new Uint8Array(buf);
    var out = [];
    for (var i = 0; i + 10 < a.length && out.length < 3; i++) {
      if (a[i]===0x6c && a[i+1]===0x6f && a[i+2]===0x61 && a[i+3]===0x64 && a[i+4]===0x69 && a[i+5]===0x6e && a[i+6]===0x67) {
        out.push('at ' + i + ': ' + Array.prototype.slice.call(a, i, i+10).map(function(x){ return x.toString(16).padStart(2,'0'); }).join(' '));
      }
    }
    return JSON.stringify({ fileLen: a.length, matches: out });
  });
})()`);
console.log('panel.js bytes as Chrome reads them:', bytes);

// ensure dropdown is CLOSED first
let hidden = JSON.parse(await c.evaluate(`JSON.stringify(document.getElementById('ws-dropdown').hasAttribute('hidden'))`));
if (!hidden) {
  await c.evaluate(`document.getElementById('ws-tree-btn').click(); 'closed'`);
  await sleep(200);
}
// open and catch the loading state
await c.evaluate(`document.getElementById('ws-tree-btn').click(); 'opened'`);
let caught = null;
for (let i = 0; i < 40; i++) {
  const r = JSON.parse(await c.evaluate(`(function(){
    var t = document.getElementById('ws-dd-status').textContent;
    return JSON.stringify({ len: t.length, codes: [...t].map(function(x){ return x.codePointAt(0).toString(16); }) });
  })()`));
  if (r.codes.join('').startsWith('6c6f6164696e67')) { caught = r; break; } // 'loading*'
  await sleep(50);
}
console.log('caught loading state:', JSON.stringify(caught));
c.close();
