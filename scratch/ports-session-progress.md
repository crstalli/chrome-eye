# ports + session reload — progress log

## T1 (port squat / auto-start) — code done
- start-stack.sh: CHROME_EYE_GUI_PORT/CHROME_EYE_BRIDGE_PORT env (defaults 3080/3081);
  new port_listening() via `ss -ltn` parse; port_open() = ss parse + node net.connect
  with explicit timeout:1500; start_bridge() adopts externally-held bridge (no more
  infinite 2s restart loop); idempotent GUI-attach mode (GUI already serving →
  bridge-only, exit 0, no second dsh).
- autostack.sh: rewritten, same robust port_open, @reboot cron untouched.
- bridge.mjs: UPSTREAM_PORT/PORT now env-configurable (defaults unchanged).

## T2 (session not restored) — root cause confirmed
- dsh-client-store createSnapshotStore({persist:{name}}) uses real
  localStorage.getItem/setItem under the key name (confirmed in live index.js bundle,
  helper `j6`). Key: `dsh.sessions.current`, value {sessionId, subagentAddress?}.
- ClientSessions (api-session.js L2278): on boot reads that key; if sessionId
  present → SessionManager.selected → projectList() → followCurrent() → session.open()
  (pulls history window). Restore logic exists and is correct.
- Root cause: Chrome partitions localStorage per ORIGIN. Panel iframe loads from
  127.0.0.1:3081; user's GUI usage writes the key on 127.0.0.1:3080 (or :3082).
  The :3081 origin's localStorage is empty on first load → restored.sessionId
  undefined → no current → new session instead of resume.
- Note: the app does NOT auto-pick the most-recent session (only follows a stored
  selection), so a fresh :3081 origin always starts with no current.

## T2 fix — CODE COMPLETE, verified in mock (2026-09-28 12:19)
Design (final):
1. bridge.mjs:
   - GET /session-seed route: `?id=` → seed script for that id; else resolve
     most-recent session via POST /api/session/list (unary RPC, minted cookie,
     max updatedAt) → seed script; none → 404 JSON.
   - Seed script = one-line IIFE: only writes dsh.sessions.current when the
     :3081 cell is empty (never clobbers a user-chosen panel session).
     Served text/javascript, no-store, CORS.
   - forward() buffers GET / 200 text/html, injects
     `<script src="/session-seed"></script>` before </head> (absolute path,
     idempotent, content-length deleted), logs the rewrite.
   - Diagnostics: log every seed resolution (id truncated to 24 chars).
2. content.js:
   - GUI_ORIGINS = {3080, 3081}; GUI-session duty (watchGuiSession poller +
     SW handler) now runs on BOTH origins (so SW guiSessionId also tracks the
     panel iframe's session).
   - New postMessage channel (all origins): seed-check (debounced, 50ms)
     replies with the frame's own dsh.sessions.current id; seed-write (debounced,
     100ms, only-when-empty write, replies ok); seed-reload (location.reload()).
     Replies via window.parent.postMessage('chrome-eye-hook', '*') — safe: only
     the extension panel can host the frame, payload is an id the panel holds.
3. panel.js:
   - On every iframe load (+ immediate kick if already loaded): post seed-check
     after 400ms (content script attach time). Result with id → done (GUI
     restores it on this load). Empty → resolveSeedId (last-seen, else
     fetch /session-seed?probe=1 and regex sessionId out of the script) →
     seed-write → 80ms → seed-reload. Round-gated, one in-flight.

Mock verification (node, mock upstream on :3980, real bridge.mjs on :3981):
- GET / → HTML contains exactly one `<script src="/session-seed">` before </head> ✓
- 2nd rewrite pass idempotent (returns null) ✓
- GET /session-seed → 200 text/javascript with the LATEST session id (max
  updatedAt of 2 mock items) ✓
- GET /session-seed?id=... → 200 with explicit id ✓
- No unhandledRejection (removed cancel() on already-consumed fetch body) ✓

## STATUS — remaining
- Stack NOT yet restarted: running bridge PID 1216 is OLD code; env ports +
  seed route need a bridge restart. Do it via start-stack.sh (attach mode:
  :3080 already serving → adopt/restart bridge only, exit 0).
  NOTE: start_bridge() adopts an EXTERNALLY-held :3081 — so the old bridge
  must be killed (kill 1216) BEFORE running start-stack.sh, or the new code
  never starts. (Brief permits replacing the running bridge via a clean
  start-stack.sh restart; do NOT touch :3080 PID 474 or :3082 PID 1840.)
- After restart: ss -ltnp | grep 30 ; tail -5 ~/.cache/chrome-eye/stack.log
  (no 2s restart flood) ; curl bridge / + /session-seed.
- In-panel postMessage path (content.js/panel.js) needs the user to reload
  the extension in chrome://extensions — cannot be curl-tested.
- Extension code changes require extension reload; bridge changes need bridge
  restart.
- Wire protocol unchanged; no manifest permission changes; trust fence intact
  (extension fetches only :3081).
