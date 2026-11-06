"use strict";

// Chrome Eye service worker.
//
// Responsibilities:
//  1. Bridge ↔ content-script relay (chrome-eye:* messages).
//  2. Drive actions (type / click / navigate / getPageText / screenshot /
//     listTabs / getActiveTab / active / driveType / driveGetPageText).
//  3. Per-tab screenshot with automatic original-tab restoration.
//
// The service worker is the only place in the extension that can see EVERY
// tab's content; the content script only sees its own page.

console.log('Chrome Eye service worker active');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Whether a URL is a real web page (http/https) — not chrome://,
// file://, about:, chrome-extension://, or the DSH web page itself.
function isWebUrl(url) {
  if (!url) return false;
  return url.indexOf('http://') === 0 || url.indexOf('https://') === 0;
}

// The DSH web GUI URL (used to detect the GUI tab and avoid targeting it).
function isGuiUrl(url) {
  if (!url) return false;
  return url.indexOf('chrome-extension://') === 0 ||
         url.indexOf('chrome://') === 0 ||
         url.indexOf('chrome-extension://chrome-eye') === 0;
}

// Resolve the tab to operate on. If `tabId` is given, get that tab.
// Otherwise return the active web tab in the current window (not the DSH GUI).
// Falls back to the first web tab in any window.
function resolveTargetTab(tabId) {
  if (typeof tabId === 'number' && isFinite(tabId)) {
    return chrome.tabs.get(tabId).then(function (tab) {
      if (tab && tab.id != null) {
        if (isGuiUrl(tab.url)) {
          throw new Error('tabId ' + tabId + ' is a GUI/extension page');
        }
        return tab;
      }
      throw new Error('no tab with id ' + tabId);
    });
  }
  // First: active tab that is a real web URL
  var activeTab = chrome.tabs.query({ active: true, currentWindow: true });
  return activeTab.then(function (activeTabs) {
    if (activeTabs && activeTabs.length) {
      for (var i = 0; i < activeTabs.length; i++) {
        if (isWebUrl(activeTabs[i].url) && !isGuiUrl(activeTabs[i].url)) {
          return activeTabs[i];
        }
      }
    }
    // Second: any web tab in the current window
    var windowTabs = chrome.tabs.query({ currentWindow: true });
    return windowTabs.then(function (tabs) {
      if (tabs) {
        for (var j = 0; j < tabs.length; j++) {
          if (isWebUrl(tabs[j].url) && !isGuiUrl(tabs[j].url)) {
            return tabs[j];
          }
        }
      }
      // Last resort: the active tab itself (may be a panel/extension)
      if (activeTabs && activeTabs.length) return activeTabs[0];
      throw new Error('no web tab found');
    });
  });
}

// Per-tab screenshot. captureVisibleTab can only target the active tab in a
// window, so we must activate the target tab first. After capture we restore
// the previously active tab so the user's view is unchanged.
function captureTabScreenshot(tab) {
  var windowId = tab.windowId;
  var hasWindow = typeof windowId === 'number' && windowId >= 0;
  var originalActive;
  return chrome.tabs.query({ active: true, currentWindow: true }).then(function (act) {
    originalActive = act && act.length ? act[0].id : null;
    return hasWindow
      ? chrome.windows.update(windowId, { focused: true })
      : Promise.resolve();
  }).then(function () {
    return chrome.tabs.update(tab.id, { active: true }).then(function () {
      return chrome.tabs.captureVisibleTab(
        hasWindow ? windowId : undefined,
        { format: 'png' }
      ).then(function (dataUrl) {
        // Restore the original active tab so the user's view is unchanged.
        if (originalActive && originalActive !== tab.id) {
          chrome.tabs.update(originalActive, { active: true }).catch(function () {});
        }
        var i = dataUrl.indexOf(',');
        return i >= 0 ? dataUrl.slice(i + 1) : dataUrl;
      });
    });
  });
}

// ---------------------------------------------------------------------------
// Command dispatch
// ---------------------------------------------------------------------------

// Relay one drive action to the target tab's content script; if there is no
// live receiver (tab opened before install/reload) inject content.js once and
// retry — mirroring captureTab's best-effort fallback.
function driveOnTab(tabId, verb, params) {
  var msg = { type: 'chrome-eye:drive:' + verb };
  for (var k in params) {
    if (Object.prototype.hasOwnProperty.call(params, k)) {
      msg[k] = params[k];
    }
  }
  return chrome.tabs.sendMessage(tabId, msg).catch(function (err) {
    var m = String((err && err.message) || err);
    if (m.indexOf('Receiving end does not exist') === -1) {
      throw new Error('drive ' + verb + ' failed: ' + m + ' (tab ' + tabId + ')');
    }
    return chrome.scripting
      .executeScript({ target: { tabId: tabId }, files: ['content.js'] })
      .then(function () { return chrome.tabs.sendMessage(tabId, msg); })
      .catch(function (retryErr) {
        throw new Error('drive ' + verb + ' failed after content-script injection: ' +
          String((retryErr && retryErr.message) || retryErr) + ' (tab ' + tabId + ')');
      });
  });
}

function executeCmd(cmd) {
  var action = cmd.action;
  var params = (cmd.params && typeof cmd.params === 'object') ? cmd.params : {};
  var tabPromise = (typeof params.tabId === 'number') ? resolveTargetTab(params.tabId) : resolveTargetTab(null);
  return tabPromise.then(function (tab) {
    if (!tab || tab.id == null) throw new Error('no target tab (open an http(s) page and retry)');
    if (action === 'screenshot') {
      return captureTabScreenshot(tab).then(function (image) {
        return { ok: true, action: action, tabId: tab.id, url: tab.url, title: tab.title, image: image };
      });
    }
    if (action === 'click') {
      if (!params.selector) throw new Error('click requires params.selector (a CSS selector)');
      return driveOnTab(tab.id, 'click', { selector: params.selector }).then(function (r) {
        return { ok: true, action: action, tabId: tab.id, url: tab.url, result: r };
      });
    }
    if (action === 'type') {
      if (!params.selector) throw new Error('type requires params.selector (a CSS selector)');
      return driveOnTab(tab.id, 'type', { selector: params.selector, text: params.text || '', clear: params.clear !== false }).then(function (r) {
        return { ok: true, action: action, tabId: tab.id, url: tab.url, result: r };
      });
    }
    if (action === 'navigate') {
      if (!params.url) throw new Error('navigate requires params.url');
      return driveOnTab(tab.id, 'navigate', { url: params.url }).then(function (r) {
        return { ok: true, action: action, tabId: tab.id, url: params.url, result: r, note: 'page is navigating; re-screenshot after a beat to see the new page' };
      });
    }
    if (action === 'active') {
      // Activate a tab by id and bring its window into focus.
      if (typeof params.tabId !== 'number') throw new Error('active requires params.tabId');
      return chrome.tabs.get(params.tabId).then(function (t) {
        if (!t || t.id == null) throw new Error('active: no tab with id ' + params.tabId);
        return chrome.tabs.update(t.id, { active: true }).then(function () {
          var hasWindow = typeof t.windowId === 'number' && t.windowId >= 0;
          if (!hasWindow) return { ok: true, action: action, tabId: t.id, url: t.url, title: t.title, note: 'no window id' };
          return chrome.windows.update(t.windowId, { focused: true }).then(
            function () { return { ok: true, action: action, tabId: t.id, url: t.url, title: t.title }; },
            function (e) {
              return { ok: true, action: action, tabId: t.id, url: t.url, title: t.title, note: 'window focus failed (tab already active)' };
            }
          );
        });
      });
    }
    if (action === 'listTabs') {
      var limit = typeof params.limit === 'number' ? Math.max(1, Math.min(params.limit, 500)) : 50;
      return chrome.tabs.query({}).then(function (tabs) {
        var out = [];
        for (var i = 0; i < tabs.length; i++) {
          var t = tabs[i];
          out.push({ id: t.id, url: t.url || '', title: t.title || '', active: false, pinned: t.pinned || false });
        }
        return chrome.tabs.query({ active: true, currentWindow: true }).then(function (act) {
          if (act && act.length) {
            for (var j = 0; j < out.length; j++) {
              if (out[j].id === act[0].id) out[j].active = true;
            }
          }
          return { ok: true, action: action, total: out.length, tabs: out.slice(0, limit) };
        });
      });
    }
    if (action === 'getActiveTab') {
      return chrome.tabs.query({ active: true, currentWindow: true }).then(function (tabs) {
        if (!tabs || !tabs.length) return { ok: true, action: action, active: null };
        return { ok: true, action: action, active: { id: tabs[0].id, url: tabs[0].url || '', title: tabs[0].title || '' } };
      });
    }
    if (action === 'getPageText') {
      return driveOnTab(tab.id, 'getPageText', { maxChars: typeof params.maxChars === 'number' ? params.maxChars : 10000 }).then(function (r) {
        return {
          ok: true,
          action: action,
          tabId: tab.id,
          url: tab.url,
          title: tab.title,
          text: (r && r.text) || '',
          length: (r && r.length) || 0,
          truncated: !!(r && r.truncated)
        };
      });
    }

    if (action === 'getPageContext') {
      return driveOnTab(tab.id, 'getPageContext', {
        maxChars: typeof params.maxChars === 'number' ? params.maxChars : 50000,
        maxLinks: typeof params.maxLinks === 'number' ? params.maxLinks : 50,
        maxHeadings: typeof params.maxHeadings === 'number' ? params.maxHeadings : 30,
        maxForms: typeof params.maxForms === 'number' ? params.maxForms : 10,
        maxTables: typeof params.maxTables === 'number' ? params.maxTables : 5
      }).then(function (r) {
        return {
          ok: true,
          action: action,
          tabId: tab.id,
          url: tab.url,
          title: tab.title,
          context: (r && r.context) || null
        };
      });
    }
    if (action === 'readPage') {
      // Capture a specific tab: screenshot (base64) + DOM text.
      // Requires params.tabId (the tab to read).
      if (!params.tabId || typeof params.tabId !== 'number') {
        throw new Error('readPage requires params.tabId (a numeric tab id)');
      }
      return chrome.tabs.get(params.tabId).then(function (targetTab) {
        if (!targetTab || !isWebUrl(targetTab.url)) {
          throw new Error('tab ' + params.tabId + ' is not a web page');
        }
        var hasWindow = typeof targetTab.windowId === 'number' && targetTab.windowId >= 0;
        // Activate the target tab, capture screenshot, get page text.
        var originalActive;
        return chrome.tabs.query({ active: true, currentWindow: true }).then(function (act) {
          originalActive = act && act.length ? act[0].id : null;
          return hasWindow ? chrome.windows.update(targetTab.windowId, { focused: true }) : Promise.resolve();
        }).then(function () {
          return chrome.tabs.update(targetTab.id, { active: true });
        }).then(function () {
          // Capture screenshot in background (activate target first).
          return chrome.tabs.captureVisibleTab(
            hasWindow ? targetTab.windowId : undefined,
            { format: 'png' }
          );
        }).then(function (dataUrl) {
          // Restore original active tab.
          if (originalActive && originalActive !== targetTab.id) {
            chrome.tabs.update(originalActive, { active: true }).catch(function () {});
          }
          var image = dataUrl.indexOf(',') >= 0 ? dataUrl.slice(dataUrl.indexOf(',') + 1) : dataUrl;
          // Get page text from the target tab via content script.
          return driveOnTab(targetTab.id, 'getPageText', { maxChars: typeof params.maxChars === 'number' ? params.maxChars : 10000 }).then(function (r) {
            return {
              ok: true,
              action: action,
              tabId: targetTab.id,
              url: targetTab.url || '',
              title: targetTab.title || '',
              image: image,
              text: (r && r.text) || '',
              length: (r && r.length) || 0,
              truncated: !!(r && r.truncated)
            };
          });
        });
      });
    }
    if (action === 'driveType') {
      if (!params.selector) throw new Error('driveType requires params.selector');
      return driveOnTab(tab.id, 'driveType', { selector: params.selector, text: params.text || '', pressEnter: !!params.pressEnter, clear: params.clear !== false }).then(function (r) {
        return { ok: true, action: action, tabId: tab.id, url: tab.url, title: tab.title, result: r };
      });
    }
    if (action === 'driveGetPageText') {
      return driveOnTab(tab.id, 'driveGetPageText', { maxChars: typeof params.maxChars === 'number' ? params.maxChars : 10000 }).then(function (r) {
        return { ok: true, action: action, tabId: tab.id, url: tab.url, title: tab.title, text: (r && r.text) || '', length: (r && r.length) || 0, truncated: !!(r && r.truncated) };
      });
    }
    if (action === 'getElementRect') {
      // Get the bounding rect of an element — enables vision model to place
      // bounding boxes on screenshots for clickable element targeting.
      if (!params.selector) throw new Error('getElementRect requires params.selector');
      return driveOnTab(tab.id, 'getElementRect', { selector: params.selector }).then(function (r) {
        return { ok: true, action: action, tabId: tab.id, url: tab.url, found: !!r.found, x: r.x || 0, y: r.y || 0, width: r.width || 0, height: r.height || 0, error: r.error || undefined };
      });
    }
    if (action === 'autoFormFill') {
      // Automatically fill form fields by matching field names to labels,
      // placeholders, or name attributes. Useful for filling out forms without
      // knowing exact CSS selectors.
      if (!params.formData || typeof params.formData !== 'object') {
        throw new Error('autoFormFill requires params.formData (object mapping field names to values)');
      }
      return driveOnTab(tab.id, 'autoFormFill', { formData: params.formData, pressEnter: !!params.pressEnter }).then(function (r) {
        return { ok: true, action: action, tabId: tab.id, url: tab.url, filled: r.filled || 0, total: r.total || Object.keys(params.formData).length, failed: r.failed || [] };
      });
    }
    return { ok: false, action: action, error: 'unknown action: ' + action };
  }).catch(function (err) {
    return { ok: false, action: action, error: String((err && err.message) || err) };
  });
}

// The loopback bridge that owns the /cmd pipeline.
// Discovered via .well-known/bridge-info on startup; falls back to :3081.
var BRIDGE = 'http://127.0.0.1:3081';
(function discoverBridge() {
  fetch('http://127.0.0.1:3081/.well-known/bridge-info', { cache: 'no-store' })
    .then(function (r) { return r.json(); })
    .then(function (info) {
      BRIDGE = 'http://127.0.0.1:' + info.port;
    })
    .catch(function () { /* keep default :3081 */ });
})();

// Post an executed command result to the bridge so its pending store
// (and the agent polling GET /cmd?cmd=<id>) resolves. The bridge
// writes any base64 result.image to CAPTURES_DIR/<id>.png and replaces
// it with result.imagePath.
function postCmdResult(id, result, error) {
  return fetch(BRIDGE + '/cmd/result', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: id, result: result, error: error }),
  }).catch(function () { /* loopback down; swallow */ });
}

// Handle a relayed command from the side panel.
// The panel polls GET /cmd/pending and forwards each as
//   { type: 'chrome-eye:cmd', cmdId: <id>, action: <a>, params: <p> }
// where cmdId is the exact id the agent used. We must echo it back verbatim
// (as the bridge's pending store key) or the result lands on the wrong row.
chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || !message.type || message.type !== 'chrome-eye:cmd') {
    sendResponse({ type: 'chrome-eye:cmd-result', id: message && (message.id || message.cmdId) || '', ok: false, error: 'expected type chrome-eye:cmd' });
    return;
  }
  var id = message.cmdId || message.id || 'anon';
  executeCmd(message).then(function (result) {
    sendResponse({ type: 'chrome-eye:cmd-result', id: id, ok: true, ...result });
    postCmdResult(id, result, null).then(function () {});
  }, function (err) {
    var msg = String((err && err.message) || err);
    sendResponse({ type: 'chrome-eye:cmd-result', id: id, ok: false, error: msg });
    postCmdResult(id, null, msg).then(function () {});
  });
  return true; // keep the channel open for the async response
});
