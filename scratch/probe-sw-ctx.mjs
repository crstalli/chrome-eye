// Probe: how many execution contexts does the MV3 service_worker CDP target
// have, and where does a contextless Runtime.evaluate land? Run while the
// test Chrome is alive. Repeats 3 rounds x 2s.
import { listTargets, attach, sleep } from './lib-cdp.mjs';

const CANARY = `JSON.stringify({
  tGui: (function(){ try { return typeof guiSessionId; } catch(e){ return 'ERR'; } })(),
  gui: (function(){ try { return (typeof guiSessionId !== 'undefined') ? guiSessionId : 'INVISIBLE'; } catch(e){ return 'ERR'; } })(),
  tEnd: (function(){ try { return typeof SHARE_ENDPOINT; } catch(e){ return 'ERR'; } })(),
  selfChrome: (typeof self.chrome !== 'undefined'),
  probe: (typeof self.__probe !== 'undefined') ? self.__probe : 'NO-PROBE'
})`;

for (let round = 0; round < 3; round++) {
  const list = await listTargets();
  const sw = list.find((t) => t.type === 'service_worker');
  if (!sw) { console.log('round' + round + ': no SW target'); await sleep(2000); continue; }
  const c = await attach(sw, 'probe' + round);
  const contexts = [];
  c.on('Runtime.executionContextCreated', (p) => contexts.push(p.context));
  c.on('Runtime.executionContextDestroyed', (p) => contexts.push({ id: p.executionContextId, destroyed: true }));
  await c.send('Runtime.enable');
  await sleep(1500); // let the SW script evaluation create its context
  const r0 = await c.evaluate(CANARY);
  console.log('round' + round + ' swId=' + String(sw.id).slice(0, 12) + ' contextsSeen=' + JSON.stringify(contexts.map((x) => ({ id: x.id, origin: x.origin, name: x.name, aux: x.auxData }))));
  console.log('round' + round + ' no-contextId: ' + r0);
  for (const x of contexts) {
    try {
      const r = await c.send('Runtime.evaluate', { expression: CANARY, awaitPromise: true, returnByValue: true, contextId: x.id });
      console.log('round' + round + ' ctxId=' + x.id + ' (' + (x.name || 'unnamed') + '): ' + JSON.stringify(r.result && r.result.value));
    } catch (e) { console.log('round' + round + ' ctxId=' + x.id + ' eval-failed: ' + e.message); }
  }
  // probe persistence: set a marker, read it back in a fresh evaluate
  await c.evaluate(`self.__probe = 'R${round}-set'; 'set'`);
  await sleep(300);
  const r1 = await c.evaluate(`(typeof self.__probe !== 'undefined') ? self.__probe : 'GONE'`);
  console.log('round' + round + ' probe-persist: ' + r1);
  c.close();
  await sleep(2000);
}
