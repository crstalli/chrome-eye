// Chrome Eye content script (CP-6: T6.1–T6.6)
// Injected on <all_urls>. On {type:'chrome-eye:capture'} from the service
// worker (or any extension context) it extracts the page's visible context
// and responds with exactly {url, title, text, links, headings}.
(function () {
  'use strict';

  console.log('Chrome Eye content script active');

  var TEXT_CAP = 120000;  // T6.1
  var LINK_CAP = 200;    // T6.2
  var HEADING_CAP = 60;  // T6.3

  // Tags whose content never counts as visible text.
  var SKIP_TAGS = {
    SCRIPT: 1,
    STYLE: 1,
    NOSCRIPT: 1,
    TEMPLATE: 1
  };

  // Heuristic block-level set: contributions from these elements are
  // separated from their neighbours (inline elements keep flowing).
  var BLOCK_TAGS = {
    ADDRESS: 1, ARTICLE: 1, ASIDE: 1, BLOCKQUOTE: 1, BODY: 1, CAPTION: 1,
    DD: 1, DETAILS: 1, DIV: 1, DL: 1, DT: 1, FIELDSET: 1, FIGCAPTION: 1,
    FIGURE: 1, FOOTER: 1, H1: 1, H2: 1, H3: 1, H4: 1, H5: 1, H6: 1,
    HEADER: 1, HGROUP: 1, HR: 1, LI: 1, MAIN: 1, NAV: 1, OL: 1, P: 1,
    PRE: 1, SECTION: 1, SUMMARY: 1, TABLE: 1, TBODY: 1, TFOOT: 1, THEAD: 1,
    TR: 1, UL: 1
  };

  // display:none, visibility:hidden, or the hidden attribute → skip subtree.
  function isHidden(el) {
    try {
      if (el.hasAttribute && el.hasAttribute('hidden')) return true;
      var cs = window.getComputedStyle(el);
      return cs.display === 'none' || cs.visibility === 'hidden';
    } catch (e) {
      return true; // detached or non-element oddity — safer to skip
    }
  }

  // Collapse a run of whitespace to a single space, keeping edge spaces so
  // inline neighbours (e.g. "Home" + ",") stay attached as rendered.
  function collapseWs(s) {
    return s.replace(/\s+/g, ' ');
  }

  // Depth-first walk from <body>; invisible subtrees are pruned entirely.
  function collectVisibleText(node, parts) {
    var children = node.childNodes;
    for (var i = 0; i < children.length; i++) {
      var child = children[i];
      if (child.nodeType === 3) { // #text
        var v = collapseWs(child.nodeValue || '');
        if (v.trim()) parts.push(v);
      } else if (child.nodeType === 1) { // element
        if (SKIP_TAGS[child.tagName]) continue;
        if (isHidden(child)) continue;
        if (BLOCK_TAGS[child.tagName]) {
          var sub = [];
          collectVisibleText(child, sub);
          var block = sub.join('');
          if (block.trim()) parts.push('\n' + block + '\n');
        } else {
          collectVisibleText(child, parts);
        }
      }
    }
  }

  // T6.1 — visible text, whitespace-normalized, capped at TEXT_CAP chars.
  function extractVisibleText() {
    var parts = [];
    if (document.body) collectVisibleText(document.body, parts);
    var text = parts.join('').replace(/\s+/g, ' ').trim();
    return text.length > TEXT_CAP ? text.slice(0, TEXT_CAP) : text;
  }

  // T6.2 — up to 200 links as {t, h} (document order, visible only).
  function extractLinks() {
    var links = [];
    var anchors = document.querySelectorAll('a[href]');
    for (var i = 0; i < anchors.length && links.length < LINK_CAP; i++) {
      var a = anchors[i];
      if (isHidden(a)) continue;
      links.push({
        t: (a.textContent || '').trim(),
        h: a.href || ''
      });
    }
    return links;
  }

  // T6.3 — up to 60 headings as {level, t} (document order, visible only).
  function extractHeadings() {
    var headings = [];
    var hs = document.querySelectorAll('h1, h2, h3, h4, h5, h6');
    for (var i = 0; i < hs.length && headings.length < HEADING_CAP; i++) {
      var h = hs[i];
      if (isHidden(h)) continue;
      headings.push({
        level: Number(h.tagName.charAt(1)),
        t: (h.textContent || '').trim()
      });
    }
    return headings;
  }

  // T6.4 + T6.5 — assemble the exact 5-field capture object.
  function buildCapture() {
    return {
      url: location.href,
      title: document.title,
      text: extractVisibleText(),
      links: extractLinks(),
      headings: extractHeadings()
    };
  }

  chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
    if (!message || message.type !== 'chrome-eye:capture') return false;
    var result;
    try {
      result = buildCapture();
    } catch (e) {
      // Keep the 5-field contract even on unexpected failure.
      result = { url: location.href, title: document.title, text: '', links: [], headings: [] };
    }
    sendResponse(result);
    return true; // keep the message channel open for the (sync) response
  });

  // ---------------------------------------------------------------------
  // GUI session tracking (page → next-prompt context).
  //
  // When this content script runs inside the panel's DSH GUI iframe
  // (origin http://127.0.0.1:3080), the GUI persists the currently open
  // session under the localStorage key "dsh.sessions.current" (the
  // SessionRuntime.selection store in @deepseek-ai/dsh-client-runtime).
  // The value is JSON: {"sessionId":"session-<uuid>",
  // "subagentAddress":{...}} when a session is open, or {} otherwise.
  //
  // Why localStorage (researched, not guessed): the GUI has NO URL
  // routing (no pushState/replaceState/hash routing anywhere in the
  // client packages) and NO data-* session markers in the DOM, so the
  // persisted selection cell is the only stable machine-readable source.
  // It is written synchronously on every selection change and rehydrated
  // on load. The `storage` event does not fire in the document that
  // performed the write, so a cheap 2 s poll is the correct observer.
  //
  // This block is fully independent of the chrome-eye:capture round trip
  // above: it activates only when the origin matches, every access is
  // guarded, and it never throws on non-GUI pages.
  // ---------------------------------------------------------------------
  var GUI_ORIGIN = 'http://127.0.0.1:3080';
  // T2 — the panel's GUI iframe loads from the BRIDGE origin (:3081), which
  // has its OWN localStorage cell (Chrome partitions per origin). The GUI
  // persists dsh.sessions.current there too (same key, same shape), so the
  // :3081 origin is a GUI origin as well: the 2 s report runs and the
  // seed-check channel is live on BOTH origins.
  var GUI_ORIGINS = { 'http://127.0.0.1:3080': 1, 'http://127.0.0.1:3081': 1 };
  var GUI_SESSION_STORAGE_KEY = 'dsh.sessions.current';
  var GUI_POLL_MS = 2000;

  function readGuiSessionId() {
    try {
      var raw = localStorage.getItem(GUI_SESSION_STORAGE_KEY);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      var id = parsed && typeof parsed.sessionId === 'string' ? parsed.sessionId : '';
      return id.length > 0 ? id : null;
    } catch (e) {
      return null;
    }
  }

  // T11.2 (Task H rework) — the Gemini-style context chip row (fixed top
  // strip + "+" picker + "→ add to session") used to be rendered here on
  // the GUI origin. It now lives inside the side panel itself: panel.html
  // #stage-row / #ts-dropdown, driven by panel.js, which polls
  // chrome-eye:panel-state on its own. This content script keeps only the
  // background duty that needs the GUI document: the 2 s active-session
  // report to the SW (change-gated).
  function watchGuiSession() {
    var lastSent = undefined; // undefined = not yet reported; null = no session
    var timer = null;
    var tick = function () {
      // session report — change-gated.
      var id = readGuiSessionId();
      if (id !== lastSent) {
        lastSent = id;
        try {
          var p = chrome.runtime.sendMessage({
            type: 'chrome-eye:gui-session',
            sessionId: id
          });
          if (p && typeof p.catch === 'function') p.catch(function () {});
        } catch (e) {
          // Extension context unavailable (e.g. right after a reload) —
          // harmless; the next tick retries.
        }
      }
    };
    tick(); // initial report as soon as the page has loaded
    timer = setInterval(tick, GUI_POLL_MS);
  }

  // ---------------------------------------------------------------------
  // T12.2 (Task J1) — window.postMessage bridge for the GUI-page Cordis
  // plugin (J2 "Add tabs" preset). The plugin runs in the same TOP window
  // as this content script (the real GUI page) and cannot reach
  // chrome.tabs itself; it posts `chrome-eye:gui:<x>` messages here and we
  // forward them to the EXISTING sw.js engine — the `gui:` namespace
  // stripped — and post the sw response back as
  // `chrome-eye:gui:<x>:result`. NO new sw.js messages (sw.js UNCHANGED).
  //
  // Protocol (same top window, '*' origin on both legs):
  //   plugin     → content.js : {type:'chrome-eye:gui:<x>', reqId:<n>, payload:{...}}
  //   content.js → plugin     : {type:'chrome-eye:gui:<x>:result', reqId:<n>, data:<sw response>}
  //
  // Verbs (→ existing sw.js message):
  //   list-tabs    → chrome-eye:list-tabs     (data = {ok, tabs[]})
  //   stage-tab    → chrome-eye:stage-tab     (payload {tabId})
  //   unstage-tab  → chrome-eye:unstage-tab   (payload {tabId})
  //   add-staged   → chrome-eye:add-staged    (data = add-to-session result)
  //   panel-state  → chrome-eye:panel-state   (data = {ok, panelOpen, staged[]})
  //
  // Guards: TOP FRAME ONLY — the panel's embedded :3080/:3081 GUI iframe
  // also runs this script; it is not where the J2 plugin posts, and a
  // forwarding duplicate there would double-respond. And only the five
  // known verbs are processed: everything else (including our own
  // `:result` replies, which this listener also receives) is ignored, so
  // replies can never re-enter the bridge. The internal `chrome-eye:*`
  // SW↔content-script namespace is a separate channel and stays untouched.
  // ---------------------------------------------------------------------
  var GUI_BRIDGE_VERBS = {
    'list-tabs': 1,
    'stage-tab': 1,
    'unstage-tab': 1,
    'add-staged': 1,
    'panel-state': 1
  };

  function guiBridgeReply(msgType, reqId, data) {
    try {
      window.postMessage(
        {
          type: msgType + ':result',
          reqId: reqId,
          data: data || { ok: false, error: 'extension-not-loaded' }
        },
        '*'
      );
    } catch (e) {
      /* page already gone — nothing to deliver */
    }
  }

  function onGuiBridgeMessage(e) {
    if (window !== window.top) return; // top frame only (no iframe dupes)
    var d = e.data;
    if (!d || typeof d.type !== 'string') return;
    if (d.type.indexOf('chrome-eye:gui:') !== 0) return;
    var verb = d.type.substring('chrome-eye:gui:'.length);
    if (!GUI_BRIDGE_VERBS[verb]) return; // unknown verb / own ':result' reply → ignore
    var swMsg = { type: 'chrome-eye:' + verb };
    if (d.payload && d.payload.tabId != null) swMsg.tabId = d.payload.tabId;
    try {
      // Same chrome.runtime.sendMessage promise pattern as the
      // chrome-eye:gui-session report above.
      var p = chrome.runtime.sendMessage(swMsg);
      if (p && typeof p.then === 'function') {
        p.then(
          function (resp) {
            guiBridgeReply(d.type, d.reqId, resp || { ok: false, error: 'extension-not-loaded' });
          },
          function () {
            // Rejected: no receiving end (extension reloaded / not loaded).
            guiBridgeReply(d.type, d.reqId, { ok: false, error: 'extension-not-loaded' });
          }
        );
        return;
      }
    } catch (err) {
      // Extension context unavailable (e.g. right after a reload).
      guiBridgeReply(d.type, d.reqId, { ok: false, error: 'extension-not-loaded' });
      return;
    }
    // No promise returned (non-MV3 environment) — classic callback form.
    try {
      chrome.runtime.sendMessage(swMsg, function (resp) {
        void chrome.runtime.lastError; // e.g. "Receiving end does not exist"
        guiBridgeReply(d.type, d.reqId, resp || { ok: false, error: 'extension-not-loaded' });
      });
    } catch (err2) {
      guiBridgeReply(d.type, d.reqId, { ok: false, error: 'extension-not-loaded' });
    }
  }

  window.addEventListener('message', onGuiBridgeMessage);

  // ---------------------------------------------------------------------
  // T2 — session-restore seed channel (panel.js ↔ this content script).
  //
  // The panel's DSH GUI iframe loads from 127.0.0.1:3081 (the bridge).
  // Chrome partitions localStorage PER ORIGIN, so the GUI's persisted
  // "current session" cell (dsh.sessions.current) that the user built on
  // the direct GUI origin (:3080) is INVISIBLE to the iframe's :3081
  // origin — a fresh panel boot therefore has nothing to restore. The
  // bridge injects a /session-seed <script> into the document head that
  // seeds the :3081 cell, but it can only resolve "latest session"
  // generically; the authoritative value is the frame's own localStorage,
  // which only this content script can read/write (it runs inside the
  // :3081 document, same-origin).
  //
  // protocol (all via window.postMessage, targetOrigin is the iframe's own
  // origin so only the frame itself can reply):
  //   panel → frame  {source:'chrome-eye-hook', type:'chrome-eye:seed-check'}
  //   frame → panel  {source:'chrome-eye-hook', type:'chrome-eye:seed-check:result', value:<id|null>}
  //   panel → frame  {source:'chrome-eye-hook', type:'chrome-eye:seed-write', sessionId:<id>}
  //   frame → panel  {source:'chrome-eye-hook', type:'chrome-eye:seed-write:result', ok:true}
  //   panel → frame  {source:'chrome-eye-hook', type:'chrome-eye:seed-reload'}
  //   (frame reloads itself; no reply)
  //
  // The reply crosses to window.parent with targetOrigin '*': the panel is
  // the ONLY top frame that can host this iframe (the extension's own
  // chrome-extension:// panel page), and the payload carries a session id
  // the panel already knows (it is the source of the seed request), so no
  // sensitive data changes hands. The seed-check reply is debounced with a
  // one-shot in-flight flag so a burst of checks (panel.js retries) cannot
  // cascade into repeated seed-writes.
  // ---------------------------------------------------------------------
  var SEED_CHECK_IN_FLIGHT = false;
  var SEED_WRITE_IN_FLIGHT = false;

  function onSeedMessage(e) {
    var d = e.data;
    if (!d || typeof d.type !== 'string' || d.source !== 'chrome-eye-hook') return;
    if (d.type === 'chrome-eye:seed-check') {
      if (SEED_CHECK_IN_FLIGHT) return;
      SEED_CHECK_IN_FLIGHT = true;
      var id = null;
      try { id = readGuiSessionId(); } catch (err) { id = null; }
      try {
        window.parent.postMessage(
          { source: 'chrome-eye-hook', type: 'chrome-eye:seed-check:result', value: id },
          '*'
        );
      } catch (err) { /* parent gone — nothing to deliver */ }
      setTimeout(function () { SEED_CHECK_IN_FLIGHT = false; }, 50);
      return;
    }
    if (d.type === 'chrome-eye:seed-write') {
      if (SEED_WRITE_IN_FLIGHT) return; // debounce double-writes
      SEED_WRITE_IN_FLIGHT = true;
      var sid = typeof d.sessionId === 'string' ? d.sessionId : '';
      var ok = false;
      if (sid.length > 0) {
        try {
          // Only write if the cell is empty — never clobber a session the
          // user opened in the panel (the seed script in the head does the
          // same guard, this is the belt-and-suspenders path).
          if (!localStorage.getItem(GUI_SESSION_STORAGE_KEY)) {
            localStorage.setItem(
              GUI_SESSION_STORAGE_KEY,
              JSON.stringify({ sessionId: sid })
            );
          }
          ok = true;
        } catch (err) {
          ok = false;
        }
      }
      try {
        window.parent.postMessage(
          { source: 'chrome-eye-hook', type: 'chrome-eye:seed-write:result', ok: ok },
          '*'
        );
      } catch (err) { /* frame gone */ }
      setTimeout(function () { SEED_WRITE_IN_FLIGHT = false; }, 100);
      return;
    }
    if (d.type === 'chrome-eye:seed-reload') {
      try { window.location.reload(); } catch (err) { /* ignore */ }
      return;
    }
  }

  // Registered on ALL origins (the seed protocol is origin-agnostic), but
  // only the panel's top frame posts these messages and only the frame
  // itself replies (window.parent.postMessage with '*' target is safe here:
  // the message carries no sensitive data beyond a session id the panel
  // already holds).
  window.addEventListener('message', onSeedMessage);

  // ------------------------------------------------------------------
  // T11.3 — workspace-tree scraping + session navigation (on demand).
  //
  // Data source is the GUI sidebar DOM only — never :3080/api (trust
  // fence). All selectors are SUBSTRING matches on the CSS-module class
  // pattern `<6-char hash>_<logicalName>`: the logical name is stable
  // across GUI builds, the 6-char hash is per-build, so hashes are never
  // hardcoded.
  //
  // Verified structure (dsh-client-ui-workspace):
  //  • grouped mode (default): per group, div._groupSection containing, in
  //    order: one _projectRow (role=treeitem, aria-expanded; label in
  //    _projectText > _title), n × _sessionRow (role=treeitem,
  //    aria-selected; title in _title), and — when collapsed — a
  //    _sessionOverflowButton (COLLAPSED_SESSION_LIMIT = 5 rows shown).
  //  • flat mode: _sessionRow directly under the list, no groupSections.
  //  • search mode: button._searchResultRow (role=treeitem, aria-selected;
  //    _searchResultTitle, _searchResultWorkspace).
  //
  // Session ids are NOT in the DOM (only in the rows' onClick closures),
  // so rows carry id:null except the aria-selected row, which is stamped
  // with the id read from dsh.sessions.current (same-origin localStorage).
  // Navigation = .click() on the row div: the app's own onClick →
  // onOpen(node.id) → selection → dsh.sessions.current → the 2 s poller.
  // No store writes, no routing.
  // ------------------------------------------------------------------

  var TREE_SESSION_CAP = 200;

  function rowTitle(el) {
    var t = el ? el.querySelector('[class*="_title"]') : null;
    return t ? (t.textContent || '').trim() : '';
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

  // A3 parity copy of scraper.js's autoExpandCollapsedGroups (H2 fix):
  // before a full-list scrape, expand every COLLAPSED group — and only
  // collapsed ones. The pre-H2 pass clicked every group's _projectRow
  // unconditionally, toggling already-expanded groups closed; the scrape
  // then read the stale pre-render DOM and listed rows React had just
  // removed → open-session hit row-not-found. Rules: overflow button →
  // truncated preview; rows visible → expanded (never touch); else
  // aria-expanded="false" → collapsed: click the project row.
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
      var projRow = g.querySelector('[class*="_projectRow"]');
      if (projRow && projRow.getAttribute('aria-expanded') === 'false') {
        projRow.click(); // the app's own treeitem toggle handler
      }
    }
  }

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
      var projRow = g.querySelector('[class*="_projectRow"]');
      if (projRow && projRow.getAttribute('aria-expanded') === 'false' && !clicked) {
        projRow.click(); // the app's own treeitem toggle handler
        clicked = 'projectRow';
      }
    }
    if (!sawGroup) return { ok: false, error: 'group-not-found' };
    if (!clicked) return { ok: false, error: 'no-expand-control' };
    return { ok: true, workspace: w, via: clicked };
  }

  // ------------------------------------------------------------------
  // T11.4 (stretch) — full-size workspace overlay over the GUI chat
  // window. The chat root is located AT RUNTIME (no hardcoded hashes):
  //   [class*="_centerCol"] (AppFrame center column) → first
  //   [class*="_root"] descendant inside it (the conversation root) →
  //   else the center column → else null = full viewport. Inline styles
  //   only (host CSP blocks <style>); the chip strip moved into the side
  //   panel (Task H), so the overlay just avoids the very top edge.
  //   Closes via ✕ and Escape.
  // ------------------------------------------------------------------

  var overlayEl = null;
  var overlayAnchor = null;
  var overlayStatusEl = null;
  var overlayRaf = 0;

  var overlayEscape = function (ev) {
    if (ev.key === 'Escape') {
      ev.stopPropagation();
      closeOverlay();
    }
  };

  function chipStripOffset() {
    // Task H — the chip strip no longer lives in the page (it moved into
    // the side panel), so there is no page-space offset to reserve.
    return 0;
  }

  function findChatRoot() {
    var center = document.querySelector('[class*="_centerCol"]');
    if (!center) return null;
    return center.querySelector('[class*="_root"]') || center;
  }

  function setOverlayStatus(text, isError) {
    if (!overlayStatusEl) return;
    overlayStatusEl.textContent = text || '';
    overlayStatusEl.style.color = isError ? '#b00020' : '#666';
  }

  function positionOverlay() {
    if (!overlayEl) return;
    var r = overlayAnchor
      ? overlayAnchor.getBoundingClientRect()
      : { left: 0, top: 0, width: window.innerWidth, height: window.innerHeight };
    var top = Math.max(r.top, chipStripOffset());
    var bottom = Math.min(r.bottom, window.innerHeight);
    var left = Math.max(0, r.left);
    var width = Math.max(120, Math.min(r.width, window.innerWidth - left));
    var height = Math.max(60, bottom - top);
    var s = overlayEl.style;
    s.top = top + 'px';
    s.left = left + 'px';
    s.width = width + 'px';
    s.height = height + 'px';
  }

  function overlayTick() {
    if (!overlayEl) return;
    // T12 — detachment guard: the overlay element can be removed out-of-
    // band — the panel-side scraper's close path removes the marked
    // element even when THIS world created it (the two ISOLATED-world
    // singletons cannot reach each other's references). Detect the
    // detached element here and tear this world's loop down: stop the rAF
    // loop, remove the keydown-capture listener, clear the stale refs so
    // a later open starts fresh.
    if (!overlayEl.isConnected) {
      if (overlayRaf) {
        cancelAnimationFrame(overlayRaf);
        overlayRaf = 0;
      }
      document.removeEventListener('keydown', overlayEscape, true);
      overlayEl = null;
      overlayAnchor = null;
      overlayStatusEl = null;
      return;
    }
    positionOverlay();
    overlayRaf = requestAnimationFrame(overlayTick);
  }

  function renderOverlayBody(tree) {
    var body = overlayEl.querySelector('[data-ce-body]');
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
                setOverlayStatus('Opened "' + s.title + '"');
                setTimeout(closeOverlay, 250);
              } else {
                setOverlayStatus('Not in the sidebar right now — open the workspace in the GUI sidebar first', true);
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
                  try { renderOverlayBody(scrapeWorkspaceTree()); } catch (e) { /* keep current */ }
                }, 450);
              } else {
                setOverlayStatus('Could not expand: ' + (res.error || 'no response'), true);
              }
            });
            body.appendChild(more);
          })(proj.name);
        }
      }
    }
  }

  function openOverlay() {
    if (overlayEl) return { ok: true, open: true, already: true };
    var tree;
    autoExpandCollapsedGroups(); // A3: overlay initial render shows full lists
    try { tree = scrapeWorkspaceTree(); } catch (e) {
      return { ok: false, error: String((e && e.message) || e) };
    }
    overlayAnchor = findChatRoot();
    overlayEl = document.createElement('div');
    overlayEl.setAttribute('data-chrome-eye-overlay', 'true');
    overlayEl.style.cssText =
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
    overlayStatusEl = document.createElement('span');
    overlayStatusEl.style.cssText =
      'flex:1;font-size:12px;color:#666;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
    var closeBtn = document.createElement('button');
    closeBtn.textContent = '✕';
    closeBtn.style.cssText =
      'cursor:pointer;border:none;background:transparent;font-size:14px;' +
      'color:inherit;padding:2px 6px;border-radius:4px;flex:none;';
    closeBtn.addEventListener('click', function () { closeOverlay(); });
    header.appendChild(title);
    header.appendChild(overlayStatusEl);
    header.appendChild(closeBtn);

    var body = document.createElement('div');
    body.setAttribute('data-ce-body', 'true');
    body.style.cssText = 'flex:1;overflow-y:auto;padding:6px 8px 12px;';

    overlayEl.appendChild(header);
    overlayEl.appendChild(body);
    (document.body || document.documentElement).appendChild(overlayEl);
    renderOverlayBody(tree);
    // H2: the sync scrape above ran before React re-rendered the
    // newly-expanded groups; refresh the body once the rows are in.
    setTimeout(function () {
      if (!overlayEl) return; // overlay closed in the meantime
      try { renderOverlayBody(scrapeWorkspaceTree()); } catch (e) { /* keep current */ }
    }, 450);
    positionOverlay();
    overlayRaf = requestAnimationFrame(overlayTick);
    document.addEventListener('keydown', overlayEscape, true);

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
      anchor: !center ? 'viewport' : (overlayAnchor === center ? 'center-col' : 'chat-root')
    };
  }

  function closeOverlay() {
    if (!overlayEl) return { ok: true, open: false };
    if (overlayRaf) { cancelAnimationFrame(overlayRaf); overlayRaf = 0; }
    document.removeEventListener('keydown', overlayEscape, true);
    if (overlayEl.parentNode) overlayEl.parentNode.removeChild(overlayEl);
    overlayEl = null;
    overlayAnchor = null;
    overlayStatusEl = null;
    return { ok: true, open: false };
  }

  if (GUI_ORIGINS[location.origin] === 1) {
    try {
      watchGuiSession();
    } catch (e) {
      // Never break the host page: GUI session tracking is best-effort.
    }

    // T11.3/T11.4 — on-demand tree + navigation + overlay, served to the
    // SW (panel flow). Registered only on the GUI origin: any other page
    // must keep answering "no receiver" so the SW's chrome.scripting
    // fallback stays meaningful.
    try {
      chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
        if (!message || typeof message.type !== 'string') return false;
        try {
          if (message.type === 'chrome-eye:scrape-tree') {
            autoExpandCollapsedGroups(); // A3/H2: message-driven full-list scrape
            // H2: let React render the newly-expanded rows before reading the
            // DOM (return true keeps the channel open for the async response —
            // the SW sends without awaitPromise, so classic sendResponse).
            setTimeout(function () {
              try {
                sendResponse(scrapeWorkspaceTree());
              } catch (e) {
                sendResponse({ ok: false, error: String((e && e.message) || e) });
              }
            }, 400);
            return true;
          }
          if (message.type === 'chrome-eye:open-session') {
            var res = openSessionAction(message.workspace, message.title);
            if (res.ok) {
              sendResponse(res);
              return true;
            }
            // H2: the GUI collapses ALL groups after a session opens, so the
            // row may sit in a collapsed group. Expand, wait one render, retry.
            autoExpandCollapsedGroups();
            setTimeout(function () {
              try {
                sendResponse(openSessionAction(message.workspace, message.title));
              } catch (e) {
                sendResponse({ ok: false, error: String((e && e.message) || e) });
              }
            }, 500);
            return true;
          }
          if (message.type === 'chrome-eye:expand-group') {
            sendResponse(expandGroupAction(message.workspace));
            return true;
          }
          if (message.type === 'chrome-eye:overlay') {
            sendResponse(message.open === false ? closeOverlay() : openOverlay());
            return true;
          }
        } catch (e) {
          sendResponse({ ok: false, error: String((e && e.message) || e) });
          return true;
        }
        return false;
      });
    } catch (e) {
      // Best-effort: the panel will surface "no response" in that case.
    }
  }

  // ---------------------------------------------------------------------
  // Agent drive channel — the agent (via the chrome-eye model tool →
  // bridge /cmd → SW) asks THIS tab's content script to act on the page:
  // click a CSS selector, type into one, or navigate. These run in the
  // isolated world on the REAL top-frame page (any http(s) origin), so
  // they are the primitive the agent uses to drive the active content tab.
  //
  // Only the three drive verbs are processed here; the capture / GUI
  // listeners above are untouched. Every action reports the smallest
  // useful result so the agent can confirm or adjust:
  //   chrome-eye:drive:click     {selector} -> {ok, matched, tag, rect}
  //   chrome-eye:drive:type      {selector, text, clear} -> {ok, matched, valueLen}
  //   chrome-eye:drive:navigate  {url}      -> {ok, from, to}
  // ---------------------------------------------------------------------
  function driveRectOf(el) {
    try {
      var r = el.getBoundingClientRect();
      return { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) };
    } catch (e) { return null; }
  }
  function driveTagOf(el) {
    return el && el.tagName ? el.tagName.toLowerCase() : null;
  }
  function driveVisible(el) {
    try {
      var r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) return false;
      var st = (window.getComputedStyle && window.getComputedStyle(el)) || null;
      return !(st && (st.visibility === 'hidden' || st.display === 'none' || st.opacity === '0'));
    } catch (e) { return true; }
  }
  // Resolve a CSS selector to the first visible element; throws a readable
  // error when nothing matches so the agent can fix the selector.
  function driveResolve(selector) {
    if (typeof selector !== 'string' || !selector.trim()) {
      throw new Error('drive: selector is required (a CSS selector)');
    }
    var els;
    try { els = Array.prototype.slice.call(document.querySelectorAll(selector)); }
    catch (e) { throw new Error('drive: bad selector "' + selector + '": ' + String((e && e.message) || e)); }
    if (!els.length) throw new Error('drive: no element matches "' + selector + '"');
    for (var i = 0; i < els.length; i++) if (driveVisible(els[i])) return els[i];
    return els[0]; // none visible — return the first and let the click decide
  }
  function driveClick(message) {
    var el = driveResolve(message.selector);
    try {
      el.scrollIntoView({ block: 'center', inline: 'center' });
    } catch (e) { /* best effort */ }
    el.click();
    return { ok: true, matched: true, tag: driveTagOf(el), rect: driveRectOf(el) };
  }
  function driveType(message) {
    var el = driveResolve(message.selector);
    var text = typeof message.text === 'string' ? message.text : '';
    var clear = message.clear !== false;
    try {
      el.focus && el.focus();
      el.scrollIntoView({ block: 'center', inline: 'center' });
    } catch (e) { /* best effort */ }
    try {
      if ('value' in el) {
        var setter = null;
        var proto = el.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
        var d = Object.getOwnPropertyDescriptor(proto, 'value');
        if (d && typeof d.set === 'function') setter = d.set;
        if (setter) setter.call(el, clear ? text : (el.value + text));
        else if ('value' in el) el.value = clear ? text : (el.value + text);
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      } else if (el.isContentEditable) {
        el.textContent = text;
        el.dispatchEvent(new InputEvent('input', { bubbles: true }));
      } else {
        el.textContent = text;
      }
    } catch (e) {
      throw new Error('drive: type failed: ' + String((e && e.message) || e));
    }
    var value = null;
    var valueDisplay = '';
    try {
      if (el.value != null) value = el.value;
      else value = el.textContent || '';
    } catch (e) { /* ignore */ }
    return { ok: true, matched: true, tag: driveTagOf(el), valueLen: value ? value.length : 0, value: String(value).slice(0, 200) };
  }
  function driveNavigate(message) {
    var url = typeof message.url === 'string' ? message.url.trim() : '';
    if (!url) throw new Error('drive: url is required for navigate');
    var from = location.href;
    try { window.location.href = url; } catch (e) { throw new Error('drive: navigate failed: ' + String((e && e.message) || e)); }
    return { ok: true, from: from, to: url };
  }
  function driveGetPageText(message) {
    var maxChars = typeof message.maxChars === 'number' ? message.maxChars : 10000;
    if (maxChars < 0) maxChars = 10000;
    var visible = document.body.innerText || document.body.textContent || '';
    var trimmed = visible.replace(/\s+/g, ' ').trim();
    if (trimmed.length > maxChars) trimmed = trimmed.slice(0, maxChars);
    return { ok: true, text: trimmed, length: trimmed.length, truncated: visible.length > maxChars };
  }

  // ---------------------------------------------------------------------------
  // driveGetPageContext — Gemini-like structured page context extraction
  // Extracts headings, links, forms, tables, meta data, and visible text
  // in a structured format that gives the model a richer understanding of the page.
  // ---------------------------------------------------------------------------
  function driveGetPageContext(message) {
    var maxChars = typeof message.maxChars === 'number' ? message.maxChars : 50000;
    if (maxChars < 0) maxChars = 50000;
    var maxLinks = typeof message.maxLinks === 'number' ? message.maxLinks : 50;
    var maxHeadings = typeof message.maxHeadings === 'number' ? message.maxHeadings : 30;
    var maxForms = typeof message.maxForms === 'number' ? message.maxForms : 10;
    var maxTables = typeof message.maxTables === 'number' ? message.maxTables : 5;

    var ctx = {
      url: document.URL,
      title: document.title || '',
      headings: [],
      links: [],
      forms: [],
      tables: [],
      meta: {},
      visibleText: ''
    };

    // Extract metadata
    try {
      var metas = document.querySelectorAll('meta[name], meta[property], meta[itemprop]');
      metas.forEach(function(m) {
        var name = m.getAttribute('name') || m.getAttribute('property') || m.getAttribute('itemprop');
        var content = m.getAttribute('content');
        if (name && content) ctx.meta[name] = content;
      });
      // Also get og:title, og:description, etc.
      var ogMetas = document.querySelectorAll('meta[property^="og:"]');
      ogMetas.forEach(function(m) {
        ctx.meta[m.getAttribute('property')] = m.getAttribute('content');
      });
    } catch(e) {}

    // Extract headings
    var headingEls = document.querySelectorAll('h1, h2, h3, h4, h5, h6');
    headingEls.forEach(function(h) {
      var text = h.textContent.trim().replace(/\s+/g, ' ').slice(0, 200);
      if (text && !h.closest('[hidden], [style*="display: none"], [style*="display:none"]')) {
        ctx.headings.push({ level: parseInt(h.tagName.charAt(1)) || 0, text: text });
      }
    });
    ctx.headings = ctx.headings.slice(0, maxHeadings);

    // Extract visible links
    var links = document.querySelectorAll('a[href]');
    links.forEach(function(a) {
      var text = a.textContent.trim().replace(/\s+/g, ' ').slice(0, 100);
      var href = a.getAttribute('href') || '';
      var visible = !a.closest('[hidden]') && isElementVisible(a);
      if (text && visible) {
        ctx.links.push({ text: text, url: href });
      }
    });
    ctx.links = ctx.links.slice(0, maxLinks);

    // Extract forms
    var forms = document.querySelectorAll('form');
    forms.forEach(function(f) {
      var inputs = f.querySelectorAll('input:not([type="hidden"]), select, textarea');
      var fields = [];
      inputs.forEach(function(inp) {
        var tag = inp.tagName.toLowerCase();
        fields.push({
          tag: tag,
          type: inp.getAttribute('type') || '',
          name: inp.getAttribute('name') || inp.id || '',
          id: inp.id || '',
          placeholder: (inp.placeholder || '').slice(0, 50),
          required: inp.hasAttribute('required'),
          value: (inp.value || '').slice(0, 50)
        });
      });
      if (fields.length > 0) {
        ctx.forms.push({
          action: f.getAttribute('action') || '',
          method: f.getAttribute('method') || 'GET',
          fields: fields
        });
      }
    });
    ctx.forms = ctx.forms.slice(0, maxForms);

    // Extract table summaries
    var tables = document.querySelectorAll('table');
    tables.forEach(function(tbl) {
      if (!isElementVisible(tbl)) return;
      var rows = tbl.querySelectorAll('tr');
      var headers = tbl.querySelectorAll('th');
      var headerTexts = [];
      headers.forEach(function(th) { headerTexts.push(th.textContent.trim().slice(0, 50)); });
      var rowTexts = [];
      var rowCount = 0;
      rows.forEach(function(tr) {
        if (rowCount >= 10) return; // limit rows
        var cells = tr.querySelectorAll('td');
        var cellTexts = [];
        cells.forEach(function(td) { cellTexts.push(td.textContent.trim().slice(0, 50)); });
        rowTexts.push(cellTexts.join(' | '));
        rowCount++;
      });
      ctx.tables.push({
        headers: headerTexts.slice(0, 10),
        rows: rowTexts.slice(0, 10),
        totalRows: rows.length,
        totalCols: Math.max(...Array.from(rows).map(r => r.querySelectorAll('td').length))
      });
    });
    ctx.tables = ctx.tables.slice(0, maxTables);

    // Visible text (inner text, cleaned)
    try {
      var visible = document.body.innerText || '';
      var cleaned = visible.replace(/\s+/g, ' ').trim();
      if (cleaned.length > maxChars) {
        ctx.visibleText = cleaned.slice(0, maxChars);
        ctx.truncated = true;
      } else {
        ctx.visibleText = cleaned;
        ctx.truncated = false;
      }
    } catch(e) {}

    ctx.totalHeadings = headingEls.length;
    ctx.totalLinks = links.length;
    ctx.totalForms = forms.length;
    ctx.totalTables = tables.length;

    return { ok: true, context: ctx };
  }

  // Helper: check if element is visible
  function isElementVisible(el) {
    if (!el || el === document.body) return true;
    var rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return false;
    var style = window.getComputedStyle(el);
    if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
    return isElementVisible(el.parentElement);
  }

  // ---------------------------------------------------------------------------
  // driveGetElementRect — return bounding rect of an element
  // Enables the agent's vision model to place bounding boxes on screenshots.
  // ---------------------------------------------------------------------------
  function driveGetElementRect(message) {
    var el = driveResolve(message.selector);
    if (!el) return { ok: true, found: false, error: 'selector not found' };
    var rect = el.getBoundingClientRect();
    return {
      ok: true,
      found: true,
      x: Math.round(rect.left),
      y: Math.round(rect.top),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
      tag: driveTagOf(el),
      text: (el.textContent || '').slice(0, 100).trim(),
    };
  }

  // ---------------------------------------------------------------------------
  // driveAutoFormFill — match form field names to labels/placeholders/names
  // and fill values. Returns { filled, failed[] }.
  // ---------------------------------------------------------------------------
  function driveAutoFormFill(message) {
    var formData = message.formData || {};
    var pressEnter = !!message.pressEnter;
    var filled = 0;
    var failed = [];

    var keys = Object.keys(formData);
    var inputs = Array.prototype.slice.call(
      document.querySelectorAll('input, select, textarea')
    );

    for (var ki = 0; ki < keys.length; ki++) {
      var key = keys[ki];
      var value = formData[key];
      var matched = false;

      // Search by: name, id, placeholder, aria-label, associated label text
      for (var ii = 0; ii < inputs.length; ii++) {
        var inp = inputs[ii];
        var match = false;

        if (inp.name && inp.name.toLowerCase().indexOf(key.toLowerCase()) >= 0) match = true;
        else if (inp.id && inp.id.toLowerCase().indexOf(key.toLowerCase()) >= 0) match = true;
        else if (inp.placeholder && inp.placeholder.toLowerCase().indexOf(key.toLowerCase()) >= 0) match = true;
        else if (inp.getAttribute('aria-label') && inp.getAttribute('aria-label').toLowerCase().indexOf(key.toLowerCase()) >= 0) match = true;
        else {
          // Check associated labels
          var labels = document.querySelectorAll('label[for="' + inp.id + '"]');
          if (labels.length) {
            for (var li = 0; li < labels.length; li++) {
              if (labels[li].textContent.toLowerCase().indexOf(key.toLowerCase()) >= 0) {
                match = true;
                break;
              }
            }
          }
        }

        if (match) {
          try {
            if ('value' in inp) {
              var proto = inp.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
              var d = Object.getOwnPropertyDescriptor(proto, 'value');
              var setter = d && typeof d.set === 'function' ? d.set : null;
              if (setter) setter.call(inp, value);
              else if ('value' in inp) inp.value = value;
              inp.dispatchEvent(new Event('input', { bubbles: true }));
              inp.dispatchEvent(new Event('change', { bubbles: true }));
            }
            filled++;
            matched = true;
            if (pressEnter && ki === keys.length - 1) {
              inp.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
              inp.dispatchEvent(new KeyboardEvent('keypress', { key: 'Enter', bubbles: true }));
              inp.dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
            }
          } catch (e) {
            // best effort — continue to next field
          }
          break;
        }
      }

      if (!matched) failed.push(key);
    }

    return { ok: true, filled: filled, total: keys.length, failed: failed };
  }

  try {
    chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
      if (!message || typeof message.type !== 'string') return false;
      var t = message.type;
      if (t !== 'chrome-eye:drive:click' && t !== 'chrome-eye:drive:type' && t !== 'chrome-eye:drive:navigate' && t !== 'chrome-eye:drive:getPageText' && t !== 'chrome-eye:drive:getPageContext' && t !== 'chrome-eye:drive:getElementRect' && t !== 'chrome-eye:drive:autoFormFill') return false;
      try {
        var result;
        if (t === 'chrome-eye:drive:click') result = driveClick(message);
        else if (t === 'chrome-eye:drive:type') result = driveType(message);
        else if (t === 'chrome-eye:drive:navigate') result = driveNavigate(message);
        else if (t === 'chrome-eye:drive:getPageText') result = driveGetPageText(message);
        else if (t === 'chrome-eye:drive:getPageContext') result = driveGetPageContext(message);
        else if (t === 'chrome-eye:drive:getElementRect') result = driveGetElementRect(message);
        else if (t === 'chrome-eye:drive:autoFormFill') result = driveAutoFormFill(message);
        sendResponse(result);
      } catch (e) {
        sendResponse({ ok: false, error: String((e && e.message) || e) });
      }
      return true; // keep the channel open for the (sync) response
    });
  } catch (e) { /* best-effort — SW will report "no receiver" */ }
})();
