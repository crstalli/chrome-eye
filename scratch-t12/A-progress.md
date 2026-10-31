# A-progress — T12.1 + T12.2 (sw.js, content.js, panel.js, new scraper.js)

## Status: DONE — T12.1 + T12.2 implemented, all 4 files node --check clean, acceptance checklist complete (Log ends 13:26)

## Task outline (from brief-A.md)
1. **Extract the scraper into a self-contained module** — new `extension/scraper.js`:
   plain functions, NO module state, working both (a) via `importScripts` in the
   classic SW and (b) re-evaluated by source inside a target :3080 frame via
   `chrome.scripting.executeScript({func, args})`. Return shapes must match
   content.js exactly: `scrapeWorkspaceTree()`, `openSessionAction(ws,title)`,
   `expandGroupAction(ws)`, `overlayOpen()`, `overlayClose()` (full teardown:
   element + anchor removal, rAF cancel, keydown-capture listener removal,
   status cleared).
2. **sw.js routing** — in each of the 4 GUI message handlers
   (`chrome-eye:workspace-tree`, `chrome-eye:open-session`,
   `chrome-eye:expand-group`, `chrome-eye:overlay`) FIRST try the panel-frame
   path: `chrome.webNavigation.getAllFrames({url:'http://127.0.0.1:3080/*'})`
   → prefer `frameId > 0` (panel iframe; a real GUI tab is frameId 0) →
   `executeScript` with the matching self-contained function → return its
   result. If no panel frame (panel closed / iframe not committed) fall back
   to the existing `findGuiTabId()`/`guiTabRoundTrip` content-script path with
   today's status texts. Keep `panel-open`/`panel-closed`, `captureTab`,
   `guiTabRoundTrip` intact.
3. **panel.js overlay toggle (T12.2)** — track `wsOverlayOpen` from the
   open/close result; `#ws-overlay-btn` click sends `{open:false}` when open,
   `{open:true}` when closed; update button text + status text. No
   panel.html element changes (textContent/classList only in panel.js).
4. Keep ALL existing message names, capture flow, guiTabRoundTrip behavior.

## Plan per change

### scraper.js (new)
- Single self-contained runner function `ceRunInFrame(action, payload)` with
  EVERY helper nested inside (executeScript serializes only the function's
  own source — no outer references allowed). No `chrome.*`, no closures over
  SW state; pure DOM + same-origin localStorage + requestAnimationFrame.
- File wrapper IIFE attaches `ceRunInFrame` to `self`/`window` so:
  - SW: `importScripts('scraper.js')` → `self.ceRunInFrame` (manifest
    background has no `"type":"module"` → classic SW → importScripts is the
    low-risk path, NO manifest change).
  - Page: when Chrome re-evaluates the function by source in the frame's
    ISOLATED world, only the function body runs (wrapper irrelevant).
- Actions (payload → return, shapes copied verbatim from content.js):
  - `'scrape-tree'` → tree scrape (suffix-based `dsw-sid-` rows, group
    headers `dsw-ws-name`/`dsw-ws-overflow`, 200-session cap,
    `dsh.sessions.current` cross-check → `{ok,mode,workspaces}` /
    `{ok:false,error:'sidebar-not-visible',mode:'none'}`).
  - `'open-session'` {workspace,title} → click row, wait 50ms →
    `{ok:true,title}` / `{ok:false,error:'row-not-found'}`.
  - `'expand-group'` {workspace} → overflow button / `.dsw-ws-arrow` click →
    `{ok:true,workspace}` / `{ok:false,error:'no-overflow'|'group-not-found'}`.
  - `'overlay'` {open} → open: build overlay (`data-chrome-eye-overlay="true"`
    marker, anchor = `#dsh-chat-root` / `.dsw-chat-list`, rAF position loop,
    Esc keydown-capture, ✕ button, grouped/flat body, count status) →
    `{ok:true,open:true,mode,sessions,anchor}` / `{ok:true,open:true,already:true}`.
    close: DOM-marker lookup (works even if the OTHER path/content.js created
    the overlay) → cancel rAF, remove keydown-capture listener, remove
    element, clear refs → `{ok:true,open:false}`.
- Overlay state machine = per-ISOLATED-world singleton
  (`window.__ceOverlayApi`): the ISOLATED world persists across
  executeScript calls for the same document, so open/close pairs from
  SEPARATE injected calls share the same rAF id + listener reference →
  exact teardown (cancelAnimationFrame + removeEventListener with the real
  reference). DOM marker `data-chrome-eye-overlay="true"` is the cross-path
  source of truth (content.js fallback path can create/tear it down too).
- `overlayTick` self-terminates when the element is detached
  (`!overlayEl.isConnected`) → rAF teardown is complete even if a
  cross-world actor removed the element without our rAF id.

### sw.js
- Top: `importScripts('scraper.js')` (classic SW; after 'use strict').
- Replace `findPanelGuiFrame` body with the brief's recipe: global
  `chrome.webNavigation.getAllFrames({url:'http://127.0.0.1:3080/*'})`,
  first frame with `frameId > 0` → `{id: tabId, frameId}`; null on error/none.
  (Strictly broader than the old panel-tab-scoped lookup: every frame the
  old code could find is frameId>0 in the panel tab and is returned here.)
- New `guiRoundTrip(preferredTabId, action, scraperPayload, contentPayload)`:
  findPanelGuiFrame() → if frame: `executeScript({target:{tabId,
  allFrames:false, frameIds:[frameId]}, func:self.ceRunInFrame,
  args:[action, scraperPayload]})` → `results[0].result` (throw if missing)
  → else `guiTabRoundTrip(preferredTabId, contentPayload)` (unchanged
  fallback, original payload shapes + error texts).
  NOTE: brief pseudo-code says `target:{...frameId}`; the actual
  chrome.scripting API key is `frameIds: [...]` (array) — already used by
  today's injection path; using the real API key.
- 4 handlers rewritten to call guiRoundTrip with (action, scraperPayload,
  contentPayload). `workspace-tree` keeps the `cachedCurrentId` annotation on
  ok results (applies to both paths).

### content.js
- Handlers stay as the fallback path, UNCHANGED.
- One robustness guard in `overlayTick`: stop scheduling when the overlay
  element is gone/detached (`!overlayEl || !overlayEl.isConnected`) so a
  cross-path close (scraper removing the element) also terminates this
  world's rAF loop. Same-path behavior identical (closeOverlay nulls
  overlayEl before the next tick; a live element is always connected).
- `overlayEscape`/`closeOverlay` unchanged → if the scraper path closes a
  content.js-created overlay, the next Esc self-heals: closeOverlay() runs
  with the stale element ref, cancels its rAF (already dead), removes its
  own listener (same-closure reference), element already detached.

### panel.js
- New `var wsOverlayOpen = false;` next to `wsTabId`.
- `#ws-overlay-btn` handler becomes a toggle: desired = !wsOverlayOpen →
  `swRequest('chrome-eye:overlay', {tabId, open: desired})` → on ok:
  `wsOverlayOpen = (res.open !== false)`; button textContent
  `'⛶ close overlay'` / `'⛶ workspace'`; status text open/closed. On error:
  status error, state unchanged.
- Status texts updated to say "in the panel" (panel-frame path) when the
  result came from there; keep the no-GUI-tab error text for the fallback.
- Dropdown path (Workspaces ▾) untouched except it now benefits from the
  SW-side routing (no code change needed — same swRequest).

## Acceptance checklist (completed 13:26)
- [x] node --check on sw.js, content.js, panel.js, scraper.js — ALL FOUR OK (ran again together as a final gate: `ALL_FOUR_OK`).
- [x] logic trace in this file (panel-frame path + fallback path) — see below.
- [x] return-shape parity quoted (scraper vs content.js) — see below.
- [x] overlay close teardown checklist verified — see below.
- [x] final message: changes per file, evidence, risks, e2e steps — sent.

## Logic trace (T12.1 + T12.2)

### Panel-frame path (primary)
1. Panel (side panel, `panel.js`) → `chrome.runtime.sendMessage({type:'chrome-eye:workspace-tree'|'open-session'|'expand-group'|'overlay', tabId, ...})`.
2. SW handler (`sw.js`) → `guiFrameAction(message, action, execPayload, fallbackPayload)`.
3. `findPanelGuiFrame()` (unchanged, L102–122) finds the panel tab's :3080 iframe (`frameId > 0`).
4. `chrome.scripting.executeScript({target:{tabId, frameIds:[frameId]}, func: ceRunInFrame, args:[action, execPayload]})` → re-evaluates the self-contained function in the frame's ISOLATED world → `results[0].result`.
   - `scrape-tree`: suffix-class scrape of the GUI sidebar DOM (grouped→flat→search→none, 200-session cap, `groupSectionName()` names, `dsh.sessions.current` for current-session id).
   - `open-session`: `findSessionRow(workspace, title)` → `row.click()` → `{ok:true,title}`.
   - `expand-group`: overflow button click → `{ok:true,workspace}`.
   - `overlay` `{open:true}`: DOM-marker check (`[data-chrome-eye-overlay="true"]`) → if present `{ok:true,open:true,already:true}` (works when content.js created it); else build element verbatim (singleton `window.__ceOverlayApi`), rAF position loop, keydown-capture Escape, ✕ button → `{ok:true,open:true,mode,sessions,anchor}`.
   - `overlay` `{open:false}`: remove the marked element (works even if content.js created it) + cancel own rAF + remove own keydown-capture listener + null singleton refs → `{ok:true,open:false}`.
5. SW: result null → `{ok:false,error:'empty content-script response'}`; on `workspace-tree` ok → `res.cachedCurrentId = guiSessionId`; reply to panel.
6. Panel: tree → `renderTree` (unchanged renderer); overlay open ok → `wsOverlayOpen=true`, label `'⛶ close overlay'`; overlay close ok (`res.open===false`) → `wsOverlayOpen=false`, label `'⛶ workspace'`.

### Fallback path (real :3080 tab)
- ANY failure of steps 3–4 (no panel frame / webNavigation rejected / executeScript rejected / no panel tab) → `guiTabRoundTrip(message.tabId, fallbackPayload)` — byte-identical to the pre-T11.3 path: finds the :3080 tab, `chrome.tabs.sendMessage` to its declared content script (top-frame, ISOLATED world, same actions, same return shapes). Its two error throws are preserved verbatim: `'no DSH GUI tab found — open http://127.0.0.1:3080 in a browser tab first'` and `'GUI tab has no live content script (reload that tab once): ' + msg`.
- `panel-open`/`panel-closed`, `captureTab`, share flow, `findGuiTab`, `findPanelGuiFrame` all untouched.

### T12.2 toggle state machine (panel.js)
- `wsOverlayOpen` starts false; each click sends `open: !wsOverlayOpen`; only a `res.ok` result flips state and label (`res.open === false` → closed). Errors leave state unchanged (no desync on transient failure). If the overlay was closed in-band (✕/Esc inside the iframe), the next click sends `open:true` — but the scraper's DOM-marker check returns `already:true` if the element still exists, and a stale state after an out-of-band close is self-healed by the content.js `overlayTick` detachment guard (below).

## Return-shape parity (scraper.js vs content.js — quoted)
- scrape-tree grouped: both `out = { ok: true, mode: 'grouped', workspaces: [] }`; per-workspace `projects: [{ name, expanded: projRow ? projRow.getAttribute('aria-expanded')==='true' : true, truncated: !!overflow, sessions: [{id, title, current}] }]`; cap: both `if (total >= TREE_SESSION_CAP) { out.truncated = true; break; }` (scraper L120 = content L517); flat: `truncated: false` + single `'All sessions'` (L139 = L536); search: `wsEl ? (wsEl.textContent||'').trim() : 'Other'`, `truncated: false` (L172 = L569); none: `out.mode='none'; out.ok=false; out.error='sidebar-not-visible'` (both).
- open-session: both `row.click()` → `{ ok: true, title: String(title || '').trim() }` / `{ ok: false, error: 'row-not-found' }` (scraper L220–223 = content L615–618 region).
- expand-group: both `{ ok: true, workspace: w }` / `{ ok: false, error: 'no-overflow' }` / `{ ok: false, error: 'group-not-found' }` (scraper L232–236 = content L626–630 region).
- overlay open: both `{ ok: true, open: true, mode: tree.mode, sessions: count, anchor: !center ? 'viewport' : (anchor === center ? 'center-col' : 'chat-root') }` (scraper L460–462 = content L842–844) and both `{ ok: true, open: true, already: true }` (scraper L378 = content L783).
- overlay close: both `{ ok: true, open: false }`.
- errors: both catch → `{ ok: false, error: String((e && e.message) || e) }`; scraper extra dispatch guard `{ ok: false, error: 'unknown-action:' + action }`; SW extra guard `{ ok: false, error: 'empty content-script response' }`.

## Overlay close teardown checklist (cross-path)
- [x] Element removal: scraper `closeOverlay` queries `[data-chrome-eye-overlay="true"]` and removes it — works for scraper-created AND content.js-created elements (both set the same marker, content.js L790).
- [x] rAF loop: scraper cancels its OWN rAF id (same-world singleton); content.js loop self-terminates via the new `overlayTick` detachment guard (`!overlayEl.isConnected` → `cancelAnimationFrame`, remove keydown-capture listener, null all three refs).
- [x] keydown-capture listener: each world removes its own reference (scraper singleton `escHandler`; content.js closure `overlayEscape`); no leak on the cross-path close.
- [x] Stale singletons: scraper open resets a stale `__ceOverlayApi` state (raf=0, el=null) before building, so an abandoned open (e.g. iframe navigation) cannot double-position; content.js `openOverlay` guards `if (overlayEl) return already` and its tick guard nulls refs after out-of-band removal.
- [x] Escape-in-iframe and ✕-button close: unchanged same-world paths; after either, a panel toggle-click sends `open:true`, scraper sees the (absent) marker → fresh open, correct.

## Log
- 02:11 — persist protocol done: brief-A.md read in full; extension/sw.js,
  content.js, panel.js, manifest.json, panel.html read; backup-A/ created
  byte-exact (md5 verified); A-progress.md created.
- NEXT: write extension/scraper.js.
- 11:03 — resumed after silence; re-reading state
- 11:03 — plan: (1) owed cross-checks (guiTabRoundTrip call sites, findGuiTab/findPanelGuiFrame usage, manifest content_scripts, exact scrape head L440-544) → (2) write scraper.js → (3) sw.js routing → (4) panel.js toggle → (5) content.js overlayTick guard; node --check after each file; then acceptance checklist + DONE message.
- 13:07 — cross-check 1 CLEAN: `guiTabRoundTrip` call sites = exactly the 4 T11 handlers (sw.js L438–483: workspace-tree, open-session, expand-group, overlay); no other callers.
- 13:07 — cross-check 2 CLEAN: `findGuiTab` is used only inside `guiTabRoundTrip`; `findPanelGuiFrame` is used only from `findGuiTab`'s else-branch (L80–122) — both stay intact as the fallback chain.
- 13:07 — cross-check 3 CLEAN: manifest content_scripts = `{matches:["<all_urls>"], js:["content.js"]}` (top-frame only, default ISOLATED world; classic SW, no `"type":"module"` → importScripts legal). Panel iframe is a subframe of chrome-extension:// → content scripts do NOT auto-run there → executeScript path required.
- 13:07 — cross-check 4 CLEAN: re-verified verbatim parity sources — sw.js L1–130 + L420–516, content.js L440–864 (grouped/flat/search/none tree shapes, findSessionRow, openSessionAction, expandGroupAction, openOverlay/closeOverlay, listener tail L865–882), panel.js full 293 lines. Plan L43–60 DOM details are STALE (dsw-sid-/dsw-ws-name/#dsh-chat-root/.dsw-ws-arrow/wait-50ms never matched); content.js is the parity source of truth.
- 13:07 — re-verified sw.js L1–130+L420–516, panel.js full, content.js L440–864 verbatim; ready to write scraper.js.
- 13:15 — WROTE extension/scraper.js (step 3): wrapper IIFE attaches `ceRunInFrame` to `self` for importScripts; single self-contained `function ceRunInFrame(action, payload)` with ALL helpers nested (no outer refs, no chrome.*); actions scrape-tree / open-session / expand-group / overlay; tree+action+overlay code copied VERBATIM from content.js L440–631 & L636–839 (re-read L150–274, L440–631, L636–882 this span to eliminate summary drift: grouped→flat→search→none order, groupSectionName-based matching, exact return shapes, exact CSS strings, mousemove/mouseleave hover, "⤓ group collapsed" row, search note); overlay state = per-ISOLATED-world singleton window.__ceOverlayApi (persists across executeScript calls for same document); open checks DOM marker first (cross-path already:true if content.js created it), else resets stale singleton state and builds element verbatim; close = remove marked element (works even for content.js-created) + cancel own rAF + remove own keydown-capture listener; chipStripOffset()=0 (no chip strip in panel iframe). `node --check scraper.js` → OK (SCRAPER_OK).
- 13:18 — REWROTE sw.js routing (step 4): (a) `importScripts('scraper.js')` at top after 'use strict' (L10, classic SW — manifest untouched); (b) new `guiFrameAction(message, action, execPayload, fallbackPayload)` at L168 — `findPanelGuiFrame()` first, then `chrome.scripting.executeScript({target:{tabId, frameIds:[frameId]}, func: ceRunInFrame, args:[action, execPayload]})`, result `results[0].result` (null → 'empty content-script response'); EVERY failure path (frame null / webNavigation rejected / executeScript rejected) → fallback `guiTabRoundTrip(message.tabId, fallbackPayload)` UNCHANGED as before; (c) all 4 panel handlers (workspace-tree L500, open-session L514, expand-group L525, overlay L537) now call guiFrameAction with matching fallback payloads — workspace-tree keeps `res.cachedCurrentId = guiSessionId` on ok; overlay passes `open: message.open !== false`. One mishap caught and fixed: an accidentally duplicated edit created two `guiFrameAction` definitions — removed the duplicate, re-verified. `node --check sw.js` → OK (SW_OK). guiTabRoundTrip intact (6 refs: def + fallback + findGuiTab usage etc.); findGuiTab/findPanelGuiFrame untouched.
- 13:21 — REWROTE panel.js overlay handler (step 5, T12.2 TOGGLE): new `wsOverlayOpen=false` next to `wsTabId` (L89, panel.html untouched); click handler now sends `open: !wsOverlayOpen` (was hardcoded `open: true`); on `res.ok && res.open !== false` → `wsOverlayOpen=true` + `wsOverlayBtn.textContent='⛶ close overlay'` + status 'Workspace overlay opened in the panel (mode, N sessions; Esc or ✕ or this button closes it)'; on `res.ok && res.open === false` → `wsOverlayOpen=false` + label back to '⛶ workspace' + status 'Workspace overlay closed'; on error → same error map as before (no DSH GUI tab → open-a-tab text, else raw error). Label flip is JS textContent only. Also refreshed the stale T11 comment block (L71–79 'a real GUI tab is required' → T12.1 panel-iframe-first + real-tab-fallback wording) and the wsTabId comment. `node --check panel.js` → OK (PANEL_OK, 309 lines). Dropdown paths untouched — they already flow through the SW handlers that are now panel-frame-first.
- 13:24 — ADDED content.js overlayTick detachment guard (step 6): inside `overlayTick()` (L688), after `if (!overlayEl) return;`, new block: `if (!overlayEl.isConnected) { if (overlayRaf) { cancelAnimationFrame(overlayRaf); overlayRaf = 0; } document.removeEventListener('keydown', overlayEscape, true); overlayEl = null; overlayAnchor = null; overlayStatusEl = null; return; }`. Kills this world's rAF loop + keydown-capture + refs when the element is removed out-of-band by the scraper's cross-path close. Same-path behavior unchanged (closeOverlay nulls overlayEl first; live element is always connected). Verified content.js openOverlay sets the SAME DOM marker (`data-chrome-eye-overlay="true"`, L790) the scraper's close queries — cross-path close is sound. `node --check content.js` → OK (CONTENT_OK, 900 lines).
- 13:26 — FINAL GATE: `node --check` on all 4 files together → `ALL_FOUR_OK`. Untouched-verification: manifest.json mtime 2026-09-08T11:11, panel.html mtime 2026-09-08T03:23 (both pre-T12; no backups existed for them in scratch-t12/backup-A — it holds only the 3 JS files from the 02:11 pre-T11.3 snapshot, so mtime is the evidence); manifest re-parsed as valid JSON with `background.service_worker=sw.js`, no `type` (classic), `content_scripts js=[["content.js"]]`, permissions/host_permissions as shipped. scraper.js grep audit: 8 `return { ok` sites, 4-action dispatch (L490–499), marker/singleton refs at L376/L398/L471 + L249–258. Acceptance checklist filled in (node --check ×4 / logic trace / return-shape parity quoted / overlay teardown checklist). No bridge restart, no test/run.sh run, no sandbox escalation attempted (none needed).
