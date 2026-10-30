// Chrome Eye — composer hook (Task J: fresh context attach at prompt time).
//
// Injected by the service worker via chrome.scripting.executeScript
// (files: ['composer-hook.js'], ISOLATED world) into the panel's :3081 GUI
// iframe, and into any real tab on :3080/:3081 via the webNavigation
// onCompleted hook. It adds two things to the DSH composer:
//
//   1. Submit interception (Enter AND the send button): when the user
//      submits a NON-EMPTY prompt — Enter keydown or a click on the send
//      button (button[aria-label="Send message"]) — while pages are staged,
//      the hook (a) asks the SW to capture every staged tab FRESH
//      ('chrome-eye:prompt-attach' — one-shot: the staged list clears
//      inside the SW), (b) appends the returned context block to the
//      composer text, preserving the user's own text, and (c)
//      re-dispatches a synthetic Enter so the app submits the combined
//      prompt. If the attach yields nothing (list emptied in the meantime,
//      or every capture failed) the plain prompt is re-submitted as-is, so
//      the user's submit always does what they expect.
//
//      Both interceptions use CAPTURE-phase document listeners +
//      stopPropagation: the app's Lexical keymap is registered on the
//      editor root element (target phase), its send-button handler is
//      delegated from the app root (bubble phase), and neither checks
//      defaultPrevented (verified in the live bundle), so preventDefault
//      alone would NOT stop the submit — propagation must be stopped
//      before the app ever sees the event. Re-submission always goes
//      through the proven synthetic-Enter path, even for a button click.
//
//   2. A small floating "📑 N" button next to the composer's send button
//      (visible only while pages are staged) with a popover listing the
//      window's http(s) tabs and checkboxes that round-trip the SW's staged
//      list. The GUI ships no CSP header, but all styles are still set via
//      the CSSOM (style.cssText) — no inline style attributes, no <style>
//      tags — so the hook stays safe if a CSP is added later.
//
//   3. Context-invalidation recovery: an extension reload kills this
//      document's chrome.runtime while the panel's GUI iframe keeps living
//      (the reload does NOT reload it). sendSw() then throws forever and
//      the badge/attach silently die. Once detected — and only after this
//      document had successfully reached the SW — the hook posts
//      'chrome-eye:context-invalidated' to the parent panel, which resets
//      the iframe src; the fresh load re-injects a hook with a live
//      runtime.
//
// Idempotency: window.__ceComposerHook in the ISOLATED world (separate from
// the page's window, shared across executeScript calls in the same frame) —
// re-injection after an iframe reload is a no-op, a fresh frame re-inits.
//
// Selectors: stable data attributes / aria-labels only
// (data-composer-input="true", aria-label="Send message") — NEVER
// CSS-module hash classes (uV2eYG_…), which change on every rebuild.
'use strict';

(function () {
  if (window.__ceComposerHook) return; // already injected in this frame
  window.__ceComposerHook = true;

  var armed = 0;             // cached staged count (polled every 2 s)
  var stagedList = [];       // latest staged list (from the SW)
  var reDispatching = false; // guard: ignore our own synthetic re-dispatches
  var button = null;
  var popover = null;
  var popoverOpen = false;
  var currentTabs = [];
  var everConnected = false;   // this document ever reached the SW
  var lastInvalidationPing = 0;

  // ------------------------------------------------------------- SW round-trip
  function sendSw(type, payload, cb) {
    var msg = { type: type };
    if (payload) { for (var k in payload) msg[k] = payload[k]; }
    try {
      chrome.runtime.sendMessage(msg, function (resp) {
        void chrome.runtime.lastError; // no receiver (reload in flight) → null
        if (resp && resp.ok) everConnected = true;
        cb(resp);
      });
    } catch (e) {
      // Extension context invalidated (extension reloaded/removed): this
      // document's chrome.runtime is dead forever. If it had reached the SW
      // before, ask the parent panel to reload this frame — the manifest
      // re-injects a fresh hook with a live runtime on the new load. The
      // everConnected gate keeps a permanently-broken extension from
      // triggering a reload loop (a fresh doc in a broken extension never
      // connects, so it never pings).
      var dead = false;
      try {
        dead = !chrome.runtime || chrome.runtime.id === undefined;
      } catch (e2) { dead = true; }
      if (dead && everConnected) {
        var now = Date.now();
        if (now - lastInvalidationPing >= 3000) {
          lastInvalidationPing = now;
          try {
            window.parent.postMessage(
              { source: 'chrome-eye-hook',
                type: 'chrome-eye:context-invalidated' }, '*');
          } catch (e3) { /* no parent frame to notify */ }
        }
      }
      cb(null);
    }
  }

  function refreshState() {
    sendSw('chrome-eye:panel-state', null, function (resp) {
      if (resp && resp.ok) {
        stagedList = Array.isArray(resp.staged) ? resp.staged : [];
        armed = stagedList.length;
        updateButton();
        if (popoverOpen) markRowsChecked();
      }
    });
  }

  // ------------------------------------------------------------- composer discovery
  // The editable root of the DSH composer, live-verified:
  //   div[data-composer-input="true"][contenteditable="true"][role="textbox"]
  // with aria-label "Message or run a task... / commands, @ files or sessions".
  // The data-* attributes are app markers (not build hashes); the aria-label
  // test is a secondary discriminator; a visible-textbox fallback is last.
  function findComposerBox() {
    var cands = document.querySelectorAll(
      'div[data-composer-input="true"][contenteditable="true"]');
    if (!cands.length) {
      cands = document.querySelectorAll(
        'div[role="textbox"][contenteditable="true"]');
    }
    var fallback = null;
    for (var i = 0; i < cands.length; i++) {
      var el = cands[i];
      var label = (el.getAttribute('aria-label') || '') + ' ' +
        (el.getAttribute('data-placeholder') || '');
      if (/message/i.test(label)) return el;
      if (!fallback) {
        var r = el.getBoundingClientRect();
        if (r.width > 50 && r.height > 10) fallback = el;
      }
    }
    return fallback;
  }

  // The send control, live-verified: button[aria-label="Send message"],
  // the last button in the composer row. Structural fallback: last visible
  // button inside the composer root (the card's parent, which also holds
  // the toolbar row).
  function findSendButton() {
    var b = document.querySelector('button[aria-label="Send message"]');
    if (b) return b;
    var box = findComposerBox();
    if (!box) return null;
    // grow → scroll → card → root (card + row)
    var root = box.parentElement && box.parentElement.parentElement &&
      box.parentElement.parentElement.parentElement;
    if (!root) return null;
    var buttons = root.querySelectorAll('button');
    for (var i = buttons.length - 1; i >= 0; i--) {
      var r = buttons[i].getBoundingClientRect();
      if (r.width > 0 && r.height > 0) return buttons[i];
    }
    return null;
  }

  // ------------------------------------------------------------- Enter interception
  function onKeydown(event) {
    if (reDispatching) return;               // our own re-dispatch — let it flow
    if (event.key !== 'Enter') return;
    if (event.shiftKey) return;              // newline
    if (event.ctrlKey || event.metaKey || event.altKey) return; // app's own paths
    if (event.repeat) return;                // held key — the app consumes repeats
    if (event.isComposing || event.keyCode === 229) return;     // IME composition
    if (!armed) return;                      // nothing staged — plain Enter
    var box = findComposerBox();
    if (!box || !box.contains(event.target)) return; // not the composer
    if (!box.textContent || !box.textContent.trim()) return;   // empty — keep staging
    event.preventDefault();
    event.stopPropagation(); // Lexical's root listener (target phase) never fires
    doAttachAndSubmit(box);
  }

  // ------------------------------------------------------------- send-button click interception
  // The GUI also submits via the send button — a click produces no
  // keydown, so onKeydown alone misses it and the prompt would go out
  // WITHOUT the staged context. Same contract: capture FRESH, append,
  // re-submit. The send control is resolved live on every click (so a
  // session switch to a fresh composer is picked up without state), and
  // the re-submission below reuses the proven synthetic-Enter path.
  function onSendClick(event) {
    if (reDispatching) return;               // our own synthetic re-dispatch
    if (!armed) return;                      // nothing staged — plain click
    if (event.button !== 0) return;          // right/middle clicks pass through
    var target = event.target;
    if (!target) return;
    var sender = null;
    if (typeof target.closest === 'function') {
      sender = target.closest('button[aria-label="Send message"]');
    }
    if (!sender) {
      var send = findSendButton();
      if (send && (target === send ||
        (send.contains && send.contains(target)))) sender = send;
    }
    if (!sender) return;                     // not a send-button click
    var box = findComposerBox();
    if (!box || !box.textContent || !box.textContent.trim()) return; // empty
    event.preventDefault();
    event.stopPropagation(); // the app's delegated handler never fires
    doAttachAndSubmit(box);
  }

  function doAttachAndSubmit(box) {
    sendSw('chrome-eye:prompt-attach', null, function (resp) {
      // The SW has already cleared the staged list (one-shot) — refresh the
      // badge right away so the UI settles even if the attach failed.
      refreshState();
      if (!resp || !resp.ok || !resp.contextText) {
        // Nothing attached (list emptied between submit and capture, or every
        // capture failed): re-submit the plain prompt so the user's submit
        // still sends their text.
        redispatchEnter(box);
        return;
      }
      if (!appendComposerText(box, '\n\n' + resp.contextText)) {
        // Could not set the text — do NOT submit; the user's text stays in the
        // box and a manual Enter sends it without context.
        console.warn('Chrome Eye composer-hook: could not append context; ' +
          'prompt left for manual send');
        return;
      }
      redispatchEnter(box);
    });
  }

  // Re-submit: dispatch a synthetic keydown Enter on the editor root.
  // Lexical's keydown listener is on that element (target phase); the event
  // must bubble from inside, and repeat:false (the app ignores repeats).
  function redispatchEnter(box) {
    reDispatching = true;
    try {
      var ev = new KeyboardEvent('keydown', {
        key: 'Enter', code: 'Enter',
        shiftKey: false, ctrlKey: false, metaKey: false, altKey: false,
        repeat: false, bubbles: true, cancelable: true, composed: true
      });
      box.dispatchEvent(ev);
    } catch (e) {
      console.warn('Chrome Eye composer-hook: re-dispatch failed', e);
    } finally {
      reDispatching = false;
    }
  }

  // Append text to the Lexical editor so the app's state (and its
  // canSubmit() check) sees it: focus, collapse the caret to the END of the
  // editable root, then execCommand('insertText') — that fires the native
  // beforeinput/input pipeline Lexical listens for on the root element and
  // re-syncs its editor state from the DOM. Fallback: manual text-node
  // mutation + a bubbled InputEvent (Lexical also re-reads the DOM on input).
  function appendComposerText(box, text) {
    if (!text) return true;
    try {
      box.focus();
      var sel = window.getSelection();
      if (!sel) return false;
      var range = document.createRange();
      range.selectNodeContents(box);
      range.collapse(false); // caret at the very end
      sel.removeAllRanges();
      sel.addRange(range);
      var inserted = false;
      try { inserted = document.execCommand('insertText', false, text); } catch (e) { inserted = false; }
      if (inserted) return true;
      // Fallback: mutate the DOM directly, then emit the input event.
      var last = box.lastChild;
      if (last && last.nodeType === 3 /* TEXT_NODE */) {
        last.nodeValue += text;
      } else {
        box.appendChild(document.createTextNode(text));
      }
      sel.removeAllRanges();
      var r2 = document.createRange();
      r2.selectNodeContents(box);
      r2.collapse(false);
      sel.addRange(r2);
      box.dispatchEvent(new InputEvent('input', {
        bubbles: true, cancelable: false, inputType: 'insertText', data: text
      }));
      return true;
    } catch (e) {
      console.error('Chrome Eye composer-hook: append failed', e);
      return false;
    }
  }

  // ------------------------------------------------------------- floating button
  function ensureButton() {
    if (button && document.body && document.body.contains(button)) return button;
    button = document.createElement('button');
    button.type = 'button';
    button.style.cssText =
      'position:fixed;z-index:2147483000;display:none;box-sizing:border-box;' +
      'width:34px;height:28px;padding:0;border-radius:8px;' +
      'border:1px solid rgba(255,255,255,0.18);background:#1b202b;color:#d7dbe2;' +
      'font:13px/26px system-ui,sans-serif;cursor:pointer;' +
      'box-shadow:0 2px 8px rgba(0,0,0,0.45);';
    button.addEventListener('click', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (popoverOpen) closePopover(); else openPopover();
    });
    (document.body || document.documentElement).appendChild(button);
    return button;
  }

  function positionButton() {
    if (!button) return;
    var send = findSendButton();
    if (!send) { button.style.display = 'none'; return; }
    var r = send.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) { button.style.display = 'none'; return; }
    button.style.display = '';
    // just left of the send button (clears the context-usage circle)
    button.style.left = Math.max(8, r.left - 44) + 'px';
    button.style.top = Math.max(8, r.top + (r.height - 28) / 2) + 'px';
  }

  function updateButton() {
    if (!armed) {
      if (popoverOpen) closePopover();
      if (button) {
        button.style.display = 'none';
        // clear the stale count/title so a re-shown badge can never flash
        // a dead state before the next refreshState poll
        button.textContent = '';
        button.title = '';
      }
      return;
    }
    ensureButton();
    positionButton();
    button.textContent = '\uD83D\uDDC1 ' + armed; // 📑 N
    button.title = armed + ' staged page' + (armed === 1 ? '' : 's') +
      ' — attached to your next prompt when you send it (Enter or the ' +
      'send button). Click to manage.';
  }

  // ------------------------------------------------------------- popover
  function openPopover() {
    ensureButton();
    if (!document.body) return;
    if (!popover || !document.body.contains(popover)) {
      popover = document.createElement('div');
      popover.style.cssText =
        'position:fixed;z-index:2147483001;box-sizing:border-box;width:340px;' +
        'max-height:320px;overflow-y:auto;border-radius:10px;' +
        'border:1px solid rgba(255,255,255,0.14);background:#12151c;' +
        'box-shadow:0 8px 28px rgba(0,0,0,0.55);' +
        'font:12px/1.45 system-ui,sans-serif;color:#d7dbe2;padding:10px 12px;';
      (document.body || document.documentElement).appendChild(popover);
    }
    // closePopover() hides the element; a re-open must make it visible again.
    popover.style.display = '';
    popoverOpen = true;
    // anchor above the button
    var r = button.getBoundingClientRect();
    popover.style.left = Math.max(8, r.right - 340) + 'px';
    popover.style.top = 'auto';
    popover.style.bottom = (window.innerHeight - r.top + 8) + 'px';
    sendSw('chrome-eye:list-tabs', null, function (resp) {
      if (!popoverOpen) return;
      currentTabs = (resp && resp.ok && Array.isArray(resp.tabs)) ? resp.tabs : [];
      renderRows();
    });
  }

  function closePopover() {
    popoverOpen = false;
    if (popover && document.body && document.body.contains(popover)) {
      popover.style.display = 'none';
    }
  }

  function renderRows() {
    if (!popover) return;
    while (popover.firstChild) popover.removeChild(popover.firstChild);

    var head = document.createElement('div');
    head.textContent = '\uD83D\uDDC1 Attached pages (' + armed + ')';
    head.style.cssText = 'font-weight:600;font-size:12.5px;margin-bottom:2px;';
    popover.appendChild(head);

    var sub = document.createElement('div');
    sub.textContent = 'Checked pages are captured fresh when you send your ' +
      'next prompt (Enter or the send button).';
    sub.style.cssText = 'color:#8b93a3;font-size:11px;margin-bottom:8px;';
    popover.appendChild(sub);

    if (!currentTabs.length) {
      var empty = document.createElement('div');
      empty.textContent = 'No http(s) tabs in this window.';
      empty.style.cssText = 'color:#8b93a3;padding:4px 0;';
      popover.appendChild(empty);
      return;
    }

    var stagedIds = [];
    for (var s = 0; s < stagedList.length; s++) stagedIds.push(stagedList[s].id);

    var list = document.createElement('div');
    list.style.cssText = 'display:flex;flex-direction:column;gap:2px;';
    popover.appendChild(list);

    for (var i = 0; i < currentTabs.length; i++) {
      (function (tab) {
        var isStaged = stagedIds.indexOf(tab.id) !== -1;
        var row = document.createElement('div');
        row.style.cssText =
          'display:flex;align-items:center;gap:7px;padding:4px 6px;' +
          'border-radius:6px;cursor:pointer;';
        row.addEventListener('mouseenter', function () { row.style.background = 'rgba(255,255,255,0.06)'; });
        row.addEventListener('mouseleave', function () { row.style.background = 'transparent'; });

        var icon = document.createElement('img');
        icon.style.cssText = 'width:14px;height:14px;border-radius:3px;flex:none;';
        if (tab.favIconUrl) {
          icon.src = tab.favIconUrl;
          icon.addEventListener('error', function () { icon.style.visibility = 'hidden'; });
        } else {
          icon.style.visibility = 'hidden';
        }
        row.appendChild(icon);

        var label = document.createElement('div');
        label.textContent = tab.title || tab.url;
        label.style.cssText =
          'flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
        row.appendChild(label);

        var box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = isStaged;
        box.style.cssText = 'flex:none;margin:0;accent-color:#4f7cff;cursor:pointer;';
        box.addEventListener('click', function (e) {
          e.stopPropagation();
          toggleTab(tab, box);
        });
        row.appendChild(box);

        row.addEventListener('click', function () {
          toggleTab(tab, box);
        });
        list.appendChild(row);
      })(currentTabs[i]);
    }
  }

  function markRowsChecked() {
    if (!popover) return;
    var stagedIds = [];
    for (var s = 0; s < stagedList.length; s++) stagedIds.push(stagedList[s].id);
    var boxes = popover.querySelectorAll('input[type="checkbox"]');
    // rows and currentTabs stay in the same order (renderRows order)
    for (var i = 0; i < boxes.length && i < currentTabs.length; i++) {
      boxes[i].checked = stagedIds.indexOf(currentTabs[i].id) !== -1;
    }
  }

  function toggleTab(tab, boxEl) {
    var isStaged = false;
    for (var i = 0; i < stagedList.length; i++) {
      if (stagedList[i].id === tab.id) { isStaged = true; break; }
    }
    var type = isStaged ? 'chrome-eye:unstage-tab' : 'chrome-eye:stage-tab';
    if (boxEl) boxEl.checked = !isStaged; // optimistic
    sendSw(type, { tabId: tab.id }, function (resp) {
      if (resp && resp.ok) {
        stagedList = Array.isArray(resp.staged) ? resp.staged : [];
        armed = stagedList.length;
        updateButton();
        if (popoverOpen) { renderRows(); }
      } else if (boxEl) {
        boxEl.checked = isStaged; // revert
      }
    });
  }

  // ------------------------------------------------------------- lifecycle
  document.addEventListener('keydown', onKeydown, true); // CAPTURE — before Lexical
  document.addEventListener('click', onSendClick, true); // CAPTURE — before the app root
  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && popoverOpen) {
      event.stopPropagation();
      closePopover();
    }
  }, true);
  document.addEventListener('mousedown', function (event) {
    if (!popoverOpen) return;
    if (popover && popover.contains(event.target)) return;
    if (button && button.contains(event.target)) return;
    closePopover();
  }, true);
  // Clicks OUTSIDE the iframe (the panel's staging rows, another tab, the
  // browser chrome) never reach this document, so the mousedown handler
  // above can't see them — but they always blur this window. Closing on
  // blur covers every "clicked outside" case the in-document one misses.
  window.addEventListener('blur', function () {
    if (popoverOpen) closePopover();
  });
  window.addEventListener('resize', function () {
    if (armed) positionButton();
    if (popoverOpen && button) {
      var r = button.getBoundingClientRect();
      popover.style.left = Math.max(8, r.right - 340) + 'px';
      popover.style.bottom = (window.innerHeight - r.top + 8) + 'px';
    }
  });
  // The composer can move (session switch, resize, panel drag) — re-anchor
  // the button on a light 1 s cadence while pages are armed.
  setInterval(function () {
    if (armed) positionButton();
  }, 1000);
  // Armed-state poll: heals after SW restarts (module state is volatile) and
  // keeps the badge in sync with panel-side staging changes.
  setInterval(refreshState, 2000);
  window.addEventListener('focus', refreshState);
  document.addEventListener('visibilitychange', function () { if (!document.hidden) refreshState(); });
  refreshState();

  console.log('Chrome Eye composer-hook active (isolated world)');
})();
