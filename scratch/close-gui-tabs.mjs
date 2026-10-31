import { listTargets } from './lib-cdp.mjs';
const ts = await listTargets();
let closed = 0;
for (const t of ts) {
  if (t.type === 'page' && t.url === 'http://127.0.0.1:3080/') {
    const r = await fetch('http://127.0.0.1:9222/json/close/' + t.id, { signal: AbortSignal.timeout(4000) });
    console.log('closed', t.id, '->', (await r.text()).trim());
    closed++;
  }
}
console.log('closed=' + closed, 'remaining pages:', (await listTargets()).filter(t => t.type === 'page').map(t => t.url));
