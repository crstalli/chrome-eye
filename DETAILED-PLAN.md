# Chrome Eye — Detailed Plan (atomic, testable tasks)

**One-sentence summary:** Build a Chrome MV3 side-panel extension that embeds the real DSH GUI (so one backend session is shared across every browser) and gives the model access to the tab the user is looking at (text + screenshot), routed through a tiny Node loopback bridge because the extension's own `fetch` is blocked by the trust fence (403 on `/api/*` with `Origin: chrome-extension://…`).

## How to use this file (for any agent)
1. Read `chrome-eye/PLAN.md` (design + checkpoints), then `chrome-eye/CP-3.5.md` (verified facts + locked wire spec), then this file.
2. Pick a task row whose **deps** are all ✅. Work it. Its **Test** cell is the definition of done — a task is `Task comple` only when that test actually passes (run it, don't assume).
3. Update the row when you finish: set `Task comple` (✅ + date), and a different agent (or the user) sets `Task reviewed`.
4. Hard constraints (violations = task failed):
   - **Trust fence:** extension pages must NEVER fetch `http://127.0.0.1:3080/api/*` directly (403). Extension-originated API calls go only through the Node bridge on `127.0.0.1:3081` (plain Node → no Origin header). The iframe's *own* same-origin traffic is fine unmodified.
   - Wire protocol is **LOCKED** (CP-3.5 §2): unary call = `POST /api/<channel>/<endpoint>`, body `{ type:'client-request', rpcId, method, payload }`; response `{ type:'server-response', rpcId, result:{ok,value|error} }`. Reuse `dsh-client-connection` client code/types; do NOT guess REST routes.
   - No DSH modification (checkout inspect-only). No npm installs (pure Node 24 + pure files). No `sessions/*` RPC exists on the remote surface — do not invent one.
   - Scratch only under `/mnt/f/ai`. Do not disturb: `gpu-intel-arc-pro-b65.md`, `searxng/`, Obsidian vault dirs, the DSH checkout.
5. Keep `CP-3.5.md` current at every checkpoint boundary (user restarts agents often).

**Legend:** `Task comple`: ✅ done · 🔄 in progress · ⏳ pending · ⬜ blocked. `Task reviewed`: ✅ confirmed · — not yet. Tasks marked **(user)** need the user in Chrome/Windows; everything else is doable by an agent in this workspace.

---

## Phase 0 — Prerequisites

| ID | Task | Test (acceptance) | Taken by | Task comple | Task reviewed |
|----|------|-------------------|----------|-------------|---------------|
| T0.1 | DSH GUI reachable at `http://127.0.0.1:3080` | `curl -sI http://127.0.0.1:3080` returns 200 + HTML | main | ✅ 07-01 | ✅ |
| T0.2 | DSH checkout readable (inspect-only) | `ls` + read of `dsh-client-connection` succeeds | main | ✅ 07-01 | ✅ |
| T0.3 | Scratch dir writable under `/mnt/f/ai` | write+delete a test file in `chrome-eye/` | main | ✅ 07-01 | ✅ |

## CP-4 — Extension skeleton (`chrome-eye/extension/`)

| ID | Task | Test (acceptance) | Taken by | Task comple | Task reviewed |
|----|------|-------------------|----------|-------------|---------------|
| T4.1 | Create `extension/` dir | dir exists | main | ✅ 07-01 | — |
| T4.2 | `manifest.json`: MV3, `side_panel.default_path=panel.html`, `action`, `background.service_worker=sw.js`, `options_page=options.html`, content script `<all_urls>`→`content.js`, perms `sidePanel,activeTab,scripting,storage`, `host_permissions http://127.0.0.1:3080/*` | `node -e "JSON.parse(...)"` passes; all listed fields present | main | ✅ 07-01 | — |
| T4.3 | `panel.html`: `#dsh-iframe` → `http://127.0.0.1:3080` filling panel minus 60px bottom bar; `#share-page` button in bar | `grep` finds iframe src + `#share-page` (verified) | main | ✅ 07-01 | — |
| T4.4 | `panel.js`: share-button click handler (stub → alert for now) | `node --check panel.js` passes (verified) | main | ✅ 07-01 | — |
| T4.5 | `content.js` stub | `node --check content.js` passes (verified) | main | ✅ 07-01 | — |
| T4.6 | `sw.js` stub | `node --check sw.js` passes (verified) | main | ✅ 07-01 | — |
| T4.7 | `options.html` + `options.js` stubs (DSH URL input, default `http://127.0.0.1:3080`, Test Connection button) | files exist; `node --check options.js` passes (verified) | main | ✅ 07-01 | — |
| T4.8 **(user)** | Load unpacked extension: `chrome://extensions` → Developer mode → Load unpacked → `F:\ai\chrome-eye\extension` | loads with **no** manifest errors | user | ⏳ (deferred to the end — user present) | — |

## CP-5 — Panel verification (user-driven)

| ID | Task | Test (acceptance) | Taken by | Task comple | Task reviewed |
|----|------|-------------------|----------|-------------|---------------|
| T5.1 **(user)** | Open side panel | DSH GUI renders inside the iframe (login/state intact) | user | ⏳ (after T4.8) | — |
| T5.2 **(user)** | Responsiveness at ~400px panel width | no horizontal scroll, sidebar usable; note any breakage in PLAN.md open items | user | ⏳ (after T5.1) | — |
| T5.3 **(user)** | Session sharing proof | the conversation open in the desktop browser at `:3080` is the same one shown in the panel (type in one, see in other) | user | ⏳ (after T5.1) | — |
| T5.4 | CSS shim in `panel.html` (width/zoom) **only if** T5.2 fails | after shim: no scroll, layout intact | agent | ⏳ (conditional) | — |

## CP-6 — Tab context extraction (`content.js` / `sw.js`) — **FINAL**

| ID | Task | Test (acceptance) | Taken by | Task comple | Task reviewed |
|----|------|-------------------|----------|-------------|---------------|
| T6.1 | `content.js`: extract visible text, cap 120,000 chars | on a known page (e.g. a news article) `0 < text.length ≤ 120000`, contains the article's visible words | agent | ✅ 09-07 | — |
| T6.2 | `content.js`: extract links, cap 200, shape `{t,h}` | `links.length ≤ 200`; every item has `t` (string) + `h` (string) | agent | ✅ 09-07 | — |
| T6.3 | `content.js`: extract headings, cap 60, shape `{level,t}` | `headings.length ≤ 60`; every item has numeric `level` 1–6 + `t` | agent | ✅ 09-07 | — |
| T6.4 | `content.js`: capture `url` + `title` | equals `location.href` and `document.title` on the page | agent | ✅ 09-07 | — |
| T6.5 | `content.js`: assemble `{url,title,text,links,headings}` and return it to the sender | returned object has exactly these 5 fields, no `undefined`s | agent | ✅ 09-07 | — |
| T6.6 | `content.js` + `sw.js`: message round-trip — sw injects/queries content script (`chrome.scripting.executeScript` or `tabs.sendMessage`) and receives the T6.5 object | console in service worker logs the full object on demand | agent | ✅ 09-07 | — |
| T6.7 | `sw.js`: `chrome.tabs.captureVisibleTab` → PNG | returns `data:image/png;base64,…` (test with panel open; active-tab constraint noted) | agent | ✅ 09-07 | — |
| T6.8 | `sw.js`: compose final share payload = T6.5 context + base64 image | payload object validated in sw console: context + non-empty `image` | agent | ✅ 09-07 | — |
| T6.9 | Text-only fallback path (if model has no vision): payload omits `image` cleanly | payload without `image` still passes T6.8 validation | agent | ✅ 09-07 | — |

**CP-6 FINAL (2026-09-07):** `bash test/run.sh` GREEN 3 consecutive runs — 10 pass / 0 fail / 0 skip, exit 0 (final report 2026-09-07T20:37:33Z); all 6 checks execute (no skips), check 3 = real sw↔content round-trip vs `test/fixture/expected.json`. Extension changes: `"tabs"` added to manifest.json permissions (check 3 needs `tab.url` visibility); sw.js now calls `chrome.sidePanel.setPanelBehavior({openPanelOnActionClick:true})` (live Windows-Chrome acceptance: action-icon click was a no-op). Flake (documented, NOT fixed): check 1 (SW target in CDP /json) — Chrome registers the SW target ~100–200 ms after the page target, one-shot enumeration fails ~1 in 4 runs; extension-side fix proven impossible (MV3 CSP rejects `unsafe-inline`; Chrome 152 refuses such a manifest); **decision: harness-side retry of `listTargets` for ~1 s near `test/harness.mjs` L51 (mirror L48 waitFor) = T11.5**.

## CP-7 — Node bridge + injection into the session

| ID | Task | Test (acceptance) | Taken by | Task comple | Task reviewed |
|----|------|-------------------|----------|-------------|---------------|
| T7.1 | `bridge/bridge.mjs`: plain-Node HTTP server bound to `127.0.0.1:3081` (no frameworks) | `curl -s http://127.0.0.1:3081/health` → 200 `{"ok":true}` | agent | ✅ 07-02 | — |
| T7.2 | bridge: forward unary calls — `POST /api/<channel>/<endpoint>` → `http://127.0.0.1:3080` with the same path/body | a `POST /api/...` through 3081 returns the DSH `server-response` JSON (verified via one known-good endpoint from CP-3.5 §4) | agent | ✅ 07-02 | — |
| T7.3 | bridge: strip any client-supplied `Origin` header on forwarded requests | log/inspect forwarded request at a debug endpoint: **no** `origin` present | agent | ✅ 07-02 | — |
| T7.4 | bridge: WebSocket upgrade for `/api/events.mux` (pipe both ways) | `node -e` ws-client through 3081 receives at least one DSH event frame | agent | ✅ 07-02 | — |
| T7.5 | bridge: WebSocket upgrade for `/api/events.host` | ws-client through 3081 connects + reads frames | agent | ✅ 07-02 | — |
| T7.6 | bridge end-to-end: extension-style unary round-trip via 3081 (simulated with curl, no Origin header) | request in → matching `rpcId` `server-response` out, `result.ok:true` | agent | ✅ 07-02 | — |
| T7.7 | Read `dsh-client-connection/lib/types/client/api.d.ts` (`SessionsApi`, `HostApi`, `EventsApi`) → write down the **exact** endpoint + method + payload that injects context/text into a session (or the closest supported primitive) | `CP-3.5.md` §7(b) updated with the exact call signature; if none exists, document why + pick the fallback (T7.9) | agent | ✅ 07-02 (CP-3.5 §7(b)) | — |
| T7.8 | bridge: `POST /share` endpoint — accepts the T6.8 payload, calls the T7.7 wire inject into the active session | `curl -X POST 127.0.0.1:3081/share -d @payload.json` → response `ok:true` **and** the text visibly appears in the DSH session | agent | 🔄 (bridge side verified 07-02; live E2E with T9.3) | — |
| T7.9 | Fallback if T7.8 infeasible: bridge writes payload to `chrome-eye/captures/<ts>.json` (+ optional screenshot file) | after `/share`, file exists with the full payload | agent | ✅ 07-02 | — |
| T7.10 | Wire UI: `panel.js` share button → `sw.js` → `fetch http://127.0.0.1:3081/share` (bridge only — never `:3080/api`) | click button on a real page → bridge log shows `/share` with the T6.8 payload | agent | 🔄 (wiring done; verifies with harness/E2E) | — |

## CP-8 — Options page + README

| ID | Task | Test (acceptance) | Taken by | Task comple | Task reviewed |
|----|------|-------------------|----------|-------------|---------------|
| T8.1 | `options.html`: DSH URL input (default `http://127.0.0.1:3080`) + "Test Connection" button | fields present; page renders standalone | agent | ✅ 07-01 (stub) | — |
| T8.2 | `options.js`: persist URL to `chrome.storage` | change value → reload page → value restored | agent | ✅ 07-02 | — |
| T8.3 | `options.js`: real connection test — fetch GUI root via the URL (or bridge `/health`), show ✅/❌ | button shows success for `http://127.0.0.1:3080`, failure for a dead port | agent | ✅ 07-02 | — |
| T8.4 | `README.md`: Windows install steps (load unpacked path `F:\ai\chrome-eye\extension`, start bridge `node bridge/bridge.mjs`, open panel, share page) + troubleshooting (bridge not running, trust-fence 403, active-tab for screenshots) | a fresh agent following README alone can get to T9.3 | agent | ✅ 07-02 | — |

## CP-9 — End-to-end (user-driven, Windows)

| ID | Task | Test (acceptance) | Taken by | Task comple | Task reviewed |
|----|------|-------------------|----------|-------------|---------------|
| T9.1 **(user)** | Load unpacked extension (fresh profile state) | no errors in `chrome://extensions` | user | ⏳ | — |
| T9.2 | Start bridge | `node /mnt/f/ai/chrome-eye/bridge/bridge.mjs` runs; `curl :3081/health` → ok | user/agent | ✅ 09-08 — runs as a managed background job (ops note in "Current state") | — |
| T9.3 **(user)** | Open panel, look at a page, click **Share this page** | page text (+screenshot) written to `captures/<unix-ts>.json` (MVP fallback — sw.js sends no `sessionId`; open: who supplies it; live injection: open, see CP-3.5.md §7(b)) | user | ⏳ (after T7.10, T9.2) | — |
| T9.4 **(user)** | Session sync proof: type a prompt in the panel; watch the desktop browser at `:3080` (and vice versa) | input + streaming status visible in **both** UIs, same session | user | ⏳ (after T9.3) | — |
| T9.5 **(user)** | Full control parity: select session, model, permissions, run a command from the panel's embedded GUI | each control behaves identically to the standalone UI | user | ⏳ (after T9.4) | — |

## Delivery / cleanup

| ID | Task | Test (acceptance) | Taken by | Task comple | Task reviewed |
|----|------|-------------------|----------|-------------|---------------|
| T10.1 | Delete CP-3.5 §6 scratch artifacts: `.gui.html`, `.gui-index.js`, `.gui-vendor.js`, `.gui-chunks.txt`, `.guichunks/` | `ls chrome-eye/` shows none of them | agent | ✅ 07-02 (deleted from `/mnt/f/ai/`, verified absent) | — |
| T10.2 | Final checkpoint update: `PLAN.md` CP-4…CP-9 statuses + `CP-3.5.md` "all done" note | both files consistent with ✅ rows above | agent | ⏳ (after T10.1) | — |

## T11 — Gemini-style integration (user request 2026-09-08)

**User constraint (verbatim):** "settings/UI should only be present when the extension is being used. It should not completely change the DSH harness."

| ID | Task | Status (2026-09-08) |
|----|------|---------------------|
| T11.1 | sessionId → /share → session.prompt (queue mode) wiring | ✅ 09-08 — `dsh.sessions.current` recipe → sw.js cache → `/share` carries `sessionId` → injected/fallback status surfaced |
| T11.2 | context chips inside the GUI — current tab auto-added as chip with ✕, "+" tab picker, chips added to the viewed session for the next prompt | ✅ 09-08 — chip row in the GUI (content-script DOM); auto-stage active tab; "+" picker; "→" per-chip sequential `/share` with `sessionId`; panel bottom bar status-only |
| T11.3 | always-present workspace-tree dropdown in the panel (extension-side; reads GUI state; NO DSH harness changes) | ✅ 09-08 — "Workspaces ▾" in the bottom bar; on-demand suffix-based sidebar scrape (grouped/flat/search modes, cap 200); current row via `aria-selected` + SW-cached id; navigation = row `.click()` (app's own `onOpen`); collapsed group → overflow-button expand; row not in DOM → "open the workspace in the GUI sidebar first" |
| T11.4 | (stretch) workspace/settings overlay above the GUI chat window (chat root located at runtime via `_centerCol` → first `_root` descendant — no hardcoded hash) — dropdown (T11.3) is the guaranteed floor | ✅ 09-08 — "⛶ workspace" opens a full-size overlay over the chat column (z-index below the chip strip); same tree + navigation; ✕ and Escape close; falls back to center column, then viewport, when the chat root isn't found |
| T11.5 | check-1 harness retry fix (`test/harness.mjs` — retry `listTargets` ~1 s near L51) | ✅ 09-08 — harness retries target enumeration ~1 s; check 1 stable |
| T11.6 | remove the always-present "Share this page" bottom-bar button (absorbed into T11.2 chips) | ✅ 09-08 — button removed; `#share-status` mirrors chip outcomes |

---

## Parallelization map (for dispatching small agents)
- **Now (no user input needed):** T6.1–T6.9 (one agent), T7.1–T7.6 + T7.9 (another agent), T7.7 (another agent — pure reading/writing), T8.1–T8.4 (another agent). All four streams are independent.
- **Needs the user first:** T4.8 → T5.1–T5.3 (one Chrome session by the user; report findings back and the agent does T5.4 if needed).
- **Then:** T7.8 → T7.10 → T9.x (end-to-end with user).
- **Last:** T10.1 → T10.2.

**Stuck?** Consult the user-specified troubleshooting repo: https://github.com/Lum1104/dsh-browser.
**Testing (settled 2026-07-02):** podman abandoned (permanently broken in this WSL). Use the
local chrome-for-testing full `chrome` binary in `test/chrome/` + `dpkg -x`'d libs in
`test/chrome-libs/` (`LD_LIBRARY_PATH`, `--no-sandbox`); details in `test/chrome-setup.md`.
User's Windows Chrome is reserved for T4.8/T9.x (DEFERRED to the end).

## Current state (as of 2026-07-02 night, after CP-7/CP-8 reports)
- CP-1–CP-4 **done** (T4.1–T4.7 ✅; T4.8 deferred with the rest of the Windows-side work).
- Overnight policy: **all implementation delegated to sub-agents** (2× qwen3.8, 1× gemma4);
  orchestrator only coordinates. Sub-agent context is 128k → tasks kept small with known tests.
- **CP-7 DONE** (bridge agent): `bridge/bridge.mjs` + `bridge/test.sh` → **ALL PASS (7 checks)**
  incl. Origin-strip proof, WS mux round-trip, /share fallback. T7.7 **solved**: exact inject
  primitive = `session.prompt` (CP-3.5.md §7(b), live-verified schema-level). `/share` injects
  only when payload carries `sessionId`; otherwise `captures/<ts>.json` fallback (MVP).
  **CORS follow-up also DONE** (16 checks, exit 0): `ACAO: *` + `Access-Control-Allow-Content-Type:
  application/json` on /share + /api/* + /health, OPTIONS preflight → 204; supersedes the earlier
  no-CORS decision (CP-3.5.md §7(b) marked). Also fixed a latent double-`writeHead` crash in the
  sessionId branch + a WS pipe race (outbox buffering). Manifest `host_permissions += :3081` kept
  anyway (harmless belt-and-suspenders).
- **CP-8 DONE** (options agent): `options.js` (T8.2 `dshUrl` storage.sync + T8.3 connection
  test) + `README.md` (T8.4).
- **CP-6 code DONE** (content agent, self-verified 16/16 vs fixture); manifest
  `host_permissions += :3081` and sw.js `text` → `visibleText` rename DONE (integration fix
  vs bridge).
- **Test infra DONE** (test-infra agent): local headless chrome-for-testing 152.0.7977.82 in
  `test/chrome/` + libs in `test/chrome-libs/` + `test/cdp-proxy.mjs` (CDP HTTP shim fixing the
  about:blank swap race). Baseline `test/run.sh`: 5 pass, 0 fail, 1 skip (check 3 SKIPped only
  against the old stub content.js; now expected to execute for real).
- **In flight:** harness verification of CP-5/CP-6 — `test/run.sh` checks 1–4 running now.
- Queued: T10.2 (final checkpoint pass) — T10.1 **done** ✅ 07-02. Post-MVP open: who supplies `sessionId` (CP-3.5.md §7(b) "Open" note).
- **Post-MVP TODO (user decision 2026-07-02: MVP ships the `captures/` fallback):**
  1. **Live session injection** — supply `sessionId` to `/share` so shares land in the session the user is viewing (bridge already supports it via `session.prompt`; nobody sends the id yet). Options: content script inside the panel's `:3080` GUI iframe reads the persist keys (`dsh.workspace.view.v5` / `dsh.conversation.chat`) and relays the id to sw.js, or a small session picker in the panel bottom bar. → **IN PROGRESS via T11.1** (2026-09-08).
- Locked facts: CP-3.5 §2, §3, §4, §7(b). `captures/` + `README.md` now exist.

## Current state (as of 2026-09-08)
- CP-6 **FINAL**: `test/run.sh` GREEN ×3 (10/10, exit 0, 2026-09-07T20:37:33Z); all 6 checks execute; see CP-6 note above.
- T11 batch (user request 2026-09-08): **T11.1–T11.6 all done** (2026-09-08,
  `test/run.sh` green 10/10); T11.3 "Workspaces ▾" dropdown and T11.4
  "⛶ workspace" overlay both shipped (extension-side only, no DSH harness changes).
- **Ops:** the bridge process died once — `nohup` does not persist in tool shells — and was
  restarted as a managed background job. If `:3081/health` is down, restart it as a managed
  background job, not `nohup`.
- Live Windows-Chrome acceptance found + fixed 2 real bugs: (a) action-icon click no-op →
  sw.js `setPanelBehavior({openPanelOnActionClick:true})`; (b) tabs opened before install/
  reload have no content script → **implemented**: sw.js `captureTab` /
  `guiTabRoundTrip` inject `content.js` via `chrome.scripting.executeScript`
  and retry the message once.

## T12 — Workspaces IN THE PANEL (user findings, 2026-09-11)

**User verbatim:** "the workspaces feature kind of works... but it doesn't do it in the
plugin. it does it in the main screen. And i don't know how to exit it. The bottom bar is
pretty ugly and doesn't match the dsh css. I See the button says disconnected based off my
last reload. Workspaces doesn't have contrast. I'm not sure the sessions are lined becasue
in the plugin, i don't see hte same workspaces int he web profile. ... This should act just
like gemini plugin for chrome" → 6 findings: F1 workspaces only work in main screen; F2 no
exit for workspace overlay; F3 ugly bottom bar (≠ dsh css); F4 stale "disconnected";
F5 workspaces dropdown has no contrast; F6 panel ≠ web profile workspace lists.
North star: **panel should act like the Gemini Chrome plugin — self-contained.**

**Recon facts (facilitator, 2026-09-11, verified):**
1. `:3080/` answering 401 to plain curl is **EXPECTED**, not an outage: DSH web auth gate
   (`dsh-client-connection/lib/index.js` ~L380–430: `isAuthenticated` = authority-bound
   signed session cookie; `writeUnauthorized` → 401 text at L424). The real browser iframe
   carries the cookie and loads fine.
2. **"disconnected" is NOT an extension string** (grep of `extension/*` = 0 matches). It is
   the DSH GUI's own connection indicator: `ConnectionState = 'connected'|'disconnected'|
   'connecting'` emitted in `dsh-client-connection/lib/client.js` (L94/L126/L142,
   `reconnect()` exponential backoff), rendered by
   `dsh-client-ui-settings-general/lib/client.js` L215–249
   (`connectionIndicator = "disconnected"`, `disconnectedLabel: t("connection.error")`).
   So F4 = the GUI's own WS/connection state, seen inside the panel iframe. DSH is
   read-only → fix the CONDITIONS (bridge liveness, panel iframe session health) + an
   honest panel-side status, never restyle the GUI.
3. Bridge `:3081` was **DOWN** at recon time (`curl :3081/health` → HTTP 000; no background
   jobs). Sanctioned recovery: restart THE bridge as a **managed background job** (never
   `nohup`); "do not start another bridge" means no duplicate instances.
4. Root cause of F1/F6: the panel iframe is a SEPARATE GUI instance. Content scripts do NOT
   run in it (it's a frame of a `chrome-extension://` page; `content_scripts` has no
   `all_frames`). Current T11.3 data path = panel → SW → a REAL :3080 tab's content
   script → its sidebar DOM. That requires a real GUI tab AND scrapes a DIFFERENT tab's
   sidebar (explains F6 "not the same workspaces" — e.g. SW's `findGuiTabId()` picking
   another tab/profile/window, or that tab's own view state).
5. **Enabler (no manifest change):** manifest already has `scripting` + `webNavigation` +
   `host_permissions :3080/*`. Discovery recipe (robust):
   `chrome.webNavigation.getAllFrames({url:'http://127.0.0.1:3080/*'})` → frames where
   `frameId > 0` = panel-iframe frames (real GUI tabs expose :3080 as top frame,
   `frameId === 0`). Prefer `frameId > 0` (panel's own GUI); fall back to `frameId === 0`
   (real GUI tab, today's path). Then
   `chrome.scripting.executeScript({target:{tabId, allFrames:false, frameId}, func, args})`
   — `func` must be a SELF-CONTAINED plain-JS function (serialized; no closures, no
   `chrome.*`, pure DOM).
6. F6 hypothesis to verify: the panel iframe is a third-party context inside a
   `chrome-extension://` page → Chrome **storage partitioning** may give it a SEPARATE
   `localStorage` → different `dsh.workspace.view.v5` view prefs (order/grouping) than the
   web tab. Workspace/session DATA is backend-global (one DSH process) so the SET should
   match; only view state may differ. (user) check: compare
   `localStorage['dsh.sessions.current']` / `dsh.workspace.view.v5` in panel-iframe console
   vs main GUI tab console.
7. Constraint reminder: modify only `extension/*` + checkpoint docs; `test/*` + `bridge/`
   + DSH checkout read-only; NO manifest permission changes; no `test/run.sh`; no POST of
   session ids to :3081; wire protocol LOCKED (CP-3.5 §2, no `sessions/*` RPC);
   `dsh.workspace.view.v5` = view prefs only — real tree data comes from the live GUI
   sidebar DOM (the T11.3 scraper, content.js L500–812 incl. overlay at L634–812).

**File-conflict map** (drives the subagent split): panel.html → B only (styling);
panel.js + sw.js + content.js → A (core), then D (wave 2); C is read-only research.

| ID | Task | Acceptance | Owner | Done |
|----|------|-----------|-------|------|
| T12.1 | F1+F6: workspaces work **in the panel**. SW routes `chrome-eye:workspace-tree` / `open-session` / `expand-group` / `overlay` to the panel's OWN `:3080` iframe frame via `executeScript` (recipe §5), reusing the T11.3 scraper logic as a self-contained injected `func` (extract to `extension/scraper.js`; SW classic-worker → `importScripts`, or module → `import`). Fall back to the real-GUI-tab content-script path when no panel frame exists. | With **no** other `:3080` tab open: panel "Workspaces ▾" lists the panel's own GUI workspaces+sessions; clicking a session opens it in the panel GUI; overlay opens over the panel's chat. `node --check` all touched files. Final gate = user e2e (T12.6). | A (brief-A) | ⏳ |
| T12.2 | F2: panel-side overlay EXIT. Make `#ws-overlay-btn` ("⛶ workspace") a TOGGLE: second click sends `chrome-eye:overlay {open:false}` (verify/harden the close path in content.js L634–812: remove `overlayEl`/anchor, cancel rAF `overlayRaf`, remove keydown-capture listener); status text reflects open/closed; Esc/✕ inside GUI must still work. NO new panel.html elements (keep file-conflict map). | From the panel ALONE: user can open AND close the overlay; no GUI-tab interaction needed. | A (brief-A) | ⏳ |
| T12.3 | F3+F5: restyle panel chrome to DSH dark theme — `#bottom-bar` (60px, currently `#f0f0f0` + `border-top #ccc`), buttons, `#ws-dropdown` (currently `#ffffff`), status text. Extract REAL DSH tokens read-only from the checkout (look: `dsh-brand`, theme/token packages, CSS custom props `--…` in `dsh-client-*`); apply dark palette, DSH borders/accents, green/red status colors matching the GUI. **Contract:** keep every existing id (`#dsh-iframe #bottom-bar #share-status #ws-controls #ws-overlay-btn #ws-tree-btn #ws-dropdown #ws-dd-head #ws-dd-title #ws-dd-status #ws-dd-body`) stable; new classes prefixed `ce-`. No pure-white/light surfaces remain in panel chrome. | grep: no `#ffffff`/`#f0f0f0`/`#ccc` in panel chrome; all ids intact; dark palette sourced from checkout tokens (cited in progress file). Final gate = user visual check. | B (brief-B) | ⏳ |
| T12.4 | F4: no stale "disconnected". (a) Research (C, read-only → `scratch-t12/T12.4-findings.md`): exact trigger of GUI `ConnectionState='disconnected'` (dsh-client-connection client.js L60–221 + settings-general L215–249: WS `/api` drop? backend restart? auto-recovery? WHICH UI element shows it — so the user knows which "button"), + impact of bridge-down (GUI itself is same-origin to :3080 → unaffected; only `/share` + extension `/api` calls break), + live-state check. (b) Implement (D, wave 2 after A): panel proactively re-evaluates connectivity on load, SW start, iframe load (`webNavigation.onCompleted`), ~10 s refresh; status = f(bridge `:3081/health`, panel-frame GUI health via injected probe / GUI indicator DOM); meaningful texts (GUI ✓ / bridge ✗ …); add ↻ reload-iframe affordance when GUI dead (can be a JS-created button in `#bottom-bar` — panel.js only, no panel.html edit). | After killing DSH backend + reloading panel: status shows a meaningful error ≤ ~10 s; recovers on backend return without manual reload (or one ↻ click); findings file exists, cited, and appended to CP-3.5.md by facilitator. | C research / D impl | ⏳ |
| T12.6 | F6 verify: panel-vs-web-profile lists reconcile after T12.1 (panel shows its OWN GUI state — Gemini-like, expected); confirm SET of workspaces/sessions matches web profile (backend-global); document localStorage partitioning result (hypothesis §6). | **(user)** panel "Workspaces ▾" shows same workspaces/sessions as main GUI; localStorage comparison noted in STATE-T12.md. | (user) | ⏳ |
| T12.7 | **Browser-automation tests with screenshots (USER ORDER 2026-09-12, verbatim: "actual tests with browsers, automation: playwright / screenshots").** New dir `chrome-eye/tests/` (NOT the read-only `test/*` CDP harness). `npm i playwright@1.63.0 --no-save` (version verified via `npx playwright --version`; browser: reuse `test/chrome/chrome-linux64/chrome` via `executablePath` or let playwright fetch). Tests: (1) launch persistent context + `--load-extension=extension` (headless=new; side panel not drivable → open `chrome-extension://<id>/panel.html` as a normal tab); (2) mint :3080 auth cookie OFFLINE per STATE-T12.md "SOLVED headless :3080 auth" recipe (secret in `/home/cztl/.dsh/.credentials.yaml` — keep secret OUT of repo, mint at test-run time) + `context.addCookies` before load; (3) screenshot evidence: full panel (chrome + dark bottom bar vs `scratch-t12/gemini-reference.png`), workspaces dropdown open, overlay open AND closed (exit paths), "disconnected" indicator state when backend healthy; (4) assertions: iframe loaded :3080 (no 401), workspaces tree non-empty in panel-only mode (no other :3080 tab), overlay toggle opens then closes. | `node chrome-eye/tests/run.mjs` (or `npx playwright test`) exits 0; ≥5 screenshots in `chrome-eye/tests/shots/` with names covering the 4 cases above; screenshots readable by user as evidence. | coordinator (AFTER A/B/D settle, so shots capture fixed panel) | ⏳ |

**Wave plan:** Wave 1 (parallel, background): A = T12.1+T12.2 (owns sw.js/content.js/panel.js);
B = T12.3 (owns panel.html only); C = T12.4-research (read-only). Wave 2 (after A settles):
D = T12.4-impl (owns panel.js/sw.js, uses C's findings). T12.6 = user verification.
**SUPERSEDED 2026-09-12:** wave-1 parallelism replaced by user standing order = strictly
sequential, ONE subagent at a time: A → B → C → D. T12.7 (playwright + screenshots) runs
LAST, after A/B/D, so screenshots capture the finished panel.

**Crash-safe protocol (user mandate 2026-09-11):** every subagent's FIRST action =
write `scratch-t12/<id>-progress.md` (outline + current state + next step) AND copy the
original files it will edit into `scratch-t12/backup-<id>/`; update the progress file after
every step. Resumed coordinator: read this section + `STATE-T12.md` + progress files +
backups, then re-launch any unfinished brief (self-contained in `scratch-t12/brief-*.md`).
Nothing of value exists only in conversation.

**Ops at 2026-09-11 checkpoint:** bridge DOWN (HTTP 000) → restart as managed background
job + verify `/health` (facilitator). `:3080` 401-to-curl = expected (§1).

## STATE-T12 (coordination state — keep current)
- T12 rows: written 2026-09-11 (this section).
- Briefs: `scratch-t12/brief-A.md`, `brief-B.md`, `brief-C.md` (self-contained; each
  mandates persist-before-edit).
- Subagents: A/B/C to be spawned in ONE background wave (not yet spawned at checkpoint).
- Bridge: was DOWN; facilitator restarts as managed job before spawning.
- Pause point for user model-restart: AFTER (1) this section + STATE-T12 on disk,
  (2) briefs on disk, (3) each spawned subagent confirms its progress file + backups on
  disk. If the model restarts before spawn: nothing lost (re-run spawn step). If after
  spawn: subagents may die; re-launch from briefs; originals safe in backups.
