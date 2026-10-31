// TASK H — live H2 diagnostic: probe the in-iframe GUI sidebar DOM and run
// the actual ceRunInFrame scraper inside it to see what scrapeWorkspaceTree
// returns on the CURRENT GUI build.
import http from 'node:http';

const CDP = 'http://127.0.0.1:9222';

function jget(path) {
  return new Promise((resolve, reject) => {
    http.get(CDP + path, (res) => {
      let d = '';
      res.on('data', (c) => { d += c; });
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map(); }
  static connect(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      const inst = new Cdp(ws);
      const t = setTimeout(() => reject(new Error('ws connect timeout')), 8000);
      ws.onopen = () => { clearTimeout(t); resolve(inst); };
      ws.onerror = () => { clearTimeout(t); reject(new Error('ws error')); };
      ws.onmessage = (ev) => {
        let m; try { m = JSON.parse(ev.data); } catch { return; }
        if (m.id && inst.pending.has(m.id)) { const p = inst.pending.get(m.id); inst.pending.delete(m.id); m.error ? p.reject(new Error(m.error.message || JSON.stringify(m.error))) : p.resolve(m.result); }
        else if (m.method) { (inst.handlers.get((m.params && m.params.sessionId) || '') || []).forEach((f) => f(m.params)); (inst.handlers.get('*') || []).forEach((f) => f(m.params)); };
      };
    });
  }
  send(method, params = {}, sessionId) {
    return new Promise((resolve, reject) => {
      const id = ++this.id;
      this.pending.set(id, { resolve, reject });
      const m = { id, method, params };
      if (sessionId) m.sessionId = sessionId;
      this.ws.send(JSON.stringify(m));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('timeout: ' + method)); } }, 20000);
    });
  }
  on(sessionId, fn) { const k = sessionId || '*'; if (!this.handlers.has(k)) this.handlers.set(k, []); this.handlers.get(k).push(fn); }
  close() { try { this.ws.close(); } catch (e) {} }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ev = (c, s, expr, await_ = false) =>
  c.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: await_ }, s).then((r) => (r.result && r.result.value));

(async () => {
  // 0. browser-level handle (for Target.createTarget)
  const ver = await jget('/json/version');
  const b = await Cdp.connect(ver.webSocketDebuggerUrl);
  await b.send('Target.setDiscoverTargets', { discover: true });
  const t1 = await b.send('Target.createTarget', { url: 'http://127.0.0.1:9222/json' });
  const t2 = await b.send('Target.createTarget', { url: 'http://127.0.0.1:9222/json/version' });
  await b.send('Target.activateTarget', { targetId: t2.targetId });
  console.log('web tabs created:', t1.targetId, t2.targetId);
  // wake the MV3 SW: opening an extension page activates the background
  const to = await b.send('Target.createTarget', { url: 'chrome-extension://mlolgaoijponghgfnlcljlohnhlpnhkd/options.html' });
  console.log('options tab created:', to.targetId);

  // 1a. wake the dormant SW: a runtime message from the options page (an
  //     extension page with full chrome.runtime) wakes it and makes its
  //     target appear in /json/list. action.click() itself is SW-only.
  const WAKE = `(function(){return new Promise(function(resolve){
    try {
      chrome.runtime.sendMessage({type:'chrome-eye:panel-state'},function(resp){
        resolve('WOKEN:' + (resp && resp.ok));
      });
      setTimeout(function(){resolve('WAKE-TIMEOUT')},6000);
    } catch(e) { resolve('WAKE-ERR:' + e.message); }
  })})()`;
  const ts0 = await jget('/json/list');
  const opt = ts0.find((t) => t.url.includes('options.html'));
  if (!opt) throw new Error('no options tab');
  const op = await Cdp.connect(opt.webSocketDebuggerUrl);
  await op.send('Runtime.enable');
  let woke = false;
  for (let i = 0; i < 6 && !woke; i++) {
    const raw = await op.send('Runtime.evaluate', { expression: WAKE, returnByValue: true, awaitPromise: true, timeout: 12000 });
    const val = raw.result && raw.result.value;
    if (raw.exceptionDetails) console.log('wake iter ' + i, 'exception:', JSON.stringify(raw.exceptionDetails).slice(0, 200));
    console.log('wake iter ' + i + ':', val);
    if (String(val).indexOf('WOKEN:true') === 0) woke = true;
    if (!woke) await sleep(1500);
  }
  op.close();

  // 1b. wait for the SW target, then click the action from the SW
  let sw = null;
  for (let i = 0; i < 40 && !sw; i++) {
    const ts = await jget('/json/list');
    sw = ts.find((t) => t.type === 'service_worker' && /extension/);
    if (!sw) await sleep(500);
  }
  if (!sw) throw new Error('no SW target after wake');
  const c = await Cdp.connect(sw.webSocketDebuggerUrl);
  const clickRes = await ev(c, '', 'chrome.action.click()');
  console.log('panel-open click from SW:', clickRes);

  // 2. wait for panel + iframe targets
  let panel = null, frame = null;
  for (let i = 0; i < 40 && (!panel || !frame); i++) {
    await sleep(500);
    const ts = await jget('/json/list');
    panel = panel || ts.find((t) => t.type === 'page' && t.url.includes('panel.html'));
    frame = frame || ts.find((t) => t.type === 'iframe' && t.url.includes('3081'));
  }
  if (!panel) throw new Error('no panel target');
  console.log('panel target:', panel.url);
  if (!frame) { console.log('NO IFRAME TARGET (GUI not loaded via :3081)'); }

  // 3. attach to the iframe, wait for app load, dump sidebar DOM
  if (frame) {
    const f = await Cdp.connect(frame.webSocketDebuggerUrl);
    const fs = (await f.send('Target.attachToTarget', { targetId: frame.id, flatten: true })).sessionId;
    await f.send('Runtime.enable', {}, fs);
    for (let i = 0; i < 20; i++) {
      const rs = await ev(f, fs, 'document.readyState');
      if (rs === 'complete') break;
      await sleep(500);
    }
    await sleep(2500); // let the GUI app render the sidebar

    const dump = await ev(f, fs, `(function () {
      var out = { url: location.href, title: document.title, readyState: document.readyState };
      out.sessionsCurrent = localStorage.getItem('dsh.sessions.current');
      var sels = {
        groupSection: '[class*="_groupSection"]',
        sessionRow: '[class*="_sessionRow"]',
        projectRow: '[class*="_projectRow"]',
        treeitem: '[role="treeitem"]',
        overflowButton: '[class*="_sessionOverflowButton"]',
        searchResultRow: '[class*="_searchResultRow"]'
      };
      out.counts = {};
      out.sampleClasses = {};
      Object.keys(sels).forEach(function (k) {
        var els = Array.prototype.slice.call(document.querySelectorAll(sels[k]));
        out.counts[k] = els.length;
        out.sampleClasses[k] = els.slice(0, 3).map(function (e) { return e.className && e.className.baseVal !== undefined ? '' : String(e.className).slice(0, 120); });
      });
      // structural dump: find the sidebar container and show its skeleton
      var navs = Array.prototype.slice.call(document.querySelectorAll('nav, aside, [class*="sidebar" i], [class*="Sidebar"]'));
      out.navCount = navs.length;
      out.navInfo = navs.slice(0, 4).map(function (n) {
        var cs = getComputedStyle(n);
        return {
          tag: n.tagName,
          cls: String(n.className).slice(0, 160),
          display: cs.display, visibility: cs.visibility,
          w: Math.round(n.getBoundingClientRect().width)
        };
      });
      // what are the actual class-name tokens that contain session-ish words?
      var all = document.querySelectorAll('*');
      var names = {};
      for (var i = 0; i < all.length; i++) {
        var cn = all[i].getAttribute && all[i].getAttribute('class');
        if (!cn) continue;
        cn.split(/\\s+/).forEach(function (tok) {
          if (/session|group|project|workspace|tree|sidebar|row|item/i.test(tok)) names[tok] = (names[tok] || 0) + 1;
        });
      }
      var arr = Object.keys(names).sort(function (a, b) { return names[b] - names[a]; }).slice(0, 60);
      out.classTokens = arr.map(function (t) { return t + ':' + names[t]; });
      return out;
    })()`);
    console.log('=== SIDEBAR DOM DUMP ===');
    console.log(JSON.stringify(dump, null, 2));

    // 4. run the ACTUAL scraper from the extension inside the iframe
    const fs2 = await f.send('Runtime.evaluate', { expression: '(function(){return typeof globalThis.ceRunInFrame;})()', returnByValue: true }, fs);
    console.log('ceRunInFrame present in iframe:', fs2.result.value, '(expect undefined — injected on demand)');
    const fs3 = await f.send('Runtime.evaluate', {
      expression: `(function () {
        // fetch the scraper source? No — instead test the selector logic directly:
        var sels = {
          groupSection: '[class*="_groupSection"]',
          sessionRow: '[class*="_sessionRow"]'
        };
        var g = document.querySelectorAll(sels.groupSection);
        var s = document.querySelectorAll(sels.sessionRow);
        // which document are sessionRows in? check each row's offsetParent
        var rowInfo = Array.prototype.slice.call(s).slice(0, 8).map(function (r) {
          return {
            cls: String(r.className).slice(0, 100),
            offsetParent: !!r.offsetParent,
            rect: (function () { var b = r.getBoundingClientRect(); return [Math.round(b.width), Math.round(b.height)]; })(),
            title: r.textContent ? r.textContent.slice(0, 60) : ''
          };
        });
        var groupInfo = Array.prototype.slice.call(g).slice(0, 8).map(function (x) {
          return { cls: String(x.className).slice(0, 100), offsetParent: !!x.offsetParent, text: (x.textContent || '').slice(0, 40) };
        });
        return { rows: rowInfo, groups: groupInfo };
      })()`,
      returnByValue: true
    }, fs);
    console.log('=== ROW/GROUP DETAILS ===');
    console.log(JSON.stringify(fs3.result.value, null, 2));

    f.ws.close();
  }

  // 5. panel-level check: what does the panel dropdown currently say? (no click yet)
  if (panel) {
    const p = await Cdp.connect(panel.webSocketDebuggerUrl);
    const ps = await p.send('Runtime.enable', {});
    await sleep(1000);
    const state = await ev(p, '', `(function () {
      var dd = document.getElementById('ws-dropdown');
      return {
        ddHidden: dd ? dd.hasAttribute('hidden') : null,
        ddText: dd ? dd.textContent.slice(0, 200) : null
      };
    })()`);
    console.log('panel ws-dropdown (before click):', JSON.stringify(state));
    p.ws.close();
  }
  c.ws.close();
  process.exit(0);
})().catch((e) => { console.error('FAIL', e); process.exit(1); });
