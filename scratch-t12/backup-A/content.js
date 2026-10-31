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

  // ---------------------------------------------------------------------
  // T11.2 — Gemini-style context chip row (view only). Rendered ONLY on
  // the GUI origin while the side panel is open. The service worker is the
  // single source of truth (staged chips + panel state); this script
  // re-renders a fixed top strip from the panel-state poll and forwards
  // ✕ / + / → interactions back to the SW. Everything here is
  // extension-injected DOM (inline style attributes only — no <style> tag,
  // the host page's CSP covers injected styles), so it vanishes when the
  // extension is disabled. No DSH harness code is touched.
  // ---------------------------------------------------------------------
  var chipsRoot = null;      // the fixed top-strip <div> (or null)
  var chipsDropdown = null;  // the "+" tab picker (or null)
  var chipsStatus = { text: '', error: false };
  var chipsBusy = false;     // "→" in flight
  var lastChipsKey = '';     // serialized (staged + status) of last render
  var currentStaged = [];

  function askSw(type, extra) {
    var msg = { type: type };
    if (extra) {
      for (var k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k)) msg[k] = extra[k];
      }
    }
    try {
      var p = chrome.runtime.sendMessage(msg);
      if (p && typeof p.catch === 'function') {
        return p.then(null, function () { return null; });
      }
    } catch (e) {
      // Extension context unavailable (e.g. right after a reload) — the
      // next tick retries.
    }
    return Promise.resolve(null);
  }

  function chipsEl(tag, cssText, text) {
    var el = document.createElement(tag);
    if (cssText) el.style.cssText = cssText;
    if (text != null) el.textContent = text;
    return el;
  }

  // Favicon-style dot: colored circle + first letter of the title.
  function chipDot(title) {
    var t = String(title || '?').trim();
    var hue = 0;
    for (var i = 0; i < t.length; i++) hue = (hue * 31 + t.charCodeAt(i)) % 360;
    var dot = chipsEl('span',
      'display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;' +
      'border-radius:8px;background:hsl(' + hue + ',45%,42%);color:#fff;font-size:10px;' +
      'flex:none;user-select:none;');
    dot.textContent = (t.charAt(0).toUpperCase()) || '?';
    return dot;
  }

  function renderChips(staged) {
    chipsRoot.innerHTML = '';
    var row = chipsEl('div', 'display:flex;align-items:center;gap:6px;flex-wrap:wrap;');

    for (var i = 0; i < staged.length; i++) {
      (function (item) {
        var chip = chipsEl('span',
          'display:inline-flex;align-items:center;gap:5px;max-width:220px;padding:2px 4px 2px 6px;' +
          'border:1px solid rgba(0,0,0,0.12);border-radius:12px;background:rgba(0,0,0,0.04);');
        chip.appendChild(chipDot(item.title));
        chip.appendChild(chipsEl('span',
          'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;', item.title));
        var x = chipsEl('button',
          'border:none;background:transparent;color:#666;font-size:12px;line-height:1;' +
          'cursor:pointer;padding:0 2px;', '✕');
        x.title = 'Remove ' + item.title;
        x.addEventListener('click', function () {
          askSw('chrome-eye:unstage-tab', { tabId: item.id }).then(function (res) {
            if (res && res.ok) syncChips(true, res.staged || []);
          });
        });
        chip.appendChild(x);
        row.appendChild(chip);
      })(staged[i]);
    }

    var plus = chipsEl('button',
      'border:1px solid rgba(0,0,0,0.15);background:rgba(0,0,0,0.03);border-radius:10px;' +
      'width:22px;height:22px;line-height:1;font-size:13px;color:#333;cursor:pointer;flex:none;', '+');
    plus.title = 'Add a tab as context';
    plus.addEventListener('click', function () {
      if (chipsDropdown) { closeDropdown(); return; }
      openDropdown();
    });
    row.appendChild(plus);

    var go = chipsEl('button',
      'border:none;background:#1a7f37;color:#fff;border-radius:10px;padding:2px 8px;' +
      'font-size:12px;cursor:pointer;flex:none;', '→ add to session');
    go.title = 'Capture each staged page into the session you are viewing ' +
      '(queued for your next prompt)';
    go.disabled = !staged.length || chipsBusy;
    go.addEventListener('click', function () { sendStagedToSession(); });
    row.appendChild(go);

    if (chipsStatus.text) {
      row.appendChild(chipsEl('span',
        'color:' + (chipsStatus.error ? '#b00020' : '#1a7f37') + ';font-size:12px;',
        chipsStatus.text));
    }
    chipsRoot.appendChild(row);
  }

  function syncChips(open, staged) {
    currentStaged = staged;
    if (!document.body) return;
    if (!open) {
      if (chipsRoot) { chipsRoot.parentNode.removeChild(chipsRoot); chipsRoot = null; }
      lastChipsKey = '';
      closeDropdown();
      return;
    }
    var key = JSON.stringify(staged) + '|' + chipsStatus.text + '|' + chipsStatus.error;
    if (key === lastChipsKey) return; // no change — do not clobber focus/dropdown
    lastChipsKey = key;
    if (!chipsRoot) {
      chipsRoot = chipsEl('div',
        'position:fixed;top:0;left:0;right:0;z-index:2147483647;display:flex;' +
        'box-sizing:border-box;padding:5px 8px;background:rgba(255,255,255,0.95);' +
        'border-bottom:1px solid rgba(0,0,0,0.1);font-size:12px;line-height:1.4;' +
        'font-family:system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;');
      document.body.appendChild(chipsRoot);
    }
    renderChips(staged);
  }

  function openDropdown() {
    askSw('chrome-eye:list-tabs').then(function (res) {
      if (!res || !res.ok) {
        chipsStatus = { text: 'tab list unavailable', error: true };
        syncChips(true, currentStaged);
        return;
      }
      showDropdown(res.tabs || []);
    });
  }

  function showDropdown(tabs) {
    closeDropdown();
    var dd = chipsEl('div',
      'position:fixed;top:30px;left:8px;z-index:2147483647;max-width:340px;max-height:240px;' +
      'overflow-y:auto;background:#fff;border:1px solid rgba(0,0,0,0.15);border-radius:8px;' +
      'box-shadow:0 4px 14px rgba(0,0,0,0.18);font-size:12px;padding:4px;');
    if (!tabs.length) {
      dd.appendChild(chipsEl('div', 'padding:6px 8px;color:#888;',
        'no http(s) tabs in this window'));
    }
    for (var i = 0; i < tabs.length; i++) {
      (function (t) {
        var entry = chipsEl('div',
          'display:flex;align-items:center;gap:6px;padding:5px 6px;border-radius:6px;cursor:pointer;');
        entry.addEventListener('mouseenter', function () { entry.style.background = 'rgba(0,0,0,0.05)'; });
        entry.addEventListener('mouseleave', function () { entry.style.background = ''; });
        entry.appendChild(chipDot(t.title));
        var txt = chipsEl('div', 'min-width:0;');
        txt.appendChild(chipsEl('div',
          'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:260px;', t.title));
        txt.appendChild(chipsEl('div',
          'color:#999;font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:260px;',
          t.url));
        entry.appendChild(txt);
        entry.addEventListener('click', function () {
          askSw('chrome-eye:stage-tab', { tabId: t.id }).then(function (res) {
            closeDropdown();
            if (!res) return;
            if (res.ok) {
              syncChips(true, res.staged || []);
            } else {
              chipsStatus = { text: String(res.error || 'staging failed'), error: true };
              syncChips(true, res.staged || []);
            }
          });
        });
        dd.appendChild(entry);
      })(tabs[i]);
    }
    document.body.appendChild(dd);
    chipsDropdown = dd;
  }

  function closeDropdown() {
    if (chipsDropdown && chipsDropdown.parentNode) {
      chipsDropdown.parentNode.removeChild(chipsDropdown);
    }
    chipsDropdown = null;
  }

  // Close the picker on any outside click (capture phase, no other side effects).
  document.addEventListener('mousedown', function (ev) {
    if (!chipsDropdown) return;
    var node = ev.target;
    var inside = false;
    while (node && node !== document) {
      if (node === chipsDropdown || node === chipsRoot) { inside = true; break; }
      node = node.parentNode;
    }
    if (!inside) closeDropdown();
  }, true);

  function sendStagedToSession() {
    if (!currentStaged.length || chipsBusy) return;
    chipsBusy = true;
    chipsStatus = {
      text: 'Adding ' + currentStaged.length + ' page' +
        (currentStaged.length === 1 ? '' : 's') + '…',
      error: false
    };
    syncChips(true, currentStaged);
    askSw('chrome-eye:add-staged').then(function (res) {
      chipsBusy = false;
      if (!res) {
        chipsStatus = { text: 'service worker unavailable — try again', error: true };
        syncChips(true, currentStaged);
        return;
      }
      var n = res.total != null ? res.total : currentStaged.length;
      if (res.ok) {
        chipsStatus = res.fallback
          ? { text: 'Saved ' + n + ' page' + (n === 1 ? '' : 's') +
            ' (no session open) → bridge HTTP ' + (res.status != null ? res.status : 200),
              error: false }
          : { text: n + ' page' + (n === 1 ? '' : 's') +
            ' added to session context (queued for your next prompt)', error: false };
      } else {
        chipsStatus = { text: 'Share failed: ' + String(res.error || 'unknown error'), error: true };
      }
      syncChips(true, res.staged || []);
    });
  }

  function watchGuiSession() {
    var lastSent = undefined; // undefined = not yet reported; null = no session
    var timer = null;
    var tick = function () {
      // 1) session report — still change-gated.
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
      // 2) T11.2: panel open/close + staged chips, every tick.
      askSw('chrome-eye:panel-state').then(function (res) {
        if (res && typeof res.panelOpen === 'boolean') {
          syncChips(res.panelOpen, res.staged || []);
        }
      });
    };
    tick(); // initial report as soon as the page has loaded
    timer = setInterval(tick, GUI_POLL_MS);
  }

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

  function expandGroupAction(workspace) {
    var w = String(workspace || '').trim();
    var groups = document.querySelectorAll('[class*="_groupSection"]');
    for (var i = 0; i < groups.length; i++) {
      if (groupSectionName(groups[i]) !== w) continue;
      var btn = groups[i].querySelector('[class*="_sessionOverflowButton"]');
      if (!btn) return { ok: false, error: 'no-overflow' };
      btn.click(); // the app's own expand handler (setExpandedSessionGroups)
      return { ok: true, workspace: w };
    }
    return { ok: false, error: 'group-not-found' };
  }

  // ------------------------------------------------------------------
  // T11.4 (stretch) — full-size workspace overlay over the GUI chat
  // window. The chat root is located AT RUNTIME (no hardcoded hashes):
  //   [class*="_centerCol"] (AppFrame center column) → first
  //   [class*="_root"] descendant inside it (the conversation root) →
  //   else the center column → else null = full viewport below the chip
  //   strip. Inline styles only (host CSP blocks <style>); z-index below
  //   the chip strip (2147483647). Closes via ✕ and Escape.
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
    return chipsRoot && chipsRoot.parentNode ? (chipsRoot.offsetHeight || 0) + 4 : 0;
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
                try { renderOverlayBody(scrapeWorkspaceTree()); } catch (e) { /* keep current */ }
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

  if (location.origin === GUI_ORIGIN) {
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
            sendResponse(scrapeWorkspaceTree());
            return true;
          }
          if (message.type === 'chrome-eye:open-session') {
            sendResponse(openSessionAction(message.workspace, message.title));
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
})();
