# Brief C — T12.4 (research half): why does the GUI show "disconnected"? (READ-ONLY, no extension edits)

## Mission
Produce `scratch-t12/T12.4-findings.md` answering, with file:line citations:
1. Under exactly what conditions does the DSH GUI show its "disconnected" indicator?
   Which UI element shows it (which panel/section — so the user knows which "button" they
   saw)? What auto-recovery exists?
2. What does the extension break when bridge :3081 is down, and what does NOT break (the
   GUI iframe is same-origin to :3080 — is it truly unaffected)?
3. A concrete panel-side connectivity-status design recommendation for wave-2 implementer
   D (what to poll, how often, what texts, what affordance).
4. Live-state snapshot at your run time.

You edit NO extension files. You write ONE file: `scratch-t12/T12.4-findings.md`.

## Where to look (all READ-ONLY)
DSH client bundle tree (non-minified):
`/mnt/f/npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-*/lib/`
- `dsh-client-connection/lib/client.js` — state machine. `ConnectionState =
  'connected'|'disconnected'|'connecting'` (declared around L1695 of
  `dsh-cordis-client-runner/lib/client.js`). `emitState("disconnected")` at
  `dsh-client-connection/lib/client.js` L94 / L126 / L142; `reconnect()` with exponential
  backoff ~L60–221. For EACH emit: read the surrounding function, name the trigger
  (e.g. generation source unavailable, pump error, sink exception, WS close), and note
  whether reconnect is automatic and its backoff shape.
- `dsh-client-ui-settings-general/lib/client.js` L215–249 — indicator rendering:
  `if (connectionState === "disconnected") connectionIndicator = "disconnected"`,
  `disconnectedLabel: t("connection.error")`. Find WHERE this indicator is displayed in
  the GUI (which component/slot/section — grep for `connectionIndicator`,
  `disconnectedLabel`, `connection.error` across the `dsh-client-*` packages). That
  answers "which button did the user see".
- `dsh-client-connection/lib/index.js` ~L380–430 — auth gate (`isAuthenticated`,
  `writeUnauthorized` 401). Relevant context: a 401 to curl is EXPECTED (auth cookie),
  not a disconnect.
- Also grep the tree for what the GUI connects to: `/api` WebSocket endpoints,
  `events.mux`, reconnect loops, and any "connection" i18n strings in
  `dsh-client-locale` or similar — to state precisely what a "disconnected" GUI means
  (WS to its own :3080 host dropped? agent session ended? backend restarted?).

Extension side (read-only reference):
- `/mnt/f/ai/chrome-eye/extension/sw.js` — `SHARE_ENDPOINT = 'http://127.0.0.1:3081/share'`;
  which flows depend on the bridge (share, /api forwarding).
- `/mnt/f/ai/chrome-eye/bridge/bridge.mjs` — what the bridge proxies; confirm the GUI
  iframe NEVER needs the bridge (it talks same-origin to :3080 directly).
- `/mnt/f/ai/chrome-eye/CP-3.5.md` §2 (wire protocol) + §9 (T12 recon) for locked facts.

## Live-state snapshot (run and record in the findings file)
- `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3081/health` (000 = bridge down)
- `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3080/` (401 = backend UP + auth
  gate working; anything else = investigate)
- Note: the facilitator may restart the bridge as a managed background job; do NOT start
  or kill it yourself.

## Deliverable: `scratch-t12/T12.4-findings.md` structure
1. **Trigger table**: for each `emitState("disconnected")` call site — file:line, trigger,
   auto-recovery? (backoff details), user-visible effect.
2. **Which UI element**: where in the GUI the "disconnected" indicator renders (component,
   i18n label, location on screen). Map it to the user's "the button says disconnected".
3. **Bridge-down impact matrix**: what breaks (share, extension /api calls) vs what does
   not (GUI iframe, session data). Cite sw.js/bridge.mjs lines.
4. **Design recommendation for D**: panel status model — sources (bridge `:3081/health`;
   panel-frame GUI health via injected probe reading the GUI's own indicator DOM or a
   lightweight same-origin check inside the panel iframe), refresh triggers (panel load,
   SW start, `webNavigation.onCompleted` for the panel frame, ~10 s interval), status
   texts (e.g. "GUI ✓ bridge ✗", "GUI ✗ — reload?"), and the ↻ reload-iframe
   affordance. Keep it implementable in panel.js + sw.js only (no panel.html edits;
   no manifest changes; no new endpoints on the bridge).
5. **Live snapshot** at your run time (the two curl results + timestamps).
6. **Open questions** the facilitator/user must resolve.

## PERSIST-PROTOCOL (MANDATORY FIRST ACTIONS)
1. Create `scratch-t12/C-progress.md` (outline + NOT STARTED) — even though you edit only
   one file, persist first.
2. Work incrementally: append findings to T12.4-findings.md as each section is done, and
   update C-progress.md after each section. A crash must lose nothing.

## Acceptance (report in your final message)
- T12.4-findings.md exists with all 6 sections; every claim has file:line (or URL for
  live checks).
- The trigger table covers ALL `emitState("disconnected")` call sites in
  dsh-client-connection.
- No extension/* or bridge/* or DSH file was modified (state this explicitly).
- The design recommendation names exact functions to add in sw.js/panel.js.
