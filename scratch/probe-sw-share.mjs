// Probe: what CDP events does a SW-target get for a fetch to :3081/share?
// Attaches to the live extension SW, enables Runtime+Network, then triggers
// the share POST from inside the SW itself (chrome.tabs.captureViewportScreenshot-free:
// direct fetch from SW scope). Records every event name seen.
import { readFileSync } from 'node:fs';
import { listTargets, attach, sleep } from './lib-cdp.mjs';

const extId = readFileSync(new URL('./ext-id.txt', import.meta.url), 'utf8').trim();
const list = await listTargets();
const sw = list.find((t) => t.type === 'service_worker' && t.url.indexOf('chrome-extension://' + extId) !== -1);
if (!sw) { console.log('no SW target; SW idle'); process.exit(0); }
const c = await attach(sw, 'probe-sw');
const events = [];
for (const m of ['Network.requestWillBeSent', 'Network.responseReceived', 'Network.loadingFailed',
  'Runtime.consoleAPICalled', 'Page.frameNavigated', 'Network.eventSourceWillBeRemoved']) {
  c.on(m, (p) => events.push({ ev: m, summary: JSON.stringify(p).slice(0, 200) }));
}
await c.send('Runtime.enable');
await c.send('Network.enable');
await sleep(300);

// Trigger the same fetch sw.js postShare does, but a minimal one:
const out = await c.evaluate(`(async () => {
  try {
    const r = await fetch('http://127.0.0.1:3081/share', { method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url: 'http://127.0.0.1:3081/health', title: 'probe', visibleText: 'probe-body', links: [], headings: [], sessionId: 'probe-' + Date.now() }) });
    const text = await r.text();
    console.log('Chrome Eye probe-share status', r.status);
    console.log('Chrome Eye probe-share body', text.slice(0, 300));
    return 'status=' + r.status + ' len=' + text.length;
  } catch (e) { return 'FETCH-ERR ' + e.message; }
})()`);
console.log('fetch result:', out);
await sleep(2500);
console.log('events seen:');
for (const e of events) console.log('  ' + e.ev + ' ' + e.summary);
c.close();
