import { readFileSync } from 'node:fs';
import { createHash, createHmac } from 'node:crypto';
const text = readFileSync('/home/cztl/.dsh/.credentials.yaml', 'utf8');
const m = text.match(/secret:\s*(\S+)/);
const secret = Buffer.from(m[1].replaceAll('-', '+').replaceAll('_', '/'), 'base64');
const b64url = (b) => Buffer.from(b).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
function mint(authority) {
  const name = 'dsh-auth-' + b64url(createHash('sha256').update(authority).digest());
  const issuedAt = Date.now();
  const body = b64url(JSON.stringify({ version: 1, authority, issuedAt, expiresAt: issuedAt + 30 * 86400000 }));
  const sig = b64url(createHmac('sha256', secret).update(body).digest());
  return `${name}=${'v1.' + body + '.' + sig}`;
}
const cookie = mint('127.0.0.1:3080');
const head = await fetch('http://127.0.0.1:3080/', { headers: { cookie } }).then(r => r.text());
const urls = [...head.matchAll(/<script[^>]*src="([^"]+)"/g)].map(x => x[1].replace(/&amp;/g, '&'));
for (const u of urls) {
  const r = await fetch('http://127.0.0.1:3080/' + u.replace(/^\.\//, ''), { headers: { cookie } });
  const js = await r.text();
  // the loader registers plugin modules: find the plugin script URL
  if (u.includes('client.js')) {
    // this file contains module loader + registration payloads? search for .js references
    const refs = [...js.matchAll(/["']([^"']*\.js(?:\?[^"']*)?)["']/g)].map(x => x[1]).filter((v, i, a) => a.indexOf(v) === i);
    console.log('plugin client.js refs:', refs.slice(0, 5));
  }
}
// The HTML itself had the big ?? plugin URL. Fetch it.
const bigUrl = (head.match(/<script[^>]*src="([^"]*plugins\/\?\?[^"]*)"/) || [])[1]?.replace(/&amp;/g, '&');
if (bigUrl) {
  const r = await fetch('http://127.0.0.1:3080/' + bigUrl, { headers: { cookie } });
  const js = await r.text();
  console.log('big bundle len:', js.length);
  const hits = {
    mux: [...new Set(js.match(/events\.[a-z]+/g) || [])].slice(0, 10),
    newWS: (js.match(/new WebSocket\([^)]{0,150}/g) || []).slice(0, 6),
    wsProto: (js.match(/["'`](?:wss?|https?):\/\/["'`]/g) || []).slice(0, 4),
    locHost: (js.match(/(?:window\.location|location)\.(?:host|origin|protocol|port)/g) || []).filter((v, i, a) => a.indexOf(v) === i).slice(0, 10),
    apiMux: (js.match(/["'`][^"'`]*events[^"'`]{0,40}["'`]/g) || []).filter((v, i, a) => a.indexOf(v) === i).slice(0, 10),
  };
  console.log(JSON.stringify(hits, null, 1));
  // context around 'WebSocket'
  const idxs = [];
  let i = js.indexOf('WebSocket');
  while (i !== -1 && idxs.length < 5) { idxs.push(i); i = js.indexOf('WebSocket', i + 9); }
  for (const i of idxs) console.log('WS ctx:', js.slice(Math.max(0, i - 160), i + 160).replace(/\n/g, ' '));
}
