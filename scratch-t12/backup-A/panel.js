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
  status.style.cssText =
    'font-size: 13px; color: #333; ' +
    'white-space: nowrap; overflow: hidden; text-overflow: ellipsis;';

  function setStatus(text, isError) {
    if (!text) return;
    status.textContent = text;
    status.style.color = isError ? '#b00020' : '#1a7f37';
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

  // Service worker → mirror the "→ add to session" outcome (T11.2).
  chrome.runtime.onMessage.addListener(function (message) {
    if (!message || message.type !== 'chrome-eye:share-result') return;
    var res = message.result;
    if (!res) return;
    var n = res.total != null ? res.total : (res.added || 0);
    if (res.ok) {
      if (res.fallback) {
        setStatus(
          'Saved ' + n + ' page' + (n === 1 ? '' : 's') +
          ' (no session open) → bridge HTTP ' +
          (res.status != null ? res.status : 200),
          false
        );
      } else {
        setStatus(
          n + ' page' + (n === 1 ? '' : 's') +
          ' added to session context (queued for your next prompt)',
          false
        );
      }
    } else {
      setStatus('Share failed: ' + String(res.error || 'unknown error'), true);
    }
  });

  // ------------------------------------------------------------------
  // T11.3 — always-present workspace-tree dropdown; T11.4 — overlay toggle.
  //
  // Data path: panel → SW → :3080 tab's content script → GUI sidebar DOM
  // (suffix-based scrape, on demand). The panel's own iframe CANNOT be
  // queried (it's an extension-page frame; no content script runs there),
  // so a real GUI tab is required — the status lines say so when there
  // isn't one.
  // ------------------------------------------------------------------

  var wsBtn = document.getElementById('ws-tree-btn');
  var wsOverlayBtn = document.getElementById('ws-overlay-btn');
  var wsDd = document.getElementById('ws-dropdown');
  var wsDdStatus = document.getElementById('ws-dd-status');
  var wsDdBody = document.getElementById('ws-dd-body');
  var wsTabId = null;    // the :3080 tab the dropdown currently talks to
  var wsDdOpen = false;

  function ddStatus(text, isError) {
    wsDdStatus.textContent = text || '';
    wsDdStatus.style.color = isError ? '#b00020' : '#666';
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
      errDiv.style.cssText = 'padding:10px 12px;font-size:12px;color:#b00020;';
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
        head.style.cssText = 'padding:8px 8px 3px;font-size:12px;font-weight:600;color:#555;';
        wsDdBody.appendChild(head);
        for (var j = 0; j < proj.sessions.length; j++) {
          (function (s, wsName) {
            var row = document.createElement('div');
            row.textContent = (s.current ? '● ' : '   ') + (s.title || '(untitled)');
            row.style.cssText =
              'padding:5px 8px;font-size:13px;border-radius:6px;cursor:pointer;' +
              'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' +
              (s.current ? 'background:rgba(26,127,55,.10);color:#116329;font-weight:600;' : '');
            row.addEventListener('mousemove', function () {
              if (!s.current) row.style.background = '#f0f4ff';
            });
            row.addEventListener('mouseleave', function () {
              if (!s.current) row.style.background = '';
            });
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
            more.style.cssText = 'padding:5px 8px;font-size:12px;color:#1a56db;cursor:pointer;';
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
      foot.style.cssText = 'margin-top:6px;padding:6px 8px;font-size:11px;color:#999;border-top:1px solid #eee;';
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
  }

  // T11.4 — open the workspace overlay in the GUI tab. The overlay itself
  // closes via its ✕ button or the Escape key INSIDE the GUI; this button
  // always opens (a second press while open is a no-op on the content side).
  if (wsOverlayBtn) {
    wsOverlayBtn.addEventListener('click', function () {
      findGuiTabId().then(function (tabId) {
        wsTabId = tabId;
        return swRequest('chrome-eye:overlay', { tabId: tabId, open: true });
      }).then(function (res) {
        if (res && res.ok) {
          setStatus(
            'Workspace overlay opened in the GUI tab (' +
            (res.mode || 'grouped') + ', ' + (res.sessions != null ? res.sessions : 0) +
            ' sessions; Esc or ✕ closes it)',
            false
          );
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
    });
  }
})();
