#!/usr/bin/env node
const BASE = 'http://127.0.0.1:9222';
const EXT_ID = 'mlolgaoijponghgfnlcljlohnhlpnhkd';
const targets = await (await fetch(BASE + '/json')).json();
console.log('targets:');
for (const t of targets) console.log(' ', t.type, t.id, t.url.slice(0, 90), t.webSocketDebuggerUrl ? 'WS-yes' : 'WS-no');
