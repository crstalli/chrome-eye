// Throwaway (task E acceptance 3): Node built-in WebSocket through the
// bridge at 127.0.0.1:3081. Expects 101 (no 401/426); prints ok and exits 0.
const ws = new WebSocket('ws://127.0.0.1:3081/api/events.mux');
const timer = setTimeout(() => {
  console.log('e-ws: FAIL — no response within 5s (no 101, no 401/426)');
  process.exit(1);
}, 5000);
ws.addEventListener('open', () => {
  clearTimeout(timer);
  console.log('e-ws: ok — /api/events.mux upgraded through :3081 without 401/426');
  ws.close();
  process.exit(0);
});
ws.addEventListener('error', (e) => {
  clearTimeout(timer);
  console.log('e-ws: FAIL — error event:', e?.message ?? 'error');
  process.exit(1);
});
