# chrome-eye — final report (2026-09-15, all tasks complete)

All 6 original bugs + task E (auth proxy) + task F (click flow) + task F2 (bridge gzip fix) + task G (panel polish + zero-launch bridge) are fixed and independently verified by the facilitator (verify.sh exit 0, bridge/test.sh 16/16, `node --check` clean, mtime scope-audit per worker, code spot-checks, live gold test).

## Per-bug result
- [x] **Workspaces don't work in the plugin** (task A) — A1 sw.js 401-gate probe, A2 scraper.js autoExpandCollapsedGroups, A3 parity + overlay.
- [x] **No way to exit workspace mode** (task D) — "✕ close workspace" button + red status line.
- [x] **Bottom bar ugly / doesn't match DSH** (task C) — 40px bar, dark DSH-token palette, zero inline light colors.
- [x] **Button says "disconnected" after reload** (task B) — probeConn() real fetch to :3080 + :3081.
- [x] **Workspaces lack contrast** (task C) — ≥4.5:1 contrast throughout.
- [x] **Plugin sessions don't match web-profile sessions** (session_sync) — full lists via auto-expand.
- [x] **Panel iframe shows 401 auth gate** (task E) — bridge.mjs full reverse proxy :3081→:3080 with self-minted cookie.
- [x] **Close overlay after clicking workspace; context doesn't load; can't read conversations** (task F) — click flow fix + gold test.
- [x] **0 rows / empty session list** (task F2) — bridge gzip stripping bug. `forwardLongLived` used raw `httpRequest` (no auto-decompress). Browser sends `Accept-Encoding: gzip` → upstream gzips → bridge strips `content-encoding` but passes compressed body verbatim → browser gets gzip bytes labeled `application/json` → `JSON.parse` fails → session list EMPTY. Fix: `delete headers['accept-encoding']` in `forwardLongLived` (bridge.mjs:241). Extension: `_projectRow` (role=treeitem) as primary expand for collapsed groups (scraper.js:226-252, content.js:497-503/635-646).
- [x] **Ugly white box + "GUI: down / bridge: down"** (task G1) — failed cross-origin iframe renders an unstyleable white page when the bridge is dead; and `probeConn()` fetched :3080 directly, which can never work cross-origin (the 401 gate has no CORS header), so it always reported "down". Fix: `#bridge-overlay` dark card (DSH tokens #151517/#353638, connecting/offline states) covers the iframe box (panel.html:13/:20-70/:278-286); `probeConn()` rewritten to a single :3081 fetch (panel.js:123-153) — up → green "GUI: up · bridge: up" + hide overlay + iframe src-reset only on down→up recovery; down → red + "Bridge offline" card. Honest status, auto-recovery, no user action.
- [x] **"I don't need to launch anything new"** (task G2) — the bridge was a manually-started process that died on DSH restart. Fix: systemd **user** service `chrome-eye-bridge` (`/home/cztl/.config/systemd/user/chrome-eye-bridge.service`, `Restart=always`, `RestartSec=2`, `WantedBy=default.target`) — active + enabled, owns :3081. Survives DSH restarts, crashes, and reboots. The user never launches it again.

## verify.sh — exit 0, 11/11
## bridge/test.sh — 16/16 PASS
## Gold test (fresh profile, CDP) — PASS
- 3 workspace groups (ai, ai, cztl), 6 session rows, 9 project rows
- First sessions: "New Session", "I want to create a (1)6h", "Research Fantasy Football Rules and Strategy4h", "can you create a prompt1d", "Running1 subagent runningLets create a skill to7h"
- Overlay opens/closes, Esc works

## Crash regression — PASS
- 5 concurrent `/plugins/events` SSE × 25s × 3 rounds, bridge alive throughout
- Only expected `aborted` + `ECONNRESET` on client disconnect, no `UND_ERR_BODY_TIMEOUT`

## Files changed (all surgical, no manifest/deps changes)
- `extension/panel.html` — 40px bar, dark-token CSS (C/B/D) + `#bridge-overlay` dark card (G1)
- `extension/panel.js` — dark tokens, probeConn(), setOverlay(), close button (C/B/D) + single :3081 probe + overlay drive + iframe auto-recovery (G1)
- `extension/sw.js` — probeGuiFrameDocument() + probe-based findPanelGuiFrame() (A1)
- `extension/scraper.js` — autoExpandCollapsedGroups() + overlay/dropdown wiring + _projectRow expand (A2/A3/F2)
- `extension/content.js` — parity copy + wiring + _projectRow expand (A3/F2)
- `bridge/bridge.mjs` — full auth proxy :3081→:3080, self-minted cookie, long-lived SSE, gzip fix (E/F2)
- `~/.config/systemd/user/chrome-eye-bridge.service` — permanent zero-launch bridge (G2)
- `verify.sh` — check-5 regex accepts the T11.x no-GUI-tab message (G1 removed the old 401-gate probe text it matched; still enforced)

## Worker history
- 14 launches, 7 delivered: 965d3805, 9c1fa83e, a0424f66, 21fc6796, 8ffcdfe7, 1db42d91 (dead/failed)
- Delivered: da9776f2 (C/B/D), 156de4d3 (A1), b7371b74 (A2), c5100cc8 (A3), 26f657c1 (E), 2a68023b (F/F2), 1f629456 (G)
- Lessons: short briefs → durable task files; one file per worker; mtime + verify.sh + code spot-checks as trust signals

## User test procedure
1. `chrome://extensions` → reload chrome-eye.
2. Sign in at http://127.0.0.1:3080 in a normal tab (if not already).
3. Open the side panel: 40px dark bottom bar, real GUI+bridge status. **No bridge launch needed** — the systemd user service `chrome-eye-bridge` keeps it alive permanently (verify: `systemctl --user status chrome-eye-bridge`).
4. Workspace dropdown: full session lists; workspace overlay shows real conversations.
5. Click a workspace → overlay opens with session list; click a session → conversation loads in iframe.
6. Close via ✕ button or Esc.
7. If the bridge is ever stopped, the panel shows a dark "Bridge offline" card (no white box) and auto-recovers (reloads the iframe) the moment it's back — no reload of the panel needed.

## RESUME
`cat /mnt/f/ai/facilitator_status.json && bash /mnt/f/ai/chrome-eye/verify.sh`

## Task H — in-panel "Add tabs" rework + workspace-selector fix (done, 2026-09-16)
- H1: add-to-session staging moved from the full-window white overlay (content.js) into a dark 36px `#stage-row` at the top of the panel (panel.html/panel.js): "Add tabs (n)" toggle + staged chips (✕) + green "→ Add to session" + a clean dark checkable tab-list dropdown (favicon, title, url, ✓; active tab marked "· current tab"). Matches the gemini / DSH "Add tabs" design the user referenced.
- H2: root cause (live-probe proven) — `autoExpandCollapsedGroups()` clicked EVERY group's project row unconditionally, toggling already-expanded groups CLOSED; the sync scrape then read the stale pre-render DOM → `row-not-found` → "Not in the sidebar right now". Fix (scraper.js + content.js parity; sw.js/panel.js/manifest untouched): expand only collapsed (`aria-expanded="false"`) or truncated (overflow button) groups; `scrape-tree`/`open-session` now async with a render-wait; open-session retries once after re-expanding (GUI collapses all groups after a session opens); overlay re-renders 450ms after expansion.
- H3: the in-panel "Add tabs" checkable list covers "select a browser tab".
- Reuses the existing sw.js engine (list-tabs/stage-tab/unstage-tab/add-staged/panel-state) — no new SW messages.
- Facilitator verification: verify.sh exit 0 (11/11, zero-light-hex holds) · bridge/test.sh 16/16 · sw.js mtime unchanged (no new SW messages) · old full-window overlay gone from content.js · H2 fix confirmed in scraper.js:227-283,570 · panel screenshot /tmp/task-h-panel.png shows the in-panel "Add tabs (2)" list. Worker gold test fresh profile 19/19.
- User: reload chrome-eye at chrome://extensions to see it live.
