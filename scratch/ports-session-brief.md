# chrome-eye port + session-reload investigation — rtx subagent brief

## Context (facilitator-established, verified 2026-09-28)
chrome-eye = Chrome side-panel extension embedding the DSH web GUI.
- Panel iframe: `extension/panel.html` L514 → `http://127.0.0.1:3081` (bridge).
- Bridge `bridge/bridge.mjs` :3081 = full reverse proxy to `:3080` (attaches minted auth cookie; upstream Host always 127.0.0.1:3080).
- DSH GUI :3080 = `dsh web` (user's "web" profile).
- Extension NEVER talks to :3080/api directly (trust fence); only loopback :3081.

## User complaints
1. "chrome-eye is running taking up too many ports. It tries to start at startup, but I had to run dsh on port 3082 to open my harness."
   → chrome-eye auto-starts its own `dsh web` on :3080 at boot; if the user already runs a harness (e.g. this GUI, :3082) OR if :3080 is taken, the user is forced to pick another port. The user wants the extension stack to NOT squat on :3080 by default / to coexist.
2. "it wouldn't load the previous session I had up with that agent"
   → the GUI's "current session" (localStorage key `dsh.sessions.current`) does not survive a panel/GUI reload; the workspace/session the user left in is not restored.

## Verified current state (do NOT redo, just build on it)
- `:3080` = `dsh web` PID 474 (started Sep 27 20:56 by start-stack).
- `:3081` = bridge PID 1216 (Sep 27 20:57).
- `:3082` = `dsh web --port 3082` PID 1840 (the user's manual harness, Sep 27 20:59).
- `start-stack.sh` (repo root) = launcher: `exec node dsh web` (main, :3080) + supervised bridge loop (:3081). Port-guarded (exits if :3080 open).
- `~/.local/share/chrome-eye/autostack.sh` = @reboot cron wrapper (systemd user manager is broken on this WSL box). Launches start-stack.sh if :3080 is down.
- `~/.config/systemd/user/dsh-web.service` exists (unit runs start-stack.sh) — but user@1000.service fails at WSL boot, so the cron path is what actually runs.
- CRON: `crontab -l` → `@reboot /home/cztl/.local/share/chrome-eye/autostack.sh`.
- stack.log is FLOODED with: `bridge: port 3081 is already in use; stop the other bridge first.` → `stack: bridge exited (code 1) — restarting in 2 s` (infinite 2s loop). Root cause: the supervised bridge loop's `port_open` guard uses `timeout 3 node -e require('net').connect(...)`. On this WSL box a connect() to a CLOSED port hangs (no ECONNREFUSED) until TCP timeout, so the guard mis-detects "port open" and the bridge child exits code 1 every 2s forever. Meanwhile a SEPARATE manually-started bridge already holds :3081 (PID 1216), so the loop can never win it.
- `~/.dsh/sessions/--mnt-f-ai--/` = session store for workspace /mnt/f/ai (jsonl.zstd). Sessions exist; the problem is the GUI not RESUMING the last one.
- `~/.dsh/settings.yaml` agent-default-model = ollama-local/rtx (the 9B fast model). subagent-model-selection enabled, allowedModels = [arc/qwen3.8-27b-k4_xl-thinking, ollama-local/rtx].

## Your tasks (IN ORDER, persist after each)
### T1 — Port squat / auto-start
Diagnose and FIX so the chrome-eye stack:
  (a) does NOT force the user to pick a different port for their own harness;
  (b) stops the infinite 2s bridge restart loop (the stack.log flood);
  (c) is idempotent and safe if :3080 is already serving (someone else's dsh web).
Likely levers (verify before acting):
  - The bridge loop's `port_open`/connect-hang mis-detection (WSL). Make the guard robust (use `ss -ltn` parse or a real TCP handshake with a short connect timeout via node net with explicit `connect(1000)` timeout, not a bare connect that hangs).
  - Whether `start-stack.sh` should even own a `dsh web` on :3080, or whether it should ATTACH to an existing :3080 (if one is serving) and only START a bridge — i.e. "bring-your-own-GUI" mode so the user's harness (any port) + the bridge is the only thing chrome-eye needs.
  - Make the DSH GUI port configurable (env, e.g. `DSH_WEB_PORT` / `CHROME_EYE_GUI_PORT`) instead of hard-coded 3080, with a sane default, so the extension and the user's harness can coexist without collision.
  - Update autostack.sh + start-stack.sh consistently; keep both idempotent; keep the @reboot cron.
DO NOT kill the user's running processes (PID 1840 :3082 harness, PID 474 :3080, PID 1216 bridge) unless a clean restart of the chrome-eye-owned ones (474/1216 via start-stack) is clearly needed — prefer code fixes. If you must restart, do it via start-stack.sh and verify ports after.

### T2 — Session not restored on reload
Find where the DSH web GUI reads/writes the "current session" (`dsh.sessions.current` in the browser localStorage, origin :3080 — which the panel reaches via :3081 bridge). Determine why a reload of the panel/GUI does not resume the last active session for the user's agent.
  - Check if the bridge (:3081) proxies localStorage correctly (it should — it's a full reverse proxy, but verify the cookie/auth flow isn't causing a "new anonymous" session).
  - Check the DSH web app's session-restore logic (apps/web dist or the client-connection package under /mnt/f/npm-global/lib/node_modules/@deepseek-ai/dsh/). Find what triggers "resume last session" vs "new session".
  - Likely fix: the panel's iframe (origin :3081 via bridge) may be partitioned or treated as a fresh context, so `dsh.sessions.current` from the user's :3080/:3082 profile is not visible. Make the panel restore the user's last session.
Report the root cause + the exact fix you made (file:line).

## Constraints
- danger-full-access; approval prompts DISABLED — do NOT set sandbox_permissions, do NOT request escalation.
- Keep the trust fence: extension fetch only to :3081 (loopback bridge), never :3080/api.
- Wire protocol LOCKED (CP-3.5 §2); do not change the RPC wire.
- No manifest permission changes.
- Do NOT re-run `test/run.sh` (Check-1 flaky).
- Persist progress to `scratch/ports-session-progress.md` after each step (Log lines with timestamps).
- Final message MUST start with `DONE:` and list every file:line changed + how to verify.

## Verification you must include in DONE
- `ss -ltnp | grep 30` showing the final port layout.
- `tail -5 ~/.cache/chrome-eye/stack.log` showing NO new "port 3081 already in use" flood after your fix.
- For T2: the exact mechanism + a reproduction/verification step the user can run (reload the panel, confirm the last session's agent/workspace is back).
