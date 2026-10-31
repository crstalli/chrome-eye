// scratch/unit-attach-test.mjs — zero-dependency unit tests for the chrome-eye
// prompt-time attach path (sw.js attachStagedContext + composer-hook.js submit
// interception, Enter AND send-button click).
//
// Architecture: two real vm contexts sharing one fake tab registry.
//   * sw.js runs in its own vm sandbox against a stubbed chrome.* API.
//   * composer-hook.js runs in a second vm sandbox with a mini DOM; its
//     chrome.runtime.sendMessage is routed straight into the REAL sw.js
//     onMessage listener, so the full path hook → SW → attachStagedContext →
//     captureTab (stubbed tabs/scripting) → response → hook append →
//     synthetic-Enter re-dispatch is exercised with no mocks in between.
//
// Run: node scratch/unit-attach-test.mjs   (from /mnt/f/ai/chrome-eye)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const EXT = path.join(here, '..', 'extension');
const SW_SOURCE = fs.readFileSync(path.join(EXT, 'sw.js'), 'utf8');
const HOOK_SOURCE = fs.readFileSync(path.join(EXT, 'composer-hook.js'), 'utf8');

// ---------------------------------------------------------------------------
// Fake tab registry + SW chrome stub
// ---------------------------------------------------------------------------

function makeTab({ id, title, url, text, receiver = true, scriptingBlocked = false, active = false }) {
  return { id, title, url, text, receiver, scriptingBlocked, active, favIconUrl: '', _captures: 0 };
}

function makeSwChrome(tabs, storageData) {
  const state = {
    tabs: new Map(tabs.map((t) => [t.id, t])),
    listener: null,
    broadcasts: [],
    injected: [],
    navListeners: [],
    importedScripts: [],
    // In-memory chrome.storage.session store. Pass the SAME object to two
    // makeSwChrome calls to simulate an SW restart (module state gone,
    // session storage survives).
    storageData: storageData || {},
  };

  const findTab = (id) => state.tabs.get(id) || null;

  const chrome = {
    runtime: {
      id: 'test-extension-id',
      lastError: undefined,
      onMessage: { addListener(fn) { state.listener = fn; } },
      // SW → extension pages (the attach-result broadcast). Record + ack.
      sendMessage(msg, cb) {
        state.broadcasts.push(msg);
        if (cb) cb();
      },
    },
    sidePanel: {
      setPanelBehavior() {
        return Promise.resolve();
      },
    },
    tabs: {
      // Promise form (getActiveTab / findPanelGuiFrame). NOTE: the list-tabs
      // handler uses the callback form in sw.js; not exercised here.
      query(info) {
        info = info || {};
        let list = [...state.tabs.values()];
        if (info.active !== undefined) list = list.filter((t) => !!t.active === !!info.active);
        if (info.url !== undefined) {
          let prefix = String(info.url);
          if (prefix.endsWith('/*')) prefix = prefix.slice(0, -1);
          list = list.filter((t) => String(t.url).startsWith(prefix));
        }
        return Promise.resolve(list);
      },
      get(id) {
        const t = findTab(id);
        return t ? Promise.resolve(t) : Promise.reject(new Error('No tab with id ' + id));
      },
      sendMessage(tabId, msg) {
        const t = findTab(tabId);
        if (t && t.receiver === true && msg && msg.type === 'chrome-eye:capture') {
          t._captures += 1;
          return Promise.resolve({ url: t.url, title: t.title, text: t.text, links: [], headings: [] });
        }
        if (t && t.receiver === 'error') {
          return Promise.reject(new Error('Tab is closed'));
        }
        return Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'));
      },
    },
    scripting: {
      executeScript(opts) {
        const t = opts && opts.target ? findTab(opts.target.tabId) : null;
        if (!t) return Promise.reject(new Error('No tab'));
        if (t.scriptingBlocked) return Promise.reject(new Error('Scripting not allowed'));
        if (opts && Array.isArray(opts.files) && opts.files.indexOf('content.js') !== -1) t.receiver = true;
        state.injected.push(opts);
        return Promise.resolve([{}]);
      },
    },
    webNavigation: {
      onCompleted: { addListener(fn, filter) { state.navListeners.push({ fn, filter }); } },
      getAllFrames() {
        return Promise.resolve([]);
      },
    },
    storage: {
      session: {
        get(key) {
          const keys = typeof key === 'string' ? [key] : Array.isArray(key) ? key : Object.keys(state.storageData);
          const out = {};
          for (const k of keys) if (k in state.storageData) out[k] = state.storageData[k];
          return Promise.resolve(out);
        },
        set(obj) {
          Object.assign(state.storageData, obj);
          return Promise.resolve();
        },
      },
    },
  };

  return { chrome, state };
}

function loadSw(tabs, storageData) {
  const { chrome, state } = makeSwChrome(tabs, storageData);
  const sandbox = {
    console,
    chrome,
    fetch: () => Promise.reject(new Error('fetch disabled in unit tests')),
    importScripts(name) {
      state.importedScripts.push(name);
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(SW_SOURCE, sandbox, { filename: 'sw.js' });
  assert.ok(state.listener, 'sw.js must register an onMessage listener');

  // Drive the real onMessage listener. Sync handlers call sendResponse before
  // returning; async handlers return true and respond later.
  function swSend(message) {
    return new Promise((resolve) => {
      let settled = false;
      const done = (v) => {
        if (!settled) {
          settled = true;
          resolve(v);
        }
      };
      let keep;
      try {
        keep = state.listener(message, {}, done);
      } catch (e) {
        done(e);
      }
      if (keep !== true) done(undefined);
    });
  }

  return { chrome, state, swSend };
}

// Drain microtask chains (all stub Promises are pre-resolved, so the whole
// attach chain settles within one macrotask boundary).
async function flush(times = 3) {
  for (let i = 0; i < times; i += 1) await new Promise((r) => setImmediate(r));
}

// Cross-realm structural equality: the SW runs in a vm realm, so its
// arrays/objects carry foreign prototypes that assert.deepStrictEqual rejects.
function deepEq(actual, expected, msg) {
  assert.deepEqual(JSON.parse(JSON.stringify(actual)), JSON.parse(JSON.stringify(expected)), msg);
}

// ---------------------------------------------------------------------------
// SW-only tests
// ---------------------------------------------------------------------------

test('SW: panel-state initial shape', async () => {
  const { swSend } = loadSw([]);
  const resp = await swSend({ type: 'chrome-eye:panel-state' });
  deepEq(resp, { ok: true, panelOpen: false, staged: [] });
});

test('SW: panel-open flips panelOpen and does not fatal with no panel tab', async () => {
  const { swSend, state } = loadSw([]);
  await swSend({ type: 'chrome-eye:panel-open' });
  await flush();
  const resp = await swSend({ type: 'chrome-eye:panel-state' });
  assert.equal(resp.ok, true);
  assert.equal(resp.panelOpen, true);
  assert.equal(resp.staged.length, 0);
  // injectComposerHook chain must have settled quietly (no panel tab found).
  assert.equal(state.importedScripts.includes('scraper.js'), true);
});

test('SW: stage-tab by id, dedup, chrome:// rejected, active-tab fallback', async () => {
  const a = makeTab({ id: 1, title: 'Doc A', url: 'https://example.com/a', text: 'alpha' });
  const chromeTab = makeTab({ id: 2, title: 'Settings', url: 'chrome://settings/', text: '' });
  const active = makeTab({ id: 3, title: 'Active', url: 'https://example.com/active', text: 'x', active: true });
  const { swSend } = loadSw([a, chromeTab, active]);

  let resp = await swSend({ type: 'chrome-eye:stage-tab', tabId: 1 });
  assert.equal(resp.ok, true);
  assert.equal(resp.staged.length, 1);
  deepEq(resp.staged[0], { id: 1, title: 'Doc A', url: 'https://example.com/a', favIconUrl: '', active: false });

  // dedup by id
  resp = await swSend({ type: 'chrome-eye:stage-tab', tabId: 1 });
  assert.equal(resp.ok, true);
  assert.equal(resp.staged.length, 1);

  // non-web url rejected
  resp = await swSend({ type: 'chrome-eye:stage-tab', tabId: 2 });
  assert.equal(resp.ok, false);
  assert.equal(resp.error, 'only http(s) tabs can be staged');
  assert.equal(resp.staged.length, 1);

  // no tabId → current-window active tab
  resp = await swSend({ type: 'chrome-eye:stage-tab' });
  assert.equal(resp.ok, true);
  assert.equal(resp.staged.length, 2);
  assert.equal(resp.staged[1].id, 3);
});

test('SW: unstage-tab removes one entry', async () => {
  const a = makeTab({ id: 1, title: 'A', url: 'https://a.example.com/', text: '' });
  const b = makeTab({ id: 2, title: 'B', url: 'https://b.example.com/', text: '' });
  const { swSend } = loadSw([a, b]);
  await swSend({ type: 'chrome-eye:stage-tab', tabId: 1 });
  await swSend({ type: 'chrome-eye:stage-tab', tabId: 2 });
  let resp = await swSend({ type: 'chrome-eye:unstage-tab', tabId: 1 });
  assert.equal(resp.ok, true);
  deepEq(resp.staged.map((s) => s.id), [2]);
});

test('SW: staged list survives simulated SW restart (storage.session durability)', async () => {
  const a = makeTab({ id: 1, title: 'Example', url: 'https://example.com/', text: 'hello' });
  const storageData = {};
  const sw1 = loadSw([a], storageData);
  const resp = await sw1.swSend({ type: 'chrome-eye:stage-tab', tabId: 1 });
  assert.equal(resp.ok, true);
  assert.equal(resp.staged.length, 1);
  assert.deepEqual(storageData.ceStagedTabs, resp.staged, 'staging must persist to session storage');

  // Simulate an SW idle restart: fresh vm + fresh module state, but the
  // SAME chrome.storage.session store (it survives SW restarts in real
  // Chrome, unlike module variables).
  const sw2 = loadSw([a], storageData);
  await flush();
  const state2 = await sw2.swSend({ type: 'chrome-eye:panel-state' });
  assert.equal(state2.ok, true);
  assert.equal(state2.staged.length, 1, 'restarted SW must restore the staged list');
  assert.equal(state2.staged[0].id, 1);

  // A one-shot attach in the restarted SW also clears the durable store.
  // NOTE: deepEq (not assert.deepEqual) — the stored array is a vm-sandbox
  // array whose Array.prototype differs from the test world's.
  const attach = await sw2.swSend({ type: 'chrome-eye:prompt-attach' });
  assert.equal(attach.ok, true);
  deepEq(storageData.ceStagedTabs, [], 'attach must clear durable storage');
});

test('SW: add-staged is confirm-only (no capture happens)', async () => {
  const a = makeTab({ id: 1, title: 'Doc A', url: 'https://example.com/a', text: 'alpha' });
  const { swSend, state } = loadSw([a]);
  await swSend({ type: 'chrome-eye:stage-tab', tabId: 1 });
  const resp = await swSend({ type: 'chrome-eye:add-staged' });
  await flush();
  assert.equal(resp.ok, true);
  assert.equal(resp.armed, 1);
  assert.equal(resp.staged.length, 1);
  assert.equal(state.tabs.get(1)._captures, 0, 'add-staged must not capture');
});

test('SW: prompt-attach success — contextText shape, staged cleared, broadcast, injection', async () => {
  const a = makeTab({ id: 1, title: 'Doc A', url: 'https://example.com/a', text: 'alpha' });
  const b = makeTab({ id: 2, title: 'Doc B', url: 'https://example.com/b', text: 'beta', receiver: false });
  const { swSend, state } = loadSw([a, b]);
  await swSend({ type: 'chrome-eye:stage-tab', tabId: 1 });
  await swSend({ type: 'chrome-eye:stage-tab', tabId: 2 });

  const resp = await swSend({ type: 'chrome-eye:prompt-attach' });
  await flush();

  assert.equal(resp.ok, true);
  assert.equal(resp.attached, 2);
  assert.equal(resp.failed.length, 0);
  deepEq(resp.staged, [], 'stagedTabs must be cleared one-shot');

  const lines = resp.contextText.split('\n');
  assert.equal(lines[0], '[chrome-eye: context from 2 staged pages, captured just now]');
  assert.equal(lines[1], '');
  assert.equal(lines[2], '=== 1. Doc A — https://example.com/a ===');
  assert.equal(lines[3], 'alpha');
  assert.equal(lines[4], '');
  assert.equal(lines[5], '=== 2. Doc B — https://example.com/b ===');
  assert.equal(lines[6], 'beta');

  // tab 2 had no receiver: content.js injected, then retry succeeded
  assert.equal(state.tabs.get(2).receiver, true, 'content.js injection should have armed tab 2');
  const injection = state.injected.find((o) => o.target && o.target.tabId === 2);
  assert.ok(injection, 'chrome.scripting.executeScript must target tab 2');
  deepEq(injection.files, ['content.js'], 'injection must target content.js');

  const broadcast = state.broadcasts.find((m) => m && m.type === 'chrome-eye:attach-result');
  assert.ok(broadcast, 'attach-result must be broadcast on success');
  assert.equal(broadcast.result.ok, true);
  assert.equal(broadcast.result.attached, 2);
  assert.equal(broadcast.result.failed, 0);
});

test('SW: prompt-attach with nothing staged → refused no-staged error', async () => {
  const { swSend, state } = loadSw([]);
  const resp = await swSend({ type: 'chrome-eye:prompt-attach' });
  await flush();
  assert.equal(resp.ok, false);
  assert.equal(resp.error, 'no staged pages');
  assert.equal(resp.attached, 0);
  assert.equal(resp.contextText, '');
  assert.equal(state.broadcasts.length, 0, 'refused attach must stay silent to the panel');
});

test('SW: prompt-attach partial failure — one capturable, one scripting-blocked', async () => {
  const a = makeTab({ id: 1, title: 'Doc A', url: 'https://example.com/a', text: 'alpha' });
  const b = makeTab({ id: 2, title: 'Doc B', url: 'https://example.com/b', text: 'beta', receiver: false, scriptingBlocked: true });
  const { swSend } = loadSw([a, b]);
  await swSend({ type: 'chrome-eye:stage-tab', tabId: 1 });
  await swSend({ type: 'chrome-eye:stage-tab', tabId: 2 });

  const resp = await swSend({ type: 'chrome-eye:prompt-attach' });
  await flush();

  assert.equal(resp.ok, true);
  assert.equal(resp.attached, 1);
  assert.equal(resp.failed.length, 1);
  assert.equal(resp.failed[0].id, 2);
  assert.equal(resp.failed[0].title, 'Doc B');
  assert.match(resp.failed[0].reason, /tab capture failed after content-script injection: .* \(tab 2\)$/);
  // head line counts SUCCESSFUL parts (sw.js L458: parts.length)
  assert.match(resp.contextText, /^\[chrome-eye: context from 1 staged page, captured just now\]/);
  assert.match(resp.contextText, /\(chrome-eye could not capture: Doc B\)$/);
  deepEq(resp.staged, []);
});

test('SW: prompt-attach all failed → refused with "no captures", silent', async () => {
  const a = makeTab({ id: 1, title: 'Doc A', url: 'https://example.com/a', text: 'alpha', receiver: false, scriptingBlocked: true });
  const { swSend, state } = loadSw([a]);
  await swSend({ type: 'chrome-eye:stage-tab', tabId: 1 });

  const resp = await swSend({ type: 'chrome-eye:prompt-attach' });
  await flush();

  assert.equal(resp.ok, false);
  assert.match(resp.error, /^no captures: Doc A: tab capture failed after content-script injection: .* \(tab 1\)$/);
  assert.equal(resp.attached, 0);
  assert.equal(resp.contextText, '');
  assert.equal(resp.failed.length, 1);
  deepEq(resp.staged, [], 'staged cleared one-shot even on refusal');
  assert.equal(state.broadcasts.length, 0, 'all-failed attach must not broadcast');
});

test('SW: capture rejects with a non-"no receiver" error → failed entry', async () => {
  const a = makeTab({ id: 1, title: 'Doc A', url: 'https://example.com/a', text: '', receiver: 'error' });
  const { swSend } = loadSw([a]);
  await swSend({ type: 'chrome-eye:stage-tab', tabId: 1 });
  const resp = await swSend({ type: 'chrome-eye:prompt-attach' });
  await flush();
  assert.equal(resp.ok, false);
  assert.match(resp.error, /no captures: Doc A: tab capture failed: Tab is closed \(tab 1\)/);
});

test('SW: PER_PAGE truncation at 20000 chars', async () => {
  const big = 'x'.repeat(25000);
  const a = makeTab({ id: 1, title: 'Big', url: 'https://big.example.com/', text: big });
  const { swSend } = loadSw([a]);
  await swSend({ type: 'chrome-eye:stage-tab', tabId: 1 });
  const resp = await swSend({ type: 'chrome-eye:prompt-attach' });
  await flush();
  assert.equal(resp.ok, true);
  assert.equal(resp.attached, 1);
  const lines = resp.contextText.split('\n');
  assert.equal(lines[2], '=== 1. Big — https://big.example.com/ [truncated] ===');
  const headerIdx = resp.contextText.indexOf('=== 1. Big');
  const bodyStart = resp.contextText.indexOf('\n', headerIdx) + 1;
  const body = resp.contextText.slice(bodyStart);
  assert.equal(body.length, 20000, 'captured body must be exactly PER_PAGE chars');
  assert.equal(body, 'x'.repeat(20000));
});

test('SW: TOTAL budget exhaustion — 6 x 20000 chars → 5 attached, 1 failed', async () => {
  const tabs = [];
  for (let i = 1; i <= 6; i += 1) {
    tabs.push(makeTab({ id: i, title: 'Page ' + i, url: 'https://p' + i + '.example.com/', text: 'y'.repeat(20000) }));
  }
  const { swSend } = loadSw(tabs);
  for (const t of tabs) await swSend({ type: 'chrome-eye:stage-tab', tabId: t.id });
  const resp = await swSend({ type: 'chrome-eye:prompt-attach' });
  await flush();
  assert.equal(resp.ok, true);
  assert.equal(resp.attached, 5);
  assert.equal(resp.failed.length, 1);
  assert.equal(resp.failed[0].id, 6);
  assert.equal(resp.failed[0].reason, 'context budget exhausted');
  assert.match(resp.contextText, /\(chrome-eye could not capture: Page 6\)$/);
});

// ---------------------------------------------------------------------------
// Mini DOM for the hook
// ---------------------------------------------------------------------------

function parseSelector(sel) {
  const m = sel.match(/^([a-zA-Z]+)((?:\[[^\]]+\])*)$/);
  if (!m) throw new Error('unsupported selector in test DOM: ' + sel);
  const attrs = {};
  const re = /\[([a-zA-Z-]+)="([^"]*)"\]/g;
  let am;
  while ((am = re.exec(m[2]))) attrs[am[1]] = am[2];
  return { tag: m[1].toLowerCase(), attrs };
}

function matches(el, sel) {
  const { tag, attrs } = parseSelector(sel);
  if (!el || el.nodeType !== 1 || el.tagName.toLowerCase() !== tag) return false;
  for (const k of Object.keys(attrs)) if (el.getAttribute(k) !== attrs[k]) return false;
  return true;
}

function makeElement(tagName, attrs = {}) {
  const el = {
    tagName: String(tagName).toUpperCase(),
    attrs,
    parentElement: null,
    children: [],
    style: { cssText: '', display: '', left: '', top: '', bottom: '' },
    textContent: '',
    title: '',
    type: '',
    checked: false,
    src: '',
    nodeType: 1,
    rect: { top: 0, left: 0, right: 0, bottom: 0, width: 0, height: 0 },
    _listeners: {},
    _focused: false,
    getAttribute(name) {
      return this.attrs[name] !== undefined ? this.attrs[name] : null;
    },
    setAttribute(name, v) {
      this.attrs[name] = String(v);
    },
    getBoundingClientRect() {
      return this.rect;
    },
    get firstChild() {
      return this.children[0] || null;
    },
    get lastChild() {
      return this.children.length ? this.children[this.children.length - 1] : null;
    },
    appendChild(child) {
      if (child.parentElement) child.parentElement.removeChild(child);
      child.parentElement = this;
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i !== -1) {
        this.children.splice(i, 1);
        child.parentElement = null;
      }
      return child;
    },
    contains(other) {
      let n = other;
      while (n) {
        if (n === this) return true;
        n = n.parentElement;
      }
      return false;
    },
    closest(selector) {
      if (selector === 'button[aria-label="Send message"]') {
        let n = this;
        while (n) {
          if (n.nodeType === 1 && n.tagName === 'BUTTON' && n.getAttribute('aria-label') === 'Send message') return n;
          n = n.parentElement;
        }
        return null;
      }
      return null;
    },
    focus() {
      el._focused = true;
    },
    blur() {},
    addEventListener(type, fn, capture) {
      (el._listeners[type] = el._listeners[type] || []).push({ fn, capture: !!capture });
    },
    removeEventListener() {},
    dispatchEvent(ev) {
      return dispatchEventMini(el, ev, CURRENT_DOC);
    },
    querySelectorAll(sel) {
      const out = [];
      const walk = (node) => {
        for (const child of node.children) {
          if (child.nodeType === 1) {
            if (matches(child, sel)) out.push(child);
            walk(child);
          }
        }
      };
      walk(el);
      return out;
    },
  };
  return el;
}

// The most recently created document (elements dispatch into it).
let CURRENT_DOC = null;

// Mini event propagation: capture (doc → parent of target), target, bubble
// (parent of target → doc). stopPropagation halts at the current phase boundary.
function dispatchEventMini(target, ev, doc) {
  ev.target = ev.target || target;
  let stopped = false;
  if (!ev.stopPropagation) ev.stopPropagation = function () { stopped = true; };
  if (!ev.preventDefault) ev.preventDefault = function () { ev.defaultPrevented = true; };

  const chain = [];
  let n = target;
  while (n) {
    chain.push(n);
    n = n.parentElement;
  }
  const full = chain.concat([doc]); // doc is the root node

  function fire(node, phase) {
    if (stopped) return;
    const list = node._listeners ? node._listeners[ev.type] : null;
    if (!list) return;
    for (const l of list) {
      const isCapture = !!l.capture;
      const match = phase === 'target' ? true : phase === 'capture' ? isCapture : !isCapture;
      if (match) {
        l.fn(ev);
        if (stopped) return;
      }
    }
  }

  for (let i = full.length - 1; i > 0; i -= 1) fire(full[i], 'capture');
  if (!stopped) fire(full[0], 'target');
  if (ev.bubbles !== false && !stopped) {
    for (let i = full.length - 1; i > 0; i -= 1) fire(full[i], 'bubble');
  }
  return !ev.defaultPrevented;
}

function makeDocument(opts = {}) {
  const body = makeElement('body');
  const documentElement = makeElement('html');
  const doc = {
    body,
    documentElement,
    hidden: false,
    _listeners: {},
    _execCommandFail: !!opts.execCommandFail,
    _execCommands: [],
    addEventListener(type, fn, capture) {
      (doc._listeners[type] = doc._listeners[type] || []).push({ fn, capture: !!capture });
    },
    removeEventListener() {},
    createElement(tagName) {
      return makeElement(tagName);
    },
    createRange() {
      return { selectNodeContents() {}, collapse() {} };
    },
    createTextNode(text) {
      return { nodeType: 3, nodeValue: String(text), parentElement: null };
    },
    querySelectorAll(sel) {
      const out = [];
      const walk = (node) => {
        for (const child of node.children) {
          if (child.nodeType === 1) {
            if (matches(child, sel)) out.push(child);
            walk(child);
          }
        }
      };
      walk(body);
      walk(documentElement);
      return out;
    },
    querySelector(sel) {
      return doc.querySelectorAll(sel)[0] || null;
    },
    execCommand(cmd, ui, text) {
      doc._execCommands.push([cmd, ui, text]);
      if (doc._execCommandFail) return false;
      if (cmd === 'insertText' && text !== undefined) {
        doc._activeBox = doc._activeBox || null;
        if (doc._activeBox) doc._activeBox.textContent += text;
      }
      return !doc._execCommandFail;
    },
  };
  documentElement.parentElement = null;
  body.parentElement = documentElement;
  CURRENT_DOC = doc;
  return doc;
}

function makeEventCtors() {
  function KeyboardEvent(type, init = {}) {
    return Object.assign(
      {
        type,
        key: '',
        code: '',
        shiftKey: false,
        ctrlKey: false,
        metaKey: false,
        altKey: false,
        repeat: false,
        isComposing: false,
        keyCode: 0,
        bubbles: false,
        cancelable: false,
        composed: false,
        button: 0,
      },
      init
    );
  }
  function MouseEvent(type, init = {}) {
    return Object.assign({ type, button: 0 }, init);
  }
  function InputEvent(type, init = {}) {
    return Object.assign({ type, inputType: '', data: '' }, init);
  }
  return { KeyboardEvent, MouseEvent, InputEvent };
}

// ---------------------------------------------------------------------------
// Combined hook + SW harness
// ---------------------------------------------------------------------------

function buildComposerDom() {
  const doc = makeDocument();
  const root = makeElement('div'); // composer root (box → grow → card → root)
  const card = makeElement('div');
  const grow = makeElement('div');
  const box = makeElement('div', {
    'data-composer-input': 'true',
    contenteditable: 'true',
    role: 'textbox',
    'aria-label': 'Message or run a task...',
  });
  box.rect = { top: 100, left: 40, right: 540, bottom: 180, width: 500, height: 80 };
  const send = makeElement('button', { 'aria-label': 'Send message' });
  send.rect = { top: 120, left: 500, right: 534, bottom: 148, width: 34, height: 28 };

  grow.appendChild(box);
  card.appendChild(grow);
  root.appendChild(card);
  root.appendChild(send);
  doc.body.appendChild(root);

  const app = { enters: [], clicks: [], inputs: [] };
  // App-side handlers, modeled on the real GUI: Lexical keymap on the box
  // (bubble phase) and the send button's click (bubble phase).
  box.addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter' && !ev.repeat) app.enters.push({ defaultPrevented: !!ev.defaultPrevented });
  });
  send.addEventListener('click', function (ev) {
    app.clicks.push({ defaultPrevented: !!ev.defaultPrevented });
  });
  box.addEventListener('input', function (ev) {
    app.inputs.push({ inputType: ev.inputType });
  });

  return { doc, box, send, app };
}

function loadHook(swState, dom, opts = {}) {
  const doc = dom.doc;
  const winListeners = {};
  const intervals = [];
  const windowStub = {
    __ceComposerHook: undefined,
    innerHeight: 800,
    addEventListener(type, fn) {
      (winListeners[type] = winListeners[type] || []).push(fn);
    },
    removeEventListener() {},
    getSelection() {
      if (opts.getSelectionNull) return null;
      return { removeAllRanges() {}, addRange() {} };
    },
  };

  const sandbox = {
    console,
    window: windowStub,
    document: doc,
    KeyboardEvent: makeEventCtors().KeyboardEvent,
    MouseEvent: makeEventCtors().MouseEvent,
    InputEvent: makeEventCtors().InputEvent,
    setInterval(fn, ms) {
      intervals.push({ fn, ms });
      return intervals.length;
    },
    clearInterval() {},
    chrome: {
      lastError: undefined,
      runtime: {
        // Route straight into the REAL sw.js onMessage listener.
        sendMessage(msg, cb) {
          let settled = false;
          const done = (v) => {
            if (!settled) {
              settled = true;
              cb(v);
            }
          };
          let keep;
          try {
            keep = swState.listener(msg, {}, done);
          } catch (e) {
            done(null);
          }
          if (keep !== true) done(null);
        },
      },
    },
  };
  vm.createContext(sandbox);
  vm.runInContext(HOOK_SOURCE, sandbox, { filename: 'composer-hook.js' });

  // execCommand needs to know which box is active; the hook focuses it first.
  doc._activeBox = dom.box;

  const hookButton = () => doc.body.children.find((c) => c.tagName === 'BUTTON' && !c.getAttribute('aria-label'));

  return {
    windowStub,
    winListeners,
    intervals,
    hookButton,
    refresh() {
      // The 2s refreshState poll (second setInterval in the hook).
      const poll = intervals.find((i) => i.ms === 2000);
      assert.ok(poll, 'hook must register the 2s refreshState poll');
      poll.fn();
    },
    tickPosition() {
      const t = intervals.find((i) => i.ms === 1000);
      assert.ok(t, 'hook must register the 1s position poll');
      t.fn();
    },
  };
}

function makeHarness(tabFactory) {
  const tabs = tabFactory();
  const sw = loadSw(tabs);
  const dom = buildComposerDom();
  const hook = loadHook(sw.state, dom);
  return { tabs, sw, dom, hook };
}

async function stageTabs(sw, ids) {
  for (const id of ids) {
    const resp = await sw.swSend({ type: 'chrome-eye:stage-tab', tabId: id });
    assert.equal(resp.ok, true, 'staging tab ' + id + ' should work');
  }
}

function findHookBadge(hook) {
  return hook.hookButton();
}

// ---------------------------------------------------------------------------
// Hook UI tests
// ---------------------------------------------------------------------------

test('HOOK: unarmed → no button; armed → badge + exact title (E2E contract prefix)', async () => {
  const { sw, hook } = makeHarness(() => [
    makeTab({ id: 1, title: 'Doc A', url: 'https://example.com/a', text: 'alpha' }),
  ]);

  // init refreshState already ran (armed 0) → no button
  assert.equal(findHookBadge(hook), undefined);

  await stageTabs(sw, [1]);
  hook.refresh();

  const btn = findHookBadge(hook);
  assert.ok(btn, 'badge button must exist when armed');
  assert.equal(btn.textContent, '\uD83D\uDDC1 1');
  assert.equal(btn.type, 'button');
  assert.match(
    btn.title,
    /^1 staged page — attached to your next prompt when you send it \(Enter or the send button\)\. Click to manage\.$/
  );
  assert.equal(btn.style.display, '', 'positioned button must be visible');
  assert.ok(btn.style.left.length > 0 && btn.style.top.length > 0, 'positioned next to send button');

  // plural form
  const h2 = makeHarness(() => [
    makeTab({ id: 1, title: 'A', url: 'https://a.example.com/', text: 'a' }),
    makeTab({ id: 2, title: 'B', url: 'https://b.example.com/', text: 'b' }),
  ]);
  await stageTabs(h2.sw, [1, 2]);
  h2.hook.refresh();
  const btn2 = findHookBadge(h2.hook);
  assert.equal(btn2.textContent, '\uD83D\uDDC1 2');
  assert.match(btn2.title, /^2 staged pages — attached to your next prompt/);
});

test('HOOK: idempotent — loading the hook twice does not double-register listeners', async () => {
  const { sw, dom, hook, windowStub } = (() => {
    const tabs = [makeTab({ id: 1, title: 'A', url: 'https://a.example.com/', text: 'a' })];
    const swx = loadSw(tabs);
    const domx = buildComposerDom();
    const hookx = loadHook(swx.state, domx);
    return { sw: swx, dom: domx, hook: hookx, windowStub: hookx.windowStub };
  })();
  const secondLoad = {
    console,
    window: windowStub,
    document: dom.doc,
    KeyboardEvent: makeEventCtors().KeyboardEvent,
    MouseEvent: makeEventCtors().MouseEvent,
    InputEvent: makeEventCtors().InputEvent,
    setInterval: () => 99,
    chrome: { runtime: { lastError: undefined, sendMessage: (m, cb) => cb(null) } },
  };
  vm.createContext(secondLoad);
  vm.runInContext(HOOK_SOURCE, secondLoad, { filename: 'composer-hook.js (2nd load)' });
  assert.equal(windowStub.__ceComposerHook, true, 'second load must be a no-op (already guarded)');
  assert.equal(dom.doc._listeners.keydown.length, 2, 'keydown listeners must not duplicate (onKeydown + Escape)');
  assert.equal(dom.doc._listeners.click.length, 1, 'click listener must not duplicate');
  void hook;
});

test('HOOK: popover closes on in-doc outside mousedown AND on window blur; re-opens visible', async () => {
  const { sw, dom, hook } = makeHarness(() => [
    makeTab({ id: 1, title: 'Doc A', url: 'https://example.com/a', text: 'alpha' }),
  ]);
  await stageTabs(sw, [1]);
  hook.refresh();

  const btn = findHookBadge(hook);
  assert.ok(btn, 'badge must be armed before opening the popover');

  const findPopover = () =>
    dom.doc.body.children.find(
      (c) => c.tagName === 'DIV' && /width:340px/.test(c.style.cssText)
    );
  const clickBadge = () => {
    btn.dispatchEvent(new (makeEventCtors().MouseEvent)('click', { button: 0, bubbles: true, cancelable: true }));
  };

  // Open via the badge.
  clickBadge();
  await flush();
  let pop = findPopover();
  assert.ok(pop, 'popover element must be created on open');
  assert.equal(pop.style.display, '', 'open popover must be visible');

  // Outside click inside the same document (e.g. the chat area) closes it.
  dom.box.dispatchEvent(new (makeEventCtors().MouseEvent)('mousedown', { button: 0, bubbles: true, cancelable: true }));
  assert.equal(pop.style.display, 'none', 'in-document outside mousedown must close the popover');

  // Re-open: the hidden element must be shown again (regression: display stuck at 'none').
  clickBadge();
  await flush();
  pop = findPopover();
  assert.ok(pop, 're-open must reuse the existing popover element');
  assert.equal(pop.style.display, '', 're-opened popover must be visible again');

  // A click OUTSIDE the iframe blurs the document window — the popover must
  // close (the mousedown handler can never see outside-iframe clicks).
  const blurFns = hook.winListeners.blur || [];
  assert.ok(blurFns.length >= 1, 'hook must listen for window blur');
  blurFns.forEach((fn) => fn());
  assert.equal(pop.style.display, 'none', 'window blur (outside-iframe click) must close the popover');

  // Escape still closes too.
  clickBadge();
  await flush();
  assert.equal(findPopover().style.display, '', 'popover must be open again before the Escape check');
  dom.box.dispatchEvent(new (makeEventCtors().KeyboardEvent)('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
  assert.equal(findPopover().style.display, 'none', 'Escape must close the popover');
});

// ---------------------------------------------------------------------------
// Hook + SW integration tests
// ---------------------------------------------------------------------------

test('INTEG: armed Enter → attach, append, synthetic-Enter submit, staged cleared', async () => {
  const { sw, dom, hook } = makeHarness(() => [
    makeTab({ id: 1, title: 'Doc A', url: 'https://example.com/a', text: 'alpha' }),
  ]);
  await stageTabs(sw, [1]);
  hook.refresh();

  dom.box.textContent = 'test.';
  dom.box.dispatchEvent(new (makeEventCtors().KeyboardEvent)('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await flush();

  // Context appended to the composer
  assert.ok(dom.box.textContent.startsWith('test.'), 'user text must stay first');
  assert.ok(dom.box.textContent.includes('\n\n[chrome-eye: context from 1 staged page, captured just now]'), 'context block appended');
  assert.ok(dom.box.textContent.includes('=== 1. Doc A — https://example.com/a ==='));
  assert.ok(dom.box.textContent.includes('alpha'));

  // Exactly ONE app submit, via the synthetic re-dispatch (user Enter was stopped)
  assert.equal(dom.app.enters.length, 1, 'app must receive exactly one Enter (the re-dispatch)');
  assert.equal(dom.app.clicks.length, 0);

  // SW staged list cleared one-shot; broadcast went out
  const state = await sw.swSend({ type: 'chrome-eye:panel-state' });
  deepEq(state.staged, []);
  const broadcast = sw.state.broadcasts.find((m) => m && m.type === 'chrome-eye:attach-result');
  assert.ok(broadcast);
  assert.equal(broadcast.result.attached, 1);

  // Badge hides again after the post-attach refresh
  hook.refresh();
  const btn = findHookBadge(hook);
  assert.ok(btn && btn.style.display === 'none', 'badge must hide when nothing is staged');
});

test('INTEG: armed send-button click → attach (REGRESSION: click bypass fixed), user click stopped', async () => {
  const { sw, dom, hook } = makeHarness(() => [
    makeTab({ id: 1, title: 'Doc A', url: 'https://example.com/a', text: 'alpha' }),
  ]);
  await stageTabs(sw, [1]);
  hook.refresh();

  dom.box.textContent = 'test.';
  dom.send.dispatchEvent(new (makeEventCtors().MouseEvent)('click', { button: 0, bubbles: true, cancelable: true }));
  await flush();

  // Attach happened: context appended
  assert.ok(dom.box.textContent.startsWith('test.'));
  assert.ok(dom.box.textContent.includes('[chrome-eye: context from 1 staged page, captured just now]'));
  assert.ok(dom.box.textContent.includes('alpha'));

  // The user's click NEVER reached the app (capture-phase stop), and the
  // prompt was submitted exactly once via the synthetic-Enter re-dispatch.
  assert.equal(dom.app.clicks.length, 0, 'user click must be stopped before the app handler');
  assert.equal(dom.app.enters.length, 1, 'submission must happen via the synthetic Enter re-dispatch');

  // SW state: staged cleared one-shot, success broadcast
  const state = await sw.swSend({ type: 'chrome-eye:panel-state' });
  deepEq(state.staged, []);
  const broadcast = sw.state.broadcasts.find((m) => m && m.type === 'chrome-eye:attach-result');
  assert.ok(broadcast);
  assert.equal(broadcast.result.ok, true);
  assert.equal(broadcast.result.attached, 1);
});

test('INTEG: unarmed Enter → passthrough, no attach call, staged untouched', async () => {
  const { sw, dom } = makeHarness(() => [
    makeTab({ id: 1, title: 'Doc A', url: 'https://example.com/a', text: 'alpha' }),
  ]);
  dom.box.textContent = 'test.';
  dom.box.dispatchEvent(new (makeEventCtors().KeyboardEvent)('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await flush();

  assert.equal(dom.app.enters.length, 1, 'unarmed Enter must reach the app');
  assert.equal(dom.app.enters[0].defaultPrevented, false);
  assert.equal(dom.box.textContent, 'test.', 'no append when unarmed');
  const state = await sw.swSend({ type: 'chrome-eye:panel-state' });
  deepEq(state.staged, []);
  assert.equal(sw.state.broadcasts.length, 0, 'no prompt-attach may have been sent');
});

test('INTEG: armed Enter on empty composer → passthrough, staged kept', async () => {
  const { sw, dom } = makeHarness(() => [
    makeTab({ id: 1, title: 'Doc A', url: 'https://example.com/a', text: 'alpha' }),
  ]);
  await stageTabs(sw, [1]);
  dom.box.textContent = '   ';
  dom.box.dispatchEvent(new (makeEventCtors().KeyboardEvent)('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await flush();

  assert.equal(dom.app.enters.length, 1, 'empty-composer Enter must reach the app');
  assert.equal(dom.box.textContent, '   ', 'no append on empty composer');
  const state = await sw.swSend({ type: 'chrome-eye:panel-state' });
  deepEq(state.staged.map((s) => s.id), [1], 'staging must be preserved');
  assert.equal(sw.state.broadcasts.length, 0);
});

test('INTEG: unarmed send-button click → passthrough, app click fires', async () => {
  const { sw, dom } = makeHarness(() => [
    makeTab({ id: 1, title: 'Doc A', url: 'https://example.com/a', text: 'alpha' }),
  ]);
  dom.box.textContent = 'test.';
  dom.send.dispatchEvent(new (makeEventCtors().MouseEvent)('click', { button: 0, bubbles: true, cancelable: true }));
  await flush();

  assert.equal(dom.app.clicks.length, 1, 'unarmed click must reach the app');
  assert.equal(sw.state.broadcasts.length, 0);
  assert.equal(dom.box.textContent, 'test.');
});

test('INTEG: armed send-button click on empty composer → passthrough, staged kept', async () => {
  const { sw, dom } = makeHarness(() => [
    makeTab({ id: 1, title: 'Doc A', url: 'https://example.com/a', text: 'alpha' }),
  ]);
  await stageTabs(sw, [1]);
  dom.box.textContent = '';
  dom.send.dispatchEvent(new (makeEventCtors().MouseEvent)('click', { button: 0, bubbles: true, cancelable: true }));
  await flush();

  assert.equal(dom.app.clicks.length, 1, 'empty-composer click must reach the app');
  const state = await sw.swSend({ type: 'chrome-eye:panel-state' });
  deepEq(state.staged.map((s) => s.id), [1], 'staging must be preserved');
});

test('INTEG: armed click on non-send button → passthrough', async () => {
  const { sw, dom, hook } = makeHarness(() => [
    makeTab({ id: 1, title: 'Doc A', url: 'https://example.com/a', text: 'alpha' }),
  ]);
  await stageTabs(sw, [1]);
  hook.refresh();
  const other = makeElement('button', { 'aria-label': 'Attach file' });
  other.rect = { top: 5, left: 5, width: 30, height: 30 };
  dom.doc.body.appendChild(other);
  other.addEventListener('click', function () {});
  let appHit = false;
  other.addEventListener('click', function () {
    appHit = true;
  });

  other.dispatchEvent(new (makeEventCtors().MouseEvent)('click', { button: 0, bubbles: true, cancelable: true }));
  await flush();

  assert.equal(appHit, true, 'clicks on other buttons must pass through');
  const state = await sw.swSend({ type: 'chrome-eye:panel-state' });
  deepEq(state.staged.map((s) => s.id), [1], 'no attach on unrelated click');
});

test('INTEG: refused attach (all captures fail) → plain re-dispatch, no append, staged cleared', async () => {
  const { sw, dom, hook } = makeHarness(() => [
    makeTab({ id: 1, title: 'Doc A', url: 'https://example.com/a', text: 'alpha', receiver: false, scriptingBlocked: true }),
  ]);
  await stageTabs(sw, [1]);
  hook.refresh();

  dom.box.textContent = 'test.';
  dom.box.dispatchEvent(new (makeEventCtors().KeyboardEvent)('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await flush();

  assert.equal(dom.box.textContent, 'test.', 'no context appended on refusal');
  assert.equal(dom.app.enters.length, 1, 'user prompt still submits (plain re-dispatch)');
  const state = await sw.swSend({ type: 'chrome-eye:panel-state' });
  deepEq(state.staged, [], 'staged cleared one-shot even on refusal');
  assert.equal(sw.state.broadcasts.length, 0, 'refused attach must not broadcast');
});

test('INTEG: refused attach via send-button click → plain re-dispatch, user click stopped', async () => {
  const { sw, dom, hook } = makeHarness(() => [
    makeTab({ id: 1, title: 'Doc A', url: 'https://example.com/a', text: 'alpha', receiver: false, scriptingBlocked: true }),
  ]);
  await stageTabs(sw, [1]);
  hook.refresh();

  dom.box.textContent = 'test.';
  dom.send.dispatchEvent(new (makeEventCtors().MouseEvent)('click', { button: 0, bubbles: true, cancelable: true }));
  await flush();

  assert.equal(dom.box.textContent, 'test.', 'no append on refusal');
  assert.equal(dom.app.clicks.length, 0, 'user click still stopped (attach path was taken)');
  assert.equal(dom.app.enters.length, 1, 'plain re-dispatch submits the prompt');
  const state = await sw.swSend({ type: 'chrome-eye:panel-state' });
  deepEq(state.staged, []);
});

test('INTEG: append failure (no selection) → no submit, staged already cleared one-shot', async () => {
  const tabs = [makeTab({ id: 1, title: 'Doc A', url: 'https://example.com/a', text: 'alpha' })];
  const sw = loadSw(tabs);
  const dom = buildComposerDom();
  const hook = loadHook(sw.state, dom, { getSelectionNull: true });
  await stageTabs(sw, [1]);
  hook.refresh();

  dom.box.textContent = 'test.';
  dom.box.dispatchEvent(new (makeEventCtors().KeyboardEvent)('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await flush();

  assert.equal(dom.app.enters.length, 0, 'must NOT submit when the context cannot be inserted');
  assert.equal(dom.app.clicks.length, 0);
  assert.equal(dom.box.textContent, 'test.', 'nothing appended');
  const state = await sw.swSend({ type: 'chrome-eye:panel-state' });
  deepEq(state.staged, [], 'attach consumed the one-shot staging');
  const broadcast = sw.state.broadcasts.find((m) => m && m.type === 'chrome-eye:attach-result');
  assert.ok(broadcast, 'SW side still reports the successful capture');
});

test('INTEG: execCommand failure → fallback text-node append still submits', async () => {
  const tabs = [makeTab({ id: 1, title: 'Doc A', url: 'https://example.com/a', text: 'alpha' })];
  const sw = loadSw(tabs);
  const dom = buildComposerDom();
  dom.doc._execCommandFail = true;
  const hook = loadHook(sw.state, dom);
  await stageTabs(sw, [1]);
  hook.refresh();

  dom.box.textContent = 'test.';
  dom.box.dispatchEvent(new (makeEventCtors().KeyboardEvent)('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await flush();

  assert.equal(dom.app.enters.length, 1, 'fallback append must still submit');
  const textNode = dom.box.lastChild;
  assert.ok(textNode && textNode.nodeType === 3, 'fallback appends a text node');
  assert.match(textNode.nodeValue, /^\n\n\[chrome-eye: context from 1 staged page, captured just now\]/);
  assert.equal(dom.app.inputs.length, 1, 'fallback dispatches an input event');
  assert.equal(dom.app.inputs[0].inputType, 'insertText');
});

test('INTEG: two armed tabs — one needs injection; partial failure reported in panel broadcast', async () => {
  const { sw, dom, hook } = makeHarness(() => [
    makeTab({ id: 1, title: 'Doc A', url: 'https://example.com/a', text: 'alpha' }),
    makeTab({ id: 2, title: 'Doc B', url: 'https://example.com/b', text: 'beta', receiver: false, scriptingBlocked: true }),
  ]);
  await stageTabs(sw, [1, 2]);
  hook.refresh();

  const btn = findHookBadge(hook);
  assert.equal(btn.textContent, '\uD83D\uDDC1 2');

  dom.box.textContent = 'test.';
  dom.box.dispatchEvent(new (makeEventCtors().KeyboardEvent)('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await flush();

  assert.ok(dom.box.textContent.includes('=== 1. Doc A — https://example.com/a ==='));
  assert.ok(dom.box.textContent.includes('(chrome-eye could not capture: Doc B)'));
  assert.equal(dom.app.enters.length, 1);
  const broadcast = sw.state.broadcasts.find((m) => m && m.type === 'chrome-eye:attach-result');
  assert.ok(broadcast);
  assert.equal(broadcast.result.ok, true);
  assert.equal(broadcast.result.attached, 1);
  assert.equal(broadcast.result.failed, 1);
  // panel.js L48-63: '📎 N page(s) attached to your prompt (M could not be captured)'
  assert.equal(broadcast.result.staged.length, 0);
});
