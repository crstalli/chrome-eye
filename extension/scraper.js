// Chrome Eye T12.1 — frame scraper (self-contained).
//
// Why this file exists: manifest content scripts do NOT auto-run in the
// side panel's embedded :3080 iframe (it is a subframe of a
// chrome-extension:// page), so the panel's GUI can only be driven through
// chrome.scripting.executeScript. This module is the injected function for
// that path.
//
// How it is consumed (both modes share ONE function):
//   1. SW: `importScripts('scraper.js')` → the wrapper below attaches
//      `ceRunInFrame` to `self` (classic service worker, no manifest change).
//      Handlers then call chrome.scripting.executeScript({func: ceRunInFrame,
//      args: [action, payload]}) against the panel GUI frame.
//   2. Frame: Chrome re-evaluates ONLY the function source in the frame's
//      ISOLATED world (the wrapper never runs there). The ISOLATED world
//      persists across executeScript calls for the same document, so the
//      per-world singleton window.__ceOverlayApi survives between open and
//      close calls and gives exact teardown references (rAF id, keydown-
//      capture listener).
//
// Self-containment rules (executeScript serializes the function source):
//   - every helper is nested inside ceRunInFrame; NO outer references;
//   - NO chrome.* — pure DOM + same-origin localStorage + rAF/cancelAF +
//     setTimeout;
//   - return shapes are COPIED VERBATIM from content.js (T11.3/T11.4):
//     tree {ok, mode:'grouped'|'flat'|'search'|'none', workspaces,
//     truncated?, error?}; open-session {ok:true,title} / {ok:false,
//     error:'row-not-found'}; expand-group {ok:true,workspace} / {ok:false,
//     error:'no-overflow'|'group-not-found'}; overlay {ok:true,open:true,
//     mode,sessions,anchor} / {ok:true,open:true,already:true} / {ok:true,
//     open:false} / {ok:false,error}.
//
// Cross-path overlay teardown: close removes the DOM element marked
// data-chrome-eye-overlay="true" (works even when content.js created it),
// and when this world's singleton holds live state it also cancels the rAF
// loop and removes the keydown-capture listener. content.js's overlayTick
// detachment guard (T12) terminates a content.js-owned rAF loop whose
// element was removed out-of-band.

(function (global) {
  'use strict';

  // One self-contained runner: every action + helper lives inside this
  // function so its source is the complete unit that gets serialized.
  function ceRunInFrame(action, payload) {
    payload = payload || {};

    // ------------------------------------------------------------------
    // T11.3 parity — DOM helpers (suffix-matched CSS-module classes;
    // identical logic to content.js, no hardcoded hashes).
    // ------------------------------------------------------------------
    var TREE_SESSION_CAP = 200;

    function rowTitle(el) {
      var t = el ? el.querySelector('[class*="_title"]') : null;
      return t ? (t.textContent || '').trim() : '';
    }

    // Session ids are NOT in the DOM; the aria-selected row is stamped with
    // the id read from dsh.sessions.current (same-origin localStorage).
    function readGuiSessionId() {
      try {
        var raw = localStorage.getItem('dsh.sessions.current');
        if (!raw) return null;
        var parsed = JSON.parse(raw);
        var id = parsed && typeof parsed.sessionId === 'string' ? parsed.sessionId : '';
        return id.length > 0 ? id : null;
      } catch (e) {
        return null;
      }
    }

    function scrapeSessionRow(r) {
      var sel = r.getAttribute('aria-selected') === 'true';
      return {
        id: sel ? readGuiSessionId() : null,
        title: rowTitle(r),
        current: sel
      };
    }

    function groupSectionName(g) {
      var projRow = g.querySelector('[class*="_projectRow"]');
      var nameEl = projRow
        ? projRow.querySelector('[class*="_projectText"] [class*="_title"]')
        : null;
      return nameEl ? (nameEl.textContent || '').trim() : '';
    }

    // Return shape: {ok, mode:'grouped'|'flat'|'search'|'none', workspaces:
    // [{workspace, projects:[{name, expanded, truncated, sessions:[{id,
    // title, current}]}]}], truncated?, error?}
    function scrapeWorkspaceTree() {
      var out = { ok: true, mode: 'grouped', workspaces: [] };

      // 1) grouped mode (default)
      var groups = document.querySelectorAll('[class*="_groupSection"]');
      if (groups.length > 0) {
        var total = 0;
        for (var i = 0; i < groups.length; i++) {
          var g = groups[i];
          var projRow = g.querySelector('[class*="_projectRow"]');
          var overflow = g.querySelector('[class*="_sessionOverflowButton"]');
          var rows = g.querySelectorAll('[class*="_sessionRow"]');
          var sessions = [];
          for (var j = 0; j < rows.length && sessions.length < TREE_SESSION_CAP; j++) {
            sessions.push(scrapeSessionRow(rows[j]));
            total++;
          }
          var name = groupSectionName(g) || ('Group ' + (i + 1));
          out.workspaces.push({
            workspace: name,
            projects: [{
              name: name,
              expanded: projRow ? projRow.getAttribute('aria-expanded') === 'true' : true,
              truncated: !!overflow,
              sessions: sessions
            }]
          });
          if (total >= TREE_SESSION_CAP) { out.truncated = true; break; }
        }
        return out;
      }

      // 2) flat mode
      var flatRows = document.querySelectorAll('[class*="_sessionRow"]');
      if (flatRows.length > 0) {
        out.mode = 'flat';
        var fs = [];
        for (var k = 0; k < flatRows.length && fs.length < TREE_SESSION_CAP; k++) {
          fs.push(scrapeSessionRow(flatRows[k]));
        }
        out.truncated = flatRows.length > TREE_SESSION_CAP;
        out.workspaces.push({
          workspace: 'All sessions',
          projects: [{
            name: 'All sessions',
            expanded: true,
            truncated: false,
            sessions: fs
          }]
        });
        return out;
      }

      // 3) search mode (group by the result's workspace label)
      var searchRows = document.querySelectorAll('[class*="_searchResultRow"]');
      if (searchRows.length > 0) {
        out.mode = 'search';
        var byWs = {};
        var order = [];
        for (var m = 0; m < searchRows.length; m++) {
          var sr = searchRows[m];
          var wsEl = sr.querySelector('[class*="_searchResultWorkspace"]');
          var ws = wsEl ? (wsEl.textContent || '').trim() : 'Other';
          if (!byWs[ws]) { byWs[ws] = []; order.push(ws); }
          if (byWs[ws].length >= TREE_SESSION_CAP) continue;
          var stEl = sr.querySelector('[class*="_searchResultTitle"]');
          var sel = sr.getAttribute('aria-selected') === 'true';
          byWs[ws].push({
            id: sel ? readGuiSessionId() : null,
            title: stEl ? (stEl.textContent || '').trim() : '',
            current: sel
          });
        }
        for (var q = 0; q < order.length; q++) {
          out.workspaces.push({
            workspace: order[q],
            projects: [{
              name: order[q],
              expanded: true,
              truncated: false,
              sessions: byWs[order[q]]
            }]
          });
        }
        return out;
      }

      // 4) no tree body at all (rail/collapsed sidebar, or layout changed)
      out.mode = 'none';
      out.ok = false;
      out.error = 'sidebar-not-visible';
      return out;
    }

    // ------------------------------------------------------------------
    // T11.3 parity — open-session / expand-group actions.
    // ------------------------------------------------------------------
    function findSessionRow(workspace, title) {
      var w = String(workspace || '').trim();
      var t = String(title || '').trim();
      if (!t) return null;

      // 1) grouped: exact workspace name, then exact session title
      var groups = document.querySelectorAll('[class*="_groupSection"]');
      for (var i = 0; i < groups.length; i++) {
        if (w && groupSectionName(groups[i]) !== w) continue;
        var rows = groups[i].querySelectorAll('[class*="_sessionRow"]');
        for (var j = 0; j < rows.length; j++) {
          if (rowTitle(rows[j]) === t) return rows[j];
        }
      }
      // 2) flat: any session row with that title
      var flatRows = document.querySelectorAll('[class*="_sessionRow"]');
      for (var k = 0; k < flatRows.length; k++) {
        if (rowTitle(flatRows[k]) === t) return flatRows[k];
      }
      // 3) search mode: result row with that title
      var searchRows = document.querySelectorAll('[class*="_searchResultRow"]');
      for (var m = 0; m < searchRows.length; m++) {
        var st = searchRows[m].querySelector('[class*="_searchResultTitle"]');
        if (st && (st.textContent || '').trim() === t) return searchRows[m];
      }
      return null;
    }

    function openSessionAction(workspace, title) {
      var row = findSessionRow(workspace, title);
      if (!row) return { ok: false, error: 'row-not-found' };
      row.click(); // the app's own onClick → onOpen(node.id); the 2 s poller
                   // then picks up dsh.sessions.current for the next prompt
      return { ok: true, title: String(title || '').trim() };
    }

    // H2: duplicate workspace names render multiple same-titled group
    // sections, so walk ALL matches. Click only what is actually collapsed
    // or truncated — clicking an already-expanded group's row would toggle
    // it CLOSED (the pre-H2 bug).
    function expandGroupAction(workspace) {
      var w = String(workspace || '').trim();
      var groups = document.querySelectorAll('[class*="_groupSection"]');
      var sawGroup = false;
      var clicked = null;
      for (var i = 0; i < groups.length; i++) {
        if (groupSectionName(groups[i]) !== w) continue;
        sawGroup = true;
        var g = groups[i];
        // Truncated preview: the app's own expand handler.
        var btn = g.querySelector('[class*="_sessionOverflowButton"]');
        if (btn) {
          if (!clicked) {
            btn.click(); // (setExpandedSessionGroups)
            clicked = 'overflowButton';
          }
          continue;
        }
        if (g.querySelectorAll('[class*="_sessionRow"]').length > 0) continue; // already expanded
        // Collapsed with 0 in-memory sessions: the project row is the toggle.
        var projRow = g.querySelector('[role="treeitem"]');
        if (projRow && projRow.getAttribute('aria-expanded') === 'false' && !clicked) {
          projRow.click(); // the app's own treeitem toggle handler
          clicked = 'projectRow';
        }
      }
      if (!sawGroup) return { ok: false, error: 'group-not-found' };
      if (!clicked) return { ok: false, error: 'no-expand-control' };
      return { ok: true, workspace: w, via: clicked };
    }

    // A2 / POINTER 2 + H2 fix: before a sidebar scrape, expand every
    // COLLAPSED group — and only collapsed ones. The pre-H2 pass clicked
    // every group's _projectRow unconditionally, which toggled ALREADY-
    // EXPANDED groups closed; the scrape that followed read the stale
    // pre-render DOM and listed rows React had just removed → open-session
    // hit row-not-found ("Not in the sidebar right now"). Rules now:
    //   - _sessionOverflowButton present → truncated preview: app expand
    //   - rows already visible           → expanded: never touch
    //   - else aria-expanded="false"     → collapsed: click the project row
    // (The GUI also collapses ALL groups after a session opens — the
    // open-session dispatch retries once after re-expanding.)
    function autoExpandCollapsedGroups() {
      var groups = document.querySelectorAll('[class*="_groupSection"]');
      for (var i = 0; i < groups.length; i++) {
        var g = groups[i];
        var btn = g.querySelector('[class*="_sessionOverflowButton"]');
        if (btn) {
          btn.click(); // the app's own expand handler
          continue;
        }
        if (g.querySelectorAll('[class*="_sessionRow"]').length > 0) continue; // expanded
        var projRow = g.querySelector('[role="treeitem"]');
        if (projRow && projRow.getAttribute('aria-expanded') === 'false') {
          projRow.click(); // the app's own treeitem toggle handler
        }
      }
    }

    // ------------------------------------------------------------------
    // T11.4 parity — workspace overlay.
    //
    // State lives in a per-ISOLATED-world singleton (window.__ceOverlayApi);
    // the DOM marker data-chrome-eye-overlay="true" is the cross-path source
    // of truth (content.js can create the element too, in which case its
    // overlayTick detachment guard tears down the rAF loop after the DOM
    // removal below).
    // ------------------------------------------------------------------
    function getOverlayApi() {
      if (!window.__ceOverlayApi) {
        window.__ceOverlayApi = {
          el: null,
          anchor: null,
          statusEl: null,
          raf: 0,
          escHandler: null
        };
      }
      return window.__ceOverlayApi;
    }

    function findChatRoot() {
      var center = document.querySelector('[class*="_centerCol"]');
      if (!center) return null;
      return center.querySelector('[class*="_root"]') || center;
    }

    function setOverlayStatus(api, text, isError) {
      if (!api.statusEl) return;
      api.statusEl.textContent = text || '';
      api.statusEl.style.color = isError ? '#b00020' : '#666';
    }

    // Chip-strip offset: the panel iframe has NO chip strip (content.js's
    // chipsRoot closure is unreachable here) → 0.
    function chipStripOffset() {
      return 0;
    }

    function positionOverlay(api) {
      if (!api.el) return;
      var r = api.anchor
        ? api.anchor.getBoundingClientRect()
        : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
      var top = Math.max(r.top, chipStripOffset());
      var bottom = Math.min(r.bottom, window.innerHeight);
      var left = Math.max(0, r.left);
      var width = Math.max(120, Math.min(r.width, window.innerWidth - left));
      var height = Math.max(60, bottom - top);
      var s = api.el.style;
      s.top = top + 'px';
      s.left = left + 'px';
      s.width = width + 'px';
      s.height = height + 'px';
    }

    function overlayTick(api) {
      if (!api.el) return;
      positionOverlay(api);
      api.raf = requestAnimationFrame(function () { overlayTick(api); });
    }

    function renderOverlayBody(api, tree) {
      var body = api.el.querySelector('[data-ce-body]');
      body.textContent = '';
      if (!tree.ok || tree.mode === 'none') {
        var d = document.createElement('div');
        d.textContent = 'The GUI sidebar isn\'t visible right now — open the workspace in the GUI sidebar first.';
        d.style.cssText = 'padding:14px 10px;font-size:13px;color:#b00020;';
        body.appendChild(d);
        return;
      }
      if (tree.mode === 'search') {
        var note = document.createElement('div');
        note.textContent = '(showing the sidebar search results)';
        note.style.cssText = 'padding:6px 10px;font-size:12px;color:#888;';
        body.appendChild(note);
      }
      for (var i = 0; i < tree.workspaces.length; i++) {
        var ws = tree.workspaces[i];
        for (var p = 0; p < ws.projects.length; p++) {
          var proj = ws.projects[p];
          var head = document.createElement('div');
          head.textContent = proj.name + ' (' + proj.sessions.length + (proj.truncated ? '+' : '') + ')';
          head.style.cssText = 'padding:10px 10px 4px;font-size:13px;font-weight:600;color:var(--dsw-alias-text-l2,#555);';
          body.appendChild(head);
          for (var j = 0; j < proj.sessions.length; j++) {
            (function (s) {
              var row = document.createElement('div');
              row.textContent = (s.current ? '● ' : '    ') + (s.title || '(untitled)');
              row.style.cssText =
                'padding:7px 10px;font-size:14px;border-radius:6px;cursor:pointer;' +
                'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;' +
                (s.current ? 'background:rgba(26,127,55,.12);color:#116329;font-weight:600;' : '');
              row.addEventListener('mousemove', function () {
                if (!s.current) row.style.background = 'rgba(128,128,128,.10)';
              });
              row.addEventListener('mouseleave', function () {
                if (!s.current) row.style.background = '';
              });
              row.addEventListener('click', function () {
                var res = openSessionAction(ws.workspace, s.title);
                if (res.ok) {
                  setOverlayStatus(api, 'Opened "' + s.title + '"');
                  setTimeout(function () { closeOverlay(); }, 250);
                } else {
                  setOverlayStatus(api, 'Not in the sidebar right now — open the workspace in the GUI sidebar first', true);
                }
              });
              body.appendChild(row);
            })(proj.sessions[j]);
          }
          if (proj.truncated) {
            (function (name) {
              var more = document.createElement('div');
              more.textContent = '⤓ group collapsed in the sidebar — expand to list all sessions';
              more.style.cssText = 'padding:5px 10px 8px;font-size:12px;color:#1a56db;cursor:pointer;';
              more.addEventListener('click', function () {
                var res = expandGroupAction(name);
                if (res.ok) {
                  // H2: wait one render cycle for the newly-expanded rows.
                  setTimeout(function () {
                    try { renderOverlayBody(api, scrapeWorkspaceTree()); } catch (e) { /* keep current */ }
                  }, 450);
                } else {
                  setOverlayStatus(api, 'Could not expand: ' + (res.error || 'no response'), true);
                }
              });
              body.appendChild(more);
            })(proj.name);
          }
        }
      }
    }

    function openOverlayAction() {
      var api = getOverlayApi();
      // Already open — created by this world OR by content.js (marker is
      // the cross-path source of truth).
      var existing = document.querySelector('[data-chrome-eye-overlay="true"]');
      if (existing) {
        return { ok: true, open: true, already: true };
      }
      // No live element: reset any stale singleton state (previous element
      // was removed out-of-band) before re-opening.
      if (api.raf) { cancelAnimationFrame(api.raf); api.raf = 0; }
      if (api.escHandler) {
        document.removeEventListener('keydown', api.escHandler, true);
        api.escHandler = null;
      }
      api.el = null;
      api.anchor = null;
      api.statusEl = null;

      var tree;
      autoExpandCollapsedGroups(); // A3: overlay initial render shows full lists
      try { tree = scrapeWorkspaceTree(); } catch (e) {
        return { ok: false, error: String((e && e.message) || e) };
      }

      api.anchor = findChatRoot();
      var el = document.createElement('div');
      el.setAttribute('data-chrome-eye-overlay', 'true');
      el.style.cssText =
        'position:fixed;z-index:2147483646;' +
        'background:var(--dsw-alias-bg-base,#ffffff);' +
        'color:var(--dsw-alias-text-l1,#111111);' +
        'border:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.4));' +
        'border-radius:10px;box-shadow:0 10px 34px rgba(0,0,0,.28);' +
        'display:flex;flex-direction:column;overflow:hidden;' +
        'font-family:var(--ds-font-family,system-ui,sans-serif);';

      var header = document.createElement('div');
      header.style.cssText =
        'display:flex;align-items:center;gap:8px;padding:10px 14px;' +
        'border-bottom:1px solid var(--dsw-alias-border-l2,rgba(128,128,128,.28));';
      var title = document.createElement('span');
      title.textContent = 'Workspaces';
      title.style.cssText = 'font-weight:600;font-size:14px;flex:none;';
      api.statusEl = document.createElement('span');
      api.statusEl.style.cssText =
        'flex:1;font-size:12px;color:#666;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
      var closeBtn = document.createElement('button');
      closeBtn.textContent = '✕';
      closeBtn.style.cssText =
        'cursor:pointer;border:none;background:transparent;font-size:14px;' +
        'color:inherit;padding:2px 6px;border-radius:4px;flex:none;';
      closeBtn.addEventListener('click', function () { closeOverlay(); });
      header.appendChild(title);
      header.appendChild(api.statusEl);
      header.appendChild(closeBtn);

      var body = document.createElement('div');
      body.setAttribute('data-ce-body', 'true');
      body.style.cssText = 'flex:1;overflow-y:auto;padding:6px 8px 12px;';

      el.appendChild(header);
      el.appendChild(body);
      (document.body || document.documentElement).appendChild(el);

      api.el = el;
      renderOverlayBody(api, tree);
      // H2: the sync scrape above ran before React re-rendered the
      // newly-expanded groups; refresh the body once the rows are in.
      setTimeout(function () {
        if (!api.el) return; // overlay closed in the meantime
        try { renderOverlayBody(api, scrapeWorkspaceTree()); } catch (e) { /* keep current */ }
      }, 450);
      positionOverlay(api);
      api.raf = requestAnimationFrame(function () { overlayTick(api); });

      var esc = function (ev) {
        if (ev.key === 'Escape') {
          ev.stopPropagation();
          closeOverlay();
        }
      };
      api.escHandler = esc;
      document.addEventListener('keydown', esc, true);

      var count = 0;
      for (var i = 0; i < tree.workspaces.length; i++) {
        for (var p = 0; p < tree.workspaces[i].projects.length; p++) {
          count += tree.workspaces[i].projects[p].sessions.length;
        }
      }
      var center = document.querySelector('[class*="_centerCol"]');
      return {
        ok: true,
        open: true,
        mode: tree.mode,
        sessions: count,
        anchor: !center ? 'viewport' : (api.anchor === center ? 'center-col' : 'chat-root')
      };
    }

    function closeOverlay() {
      var api = getOverlayApi();
      // Cross-path: remove the marked element even if content.js created
      // it. content.js's overlayTick detachment guard then terminates its
      // own rAF loop (it cannot reach this world's references).
      var marked = document.querySelector('[data-chrome-eye-overlay="true"]');
      if (marked && marked.parentNode) {
        marked.parentNode.removeChild(marked);
      }
      if (api.raf) { cancelAnimationFrame(api.raf); api.raf = 0; }
      if (api.escHandler) {
        document.removeEventListener('keydown', api.escHandler, true);
        api.escHandler = null;
      }
      api.el = null;
      api.anchor = null;
      api.statusEl = null;
      return { ok: true, open: false };
    }

    // ------------------------------------------------------------------
    // Action dispatch.
    // ------------------------------------------------------------------
    try {
      if (action === 'scrape-tree') {
        autoExpandCollapsedGroups();
        // H2: give React one render cycle to insert the newly-expanded rows
        // before the DOM is read (a synchronous read returned the stale
        // pre-toggle tree). ceRunInFrame's Promise return is resolved by
        // chrome.scripting.executeScript.
        return new Promise(function (resolve) {
          setTimeout(function () {
            try {
              resolve(scrapeWorkspaceTree());
            } catch (e) {
              resolve({ ok: false, error: String((e && e.message) || e) });
            }
          }, 400);
        });
      }
      if (action === 'open-session') {
        var res = openSessionAction(payload.workspace, payload.title);
        if (res.ok) return res;
        // H2: the GUI collapses ALL groups after a session opens, so the row
        // may sit inside a collapsed group. Expand, wait one render, retry.
        autoExpandCollapsedGroups();
        return new Promise(function (resolve) {
          setTimeout(function () {
            resolve(openSessionAction(payload.workspace, payload.title));
          }, 500);
        });
      }
      if (action === 'expand-group') {
        return expandGroupAction(payload.workspace);
      }
      if (action === 'overlay') {
        return payload.open === false ? closeOverlay() : openOverlayAction();
      }
      return { ok: false, error: 'unknown-action:' + String(action) };
    } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
  }

  // SW importScripts mode: attach to the global scope (self on a classic
  // service worker). In the frame's ISOLATED world only the function
  // source is re-evaluated by executeScript, so this wrapper is inert
  // there.
  global.ceRunInFrame = ceRunInFrame;
})(typeof self !== 'undefined' ? self : this);
