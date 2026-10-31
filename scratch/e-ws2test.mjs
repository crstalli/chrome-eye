// Direct test of the BUILT-IN WebSocket client against the bridge:
// start bridge, connect, send a $events open, expect a ready item.
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const child = spawn('node', ['bridge/bridge.mjs'], {
  cwd: '/mnt/f/ai/chrome-eye',
  stdio: ['ignore', 'pipe', 'pipe'],
});
let log = '';
child.stdout.on('data', (c) => { log += c; process.stdout.write('[bridge] ' + c); });
child.stderr.on('data', (c) => { log += c; process.stdout.write('[bridge!] ' + c); });

// wait for listening
for (let i = 0; i < 50; i++) {
  if (log.includes('listening')) break;
  await sleep(100);
}

const ws = new WebSocket('ws://127.0.0.1:3081/api/remote.mux');
let opened = false;
const done = (code, msg) => {
  console.log('RESULT:', code, msg);
  child.kill();
  process.exit(code === 0 ? 0 : 1);
};
const overall = setTimeout(() => done(2, 'timeout'), 10000);

ws.addEventListener('message', (ev) => {
  try {
    const parsed = JSON.parse(typeof ev.data === 'string' ? ev.data : '');
    console.log('GOT:', JSON.stringify(parsed).slice(0, 200));
    if (parsed.type === 'item' && parsed.value?.type === 'ready') {
      clearTimeout(overall);
      ws.close(1000, 'ok');
    }
  } catch {}
});
ws.addEventListener('open', () => {
  opened = true;
  console.log('OPEN');
  ws.send(JSON.stringify({ type: 'open', streamId: 'smoke-1', endpoint: '$events', payload: { args: {} } }));
  console.log('SENT open');
});
ws.addEventListener('close', (ev) => {
  clearTimeout(overall);
  console.log('CLOSED code=', ev.code, 'reason=', ev.reason, 'opened=', opened);
  done(ev.code === 1000 && opened ? 0 : 1, `code=${ev.code}`);
});
ws.addEventListener('error', (ev) => { console.log('ERROR', ev.message); });
setTimeout(() => { child.kill(); process.exit(3); }, 15000);
