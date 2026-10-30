# REQ: cookie capture when a tab is staged (DraftKings salary pipeline)

Status: **open** — extension-side work assigned to the chrome-eye build agent.
Filed: 2026-09-20 by the coordinator (NFL project).

## Why

The NFL project (`/mnt/f/ai/projects/nfl`) ingests DraftKings DFS salaries via
`src/ingest_salaries.py`, which needs the user's `DK_SESSION` cookie. The user is
logged into DraftKings in Chrome. Today the cookie is copied by hand (DevTools →
Application → Cookies). Goal: **when a draftkings.com tab is added as context
(staged in the side panel), the extension also captures that tab's cookies
(including HttpOnly) and hands them to a local receiver**, which persists the
cookie (mode 600, gitignored) and can optionally trigger the salary ingest.
Zero manual copy-paste.

## What already exists — do NOT rebuild, do NOT delete

### `bridge/dk-receiver.mjs` (written + tested by the coordinator, 2026-09-20)

Standalone loopback receiver on `127.0.0.1:3082`. Pure Node, zero dependencies,
same style as `bridge.mjs` (which it deliberately does not modify). Routes:
`GET /health`, `POST /cookie`, `OPTIONS`. Env overrides documented in its header
(`DK_RECEIVER_PORT`, `DK_COOKIE_ORIGINS`, `DK_COOKIE_FILE`, `DK_INGEST_CWD`,
`DK_AUTO_INGEST`).

Verified by test: health, valid POST (file written `0600` with
`DK_SESSION=...; other=...`), non-allowlisted origin → 403, empty cookies → 400,
preflight → 204, `run:true` spawn (see caveat below). Responses carry metadata
only (names, count, `DK_SESSION` expiry) — cookie values are never logged.

**Tested caveat (9p write visibility):** the spawn chain works end-to-end — a
spawned `python -m src.ingest_salaries` provably executed and read the cookie
file argument (its only failure was a test artifact: the test deleted the file
mid-run). However, one test run's child stdout + banner did not appear in
`dk-ingest.log` — suspected cross-process write visibility on the `/mnt/f` 9p
mount. **Recommended hardening (adopt or fix as you see fit):** spawn the ingest
with the cookie passed via the `DK_SESSION` environment variable (the script
supports it — `src/ingest_salaries.py` `load_cookie()`) instead of / in
addition to `--cookie-file`. Env inheritance crosses the 9p boundary with no
file-visibility dependency. Keep the 0600 file write as the persistent artifact
for manual runs.

### nfl side (reference, no work needed here)

- `src/ingest_salaries.py`: cookie via `--cookie` / `--cookie-file` / env
  `DK_SESSION`; `--seasons` defaults to the current year; 401/403 = expired or
  incomplete cookie → aborts (no retry); self-diagnosing parser.
- Cookie file location: `/mnt/f/ai/projects/nfl/data/keys/dk_session.txt`
  (gitignored).

## Requirements (extension side — the build agent's work)

### R1 — manifest.json
Add `"cookies"` to `permissions`. Add to `host_permissions`:
`"https://www.draftkings.com/*"` and `"http://127.0.0.1:3082/*"`.
(Keep existing entries; additive only.)

### R2 — sw.js: capture cookies when a tab is staged
Allowlist constant near `SHARE_ENDPOINT`:

```js
var COOKIE_RECEIVER_ENDPOINT = 'http://127.0.0.1:3082/cookie';
var COOKIE_ORIGINS = ['https://www.draftkings.com'];
```

When a tab is added to the staged list — **both** paths: panel-open auto-stage
and the "+" add flow — if the tab's origin is in the allowlist, call
`chrome.cookies.getAll({ url: tab.url })` (works on non-active tabs too, and
returns HttpOnly cookies — that is the point) and POST the result to
`COOKIE_RECEIVER_ENDPOINT` as `{ origin, cookies: [{name, value, httpOnly,
expirationDate}], run: false }`. Fire-and-forget: log failures, never block or
fail staging. Reference implementation:

```js
function captureAndSendCookies(tab) {
  var url = tab && tab.url;
  if (!isWebUrl(url)) return Promise.resolve(null);
  var allowed = COOKIE_ORIGINS.some(function (o) { return url.indexOf(o) === 0; });
  if (!allowed) return Promise.resolve(null);
  return chrome.cookies.getAll({ url: url }).then(function (cs) {
    var cookies = cs.map(function (c) {
      return { name: c.name, value: c.value, httpOnly: !!c.httpOnly,
               expirationDate: c.expirationDate };
    });
    if (!cookies.length) return { ok: false, reason: 'no cookies' };
    return fetch(COOKIE_RECEIVER_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ origin: new URL(url).origin, cookies: cookies, run: false })
    }).then(function (r) {
      return r.json().then(function (j) { return { ok: r.ok, meta: j }; });
    });
  }).catch(function (e) { return { ok: false, reason: String(e) }; });
}
```

### R3 — share payload: metadata only
Attach `cookieMeta` (per staged tab: `{origin, names, sessionExpires,
capturedAt}`) to the `/share` payload so the DSH session knows a cookie was
captured. **Cookie values must never enter the share payload or the model
context** — values go only to the loopback receiver.

### R4 — UI (optional, nice-to-have)
A 🎟 badge on the staged row when its cookie was captured.

### R5 — start-stack.sh
Start the receiver alongside the existing stack, e.g.:
`node /mnt/f/ai/chrome-eye/bridge/dk-receiver.mjs &` (match the script's
existing style; it binds 3082, exits cleanly on port conflict).

### R6 — security invariants (non-negotiable)
- Allowlist only: cookies are captured for `COOKIE_ORIGINS` origins and only.
  No blanket cookie capture for every tab.
- Cookie values are never logged anywhere (receiver already enforces this for
  its side; sw.js/panel.js must not log or display values either).
- Values travel only extension → `127.0.0.1:3082` → 0600 file → ingest script.

### R7 — explicit "save & ingest now" (v1: optional)
A second POST with `run: true` (e.g. a small button on the options page or a
panel action) triggers the ingest from the browser. For v1 it is acceptable to
leave the explicit trigger on the DSH side (the agent runs
`.venv/bin/python -m src.ingest_salaries --cookie-file data/keys/dk_session.txt`
once the cookie is fresh) and keep the extension to capture-on-stage only.

## Acceptance tests

- **A1** `curl http://127.0.0.1:3082/health` → `{"ok":true,...}`.
- **A2** Logged into draftkings.com in Chrome → open the side panel (auto-stages
  the active DK tab) → within seconds,
  `/mnt/f/ai/projects/nfl/data/keys/dk_session.txt` exists, mode `600`,
  contains `DK_SESSION=<real value>`.
- **A3** The `/share` payload for that tab carries `cookieMeta` with names only
  — no values. (R4: row shows the 🎟 badge.)
- **A4** Stage a non-allowlisted tab (e.g. google.com) → no POST to :3082
  (no new line in `bridge/dk-receiver.log`), no `cookieMeta`.
- **A5** Trigger a run (`run:true`) → `bridge/dk-ingest.log` gains the banner
  **and** the ingest's own stdout (week-progress lines); the nfl DB `salaries`
  table gains current-week rows. If the log shows only the banner or nothing,
  apply the env-var spawn hardening above and re-test.
- **A6** Log out / back in on DK (fresh session) → re-stage → cookie file
  updates to the new value and the ingest works again.

## Handoff prompt (paste to the build agent)

```
New requirement for Chrome Eye: /mnt/f/ai/chrome-eye/REQ-dk-cookies.md — read
it fully first. Goal: when a draftkings.com tab is staged as context, also
capture its cookies (HttpOnly included) via the chrome.cookies API and POST
them to the local receiver; the receiver persists the cookie and can trigger
the NFL salary ingest.

Already done, do not rebuild and do not delete: bridge/dk-receiver.mjs —
standalone, zero-dep, loopback 127.0.0.1:3082, tested (health/403/400/0600
file write/spawn all verified). Your work is the extension side only:
  R1 manifest: + "cookies" permission, + host_permissions
     "https://www.draftkings.com/*" and "http://127.0.0.1:3082/*"
  R2 sw.js: captureAndSendCookies(tab) on BOTH staging paths (panel-open
     auto-stage and "+"); reference snippet is in the REQ; fire-and-forget,
     never blocks staging
  R3 share payload: cookieMeta (names + expiry only) — cookie VALUES must
     never enter the share payload or any log
  R5 start-stack.sh: start dk-receiver.mjs (port 3082)
  R4/R7 (optional): 🎟 badge on staged row; explicit run:true button
Also adopt the 9p hardening note in the REQ (pass the cookie to the ingest via
the DK_SESSION env var when spawning — the python script supports it) if you
touch the spawn path; if you don't touch the receiver, leave it as-is.

Definition of done: acceptance tests A1–A6 in the REQ pass on this machine
with a real logged-in DraftKings tab; report results per test. Do not modify
bridge.mjs. Do not commit or log any cookie value anywhere.
```
