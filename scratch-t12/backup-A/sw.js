// Chrome Eye service worker (CP-6: T6.6–T6.9, CP-7: T7.10)
// Relays panel ↔ content messages, captures the visible tab, composes the
// final share payload, and POSTs it to the loopback bridge on :3081 —
// NEVER http://127.0.0.1:3080/api/* directly (trust fence).
'use strict';

console.log('Chrome Eye service worker active');

// Clicking the toolbar action opens the side panel (MV3: default is NO-OP
// when no popup is declared and this behavior is not registered).
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch(function (e) { console.error('Chrome Eye: sidePanel behavior failed', e); });

var SHARE_ENDPOINT = 'http://127.0.0.1:3081/share';

// Latest active DSH session id reported by the content script running
// inside the panel's GUI iframe (origin http://127.0.0.1:3080, read from
// the GUI's own localStorage key "dsh.sessions.current"). Module-level
// variable: a service-worker restart loses the cache (acceptable for the
// MVP) — the GUI poller re-reports the current id within ~2 s of any wake
// (the SW wakes on messages and on share clicks), so the cache rebuilds
// immediately. Latest non-empty id wins; empty reports do not clear it.
var guiSessionId = null;

// T11.2 — side-panel open/close (panel.js reports it) and the staged
// context-chip list. The SW is the single source of truth for chips; the
// GUI content script is a pure view over it. Module state is lost on SW
// restart: panelOpen resets to false (the GUI poller hides the row within
// ~2 s) and the staged list is rebuilt when the panel re-opens.
var panelOpen = false;
var stagedTabs = [];

function getActiveTab() {
  return chrome.tabs.query({ active: true, currentWindow: true }).then(function (tabs) {
    return tabs && tabs.length ? tabs[0] : null;
  });
}

function isWebUrl(url) {
  return typeof url === 'string' &&
    (url.indexOf('http://') === 0 || url.indexOf('https://') === 0);
}

// T6.6 — round-trip: ask the tab's content script for the T6.5 capture object
// ({url, title, text, links, headings}).
// T11.2 — if the tab has no live receiver (opened before install/reload —
// the known pre-install limitation), inject content.js via
// chrome.scripting (isolated world = the declared content-script world)
// and retry the capture message once. Best effort: if that still fails the
// chip fails with a clear message and the other staged tabs proceed.
function captureTab(tabId) {
  return chrome.tabs
    .sendMessage(tabId, { type: 'chrome-eye:capture' })
    .catch(function (err) {
      var msg = String((err && err.message) || err);
      if (msg.indexOf('Receiving end does not exist') === -1) {
        throw new Error('tab capture failed: ' + msg + ' (tab ' + tabId + ')');
      }
      return chrome.scripting
        .executeScript({ target: { tabId: tabId }, files: ['content.js'] })
        .then(function () {
          return chrome.tabs.sendMessage(tabId, { type: 'chrome-eye:capture' });
        })
        .catch(function (retryErr) {
          throw new Error(
            'tab capture failed after content-script injection: ' +
            String((retryErr && retryErr.message) || retryErr) + ' (tab ' + tabId + ')');
        });
    });
}

// T11.3 — resolve the destination for GUI content-script messages. Returns
// a descriptor { id, frameId }: frameId is undefined for a real browser tab
// (top frame) and the child frame id for the panel-frame fallback below.
// The panel reports the tab id it just found (chrome.tabs.query on its
// side); that is preferred, falling back to the first tab on :3080. All
// :3080 instances share dsh.sessions.current and follow each other via
// storage events, so the first tab is semantically fine.
function findGuiTab(preferredTabId) {
  if (typeof preferredTabId === 'number' && isFinite(preferredTabId)) {
    return chrome.tabs.get(preferredTabId).then(function (tab) {
      return tab && tab.id != null ? { id: tab.id } : null;
    }, function () { return null; });
  }
  return chrome.tabs.query({ url: 'http://127.0.0.1:3080/*' }).then(function (tabs) {
    if (tabs && tabs.length) return { id: tabs[0].id }; // real tab is PREFERRED
    return findPanelGuiFrame(); // panel-only mode fallback
  });
}

// Panel-only fallback: no real :3080 tab is open, but the panel page
// (chrome-extension://<id>/panel.html — a tab while the side panel is
// open) embeds the GUI in a child iframe. Content scripts never run on
// extension pages or in that iframe (the declared content script is
// top-frame-only and never matches chrome-extension://), so
// guiTabRoundTrip injects content.js into exactly that frame on demand.
// Only COMMITTED frames are visible to webNavigation: a 401 or
// not-yet-committed iframe (no auth cookie, or the first-click race
// before the iframe loads) yields null here → the caller keeps the
// original "no DSH GUI tab found" error (graceful degradation).
function findPanelGuiFrame() {
  var prefix = 'chrome-extension://' + chrome.runtime.id + '/panel.html';
  var guiPrefix = 'http://127.0.0.1:3080/';
  return chrome.tabs.query({}).then(function (tabs) {
    var tab = null;
    for (var i = 0; i < tabs.length; i++) {
      if (String(tabs[i].url || '').indexOf(prefix) === 0) { tab = tabs[i]; break; }
    }
    if (!tab) return null; // panel not open
    return chrome.webNavigation.getAllFrames({ tabId: tab.id }).then(function (frames) {
      for (var j = 0; j < frames.length; j++) {
        if (String(frames[j].url || '').indexOf(guiPrefix) === 0) {
          return { id: tab.id, frameId: frames[j].frameId };
        }
      }
      return null; // no committed :3080 frame (401 / not loaded yet)
    }, function () {
      return null; // webNavigation unavailable → original error path
    });
  });
}

// T11.3/T11.4 — relay one message to the resolved GUI destination (real
// tab top frame, or the panel's :3080 iframe when target.frameId is set),
// with the same pre-install fallback as captureTab: if the destination has
// no live receiver, inject content.js via chrome.scripting and retry once.
// For the panel iframe the injection targets that specific frame
// (frameIds — never all_frames), since no declared content script runs
// there at all.
function guiTabRoundTrip(preferredTabId, payload) {
  return findGuiTab(preferredTabId).then(function (tab) {
    if (!tab) {
      throw new Error('no DSH GUI tab found — open http://127.0.0.1:3080 in a browser tab first');
    }
    var sendOpts = tab.frameId != null ? { frameId: tab.frameId } : {};
    return chrome.tabs.sendMessage(tab.id, payload, sendOpts).catch(function (err) {
      var msg = String((err && err.message) || err);
      if (msg.indexOf('Receiving end does not exist') === -1) throw err;
      var execTarget = { tabId: tab.id };
      if (tab.frameId != null) execTarget.frameIds = [tab.frameId];
      return chrome.scripting
        .executeScript({ target: execTarget, files: ['content.js'] })
        .then(function () {
          return chrome.tabs.sendMessage(tab.id, payload, sendOpts);
        })
        .catch(function (retryErr) {
          throw new Error(
            'GUI tab has no live content script (reload that tab once): ' +
            String((retryErr && retryErr.message) || retryErr));
        });
    });
  });
}

// T6.7 — chrome.tabs.captureVisibleTab → PNG; strip the data: URL prefix so
// the payload carries raw base64 (T6.8).
function captureScreenshot() {
  return chrome.tabs.captureVisibleTab(null, { format: 'png' }).then(function (dataUrl) {
    var i = dataUrl.indexOf(',');
    return i >= 0 ? dataUrl.slice(i + 1) : dataUrl;
  });
}

// T6.8 / T6.9 — final payload = T6.5 context + base64 image; when the image
// is absent (capture failed) the payload simply omits the image field.
function composePayload(context, image) {
  var payload = {
    url: context.url,
    title: context.title,
    visibleText: context.text, // bridge reads visibleText (spec name)
    links: context.links,
    headings: context.headings
  };
  if (image) payload.image = image;
  // When the GUI iframe reported an active session, the bridge injects
  // this page into that session (session.prompt, mode "queue"); without a
  // sessionId it falls back to a captures/<ts>.json file.
  if (guiSessionId) payload.sessionId = guiSessionId;
  return payload;
}

// T7.10 — POST a composed share payload to the bridge and parse the
// response body so the UI can distinguish "queued into the session"
// ({ok,injected:true}) from the "saved to captures" fallback
// ({ok,fallback:true}) and surface a real error string from {ok:false,error}.
function postShare(payload, context) {
  return fetch(SHARE_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  }).then(function (res) {
    return res.text().then(function (text) {
      var body = null;
      try { body = JSON.parse(text); } catch (e) { body = null; }
      var error = null;
      if (body && body.error !== undefined) {
        error = typeof body.error === 'string'
          ? body.error
          : (body.error.message || body.error.code || 'share error');
      }
      return {
        ok: res.ok,
        status: res.status,
        injected: !!(body && body.injected === true),
        fallback: !!(body && body.fallback === true),
        error: error,
        url: context.url,
        title: context.title,
        textLength: context.text ? context.text.length : 0
      };
    }, function () {
      return Promise.reject(new Error(
        'bridge response could not be read (HTTP ' + res.status + ')'));
    });
  }, function (e) {
    return Promise.reject(new Error(
      'bridge POST to ' + SHARE_ENDPOINT + ' failed: ' +
      String((e && e.message) || e)));
  });
}

// Full share flow: active tab → capture → screenshot (best effort) →
// compose payload → log it (T6.8 acceptance) → POST to the bridge (T7.10).
function sharePage() {
  return getActiveTab().then(function (tab) {
    if (!tab || !tab.id) return Promise.reject(new Error('no active tab to share'));
    return captureTab(tab.id).then(function (context) {
      if (!context || typeof context !== 'object' || !('title' in context)) {
        return Promise.reject(new Error(
          'content script returned no capture (tab: ' + tab.url + ')'));
      }
      console.log('Chrome Eye capture context', context);
      return captureScreenshot().catch(function (e) {
        console.warn('Chrome Eye: screenshot failed — sharing text only (T6.9)', e);
        return null;
      }).then(function (image) {
        var payload = composePayload(context, image);
        console.log('Chrome Eye share payload', payload);
        return postShare(payload, context).then(function (result) {
          result.hasImage = !!image;
          return result;
        });
      });
    });
  });
}

// T11.2 — share one staged chip: capture the tab by id (with the
// content-script-injection fallback), attach a screenshot only while the
// tab is the active tab (captureVisibleTab cannot see background tabs),
// then POST the same /share payload shape (sessionId included) as the
// panel share.
function shareTab(tabId) {
  return chrome.tabs.get(tabId).then(function (tab) {
    if (!tab || !tab.id) return Promise.reject(new Error('tab no longer exists: ' + tabId));
    return captureTab(tabId).then(function (context) {
      if (!context || typeof context !== 'object' || !('title' in context)) {
        return Promise.reject(new Error('no capture from tab ' + tabId));
      }
      var imagePromise = tab.active && isWebUrl(tab.url)
        ? captureScreenshot().catch(function () { return null; })
        : Promise.resolve(null); // background tabs: text only
      return imagePromise.then(function (image) {
        return postShare(composePayload(context, image), context);
      });
    });
  });
}

// T11.2 — add a tab to the staged chip list (deduped by tab id).
function stageTab(tab) {
  for (var i = 0; i < stagedTabs.length; i++) {
    if (stagedTabs[i].id === tab.id) return;
  }
  stagedTabs.push({
    id: tab.id,
    title: tab.title || tab.url,
    url: tab.url,
    favIconUrl: tab.favIconUrl || '',
    active: !!tab.active
  });
}

// T11.2 — the "→ add to session" action: capture + POST each staged chip
// sequentially (one /share per chip; sequential so the session queue keeps
// the order the user staged them). The list clears only when every chip
// succeeded — otherwise the chips stay for a retry. The outcome is also
// mirrored to the panel bottom-bar status via a runtime message.
function addStagedToSession() {
  var items = stagedTabs.slice();
  if (!items.length) {
    return Promise.resolve({
      ok: false, added: 0, total: 0, injected: false, fallback: false,
      status: null, error: 'no staged pages', staged: stagedTabs
    });
  }
  var results = [];
  var chain = Promise.resolve();
  items.forEach(function (item) {
    chain = chain.then(function () {
      return shareTab(item.id).then(
        function (r) { results.push(r); },
        function (e) {
          results.push({ ok: false, error: String((e && e.message) || e), title: item.title });
        }
      );
    });
  });
  return chain.then(function () {
    var okCount = 0, injected = false, allFallback = true,
        firstError = null, bridgeStatus = null;
    for (var i = 0; i < results.length; i++) {
      var r = results[i];
      if (r.ok) {
        okCount++;
        if (bridgeStatus === null) bridgeStatus = r.status;
        if (r.injected) injected = true;
        if (!r.fallback) allFallback = false;
      } else if (firstError === null) {
        firstError = r.error;
        allFallback = false;
      }
    }
    var allOk = okCount === results.length;
    if (allOk) stagedTabs = [];
    var resp = {
      ok: allOk,
      added: okCount,
      total: results.length,
      injected: injected,
      fallback: allOk && allFallback,
      status: bridgeStatus,
      error: firstError,
      staged: stagedTabs
    };
    // Mirror the outcome into the panel bottom-bar status (T11.6).
    try {
      chrome.runtime.sendMessage({ type: 'chrome-eye:share-result', result: resp }, function () {
        void chrome.runtime.lastError; // panel may not be open — fine
      });
    } catch (e) { /* extension context gone */ }
    return resp;
  });
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (!message || typeof message.type !== 'string') return false;

  // GUI iframe content script → active-session report (page → next-prompt
  // context). Cache the latest non-empty id; empty reports (no session
  // open in the GUI) are ignored rather than clearing the cache.
  if (message.type === 'chrome-eye:gui-session') {
    var id = typeof message.sessionId === 'string' ? message.sessionId.trim() : '';
    if (id.length > 0) guiSessionId = id;
    return false;
  }

  // T11.2 — panel open/close from panel.js (chip-row visibility signal).
  if (message.type === 'chrome-eye:panel-open') {
    panelOpen = true;
    // The active web tab becomes a chip (removable via ✕).
    getActiveTab().then(function (tab) {
      if (tab && tab.id != null && isWebUrl(tab.url)) stageTab(tab);
    }).catch(function () { /* nothing to stage */ });
    return false;
  }
  if (message.type === 'chrome-eye:panel-closed') {
    panelOpen = false;
    return false;
  }
  // GUI content script → panel state + staged chips (view sync, polled on
  // the same 2 s cadence as the session report).
  if (message.type === 'chrome-eye:panel-state') {
    sendResponse({ ok: true, panelOpen: panelOpen, staged: stagedTabs });
    return false;
  }
  // GUI content script → this window's http(s) tabs for the "+" picker
  // (capped at 30).
  if (message.type === 'chrome-eye:list-tabs') {
    chrome.tabs.query({ currentWindow: true }, function (tabs) {
      var list = [];
      for (var li = 0; li < tabs.length && list.length < 30; li++) {
        var t = tabs[li];
        if (!isWebUrl(t.url)) continue;
        list.push({
          id: t.id,
          title: t.title || t.url,
          url: t.url,
          favIconUrl: t.favIconUrl || '',
          active: !!t.active
        });
      }
      sendResponse({ ok: true, tabs: list });
    });
    return true; // async response
  }
  // GUI content script → stage a tab as a chip (by id, or the active tab).
  if (message.type === 'chrome-eye:stage-tab') {
    (message.tabId != null ? chrome.tabs.get(message.tabId) : getActiveTab()).then(
      function (tab) {
        if (!tab || tab.id == null || !isWebUrl(tab.url)) {
          sendResponse({ ok: false, error: 'only http(s) tabs can be staged', staged: stagedTabs });
          return;
        }
        stageTab(tab);
        sendResponse({ ok: true, staged: stagedTabs });
      },
      function (err) {
        sendResponse({ ok: false, error: String((err && err.message) || err), staged: stagedTabs });
      }
    );
    return true; // async response
  }
  // GUI content script → remove a chip (sync).
  if (message.type === 'chrome-eye:unstage-tab') {
    var kept = [];
    for (var ki = 0; ki < stagedTabs.length; ki++) {
      if (stagedTabs[ki].id !== message.tabId) kept.push(stagedTabs[ki]);
    }
    stagedTabs = kept;
    sendResponse({ ok: true, staged: stagedTabs });
    return false;
  }
  // GUI content script → "→ add to session": sequential capture + /share of
  // every staged chip.
  if (message.type === 'chrome-eye:add-staged') {
    addStagedToSession().then(function (resp) {
      sendResponse(resp);
    });
    return true; // async response
  }

  // T11.3 — panel → workspace tree from the GUI sidebar DOM (on demand;
  // never a :3080/api call — trust fence). The SW-cached session id is
  // attached as a cross-check/footer value (lossy on SW restart — fine,
  // the DOM aria-selected mark is authoritative).
  if (message.type === 'chrome-eye:workspace-tree') {
    guiTabRoundTrip(message.tabId, { type: 'chrome-eye:scrape-tree' }).then(
      function (res) {
        if (res && res.ok) res.cachedCurrentId = guiSessionId;
        sendResponse(res || { ok: false, error: 'empty content-script response' });
      },
      function (err) {
        sendResponse({ ok: false, error: String((err && err.message) || err) });
      }
    );
    return true; // async response
  }
  // T11.3 — panel → open a session in the GUI sidebar (row .click()).
  if (message.type === 'chrome-eye:open-session') {
    guiTabRoundTrip(message.tabId, {
      type: 'chrome-eye:open-session',
      workspace: message.workspace,
      title: message.title
    }).then(
      function (res) { sendResponse(res || { ok: false, error: 'empty content-script response' }); },
      function (err) { sendResponse({ ok: false, error: String((err && err.message) || err) }); }
    );
    return true; // async response
  }
  // T11.3 — panel → expand a collapsed group (overflow-button .click()).
  if (message.type === 'chrome-eye:expand-group') {
    guiTabRoundTrip(message.tabId, {
      type: 'chrome-eye:expand-group',
      workspace: message.workspace
    }).then(
      function (res) { sendResponse(res || { ok: false, error: 'empty content-script response' }); },
      function (err) { sendResponse({ ok: false, error: String((err && err.message) || err) }); }
    );
    return true; // async response
  }
  // T11.4 — panel → open/close the workspace overlay in the GUI tab.
  if (message.type === 'chrome-eye:overlay') {
    guiTabRoundTrip(message.tabId, {
      type: 'chrome-eye:overlay',
      open: message.open !== false
    }).then(
      function (res) { sendResponse(res || { ok: false, error: 'empty content-script response' }); },
      function (err) { sendResponse({ ok: false, error: String((err && err.message) || err) }); }
    );
    return true; // async response
  }

  // Panel → full share flow (T7.10).
  if (message.type === 'chrome-eye:share-page') {
    sharePage().then(
      function (result) { sendResponse(result); },
      function (err) {
        console.error('Chrome Eye share failed:', err);
        sendResponse({ ok: false, error: String((err && err.message) || err) });
      }
    );
    return true; // async response
  }

  // Panel → generic relay to a tab (default: active tab); the tab's response
  // is relayed back to the panel.
  if (message.type === 'chrome-eye:send-to-tab') {
    var tabId = message.tabId != null ? message.tabId : null;
    (tabId != null ? Promise.resolve({ id: tabId }) : getActiveTab()).then(
      function (tab) {
        if (!tab || !tab.id) throw new Error('no target tab');
        return chrome.tabs.sendMessage(tab.id, message.message).then(function (response) {
          sendResponse({ ok: true, response: response });
        });
      },
      function (err) {
        sendResponse({ ok: false, error: String((err && err.message) || err) });
      }
    );
    return true; // async response
  }

  return false;
});
