// Chrome Eye panel (T11.6) — no share button anymore: the context chip row
// in the embedded GUI (content.js) is the share UI. The panel's job here is
// (1) tell the service worker when the side panel opens/closes (that drives
// the chip row's visibility), and (2) mirror the chip-share outcome into the
// bottom-bar #share-status span.
(function () {
  'use strict';

  var status = document.getElementById('share-status');
  if (!status) {
    status = document.createElement('span');
    status.id = 'share-status';
    var bar = document.getElementById('bottom-bar');
    (bar || document.body).appendChild(status);
  }
  // Task C: all coloring lives in panel.html's <style> (dark DSH tokens);
  // this file only sets text + the .ce-status-ok/.ce-status-err class.
  function setStatus(text, isError) {
    if (!text) return;
    status.textContent = text;
    status.setAttribute('class', isError ? 'ce-status-err' : 'ce-status-ok');
  }

  // Fire-and-forget, callback form: safe during unload (no open port to
  // hold, lastError swallowed — the SW handler needs no response).
  function tellSw(type) {
    try {
      chrome.runtime.sendMessage({ type: type }, function () {
        void chrome.runtime.lastError;
      });
    } catch (e) { /* extension context gone — nothing to tell */ }
  }

  // The side panel page exists only while it is open.
  tellSw('chrome-eye:panel-open');
  window.addEventListener('beforeunload', function () {
    tellSw('chrome-eye:panel-closed');
  });
  window.addEventListener('pagehide', function () {
    tellSw('chrome-eye:panel-closed');
  });

  // Task J — the prompt-time attach outcome: the SW captured the staged
  // pages the instant the user hit Enter in the GUI composer, and the
  // context block was appended to the prompt. The composer itself shows
  // what happened (the appended block) — this bottom-bar line is the
  // panel-side confirmation.
  chrome.runtime.onMessage.addListener(function (message) {
    if (!message || message.type !== 'chrome-eye:attach-result') return;
    var res = message.result;
    if (!res) return;
    if (res.ok) {
      setStatus(
        '📎 ' + res.attached + ' page' + (res.attached === 1 ? '' : 's') +
        ' attached to your prompt' +
        (res.failed ? ' (' + res.failed + ' could not be captured)' : ''),
        false
      );
    }
    // A refused attach (nothing captured) is reported in the composer by
    // the hook itself; the staged list was already cleared there, so there
    // is nothing to retry from here.
  });

  // ------------------------------------------------------------------
  // Agent command channel (bridge /cmd) + screenshot preview.
  //
  // The DSH agent drives the browser through a Host model tool (chrome-eye)
  // that POSTs commands to the bridge. This panel is the RELAY: it polls
  // GET /cmd/pending for new commands, forwards each to the service worker
  // ('chrome-eye:cmd'), and the SW executes it on the target tab and writes
  // the result back to /cmd/result (the model tool then polls GET /cmd?cmd=
  // <id>). Screenshot results are also broadcast to this panel as
  // 'chrome-eye:screenshot' so the preview overlay updates live.
  // ------------------------------------------------------------------
  var CMD_BASE = 'http://127.0.0.1:3081';

  // Screenshot preview overlay (added to panel.html this change).
  var ssOverlay = document.getElementById('screenshot-overlay');
  var ssTitle = document.getElementById('ss-title');
  var ssCaptureBtn = document.getElementById('ss-capture');
  var ssCloseBtn = document.getElementById('ss-close');
  var ssImgWrap = document.getElementById('ss-img-wrap');
  var ssLoading = document.getElementById('ss-img-loading');
  var ssAutoHideTimer = null;
  var ssUserDismissed = false;

  function ssShowImage(title, image) {
    if (!ssOverlay) return;
    if (ssTitle) ssTitle.textContent = title || 'screenshot';
    if (ssImgWrap) {
      ssImgWrap.textContent = '';
      var img = document.createElement('img');
      img.id = 'ss-img';
      img.alt = title || 'screenshot';
      img.src = 'data:image/png;base64,' + image;
      ssImgWrap.appendChild(img);
    }
    if (ssLoading) ssLoading.setAttribute('hidden', '');
    ssOverlay.removeAttribute('hidden');
    ssStartAutoHide();
  }

  function ssShowLoading(title) {
    if (!ssOverlay) return;
    if (ssTitle) ssTitle.textContent = title || 'capturing…';
    if (ssImgWrap) {
      ssImgWrap.textContent = '';
      var span = document.createElement('span');
      span.id = 'ss-img-loading';
      span.textContent = 'capturing…';
      ssImgWrap.appendChild(span);
    }
    ssOverlay.removeAttribute('hidden');
  }

  function ssClose() {
    if (ssOverlay) {
      ssOverlay.setAttribute('hidden', '');
      ssUserDismissed = true;
      if (ssAutoHideTimer) { clearTimeout(ssAutoHideTimer); ssAutoHideTimer = null; }
    }
  }

  function ssStartAutoHide() {
    if (ssAutoHideTimer) clearTimeout(ssAutoHideTimer);
    ssAutoHideTimer = setTimeout(function () {
      if (ssOverlay && !ssOverlay.hasAttribute('hidden')) {
        ssOverlay.setAttribute('hidden', '');
        ssUserDismissed = true;
      }
    }, 8000);
  }

  // A finished screenshot (from the SW: either a staged-on-add snapshot or a
  // /cmd screenshot result) is relayed here as a runtime broadcast. Render it
  // into the overlay; if the user closed the overlay we do NOT reopen it
  // (that was the "consistently overlaid" complaint). A new explicit capture
  // (📷 button) always shows the loading state regardless.
  chrome.runtime.onMessage.addListener(function (message) {
    if (!message || message.type !== 'chrome-eye:screenshot') return;
    if (!message.image) return;
    // If the user dismissed the overlay, do not force it back. The image is
    // still saved to disk; the agent can request it again explicitly.
    if (ssUserDismissed) return;
    var title = message.title || 'screenshot';
    if (message.url) title = title + '  —  ' + message.url;
    ssShowImage(title, message.image);
  });

  if (ssCloseBtn) {
    ssCloseBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      ssClose();
    });
  }

  // The staging-row 📷 button: capture the ACTIVE content tab on demand
  // (what the agent sees). Generate a command id, POST it to the bridge, and
  // the SW will execute + broadcast the screenshot back to this overlay.
  function ssCaptureActive() {
    if (!ssOverlay) return;
    ssUserDismissed = false;
    ssShowLoading('capturing active tab…');
    var id = 'ss-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    fetch(CMD_BASE + '/cmd', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: id, action: 'screenshot', params: {} })
    }).then(function (res) {
      return res.json();
    }).then(function (r) {
      if (!r || !r.ok) throw new Error((r && r.error) || 'bridge rejected the command');
      // The SW relay picks the command up on its next poll and broadcasts the
      // screenshot; nothing more to do here (the overlay updates itself).
      void r.id;
    }).catch(function (e) {
      setStatus('screenshot failed: ' + String((e && e.message) || e), true);
    });
  }
  if (ssCaptureBtn) {
    ssCaptureBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      ssCaptureActive();
    });
  }
  // The staging-row 📷 button (same action, different placement).
  var ssCaptureRow = document.getElementById('ss-capture-row');
  if (ssCaptureRow) {
    ssCaptureRow.addEventListener('click', function (ev) {
      ev.stopPropagation(); // do NOT toggle the staged dropdown
      ssCaptureActive();
    });
  }

  // The relay loop: poll /cmd/pending every second; forward each NEW command
  // (not yet relayed) to the SW. The SW executes it and posts the result; the
  // bridge then drops it from the pending list, so the next poll sees only
  // genuinely new work. A per-session relayed set guards against the rare
  // double-poll within a single tick.
  (function () {
    var relayed = {};
    function pollCmds() {
      fetch(CMD_BASE + '/cmd/pending', { cache: 'no-store' })
        .then(function (res) { return res.json(); })
        .then(function (data) {
          if (!data || !data.ok || !data.pending) return;
          for (var i = 0; i < data.pending.length; i++) {
            var cmd = data.pending[i];
            if (relayed[cmd.id]) continue;
            relayed[cmd.id] = true;
            swRequest('chrome-eye:cmd', {
              cmdId: cmd.id,
              action: cmd.action,
              params: cmd.params
            });
            setStatus('chrome-eye: executing ' + cmd.action, false);
          }
        })
        .catch(function () { /* bridge down — the 30s probe shows that */ });
    }
    pollCmds();
    setInterval(pollCmds, 1000);
  })();

  // ------------------------------------------------------------------
  // Task B (real probe) + Task G1 — bottom-bar connectivity + the dark
  // bridge-offline card over the iframe area. ONE probe to
  // http://127.0.0.1:3081/ drives everything: the bridge is a full
  // reverse proxy to :3080 and answers CORS (ACAO *), so the fetch
  // resolves exactly when the bridge — and the GUI behind it — is
  // reachable. (The old direct :3080 fetch can never succeed from an
  // extension page: the 401 gate sends no ACAO header, so it only ever
  // painted a false "GUI: down".)
  //   probe resolves -> "GUI: up · bridge: up" (green), overlay hidden;
  //                     on a down→up transition the iframe src is reset
  //                     so a load that failed while the bridge was dead
  //                     recovers without user action.
  //   probe rejects  -> "GUI: down · bridge: down" (red), overlay shows
  //                     the "bridge offline" card.
  // Re-probed on load and every 30s while the panel is open.
  // ------------------------------------------------------------------
  var connGui = document.getElementById('conn-gui');
  var connBridge = document.getElementById('conn-bridge');
  var connTimer = null;
  var bridgeOverlay = document.getElementById('bridge-overlay');
  var bridgeOverlayTitle = document.getElementById('bridge-overlay-title');
  var bridgeOverlayMsg = document.getElementById('bridge-overlay-msg');
  var dshIframe = document.getElementById('dsh-iframe');
  // null = first probe still in flight, true/false = last probe result.
  var bridgeUp = null;

  function connSegment(el, text, cls) {
    if (!el) return;
    el.textContent = text;
    el.setAttribute('class', cls);
  }

  // Task G1 — drive the dark overlay over the iframe area. "hidden"
  // removes it; "connecting" and "offline" show the card in the matching
  // state (title/message set here, colors in panel.html via data-state).
  function setBridgeOverlay(state) {
    if (!bridgeOverlay) return;
    if (state === 'hidden') {
      bridgeOverlay.setAttribute('hidden', '');
      return;
    }
    bridgeOverlay.removeAttribute('hidden');
    bridgeOverlay.setAttribute('data-state', state);
    if (bridgeOverlayTitle) {
      bridgeOverlayTitle.textContent = state === 'offline' ? 'Bridge offline' : 'Connecting…';
    }
    if (bridgeOverlayMsg) {
      bridgeOverlayMsg.textContent = state === 'offline'
        ? 'the chrome-eye bridge on 127.0.0.1:3081 is not running'
        : 'reaching the chrome-eye bridge on 127.0.0.1:3081';
    }
  }

  // Force a real iframe navigation. A same-URL `src = src` assignment is
  // a NO-OP in Chrome for an already-loaded frame (the navigation is
  // skipped entirely), so route through about:blank to commit a fresh
  // document. The manifest re-injects the composer hook on the fresh load.
  function reloadDshIframe() {
    if (!dshIframe) return;
    var u = dshIframe.getAttribute('src') || 'http://127.0.0.1:3081/';
    dshIframe.src = 'about:blank';
    setTimeout(function () { if (dshIframe) dshIframe.src = u; }, 60);
  }

  function probeConn() {
    // One probe drives both segments: :3081 is a full reverse proxy to
    // :3080 and answers CORS, so it resolves exactly when the bridge (and
    // the GUI behind it) is reachable. Any HTTP response — even a 4xx/5xx
    // from the proxied app — proves the bridge is answering; a network
    // failure (connection refused) means the bridge is down.
    function up() {
      var recovering = bridgeUp === false;
      bridgeUp = true;
      setBridgeOverlay('hidden');
      if (recovering) {
        // The iframe navigation that started while the bridge was dead
        // rendered a white failure page; force a fresh load so it
        // recovers without user action.
        reloadDshIframe();
      }
      connSegment(connGui, 'GUI: up', 'ce-conn-ok');
      connSegment(connBridge, 'bridge: up', 'ce-conn-ok');
    }
    function down() {
      bridgeUp = false;
      setBridgeOverlay('offline');
      connSegment(connGui, 'GUI: down', 'ce-conn-bad');
      connSegment(connBridge, 'bridge: down', 'ce-conn-bad');
    }
    try {
      fetch('http://127.0.0.1:3081/', { cache: 'no-store' }).then(up).catch(down);
    } catch (e) {
      down();
    }
  }

  if (connGui && connBridge) {
    probeConn();
    if (connTimer) clearInterval(connTimer);
    connTimer = setInterval(probeConn, 30000);
  }

  // ------------------------------------------------------------------
  // T2 — session-restore for the panel's GUI iframe.
  //
  // The iframe loads the DSH GUI from 127.0.0.1:3081 (the bridge). Chrome
  // partitions localStorage PER ORIGIN, so the GUI's persisted
  // "current session" cell (dsh.sessions.current) that the user built on
  // the direct GUI origin (:3080) is invisible to the iframe's :3081
  // origin — a fresh panel boot has nothing to restore. The bridge
  // injects a /session-seed <script> into the document head that seeds
  // the :3081 cell generically (latest session via the upstream RPC), but
  // the authoritative value is the :3081 origin's own localStorage,
  // which only the content script running INSIDE the frame can read and
  // write (same-origin). On every iframe load we ask that content script
  // for the cell value; if it is empty we hand it the last-seen session
  // id (or ask the bridge to resolve the latest) and the frame reloads
  // once with the seed in place. The GUI's own restore logic then picks
  // it up on the rehydrating load.
  //
  // Protocol (window.postMessage, same 'chrome-eye-hook' source as the
  // invalidation-recovery channel above):
  //   panel → frame  {source:'chrome-eye-hook', type:'chrome-eye:seed-check'}
  //   frame → panel  {source:'chrome-eye-hook', type:'chrome-eye:seed-check:result', value:<id|null>}
  //   panel → frame  {source:'chrome-eye-hook', type:'chrome-eye:seed-write', sessionId:<id>}
  //   frame → panel  {source:'chrome-eye-hook', type:'chrome-eye:seed-write:result', ok:true}
  //   panel → frame  {source:'chrome-eye-hook', type:'chrome-eye:seed-reload'}
  // ------------------------------------------------------------------
  var seedLastSeen = null;      // most recent non-null session id observed
  var seedInFlight = false;     // debounce: one seed round per load
  var seedRound = 0;            // which round we're in (0 = none)
  var SEED_ROUND_TIMEOUT_MS = 4000;

  function postToIframe(obj) {
    if (!dshIframe || !dshIframe.contentWindow) return;
    try {
      dshIframe.contentWindow.postMessage(obj, 'http://127.0.0.1:3081');
    } catch (e) { /* frame not navigated yet */ }
  }

  function iframeLoaded() {
    // The content script re-injects on every fresh load; give it a beat to
    // attach its message listener before we post the seed-check.
    setTimeout(function () {
      if (seedInFlight) return;
      seedInFlight = true;
      seedRound += 1;
      var round = seedRound;
      setTimeout(function () {
        if (round !== seedRound) return; // superseded by a newer load
        postToIframe({ source: 'chrome-eye-hook', type: 'chrome-eye:seed-check' });
      }, 400);
    }, 0);
  }

  function resolveSeedId(callback) {
    // Prefer the last-seen id (from the :3080 or :3081 origin via the SW
    // guiSessionId, mirrored here by the seed-check:result value we just
    // got back); otherwise ask the bridge to resolve the latest session
    // (it queries the upstream /api/session/list with the minted cookie).
    if (seedLastSeen) {
      callback(seedLastSeen);
      return;
    }
    fetch('http://127.0.0.1:3081/session-seed?probe=1', { cache: 'no-store' })
      .then(function (r) {
        // The bridge answers the ?id= form with a one-line script; we just
        // want the id, so ask the bridge's /session-seed in "resolve" mode
        // (no id param) which returns the seed script for the latest
        // session — parse the sessionId out of it.
        if (!r.ok) { callback(null); return; }
        return r.text();
      })
      .then(function (text) {
        var m = text && text.match(/sessionId:"([^"]+)"/);
        callback(m ? m[1] : null);
      })
      .catch(function () { callback(null); });
  }

  function onSeedResult(e) {
    var d = e.data;
    if (!d || d.source !== 'chrome-eye-hook') return;
    if (d.type === 'chrome-eye:seed-check:result') {
      var id = typeof d.value === 'string' && d.value.length > 0 ? d.value : null;
      if (id) seedLastSeen = id;
      if (seedInFlight) seedInFlight = false;
      if (id) {
        // Cell already holds a session — nothing to seed; the GUI will
        // restore it on this very load (the seed script in the head is a
        // no-op when the cell is non-empty).
        return;
      }
      // Cell empty: resolve an id and ask the frame to write it, then
      // reload once so the GUI rehydrates with the seed in place.
      seedInFlight = true;
      resolveSeedId(function (sid) {
        if (!sid) {
          seedInFlight = false;
          return; // no resolvable session — leave the frame as-is
        }
        seedLastSeen = sid;
        postToIframe({ source: 'chrome-eye-hook', type: 'chrome-eye:seed-write', sessionId: sid });
      });
      return;
    }
    if (d.type === 'chrome-eye:seed-write:result') {
      if (seedInFlight) seedInFlight = false;
      if (d.ok) {
        // Give the frame a beat to commit the write, then reload so the
        // GUI's restore logic (which runs on document load) sees the seed.
        setTimeout(function () {
          postToIframe({ source: 'chrome-eye-hook', type: 'chrome-eye:seed-reload' });
        }, 80);
      }
      return;
    }
  }

  if (dshIframe) {
    dshIframe.addEventListener('load', iframeLoaded);
    // The frame may have already loaded before this listener attached
    // (e.g. panel.js re-evaluated after an extension reload) — kick off
    // one round now. (document is same-origin here: the extension's
    // host_permissions cover :3081, so the cross-check is allowed.)
    try {
      if (dshIframe.contentWindow && dshIframe.contentWindow.document &&
          dshIframe.contentWindow.document.readyState === 'complete') {
        iframeLoaded();
      }
    } catch (e) { /* not navigated yet — the 'load' listener covers it */ }
  }
  window.addEventListener('message', onSeedResult);

  // ------------------------------------------------------------------
  // Invalidation recovery (Task J): an extension reload kills the
  // content-script context inside the still-open :3081 GUI frame — its
  // chrome.runtime is dead, so the composer hook (isolated world) can no
  // longer reach the SW and the staged-page badge/attach silently stop
  // working. The hook detects this itself (sendSw throws + runtime.id
  // undefined, gated on having connected before, so a permanently broken
  // extension can never start a reload loop) and posts
  // 'chrome-eye:context-invalidated' here; we reset the iframe src and
  // the manifest re-injects a hook with a live runtime on the fresh load.
  // ------------------------------------------------------------------
  var lastInvalidationReload = 0;
  window.addEventListener('message', function (e) {
    if (!e.data || e.data.source !== 'chrome-eye-hook' ||
        e.data.type !== 'chrome-eye:context-invalidated') return;
    var now = Date.now();
    if (now - lastInvalidationReload < 10000) return; // belt-and-braces loop guard
    lastInvalidationReload = now;
    reloadDshIframe();
  });

  // ------------------------------------------------------------------
  // Task H — in-panel "Add tabs" staging row + checkable tab list (the
  // old full-window chip strip from content.js, reworked into the panel).
  //
  // Wires panel.html #stage-row / #ts-dropdown to the EXISTING sw.js
  // messages — no new SW messages:
  //   chrome-eye:list-tabs     → dropdown rows (this window's http(s) tabs)
  //   chrome-eye:stage-tab     → check a row / chip (by id)
  //   chrome-eye:unstage-tab   → uncheck a row / chip
  //   chrome-eye:add-staged    → "→ Add to session": CONFIRM ONLY — no
  //                              capture here. The SW keeps its staged
  //                              list; the prompt-time hook in the GUI
  //                              iframe captures the pages fresh when the
  //                              user submits the next prompt (one-shot:
  //                              the staged list clears after the attach).
  //   chrome-eye:panel-state   → 2s poll keeps chips + open rows in sync
  //                              and heals after an SW restart (which
  //                              drops its module state: the staged list
  //                              starts empty — nothing is re-staged,
  //                              staging is always explicit)
  //
  // All dark styling lives in panel.html (#stage-row + .ts-* rules,
  // token-cited) — this code carries no colors (Task C rule).
  // ------------------------------------------------------------------

  var tsBtn = document.getElementById('ts-btn');
  var tsChev = document.getElementById('ts-chev'); // Task J4 — row chevron
  var tsStageRow = document.getElementById('stage-row'); // Task J4 — the toggle row
  var tsAdd = document.getElementById('ts-add'); // Task J5 — bottom of the list
  var tsDd = document.getElementById('ts-dropdown');
  var tsDdStatus = document.getElementById('ts-dd-status');
  var tsDdBody = document.getElementById('ts-dd-body');
  var tsDdOpen = false;
  var tsStaged = []; // [{id,title,url,favIconUrl,active}] — last SW snapshot
  var tsListCount = 0; // Task J5 — rows in the last list-tabs snapshot
  var tsSavedTimer = null; // Task J5 — brief "Saved N page(s)" reversion

  function tsStagedMap() {
    var m = {};
    for (var i = 0; i < tsStaged.length; i++) m[String(tsStaged[i].id)] = true;
    return m;
  }

  function tsStatus(text, isError) {
    tsDdStatus.textContent = text || '';
    tsDdStatus.setAttribute('class', isError ? 'ce-status-err' : '');
  }

  // 16×16 favicon with a neutral letter-dot fallback (no per-title hues —
  // colors come from the panel.html classes only).
  function tsFavEl(tab) {
    var box = document.createElement('span');
    box.className = 'ts-fav';
    var letter = (tab.title || '?').charAt(0).toUpperCase();
    if (tab.favIconUrl) {
      var img = document.createElement('img');
      img.className = 'ts-fav-img';
      img.alt = '';
      img.src = tab.favIconUrl;
      img.onerror = function () {
        box.removeChild(img);
        var dot = document.createElement('span');
        dot.className = 'ts-dot';
        dot.textContent = letter;
        box.appendChild(dot);
      };
      box.appendChild(img);
    } else {
      var dot = document.createElement('span');
      dot.className = 'ts-dot';
      dot.textContent = letter;
      box.appendChild(dot);
    }
    return box;
  }

  // One Gemini-style row (Task J4): 16px favicon + ONE truncated title
  // line + a check circle (filled green when selected). active=true adds
  // the " · Current tab" suffix (informational only — nothing is
  // pre-staged; the user checks rows explicitly).
  function tsRowEl(tab, on, active) {
    var row = document.createElement('div');
    row.className = on ? 'ts-row ts-row-on' : 'ts-row';
    row.setAttribute('data-tab-id', String(tab.id));
    row.title = tab.url || '';
    row.appendChild(tsFavEl(tab));
    var t = document.createElement('span');
    t.className = 'ts-title';
    t.textContent = tab.title + (active ? ' · Current tab' : '');
    row.appendChild(t);
    var chk = document.createElement('span');
    chk.className = on ? 'ts-check ts-check-on' : 'ts-check';
    chk.textContent = on ? '✓' : '';
    row.appendChild(chk);
    row.addEventListener('click', function () { tsToggleTab(tab); });
    return row;
  }

  // Task J5 — the header "(N)" text is the only selection indicator in
  // the row (the chips are gone; rows show ✓ + green border themselves).
  function tsListStatus() {
    return tsListCount
      ? tsListCount + ' pages in this window — click to check'
      : 'no http(s) pages in this window';
  }

  // Rebuild the header "(N)" + button state from an SW staged snapshot,
  // and — if the dropdown is open — refresh the existing rows in place
  // (keeps the scroll position; no rebuild).
  function tsSyncStaged(staged) {
    if (!staged || typeof staged !== 'object') return;
    tsStaged = staged;
    var on = tsStagedMap();
    tsBtn.textContent = tsStaged.length
      ? 'Add tabs (' + tsStaged.length + ')'
      : 'Add tabs';
    tsAdd.disabled = tsStaged.length === 0;
    if (tsDdOpen) {
      var kids = tsDdBody.children;
      for (var r = 0; r < kids.length; r++) {
        var el = kids[r];
        var rowId = el.getAttribute('data-tab-id');
        if (rowId === null) continue;
        var isOn = !!on[rowId];
        el.className = isOn ? 'ts-row ts-row-on' : 'ts-row';
        var c = el.querySelector('.ts-check');
        if (c) {
          c.className = isOn ? 'ts-check ts-check-on' : 'ts-check';
          c.textContent = isOn ? '✓' : '';
        }
      }
    }
  }

  // Check/uncheck one tab (row clicks pass the tab object). Task J5:
  // clicking a SELECTED row unchecks it (stage↔unstage toggle) and the
  // header "(N)" count updates from the SW snapshot. On a failed round-
  // trip (SW asleep/restarting) the click simply did nothing — the 2s
  // panel-state poll heals the UI.
  function tsToggleTab(tabOrId) {
    var id = typeof tabOrId === 'object' ? tabOrId.id : tabOrId;
    if (id == null) return;
    var type = tsStagedMap()[String(id)]
      ? 'chrome-eye:unstage-tab'
      : 'chrome-eye:stage-tab';
    swRequest(type, { tabId: id }).then(function (res) {
      if (res && res.ok) tsSyncStaged(res.staged);
    });
  }

  function tsOpenDd() {
    tsDdOpen = true;
    tsDd.removeAttribute('hidden');
    tsBtn.setAttribute('aria-expanded', 'true');
    if (tsChev) tsChev.setAttribute('aria-expanded', 'true');
    tsStatus('Loading pages…');
    tsDdBody.textContent = '';
    swRequest('chrome-eye:list-tabs').then(function (res) {
      if (!tsDdOpen) return; // closed while loading
      if (!res || !res.ok) {
        tsStatus((res && res.error) || 'could not list tabs', true);
        return;
      }
      var tabs = res.tabs || [];
      tsListCount = tabs.length;
      var on = tsStagedMap();
      for (var i = 0; i < tabs.length; i++) {
        var t = tabs[i];
        tsDdBody.appendChild(tsRowEl(t, !!on[String(t.id)], !!t.active));
      }
      tsStatus(tsListStatus());
      // Task J: nothing is selected by default — the list mirrors the
      // staged set exactly. The "· Current tab" marker stays purely
      // informational (it never stages).
    });
  }

  function tsCloseDd() {
    tsDdOpen = false;
    tsDd.setAttribute('hidden', '');
    tsBtn.setAttribute('aria-expanded', 'false');
    if (tsChev) tsChev.setAttribute('aria-expanded', 'false');
  }

  if (tsBtn && tsAdd && tsDd && tsDdBody) {
    // Task J4/J5 — the whole "Add tabs" header row toggles the list
    // (Gemini: the row IS the affordance; the chevron only mirrors its
    // state). Task J5: the header holds ONLY the label + "(N)" + chevron
    // (the chips and the Add button moved out), so every click on it
    // toggles.
    if (tsStageRow) {
      tsStageRow.addEventListener('click', function () {
        if (tsDdOpen) tsCloseDd(); else tsOpenDd();
      });
    }

    // Task J — bottom-of-list "→ Add to session": CONFIRM ONLY. No capture
    // happens here — the SW simply keeps the staged list, and the
    // prompt-time hook in the GUI iframe captures the pages fresh when the
    // user submits the next prompt (one-shot: the staged list clears after
    // the attach). The list stays open and the status line says what will
    // happen; the ✓ marks and the header "(N)" stay as they are.
    tsAdd.addEventListener('click', function () {
      if (tsAdd.disabled) return;
      swRequest('chrome-eye:add-staged').then(function (res) {
        if (res && res.ok) {
          var n = (res.staged && res.staged.length) || tsStaged.length;
          tsStatus(n + ' page' + (n === 1 ? '' : 's') + ' will attach to your next prompt');
          if (tsSavedTimer) clearTimeout(tsSavedTimer);
          tsSavedTimer = setTimeout(function () {
            if (tsDdOpen) tsStatus(tsListStatus());
          }, 3000);
        } else {
          tsStatus((res && res.error) || 'no response from the service worker', true);
        }
      });
    });

    // Outside click / Escape close the dropdown (same pattern as the
    // workspace-tree dropdown above).
    document.addEventListener('mousedown', function (ev) {
      if (!tsDdOpen) return;
      if (tsDd.contains(ev.target)) return;
      if (tsBtn.contains(ev.target)) return;
      if (tsStageRow && tsStageRow.contains(ev.target)) return; // row = toggle, not "outside"
      tsCloseDd();
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && tsDdOpen) tsCloseDd();
    });
    // Clicks on the main browser tab (or anywhere in the browser chrome)
    // never reach THIS document — the mousedown/Escape handlers above can
    // never see them — but they always blur this window. Closing on blur
    // covers every "clicked outside" case the in-document ones miss (same
    // pattern the staged-pages badge popover uses in composer-hook.js).
    window.addEventListener('blur', function () {
      if (tsDdOpen) tsCloseDd();
    });

    // 2s poll: chips + open rows stay in sync with the SW (also heals
    // after an SW restart, which drops its staged list).
    (function () {
      function poll() {
        swRequest('chrome-eye:panel-state').then(function (res) {
          if (res && res.ok) tsSyncStaged(res.staged);
        });
      }
      poll();
      setInterval(poll, 2000);
    })();
  }

  // ------------------------------------------------------------------
  // T11.3 — always-present workspace-tree dropdown; T11.4/T12.2 — overlay
  // toggle.
  //
  // Data path (T12.1): panel → SW → the panel's OWN embedded :3080 iframe
  // (self-contained scraper via chrome.scripting.executeScript — declared
  // content scripts do not run in an extension-page subframe). A real
  // :3080 browser tab stays as the automatic fallback when the panel
  // iframe isn't usable; the status lines say so when NEITHER exists.
  // ------------------------------------------------------------------

  var wsBtn = document.getElementById('ws-tree-btn');
  // Task J: the "⛶ workspace" toggle and the danger "✕ close workspace"
  // button were removed from panel.html — their lookups below stay as null
  // so the dormant overlay wiring (setOverlay + the guarded click blocks)
  // is skipped instead of throwing.
  var wsOverlayBtn = document.getElementById('ws-overlay-btn'); // null since Task J
  var wsCloseBtn = document.getElementById('ws-close-btn'); // null since Task J
  var wsDd = document.getElementById('ws-dropdown');
  var wsDdStatus = document.getElementById('ws-dd-status');
  var wsDdBody = document.getElementById('ws-dd-body');
  var wsTabId = null;    // the :3080 tab the SW falls back to when no panel frame
  var wsDdOpen = false;
  var wsOverlayOpen = false; // T12.2 — panel-side toggle state for the overlay

  function ddStatus(text, isError) {
    wsDdStatus.textContent = text || '';
    wsDdStatus.setAttribute('class', isError ? 'ce-status-err' : '');
  }

  // Promise wrapper for SW round-trips (callback form; lastError swallowed,
  // null result covers "no response").
  function swRequest(type, extra) {
    return new Promise(function (resolve) {
      try {
        var msg = { type: type };
        if (extra) {
          for (var k in extra) {
            if (Object.prototype.hasOwnProperty.call(extra, k)) msg[k] = extra[k];
          }
        }
        chrome.runtime.sendMessage(msg, function (res) {
          void chrome.runtime.lastError;
          resolve(res || null);
        });
      } catch (e) {
        resolve(null); // extension context gone (mid-reload) — treat as no response
      }
    });
  }

  function findGuiTabId() {
    return new Promise(function (resolve) {
      try {
        chrome.tabs.query({ url: 'http://127.0.0.1:3080/*' }, function (tabs) {
          void chrome.runtime.lastError;
          resolve(tabs && tabs.length ? tabs[0].id : null);
        });
      } catch (e) { resolve(null); }
    });
  }

  function closeWsDd() {
    wsDdOpen = false;
    if (wsDd) wsDd.setAttribute('hidden', '');
  }

  function renderTree(res) {
    wsDdBody.textContent = '';
    if (!res || !res.ok) {
      var msg = String((res && res.error) || 'no response from the service worker');
      var text;
      if (msg.indexOf('no DSH GUI tab') === 0) {
        text = 'No DSH GUI tab found — open http://127.0.0.1:3080 in a browser tab first (the panel\'s own view can\'t be queried).';
      } else if (msg.indexOf('no live content script') >= 0) {
        text = 'The GUI tab has no Chrome Eye content script yet — reload that tab once and retry.';
      } else if (msg === 'sidebar-not-visible') {
        text = 'The GUI sidebar isn\'t visible right now — open the workspace in the GUI sidebar first.';
      } else {
        text = 'Could not read the workspace tree: ' + msg;
      }
      var errDiv = document.createElement('div');
      errDiv.textContent = text;
      errDiv.className = 'ce-ws-err';
      wsDdBody.appendChild(errDiv);
      ddStatus('error', true);
      return;
    }
    var total = 0;
    for (var i = 0; i < res.workspaces.length; i++) {
      var ws = res.workspaces[i];
      for (var p = 0; p < ws.projects.length; p++) {
        var proj = ws.projects[p];
        total += proj.sessions.length;
        var head = document.createElement('div');
        head.textContent = proj.name + ' (' + proj.sessions.length + (proj.truncated ? '+' : '') + ')';
        head.className = 'ce-ws-head';
        wsDdBody.appendChild(head);
        for (var j = 0; j < proj.sessions.length; j++) {
          (function (s, wsName) {
            var row = document.createElement('div');
            row.textContent = (s.current ? '● ' : '   ') + (s.title || '(untitled)');
            // Row look (dark tokens, hover, current-row tint) comes from the
            // .ce-ws-row / .ce-ws-row-current classes in panel.html — task C.
            row.className = s.current ? 'ce-ws-row ce-ws-row-current' : 'ce-ws-row';
            row.addEventListener('click', function () {
              openSession(wsName, s.title);
            });
            wsDdBody.appendChild(row);
          })(proj.sessions[j], ws.workspace);
        }
        if (proj.truncated) {
          (function (name) {
            var more = document.createElement('div');
            more.textContent = '⤓ group collapsed in the sidebar — show all sessions';
            more.className = 'ce-ws-more';
            more.addEventListener('click', function () { expandGroup(name); });
            wsDdBody.appendChild(more);
          })(proj.name);
        }
      }
    }
    if (res.mode === 'search') ddStatus('sidebar search results', false);
    else if (res.mode === 'flat') ddStatus('flat session list', false);
    else ddStatus(res.workspaces.length + ' workspace(s), ' + total + ' session(s)', false);
    if (res.cachedCurrentId) {
      var foot = document.createElement('div');
      foot.textContent = 'current (SW cache): ' + res.cachedCurrentId;
      foot.className = 'ce-ws-foot';
      wsDdBody.appendChild(foot);
    }
  }

  function refreshTree() {
    ddStatus('loading…');
    wsDdBody.textContent = '';
    findGuiTabId().then(function (tabId) {
      wsTabId = tabId;
      return swRequest('chrome-eye:workspace-tree', { tabId: tabId });
    }).then(renderTree);
  }

  function openSession(ws, title) {
    ddStatus('opening "' + title + '"…');
    swRequest('chrome-eye:open-session', {
      tabId: wsTabId,
      workspace: ws,
      title: title
    }).then(function (res) {
      if (res && res.ok) {
        ddStatus('opened "' + title + '"', false);
        setStatus('Opened session "' + title + '" in the GUI', false);
        // Let dsh.sessions.current land, then re-mark the current row.
        setTimeout(refreshTree, 900);
      } else {
        ddStatus(
          res && res.error === 'row-not-found'
            ? 'Not in the sidebar right now — open the workspace in the GUI sidebar first'
            : 'Could not open: ' + ((res && res.error) || 'no response'),
          true
        );
      }
    });
  }

  function expandGroup(name) {
    ddStatus('expanding…');
    swRequest('chrome-eye:expand-group', { tabId: wsTabId, workspace: name }).then(function (res) {
      if (res && res.ok) refreshTree();
      else ddStatus('Could not expand: ' + ((res && res.error) || 'no response'), true);
    });
  }

  if (wsBtn && wsDd && wsDdBody) {
    wsBtn.addEventListener('click', function (ev) {
      ev.stopPropagation();
      if (wsDdOpen) { closeWsDd(); return; }
      wsDdOpen = true;
      wsDd.removeAttribute('hidden');
      refreshTree();
    });

    // Outside click / Escape close the dropdown.
    document.addEventListener('mousedown', function (ev) {
      if (!wsDdOpen) return;
      if (wsDd.contains(ev.target)) return;
      if (wsBtn.contains(ev.target)) return;
      closeWsDd();
    });
    document.addEventListener('keydown', function (ev) {
      if (ev.key === 'Escape' && wsDdOpen) closeWsDd();
    });
    // Clicks on the main browser tab (or anywhere in the browser chrome)
    // never reach THIS document — the mousedown/Escape handlers above can
    // never see them — but they always blur this window.
    window.addEventListener('blur', function () {
      if (wsDdOpen) closeWsDd();
    });
  }

  // T11.4/T12.2 — OPEN/CLOSE the workspace overlay. Opening happens in the
  // panel's embedded :3080 iframe (the SW falls back to a real :3080 tab
  // when the panel frame isn't usable); closing works from the panel alone.
  // The overlay can also close itself (✕ / Escape inside the iframe); if it
  // already did, a close request is a harmless no-op on the scraper side.
  // Task D: the SAME 'chrome-eye:overlay' close path (no new message flow)
  // now drives three panel-level cues — the label flip
  // '⛶ workspace' ↔ '⛶ close overlay', the danger '✕ close workspace'
  // button in the bottom bar, and a red bottom-bar status line naming the
  // current workspace mode + how to exit.
  function setOverlay(open) {
    findGuiTabId().then(function (tabId) {
      wsTabId = tabId;
      return swRequest('chrome-eye:overlay', {
        tabId: tabId,
        open: open
      });
    }).then(function (res) {
      if (res && res.ok && res.open !== false) {
        wsOverlayOpen = true;
        wsOverlayBtn.textContent = '⛶ close overlay';
        if (wsCloseBtn) wsCloseBtn.removeAttribute('hidden');
        setStatus(
          'workspace overlay open (' +
          (res.mode || 'grouped') + ', ' + (res.sessions != null ? res.sessions : 0) +
          ' sessions) — Esc or ✕ to close',
          true
        );
      } else if (res && res.ok) {
        // res.open === false → close (or close-no-op) succeeded
        wsOverlayOpen = false;
        wsOverlayBtn.textContent = '⛶ workspace';
        if (wsCloseBtn) wsCloseBtn.setAttribute('hidden', '');
        setStatus('Workspace overlay closed', false);
      } else {
        setStatus(
          'Overlay failed: ' +
          ((res && res.error && res.error.indexOf('no DSH GUI tab') === 0)
            ? 'no GUI tab — open http://127.0.0.1:3080 in a browser tab'
            : ((res && res.error) || 'no response')),
          true
        );
      }
    });
  }

  if (wsOverlayBtn) {
    wsOverlayBtn.addEventListener('click', function () {
      setOverlay(!wsOverlayOpen);
    });
  }
  // Task D — unmistakable exit affordance while the overlay is open.
  if (wsCloseBtn) {
    wsCloseBtn.addEventListener('click', function () {
      setOverlay(false);
    });
  }
})();
