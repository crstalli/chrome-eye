# TASK QUEUE — chrome-eye phase 2 (worker: execute ONE task at a time, top-down)

After each task: set its status in `/mnt/f/ai/facilitator_status.json` (tasks.<id>.status = done/blocked + one-line note). Do not start the next task until the status file is updated. Targeted reads only.

## A. workspaces in plugin + session sync (workspaces_plugin_fix, session_sync)
- Files: `extension/sw.js` (findPanelGuiFrame ~107-139, msg handlers ~466-517), `extension/scraper.js` (scrape ~93-185, collapsed-group cap ~226-237), `extension/panel.js` (tree fetch/render ~207-228).
- Do:
  1. Make the REAL GUI tab path work: detect the authenticated GUI tab reliably (url match `127.0.0.1:3080`, prefer tab with visible sidebar), inject content.js scrape there.
  2. Remove/raise the ~5-row collapsed-group cap (scraper.js:226-237) so the plugin list matches the web profile session list (session_sync).
  3. Graceful degradation: if NO GUI tab open, dropdown shows clear message "Open the DSH GUI in a tab to load workspaces" instead of a silent failure.
- Accept: with a GUI tab open, dropdown shows the same workspaces/sessions as the sidebar (full list, not 5-row cap); without, the message shows.

## B. real connectivity indicator (disconnected_button_fix)
- Context: the GUI's own "disconnected" chip (component Hd in the built GUI bundle) appears inside the panel iframe because :3080 is 401-gated — the iframe lands on the auth gate. Extension alone cannot fix the GUI chip.
- Do: in `extension/panel.js` + `panel.html`, probe real state in the bottom bar: fetch `http://127.0.0.1:3080/` (or the GUI tab's live state) + `http://127.0.0.1:3081/` health; render status text: "GUI: 401 auth gate" / "GUI: ok" and "bridge: up/down". Dark-theme colors only.
- Accept: bottom bar status reflects actual connectivity, not the stale GUI chip.

## C. bottom bar restyle + contrast (ui_bottom_bar_css, workspace_contrast)
- Files: `extension/panel.html` (#bottom-bar 32-41, #ws-dropdown 75-138), `extension/panel.js` (inline colors 16-23, 93, 162-201).
- Do:
  1. Shrink #bottom-bar 60px → ~40px; update #dsh-iframe height calc.
  2. Move ALL inline light-theme colors from panel.js to CSS classes in panel.html using the existing DSH dark tokens (keep token-citation comments). No `#333`/`#666`/`#555` text on dark.
  3. Dropdown row text ≥ 4.5:1 contrast on #353638 (use label-primary/secondary tokens).
- Accept: bottom bar ~40px, all text legible dark-on-dark, no light inline overrides anywhere in panel.js (grep check).

## D. visible exit affordance (exit_mechanism)
- Context: overlay closes via iframe ✕ (scraper.js:418-423), Esc (441-448), and the bottom-bar button label flip (panel.js:285). Only the label flip is panel-level.
- Do: while overlay open, make the panel button unmistakable (DSH danger token color, label "✕ close workspace") AND add a bottom-bar status line "workspace overlay open — Esc or ✕ to close".
- Accept: a user who opened the overlay can see a close path without looking inside the iframe.

## Notes
- DSH dark tokens (already cited in panel.html): bg-layer-1 #232324, bg-module-platform #353638, label-primary #f9fafb, label-secondary #cfd3d6, label-tertiary #adb2b8, borders white+alpha.
- 3080 is 401-gated; 3081 bridge not running by default (bridge/test.sh starts it).
- Do not touch the share/staging flow unless a task requires it.

## E. loopback auth proxy: panel iframe renders the real GUI (auth_proxy_panel_render)
Read AUTH-DISABLE-RESEARCH.md first. Core web auth (BrowserAuth in @deepseek-ai/dsh-client-connection) CANNOT be disabled, and the official cookie flow fails inside a chrome-extension:// iframe (SameSite=Strict, cross-site; proven in #5063). Fix: bridge.mjs (127.0.0.1:3081) becomes a FULL reverse proxy to :3080 that attaches a self-minted auth cookie to every upstream request.
Ground truth for the cookie format: /home/cztl/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-client-connection/lib/index.js (BrowserAuth, ~L196-425) — READ IT and verify the recipe below before coding. Secret: /home/cztl/.dsh/.credentials.yaml → records["client-connection/browser-session"].payload.secret (base64url 32B; verified present). Recipe (verify against source): cookie name = "dsh-auth-" + b64url(sha256("<host>")); value = "v1." + b64url(JSON {version:1, authority, issuedAt, expiresAt}) + "." + b64url(HMAC-SHA256(secret, body)). Present Host 127.0.0.1:3081 to upstream (loopback passes the Host/Origin fence) — keep the bridge's existing Origin/Referer stripping. Re-mint before expiry (TTL <= cookieMaxAgeDays, default 30d).
Scope:
1. bridge/bridge.mjs — (a) full reverse proxy: any method/path (today only POST /api/* + 2 WS routes + /health + /share) → forward to :3080 with minted Cookie header; stream bodies both ways; (b) forward ANY /api/* WebSocket upgrade (today only events.mux/events.host); (c) mint at startup + re-mint on expiry; (d) keep /health, /share, CORS behavior intact. If upstream HTML/JS references absolute :3080 URLs, rewrite them to 3081 (check before assuming).
2. extension/panel.html — #dsh-iframe src → http://127.0.0.1:3081.
3. extension/panel.js — probeConn(): GUI probe → :3081.
4. extension/sw.js — findPanelGuiFrame(): accept panel frames whose URL is http://127.0.0.1:3081 in addition to :3080; keep A1's document probe + real-GUI-tab fallback.
Accept (run all yourself):
- bash bridge/test.sh starts the bridge; curl -s http://127.0.0.1:3081/ → 200 text/html GUI markup, NOT "authentication required"; an /api endpoint via 3081 → non-401.
- Built-in node WebSocket to ws://127.0.0.1:3081/api/events.mux upgrades (no 401/426).
- Gold test (if feasible): scratch/launch-chrome.sh + CDP page-load probe (pattern in scratch/probe-panel*.mjs) — page renders the app root, not auth text.
- verify.sh exits 0. No manifest change (host_permissions already covers 3081). No DSH install/config changes.
Report <=200 words, ending with the exact bridge.mjs line ranges changed + TASK E COMPLETE.

## F. workspace click loads real context + conversations readable (ui_close_overlay_on_click)
User report: "Close overlay appears after clicking on a workspace. Workspace context doesn't load in the plugin. I cannot read the previous conversations, and it doesn't bring it up." Task E is DONE: the panel iframe now renders the REAL GUI through the :3081 auth proxy (bridge.mjs). The "close overlay" the user sees is the task-D affordance (bottom-bar "✕ close workspace" + overlay ✕) appearing on an EMPTY overlay — pre-E the iframe was the 401 gate so the in-frame scraper had nothing to scrape.
Trace first: workspace-row click (panel.js ~:246) → sw.js open-session flow (~:466-517) → scraper.js (openSessionAction / openOverlay, overlay render ~:418-448).
Do (with the real GUI now in the iframe):
1. Workspace click → the overlay must show the REAL session list + context, scraped from the now-live in-iframe sidebar (reuse the existing autoExpandCollapsedGroups() before scraping).
2. Session click → the real GUI inside the iframe opens THAT session (click the matching sidebar row in the in-iframe DOM — the app's own handler). No separate conversation scraping needed: the GUI itself renders the readable history.
3. Keep the task-D close affordance (Esc / ✕ / "✕ close workspace" label) working — it is intended, but an empty overlay with only a close button is exactly the reported bug.
4. If session data still comes from the real-GUI-tab fallback, make the in-iframe path (3081 frame) the primary source now.
Accept (run yourself). BRIDGE IS ALREADY RUNNING on 127.0.0.1:3081 as a managed process — do NOT start a second one (EADDRINUSE). If you need a fresh instance, kill `node bridge/bridge.mjs` first and start one; end with exactly one bridge running.
- Gold test (REQUIRED): scratch/launch-chrome.sh + CDP (patterns in scratch/probe-panel*.mjs): load the extension, open the panel page, click a workspace row → assert the overlay/DOM contains real session text; click a session row → assert the iframe shows that session (conversation DOM or URL change).
- Esc and ✕ still close the overlay/workspace mode.
- verify.sh exits 0. No manifest change. No DSH install/config changes.
Report <=200 words: what was broken in the click flow, per-file changes, gold-test DOM evidence, ending with "TASK F COMPLETE".

## F2. bridge gzip bug + extension expand fix (bridge_gzip_strip_bug, project_row_expand)
ROOT CAUSE PROVEN (facilitator recon f-recon26-30):
- The bridge's `forwardLongLived()` (bridge.mjs :234-292) uses raw `httpRequest` which does NOT auto-decompress. When the client sends `Accept-Encoding: gzip` (browsers always do), the upstream returns gzip-compressed bytes. The bridge strips `content-encoding` from the response headers (STRIP_RESPONSE_HEADERS :159) but passes the compressed body through verbatim. The browser receives gzip bytes with no `content-encoding` header → JSON.parse fails → the in-memory session list stays EMPTY → 0 rows in the workspace tree.
- Proven: `curl` with no Accept-Encoding → 187988B plain JSON (97 items, 29 visible). `curl` with `Accept-Encoding: gzip` → 39313B gzip bytes, `content-encoding` absent from response headers. Decoded gzip = same 97 items.
- This breaks ALL /api/* POST routes through the bridge: session/list, session/create, dynamicCordisRunner/*, etc. The app's boot fetch of /api/session/list returns 200 with 39KB gzip bytes → JSON.parse fails → empty state → 0 rows.

PART 1 — bridge.mjs fix (the critical fix):
- In `forwardLongLived()` (bridge.mjs :234-292), after receiving `upRes`, check the upstream `content-encoding` header. If it is `gzip` (or `deflate`/`br`), decompress the stream before piping to the client. Use `zlib.createGunzip()` / `createInflateRaw()` / `createBrotliDecompress()` piped between `upRes` and `res`. The `content-encoding` strip in STRIP_RESPONSE_HEADERS is CORRECT (we're decompressing, so the client must not see it) — only the body decompression is missing.
- Alternatively: strip `accept-encoding` from the request headers sent upstream (add to STRIP_REQUEST_HEADERS or handle in forwardLongLived) so the upstream always returns plain. This is simpler and avoids the decompression pipeline. PREFERRED: strip `accept-encoding` from upstream request in forwardLongLived (one line).
- Verify: `curl -H "Accept-Encoding: gzip" http://127.0.0.1:3081/api/session/list` (with the correct POST body) → plain JSON, not gzip bytes.

PART 2 — extension expand fix (secondary, for collapsed-group UX):
- In `extension/scraper.js` (autoExpandCollapsedGroups ~:226-234, expandGroupAction ~:246-252) and `extension/content.js` (~:498-501, ~:635-642): the current code only clicks `_sessionOverflowButton` to expand. In the current GUI build, collapsed groups with 0 in-memory sessions render NO overflow button — the expand control is the `_projectRow` (role=treeitem) itself, whose `aria-expanded` flips on click. Add: if no `_sessionOverflowButton` is found in a collapsed group, click the `_projectRow` instead. Keep the overflow-button path as a fallback for the ≥5-sessions collapsed preview case.
- Poll for `_sessionRow` appearance after expand (timeout ~3s) before scraping.

Accept (run yourself):
- `bash bridge/test.sh` → 16/16.
- `curl -s -X POST -H "content-type: application/json" -H "Accept-Encoding: gzip" -d '{"type":"client-request","rpcId":"t","method":"session/list","payload":{"args":{"_request":{}}}}' http://127.0.0.1:3081/api/session/list` → plain JSON (starts with `{`), NOT gzip (does NOT start with `\x1f\x8b`).
- Gold test (REQUIRED, FRESH profile): scratch/launch-chrome.sh + CDP: load extension, open panel, wait for boot, click a workspace `_projectRow` → assert `_sessionRow` elements appear with real session text. The in-memory list must be non-empty (the gzip fix is what makes this work).
- `bash verify.sh` exits 0. No manifest change. No DSH install/config changes.
Report <=200 words: what was broken, per-file changes with line ranges, gold-test DOM evidence (row count + first session text), ending with "TASK F2 COMPLETE".

## TASK G — panel ugliness + "bridge: down" + zero-launch bridge (2026-09-15)
User report: side panel is a big UGLY WHITE BOX with a sad-file icon; bottom bar shows red "GUI: down · bridge: down"; "Ideally I don't need to launch anything new" (the bridge must never need a manual start again).

FACTS (verified by facilitator):
- The white box = the #dsh-iframe (panel.html:225) failed to load because the bridge on :3081 was DEAD (DSH process restarted, the background job died with it). Chrome renders a failed cross-origin iframe as a white failure page + sad icon — you cannot style inside a failed iframe.
- "GUI: down" is a FALSE report: panel.js probeConn() (~:92-135) fetches :3080 directly from the extension page; that fetch always throws (CORS: the 401-gate response has no ACAO header) → code reports "down". While the bridge is up the panel never needs a direct :3080 fetch at all.
- Bridge is currently running as facilitator job bash-1 (pid 1418, port 3081). YOU must replace it with the permanent mechanism below (kill pid 1418 first — get pid from `ss -tlnp | grep 3081`, then `kill <pid>`; NEVER use pkill -f patterns that can match your own shell).

G1 — panel UI polish (extension/panel.html + panel.js ONLY, no manifest change):
- Add a dark overlay card that completely covers the #dsh-iframe area while the bridge is unreachable: same dark DSH tokens as the rest of the panel (#151517 bg, #353638 surface, #f9fafb/#cfd3d6/#adb2b8 text, #56d364/#f85149 status). Two states: (a) "connecting…" while first probe is in flight, (b) "bridge offline" with a one-line instruction ("the chrome-eye bridge on 127.0.0.1:3081 is not running"). Pure CSS/JS, zero inline light colors (verify.sh enforces this).
- Drive it from probeConn(): bridge fetch to :3081 fails → show overlay (offline state); bridge fetch succeeds → hide overlay AND force-reload the iframe (set iframe.src to the same URL) so a previously-failed load recovers without user action.
- Fix the false "GUI: down": probe ONLY :3081 (it sends ACAO *, so the fetch works). Success → bottom bar shows "GUI: up · bridge: up" (green). Failure → "GUI: down · bridge: down" (red). Remove the direct :3080 fetch from probeConn (it can never succeed cross-origin). Keep the 30s interval.
- The dropdown's "open the GUI in a browser tab" guidance path (T11.x) stays untouched.

G2 — zero-launch bridge (permanent, survives DSH restarts and reboots):
- Write /home/cztl/.config/systemd/user/chrome-eye-bridge.service:
  [Unit] Description=chrome-eye bridge (127.0.0.1:3081 → :3080 auth proxy)
  [Service] ExecStart=<abs node path> /mnt/f/ai/chrome-eye/bridge/bridge.mjs (use `command -v node`), WorkingDirectory=/mnt/f/ai/chrome-eye, Restart=always, RestartSec=2
  [Install] WantedBy=default.target
- `systemctl --user daemon-reload && systemctl --user enable --now chrome-eye-bridge` then verify `systemctl --user status chrome-eye-bridge` = active (running).
- FALLBACK if systemctl --user fails (e.g. no user dbus in WSL): create bridge/start.sh (nohup node bridge/bridge.mjs, pidfile bridge/bridge.pid, simple while-true restart loop, log to bridge/bridge.log), run it, and report which path you used. Keep the unit file either way.
- After switching: bridge must be served by the service (check `ss -tlnp | grep 3081` shows the systemd-owned node process).

Accept (run yourself):
- `bash bridge/test.sh` → 16/16 (against the service/fallback bridge).
- `bash verify.sh` → exit 0.
- Gold test (REQUIRED, fresh profile): `bash scratch/launch-chrome.sh` then `node scratch/f-gold-f2.mjs` → PASS (6+ session rows, real titles). Then kill the test chrome (pid from scratch/chrome.pid).
- `systemctl --user status chrome-eye-bridge` active (or start.sh fallback running + pidfile).
Report <=200 words: per-file changes with line ranges, which G2 path (systemd vs fallback) and its status output (1-2 lines), gold-test row count + first session, ending with "TASK G COMPLETE".

## TASK H — in-panel rework: "add to session" into the panel + fix workspace selector + tab picker (2026-09-16)
User report (verbatim): "This still looks pretty ugly. You can create a new agent preset if you want that has a button to select tabs in the current browser. That add to session at the top ideally is within the plugin, not an overlay to the entire window. I can't really read it. Also, the workspace selector doesn't work."
User chose "Both" = (H) rework the in-panel UI now, and (J) LATER create a new DSH agent preset. THIS TASK = H ONLY (do NOT build the preset).
DESIGN REFERENCE (2026-09-16, user): tab selection should work "like the gemini extension" = the DSH GUI's native "Add tabs" — a clean, dark, IN-PANEL LIST of the current browser's tabs (row = favicon + title, current tab checked, selecting tabs adds them to the session), NOT a full-window overlay. Image: /home/cztl/.dsh/attachments/v1/objects/52/52600fa060de2132fd1f207bfa0d0f22c0eaf22b6322ffc74c0a856a72f716a3. So H1/H3's tab UI = a checkable LIST of tabs (not just a chip row).

FACTS (verified by facilitator — trust these, read the cited lines to confirm):
- The "add to session" ENGINE is DONE and working in sw.js. Message surface (reuse VERBATIM, do NOT add new SW messages): `chrome-eye:list-tabs` (:461, http(s) tabs current window, cap 30) · `chrome-eye:stage-tab` (:480) · `chrome-eye:unstage-tab` (:497) · `chrome-eye:add-staged` (:508 → addStagedToSession :371 → per-tab shareTab → POST /share, sequential) · `chrome-eye:gui-session` (:434) · `chrome-eye:panel-open` (:441, auto-stages active tab) / `panel-closed` (:449) / `panel-state` (:455).
- The ONLY UI bug: content.js renders the chips/staging row as a FULL-WINDOW fixed bar pinned to the top of EVERY page — content.js:294-301 (chipsRoot, `position:fixed;top:0;...background:rgba(255,255,255,0.95)`), renderChips :230-280, the "+" dropdown (openDropdown/closeDropdown), the "→ add to session" button + status. That white bar with light text is the "ugly / I can't read it" overlay.
- The side panel (panel.html) is currently just the GUI #dsh-iframe (:225) + the 40px #bottom-bar (:293-315: #share-status, #conn-status, #ws-controls{ws-close-btn, ws-overlay-btn, ws-tree-btn}, #ws-dropdown). The staging/chips UI has NO home in the panel.
- "The workspace selector doesn't work": #ws-tree-btn→#ws-dropdown (panel.js:172-330) AND the "Not in the sidebar right now" banner BOTH depend on scraping the GUI's NATIVE sidebar DOM. scraper.js:183 + content.js:598 set error `sidebar-not-visible`; panel.js:314 + content.js:785 + scraper.js:375 render the "Not in the sidebar right now" text. The scrape fails when the in-iframe GUI sidebar isn't in the expected state. This is the shared root cause.

H1 — move the staging/"add to session" UI from the full-window overlay into the panel (PRIMARY fix):
- REMOVE the full-window chips overlay from content.js (the fixed-top chipsRoot + renderChips + the "+" dropdown + "→ add to session" button/status). KEEP content.js's background duties intact and working: the gui-session report, the panel-state report, and the in-iframe sidebar-scrape dispatch (chrome-eye:scrape-tree / open-session / expand-group) — the panel depends on those.
- ADD a compact staging row at the TOP of the side panel (panel.html, above #dsh-iframe): (a) staged chips (title + ✕ remove), (b) a "+" button opening an IN-PANEL dropdown listing http(s) tabs (list-tabs) — click to stage (stage-tab), (c) a "→ add to session" button (add-staged, disabled when 0 chips), (d) a status line. Wire in panel.js to the EXISTING sw.js messages. Panel-open still auto-stages the active tab (sw.js:441 — keep).
- New panel layout: [top: staging row] / [middle: #dsh-iframe] / [bottom: existing #bottom-bar]. Adjust #dsh-iframe height calc for the new top row.

H2 — fix the workspace selector so it reliably lists workspaces/sessions and opens one:
- Diagnose the `sidebar-not-visible` / "Not in the sidebar right now" root cause. Inspect the LIVE in-iframe GUI DOM (headless Chrome: scratch/launch-chrome.sh + CDP, or curl :3081 with the minted cookie — /tmp/cookie.txt pattern) to see what the sidebar looks like NOW. Likely: hashed class names changed in this build, the in-iframe rail is collapsed/not rendered, or a scrape-before-render timing race.
- Make the in-iframe path (the panel's :3081 frame — primary source since Task F) reliably return the workspace tree. Fix selectors/state-detection in scraper.js to match the CURRENT GUI DOM. Keep TREE_SESSION_CAP=200 + autoExpandCollapsedGroups().
- "Not in the sidebar right now" should only appear when there genuinely is no data.
- If DOM scraping is fundamentally unreliable here you MAY switch the data source to the GUI's own data through the bridge (the /api session-list the app itself fetches), but only with proof it's more reliable AND an updated "trust fence" comment at sw.js:516. PREFER fixing the DOM scrape first (smaller surface, no new trust model).

H3 — (nice-to-have, only if H1+H2 are solid) an explicit "select a browser tab" button:
- A dedicated button (staging row or bottom bar) that lists the current browser's tabs and stages the chosen one — same as the "+" picker but an explicit affordance. If the "+" picker already covers it, H3 is a no-op; report which.

CONSTRAINTS (hard):
- Dark DSH tokens ONLY (bg #232324/#353638, label #f9fafb/#cfd3d6/#adb2b8, borders rgba(255,255,255,.16), status #56d364/#f85149). ZERO light inline colors in panel.js (verify.sh enforces). Contrast ≥4.5:1.
- Plain ES5-style JS (var/function/string concat). No TS/JSX/import/require in extension files.
- NO manifest changes. Do NOT touch bridge.mjs or the systemd unit. The bridge is a PERMANENT systemd user service on :3081 — test against the running one; do NOT start a second (EADDRINUSE).
- Keep TREE_SESSION_CAP=200. Keep the sw.js engine messages verbatim.

ACCEPT (run yourself):
- `bash verify.sh` → exit 0 (incl. zero-light-hex check on panel.js).
- `bash bridge/test.sh` → 16/16 (against the running :3081 bridge).
- Gold test (REQUIRED, fresh profile): scratch/launch-chrome.sh + CDP (patterns in scratch/probe-panel*.mjs): open the panel → assert the staging row is at the top of the PANEL (not a full-window overlay on the page); stage the active tab → chip appears; open the workspace dropdown → assert real workspace/session rows (NOT "Not in the sidebar right now"); click a session → the in-iframe GUI opens it.
- Screenshot the reworked panel (CDP Page.captureScreenshot) with chips staged + workspace list visible → save /tmp/task-h-panel.png, report the path.
- Report <=200 words: per-file changes with line ranges (panel.html, panel.js, content.js, scraper.js), the workspace-selector root cause + fix approach, gold-test evidence (row count + first session, chip present, no full-window overlay), screenshot path, ending with "TASK H COMPLETE".

## J. tab-select button in a new DSH agent preset (task_j_tab_select_preset)
Goal: a DSH agent preset (copy of `cordis`) that adds an inline "Add tabs" button to the GUI — a clean dark checkable list of the current browser's tabs (favicon+title, active tab "· current tab"), selecting tabs adds them to the session. Works like the gemini/DSH "Add tabs" (reference image: /tmp/task-h-panel.png + the user's gemini screenshot). Two pieces:

### J1 (DELEGATED → worker): content.js window.postMessage bridge
The GUI-page Cordis plugin (J2, facilitator-built) cannot call chrome.tabs — only the extension can. content.js (injected into the GUI page) is the bridge. It ALREADY bridges panel↔sw.js via chrome.runtime.sendMessage (gui-session/panel-state/scrape-tree/open-session handlers). ADD a window.postMessage bridge to the EXISTING sw.js engine — NO new sw.js messages (sw.js is UNCHANGED, mtime 2026-09-14).
Protocol (Cordis plugin ↔ content.js, same top window):
- Plugin→content.js: `window.postMessage({type:'chrome-eye:gui:<x>', reqId:<n>, payload:{...}}, '*')`
- content.js→plugin: `window.postMessage({type:'chrome-eye:gui:<x>:result', reqId:<n>, data:<sw response>}, '*')`
- Map (strip the `gui:` namespace to the existing sw.js message):
  - `chrome-eye:gui:list-tabs`        → sw `{type:'chrome-eye:list-tabs'}`            (data = tab list)
  - `chrome-eye:gui:stage-tab`        → sw `{type:'chrome-eye:stage-tab', tabId}`      (payload {tabId})
  - `chrome-eye:gui:unstage-tab`      → sw `{type:'chrome-eye:unstage-tab', tabId}`    (payload {tabId})
  - `chrome-eye:gui:add-staged`       → sw `{type:'chrome-eye:add-staged'}`            (data = add-to-session result)
  - `chrome-eye:gui:panel-state`      → sw `{type:'chrome-eye:panel-state'}`           (data = stagedTabs)
Implementation (content.js only, ES5 var/function, no imports):
- `window.addEventListener('message', onGui)`. In onGui: `if (window !== window.top) return;` (top frame only, avoid iframe dupes); `var d = e.data; if (!d || typeof d.type !== 'string' || d.type.indexOf('chrome-eye:gui:') !== 0) return;`
- `var swType = d.type.replace('chrome-eye:gui:', 'chrome-eye:');` forward `{type:swType, tabId: d.payload && d.payload.tabId}` via the EXISTING chrome.runtime.sendMessage pattern (reuse the helper the gui-session/panel-state handlers use).
- On response (or no-response/extension-not-loaded): `window.postMessage({type: d.type + ':result', reqId: d.reqId, data: resp || {ok:false,error:'extension-not-loaded'}}, '*');`
- Do NOT touch sw.js / panel.js / panel.html / manifest. content.js already had the full-window overlay REMOVED in H — do not re-add it.
Accept: `bash verify.sh` exit 0; content.js still syntax-clean; a GUI-page script posting `chrome-eye:gui:list-tabs` gets a `chrome-eye:gui:list-tabs:result` with the tab list (test by CDP Runtime.evaluate in the :3080/:3081 GUI page after reloading the extension). Report <=150 words: content.js line ranges, the guard clauses, test evidence, ending "TASK J1 COMPLETE".

### J2 (FACILITATOR): the Cordis preset + client plugin (built with cordis_* tools, not delegated)
- Mount a temp Host plugin that `inject:['agentPresets']` + registers tools (preset_list/read/copy/recompose) to reach the roster service.
- `agentPresets.copy('cordis', <idPrefix>, 'Name')` → new preset dir under $DSH_HOME/.agent-presets/<id>/.
- Add a client-plugin row to the new preset's agent.cordis.yml: an "Add tabs" button in a live Slot (query client Slots.listSubTree for the right one; query client Builtin for window/postMessage access) that uses the J1 postMessage bridge to list/stage/select tabs and add to session. Use theme tokens, no light hex.
- Verify it mounts (roster list shows it, trust:user) + the button renders + selecting a tab adds it to the session (end-to-end via the bridge).

## TASK J5b — prompt-time attach redesign (task_j_tab_select_preset, 2026-09-21)
User decisions (verbatim intent): staging is REFERENCE-ONLY (no DOM snapshot at add-time); context is captured FRESH at prompt-submit time inside the DSH chat iframe; a button on the composer opens the tab list (checkboxes, same SW staging state); nothing selected by default; remove the left bottom-bar `#ws-overlay-btn` + hidden `#ws-close-btn`, keep right `#ws-tree-btn`.
STATE: **IMPLEMENTED + MECHANISM-VERIFIED** (see facilitator_status.json `task_j_tab_select_preset.notes` for the full evidence record).
- sw.js: `add-staged` = confirm-only; `chrome-eye:prompt-attach` → `attachStagedContext()` (fresh capture, 20k/100k budgets, one-shot clear, panel mirror); `injectComposerHook*` + `webNavigation.onCompleted` on :3080/:3081.
- composer-hook.js (NEW): capture-phase Enter interception → append context via execCommand → synthetic re-dispatch; 📑 button + popover (stable selectors only: `div[data-composer-input="true"]`, `button[aria-label="Send message"]`).
- panel.html/panel.js: bottom-bar left buttons removed, ts-add confirm-only, attach-result status.
STATE 2026-09-21 (final): **E2E 21/21 PASS** — `scratch/e2e-attach-test.mjs` (new-semantics flow: stage → prompt-attach fresh capture + one-shot clear → second attach refused → hook button 🗁1 in GUI iframe → top-level panel screenshot → cleanup). Evidence: `scratch/e2e-evidence.png` (43204B). Root causes fixed + verified: manifest `host_permissions <all_urls>` (executeScript on real tabs); sw.js:207-234 URL-filtered webNavigation fallback (headless Chrome 153 rejects filtered listeners); stale-SW-from-HTTP-cache (wipe profile Cache + Code Cache; `chrome.runtime.reload()` KILLS headless ext — never use); `Page.captureScreenshot` top-level-only (capture the panel page, compositor includes the :3081 OOPIF); non-`/u` `\u{1F5C1}` regex → surrogate-pair form. CDP-OP resident subagent READY (id `746907e0-018e-4fca-aea2-77549570d73a`) for on-demand screenshot/eval/tab-control (safety: never types into DSH composer, extension/bridge source untouched). Stack durability: WSL user-scope systemd broken at boot (`user@1000.service` EBUSY) → `@reboot` cron `/home/cztl/.local/share/chrome-eye/autostack.sh` → `start-stack.sh` (added :3080 idempotency guard); both paths verified. `verify.sh` all PASS (:3080=401 expected, :3081=200).
REMAINING (next steps, top-down):
1. User reloads the extension at `chrome://extensions` in REAL Chrome (dev-loaded, mlolgaoijponghgfnlcljlohnhlpnhkd) — new-permissions notice for `<all_urls>` expected; feature is inactive in real Chrome until then.
2. `scratch/task-j5-test.mjs` is SUPERSEDED by `e2e-attach-test.mjs` (it tests the old add-to-session/"Saved N pages" semantics). Full rewrite to new panel-UI semantics (nothing pre-selected, confirm-only ts-add, attach status) = J6 candidate.
3. J6 (deferred): button prominence, file attach, screenshot-in-prompt, task-j5-test.mjs rewrite.
CONSTRAINTS (unchanged): plain ES5, no manifest changes (hook is on-demand `files` injection), never patch DSH compiled code, no real sends into user sessions during tests, J1 bridge in content.js (L204-296) off-limits.
