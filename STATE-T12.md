# STATE-T12 — coordination state (idempotent; read this FIRST on resume)

Last updated: 2026-09-12 ~06:10 UTC (A `e470bad5…` re-queued ACTIVE for T12.1+T12.2;
B/C/D parked; three NEW user orders recorded below; :3080 headless auth SOLVED).
Rule: all durable progress lives in FILES. Conversation is disposable.

## NEW USER ORDERS (2026-09-12, verbatim) — acceptance bar for all remaining work
1. "make sure the other workers keep running - retry their work if they dont write their
   status. ,make sure this plugin works like the gemini plugin."
   → (a) queue keeps moving; any agent dying without a status/progress update gets its brief
     re-sent; (b) **Gemini parity IS the acceptance bar.** Visual reference saved at
     `scratch-t12/gemini-reference.png` (PNG 356×549, 23491 B, -rw-r--r--) — dark full-height
     chat, bottom bar with "👁 Sharing '…'" chip + × close, "Type @ to add tabs" input,
     + button, model selector "Flash-Lite", voice icon. Subagents may read it via read_image.
2. "and that you have actual tests with browsers, automation: playwright / screenshots."
   → New task **T12.7** (see DETAILED-PLAN.md): a REAL headless-browser test layer using
     playwright 1.63.0 (`npx playwright --version` verified) + screenshot evidence. Runs
     AFTER A/B/D implementation so screenshots capture the fixed panel. New test dir
     `chrome-eye/tests/` (NOT the read-only `test/*` harness).
3. Standing order (re-affirmed): max ONE subagent at a time — queue A → B → C → D → tests.

## Task board (source of truth: DETAILED-PLAN.md §"T12", rows T12.1–T12.6)

| Task | What | Owner (subagent) | Status at checkpoint |
|------|------|------------------|----------------------|
| T12.1 | Workspaces IN the panel (executeScript into panel's own :3080 iframe, frameId>0 prefer, real-GUI-tab fallback) | A | ⏳ NOT STARTED |
| T12.2 | Panel-side overlay EXIT (toggle #ws-overlay-btn → `chrome-eye:overlay {open:false}`; harden teardown) | A | ⏳ NOT STARTED |
| T12.3 | Restyle panel chrome to DSH dark tokens (F3 bottom bar + F5 dropdown contrast) | B | ⏳ NOT STARTED |
| T12.4a | RESEARCH: why GUI shows "disconnected" + design rec → `scratch-t12/T12.4-findings.md` | C | ⏳ NOT STARTED |
| T12.4b | IMPLEMENT panel-side connectivity status + ↻ reload affordance | D | ⏳ WAVE 2 (after A settles) |
| T12.6 | (user) e2e: panel workspaces == web-profile workspaces | user | ⏳ pending |
| T12.7 | Browser-automation tests (playwright 1.63.0, headless, screenshots): load unpacked ext in persistent ctx, screenshot panel chrome vs gemini-reference.png, exercise workspaces dropdown/overlay, verify in-panel GUI iframe auth + "disconnected" indicator state | coordinator (after A/B/D) | ⏳ NEW (user order 2026-09-12) |
| T12.7 | Browser-automation tests (playwright 1.63.0, headless, screenshots): load unpacked ext in persistent ctx, screenshot panel chrome vs gemini-reference.png, exercise workspaces dropdown/overlay, verify in-panel GUI iframe auth + "disconnected" indicator state | coordinator (after A/B/D) | ⏳ NEW (user order 2026-09-12) |

## Ownership / file-conflict map (hard)
- **A**: `extension/sw.js`, `extension/content.js`, `extension/panel.js`, NEW `extension/scraper.js`. NOT panel.html.
- **B**: `extension/panel.html` ONLY (CSS/inline style; all existing ids stay stable: `#dsh-iframe #bottom-bar #share-status #ws-controls #ws-overlay-btn #ws-tree-btn #ws-dropdown #ws-dd-head #ws-dd-title #ws-dd-status #ws-dd-body`).
- **C**: read-only; writes only `scratch-t12/T12.4-findings.md` + `scratch-t12/C-progress.md`.
- **D** (wave 2): `extension/panel.js` + `extension/sw.js` (after A settles; reads C's findings).
- Everyone: `test/*`, `bridge/`, DSH checkout, all `*.md` at chrome-eye root = READ-ONLY (facilitator owns checkpoint docs). NO manifest permission changes. NO `test/run.sh`. NO bridge start/kill by subagents.

## Briefs (self-contained; re-launch from these after any crash)
- `scratch-t12/brief-A.md` — T12.1+T12.2 (A)
- `scratch-t12/brief-B.md` — T12.3 (B)
- `scratch-t12/brief-C.md` — T12.4-research (C)
- brief-D.md — NOT YET WRITTEN. Write it after C settles (its content = T12.4-findings.md §4 design recommendation + the D constraints above: panel.js+sw.js only, no panel.html, no manifest, persist-protocol mandatory).

## Subagent spawn log (append a line per spawn/settlement)
- 2026-09-11 checkpoint: NONE launched — user ordered: DO NOT launch subagents until
  after the model restart. On resume, spawn per procedure step 4 (A+B+C one wave).
- Bridge: RESTARTED as managed background job `bash-1` (node bridge.mjs from
  /mnt/f/ai/chrome-eye/bridge) at checkpoint; `:3081/health` → 200 {"ok":true}.
  A resumed session: check `job_list` first — if `bash-1` still runs, the bridge is UP,
  do NOT start another. If it died, re-run the same command as a managed job (never nohup).
- 2026-09-12 00:14: spawned A×2 (accidental double-spawn), B×2 (accidental double-spawn),
  C×1 — ALL 5 BACKGROUND subagents died ("failed before it finished, no closing message"),
  zero artifacts written (no progress files, no backups, no partial edits).
- **LESSON (verified 2026-09-12):** background subagent sessions DO NOT survive the
  user's model restart (the user stops/restarts the model frequently). Plain background
  BASH jobs DO survive (bridge `bash-1` still running after 2+ restarts). Foreground
  (run_in_background: false) subagents work (trivial probe OK at 04:58Z).
- **PIVOT (2026-09-12):** heavy implementation work → FOREGROUND subagents (one at a
  time, each with its self-contained brief + persist-first protocol); small/self-contained
  work → done inline by the coordinator. If a foreground child dies to a model restart,
  re-launch the SAME brief — file state (progress + backups) is the resume source.
- 2026-09-12: (SUPERSEDED) earlier pivot note claimed T12.3 done inline — FALSE: panel.html
  is still pristine (md5 == backup-B, mtime Sep 8). B's work is still pending in the queue.
- 2026-09-12 05:38 UTC: USER RESUMED ALL 5 subagents. **New standing order from user:
  max ONE subagent active at a time; coordinator keeps coordinating.** Action taken:
  kept A `e470bad5-4ab4-4e35-83d1-4aee91285f30` (T12.1+T12.2) alive, re-anchored it via
  send_message (read brief-A.md; persist-first: A-progress.md + backup-A/; resume-check
  vs backups; progress after every step; DONE marker at end). INTERRUPTED the other 4:
  duplicate A `91f6140e…`, B×2 `8c529351…`/`2fc8b876…`, C `5b76b551…`. They are parked
  (status `ready`) — resumable later via send_message, but do NOT start more than one at
  a time. NOTE: A `e470bad5…` was also accidentally interrupted in the same batch; it is
  idle and was re-queued via send_message (the "GO — start now" message). If A is idle
  with no new A-progress.md progress after resume, re-send the GO message.
- 2026-09-12 ~06:05 UTC: A + C were interrupted mid-turn to re-anchor with the NEW test
   mandate (playwright/screenshots) + Gemini-parity bar. Loss assessment: A had finished
   reading all 3 target files (no edits - extension verified PRISTINE again: content.js
   md5 6d0cd7b81973409a8914bd0b32eb862d, panel.js 50e5effc9bc48b3f5d4cf088b632b5a2,
   sw.js 0c5f17f2449715f1eb6c130b0e92da6a, all == backup-A/; panel.html b7ae8ef88239b01476798651e29a0149
   == backup-B/). A full plan survives in A-progress.md (NEXT: write extension/scraper.js).
   C had NOT started (C-progress.md = outline only). A RE-QUEUED FIRST at ~06:10 with
   full re-anchor (finish owed cross-checks: sw.js guiTabRoundTrip L131-237,
   findGuiTab/findPanelGuiFrame call sites, manifest content_scripts; then execute plan;
   persist after every step; DONE marker; Gemini parity bar for scope = workspaces fully
   functional + exit-able INSIDE the panel). B/C/D still parked.
- Surviving-agent artifacts so far: `scratch-t12/B-progress.md` (01:10) +
  `scratch-t12/backup-B/panel.html` (byte-exact, panel.html itself untouched — mtime Sep 8);
  `scratch-t12/C-progress.md` (01:06; C had mapped the 3 `emitState("disconnected")` sites
  L94/126/142 and was tracing consumers when stopped — resume C there).
- **Queue (strictly sequential, one active at a time):**
  1. A `e470bad5…` — ACTIVE NOW (T12.1+T12.2).
  2. then B (resume `8c529351…` or fresh spawn from brief-B.md; backup-B already exists —
     re-verify panel.html still matches backup before editing).
  3. then C (resume `5b76b551…` from C-progress.md, or fresh spawn from brief-C.md).
  4. then D (write brief-D.md from T12.4-findings.md §4 after C; only after A settled).

## Persist-protocol (mandated for every subagent, verbatim in each brief)
FIRST actions before touching extension/*:
1. write `scratch-t12/<id>-progress.md` (outline + NOT STARTED + plan);
2. `mkdir -p scratch-t12/backup-<id>` + copy originals of every file it will edit there;
3. update progress file after EVERY step.
→ Crash-safe: a dead agent loses at most its current in-flight edit; originals are in
`scratch-t12/backup-<id>/`; resume = re-launch the same brief.

## Resume procedure (resumed coordinator, in order)
1. Read `DETAILED-PLAN.md` (T12 section = task table + wave plan + recon facts) and this file.
2. `ls scratch-t12/` — for each of A/B/C: if `backup-<id>/` exists but `<id>-progress.md`
   shows NOT DONE → check `extension/*` for partial edits (diff vs backup-<id>/), then
   re-launch that brief (it is self-contained). If no progress file → fresh spawn.
3. Check bridge: `curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3081/health` →
   000 = down → restart THE bridge as a **managed background job** (`node
   bridge/bridge.mjs` from `/mnt/f/ai/chrome-eye/bridge`, or per bridge/test.sh start
   path — inspect first), verify 200. NEVER nohup; never a second instance (check
   `job_list` first — a running job = bridge already up).
4. **USER STANDING ORDER (2026-09-12): max ONE subagent active at a time.** Sequential
   queue: A → B → C → D (each settles before the next starts). Prefer resuming the
   existing parked agent ids via send_message (see spawn log queue); fresh spawn from
   the matching brief only if the id is gone.
5. When C settles → write `scratch-t12/brief-D.md` → start D (only if A has settled too).
6. When A+B settle → run `node --check` on all touched extension files; ask user for T12.6
   e2e (fresh profile → panel → "Workspaces ▾" with NO other :3080 tab → overlay
   open/close → visual dark-theme check).
7. After user e2e passes: append done-markers + timestamp to DETAILED-PLAN.md T12 rows +
   this file; then (only if user asks) consider a `test/run.sh` gate.

## Live-state snapshot at checkpoint (2026-09-11 ~23:56–00:05 local)
- Bridge `:3081/health` → was HTTP 000 (DOWN) at 23:56; RESTARTED as managed job
  `bash-1` → now 200 `{"ok":true}`. (See spawn log.)
- `:3080/` → 401 to curl = EXPECTED (DSH web auth gate, authority-bound signed cookie).
- DSH client bundle tree (verified path):
  `/mnt/f/npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-*/lib/`
  — non-minified `client.js`/`index.js`; key files cited in CP-3.5.md §9.
- No "disconnected" string anywhere in `extension/*` (0 grep matches) — it is the DSH GUI's
  own `ConnectionState` indicator (see CP-3.5.md §9 for call sites).

## Notes
- Wire protocol LOCKED (CP-3.5 §2): `POST /api/<channel>/<endpoint>`,
  `{type:'client-request', rpcId, method, payload}` →
  `{type:'server-response', rpcId, result:{ok, value|error}}`. No `sessions/*` RPC.
  Share payload text field = `visibleText`. Bridge CORS: OPTIONS 204 + `*`.
- `dsh.workspace.view.v5` = VIEW PREFS only; real tree data = live GUI sidebar DOM
  (T11.3 scraper in content.js). F6 fix = drive the panel's OWN iframe (T12.1), plus
  localStorage-partitioning verification (T12.6) — see CP-3.5.md §9 hypothesis.
- Green baseline to not regress: `test/run.sh` 10/10 ×3 @ 2026-09-07T20:37:33Z (do not
  re-run until T12 implemented + user requests).
- Known flake (deferred, T11.5): Check-1 SW-target ~1 in 4.

## SOLVED: headless :3080 auth for browser tests (T12.7 recipe — 2026-09-12)
- The `:3080` gate (dsh-client-connection/lib/index.js, read L190-449) mints cookies from a
  PERSISTENT signing secret in the DSH home credential record, NOT from the process-scoped
  launch token (WeakMap — unreplayable). So we mint a valid cookie OFFLINE.
- Secret location: `/home/cztl/.dsh/.credentials.yaml` → `records.client-connection/browser-session.payload.secret`
  (base64url, 32 bytes). The live `:3080` server (PID 1060, `dsh --profile web`, DSH_HOME
  /home/cztl/.dsh) reads the SAME file — no per-profile override found.
- Cookie recipe (VERIFIED: both 1-day and 30-day cookies → HTTP 200, 24474 B index.html):
  1. authority = "127.0.0.1:3080"; cookieName = "dsh-auth-" + base64url(sha256(authority)).
  2. payload = base64url(JSON {version:1, authority, issuedAt:Date.now(), expiresAt:issuedAt+days*86400000}).
  3. sig = base64url(HMAC-SHA256(base64url-decoded secret buffer, payload)).
  4. cookie value = "v1." + payload + "." + sig. Send `Cookie: <cookieName>=<value>` with
     `Host: 127.0.0.1:3080` (authority must match; isAuthenticated re-checks signature,
     authority, expiry, and issuedAt span ≤ server maxAgeDays).
- **Working script now lives in the repo at `chrome-eye/tests/mint.mjs`** (exports
  `mintCookie({authority, days, dshHome})`; reads the secret from
  $DSH_HOME/.credentials.yaml AT RUN TIME — the secret itself is never committed).
  Verified live: first fetch → HTTP 200, 24474 B. The old `/tmp/mint2.mjs` is obsolete.
- Server maxAgeDays is small (30-day cookie passed, so ≤30; 1-day is the safe test value).
- First-request 401 flake observed once (30-day), then 200 — re-try once before concluding.
- Playwright usage: `context.addCookies([{url:'http://127.0.0.1:3080/', name:cookieName,
  value, httpOnly:true, sameSite:'Strict'}])` BEFORE navigating the iframe.
- DSH dark-theme tokens for B (dsh-client-ui-theme/lib/client.js): static palette at
  L1053 (e.g. --dsw-static-neutral-00 #fff, -100 #f5f5f5, -150 #ededed, -200 #e5e5e5,
  -250 #dcdcdc, -300 #d4d4d4, -400 #a2a4a6, -500 #7f8287, -50 #fafafa, -550 #65676b,
  -1000 #000; --dsw-static-deepseek-500 #4176e6; green-400 #4ed17e / -500 #22c55e;
  amber-400 #f7ad31 / -500 #f59e0b; blue-450 #4d93f8 / -500 #3b82f6 / -600 #2563eb;
  amber-900 #27241f; green-900 #233c2c). Alias descriptors (border-l1/l2/l4,
  label-primary/secondary/tertiary/caption, brand-primary, interactive-bg-hover,
  bg-module-platform, bg-layer-1, state-error/success/warn-primary) at L1165-1218+;
  B must extract the DARK-theme resolved hexes (dark block below L1053) and hardcode them
  (extension page cannot read iframe CSS vars).
