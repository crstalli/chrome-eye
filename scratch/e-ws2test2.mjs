// Test built-in WS through the fixed bridge
const url = 'ws://127.0.0.1:3081/api/remote.mux';
const ws = new WebSocket(url);
let opened = false;
const timeout = setTimeout(() => { console.error('timeout'); process.exit(2); }, 10000);

ws.addEventListener('open', () => {
  opened = true;
  console.log('open');
  ws.send(JSON.stringify({ type: 'open', streamId: 'smoke-1', endpoint: '$events', payload: { args: {} } }));
});
ws.addEventListener('message', (ev) => {
  const text = typeof ev.data === 'string' ? ev.data : '';
  if (!text) return;
  let parsed;
  try { parsed = JSON.parse(text); } catch { return; }
  if (parsed.type === 'item' && parsed.value?.type === 'ready') {
    console.log('READY! close=1000');
    clearTimeout(timeout);
    ws.close(1000, 'done');
  } else if (parsed.type === 'error') {
    console.error('error:', JSON.stringify(parsed.error));
  }
});
ws.addEventListener('close', (ev) => {
  console.log('close:', ev.code, ev.reason);
  clearTimeout(timeout);
  process.exit(ev.code === 1000 ? 0 : 1);
});
ws.addEventListener('error', (ev) => {
  console.error('error:', ev.message || 'unknown');
});
