import { readFileSync } from 'node:fs';
import { listTargets, attach, sleep } from './lib-cdp.mjs';
const list = await listTargets();
const t = list.find((x) => x.type === 'page' && x.url === 'http://127.0.0.1:3080/');
if (!t) { console.log('no :3080 tab'); process.exit(0); }
const c = await attach(t, 'real');
await c.send('Runtime.enable');
const r = JSON.parse(await c.evaluate(`JSON.stringify({
  w: window.innerWidth,
  groups: document.querySelectorAll('[class*="_groupSection"]').length,
  projRows: document.querySelectorAll('[class*="_projectRow"]').length,
  sessRows: document.querySelectorAll('[class*="_sessionRow"]').length,
  searchRows: document.querySelectorAll('[class*="_searchResultRow"]').length,
  bodyLen: document.body ? document.body.innerText.length : -1,
  bodyHead: document.body ? document.body.innerText.slice(0, 300) : ''
})`));
console.log(JSON.stringify(r, null, 1));
c.close();
