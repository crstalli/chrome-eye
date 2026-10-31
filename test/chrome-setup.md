# Chrome Eye — local headless Chrome test setup

`bash test/run.sh` runs the full test harness against a **local** headless
Chrome on this WSL host. No podman/docker is required (the original
`test/docker/Dockerfile` approach is kept for reference only).

## Run

```bash
bash /mnt/f/ai/chrome-eye/test/run.sh
```

Expected result (observed, 3 consecutive runs):

- exit code `0`
- check 1 (extension service worker + content script): **PASS**
- check 2 (capture round-trip): **SKIP** — expected: `extension/content.js`
  is still a stub and produces no extraction response
- check 3 (panel UI at 400px): **PASS** — bottom bar rendered
  (`{"h":61,"w":400}`), iframe loads the real DSH GUI on `:3080`,
  no horizontal scroll (`{"sw":400,"cw":400}`)
- summary line: `5 pass, 0 fail, 1 skip` → `test/out/report.json` +
  `test/out/panel-400.png`

## Components

| Piece | Location | Notes |
|---|---|---|
| Chrome binary | `test/chrome/chrome-linux64/` | **Google Chrome for Testing 152.0.7977.82** (linux-x64) |
| Shared libraries | `test/chrome-libs/usr/lib/x86_64-linux-gnu/` | extracted from debs (see below); `LD_LIBRARY_PATH` is set by `run.sh` |
| Fixture server | `test/server.mjs` | serves `test/fixture/` on `:3456` |
| CDP harness | `test/harness.mjs` + `test/cdp.mjs` | unmodified project files |
| CDP HTTP proxy | `test/cdp-proxy.mjs` | new, run-side shim; see below |
| Orchestrator | `test/run.sh` | starts everything, wires ports, cleans up |

## Library dependencies (no sudo on this host)

System packages could not be installed (no sudo, approval prompts disabled),
so the three required debs were downloaded and extracted into
`test/chrome-libs/` (only the `.so` payload, no system modification):

- `libnspr4_4.38.2-1ubuntu1_amd64.deb` → `libnspr4.so`, `libplds4.so`
- `libnss3_3.120-1ubuntu2_amd64.deb` → `libnss3.so`, `libnssutil3.so`,
  `libsmime3.so`, `libssl3.so`, `libnssckbi.so`, `libnssdbm3.so`,
  `libfreebl3.so`, `libfreeblpriv3.so`, `libsoftokn3.so`, `libplc4.so`
- `libasound2t64_1.2.15.3-1ubuntu1_amd64.deb` → `libasound.so.2`

(`run.sh` exports `LD_LIBRARY_PATH=test/chrome-libs/usr/lib/x86_64-linux-gnu`.)

## Ports

| Port | Owner |
|---|---|
| 3456 | fixture server |
| 9223 | Chrome's real `--remote-debugging-port` |
| 9222 | `cdp-proxy.mjs` — the endpoint the harness is pointed at |

## The about:blank swap race (why `cdp-proxy.mjs` exists)

Measured with a CDP observer attached alongside the real harness flow:

- t0: the new panel target appears in `/json` (i.e. the `PUT /json/new?…`
  response is generated). Note the `/json` entry already reports the
  *requested* URL (`panel.html`) — but the tab's actual document is still
  `about:blank`, and `about:blank` already has `readyState === "complete"`.
- t0+16ms: the harness's first `readyState` poll → sees
  `complete`/`about:blank` → `waitFor` exits immediately → the
  `#bottom-bar` evaluation runs against `about:blank` → `null` → FAIL.
- t0+39ms: the document actually swaps to `panel.html` (readyState
  `loading`), `interactive` at +68ms, `complete` at ~+1100ms.

The harness's first poll lands ~23ms **before** the swap, so the race is lost
every time. Warming the panel target first was tried (open-then-close and
leave-open variants) and does not beat this gap — and a leave-open warm
target even breaks the 400px scroll check (its iframe renders at 500px).

`test/cdp-proxy.mjs` is an HTTP-only CDP shim (no WS framing — response
bodies pass through unchanged, so every `webSocketDebuggerUrl` still points
straight at `:9223` and all WebSocket traffic bypasses the proxy):

- `GET /json`, `/json/list`, `/json/version`, `PUT /json/close/<id>` →
  forwarded as-is.
- `PUT /json/new?<url>` (url ≠ `about:blank`) → forwarded, then the
  response is **held** until a short-lived CDP connection to the new target
  confirms `location.href === <url>` (10ms poll, 15s cap). Only then is the
  original 200 body returned.

Observed hold times: +46ms, +50ms, +53ms. After release the harness's first
poll sees the real panel document (`loading` → waits out `complete` within its
20s budget → `#bottom-bar` found) — deterministic either way.

## Other run.sh workarounds (this host)

- **Crashpad SIGTRAP (exit 133)** on first launch: fixed with a writable
  `CHROME_CONFIG_HOME=$ROOT/test/.chrome-test/config` (root fs and `$HOME`
  are read-only here).
- Fresh `--user-data-dir` under `test/.chrome-test/udata` on every run
  (wiped + recreated); no `--no-sandbox` issue thanks to it, but
  `--no-sandbox --disable-gpu --disable-dev-shm-usage` are still passed for
  WSL headless robustness.
- `run.sh` cleanup kills the proxy, the fixture server, and Chrome by
  pattern; all scratch (chrome log, proxy log, udata, config) lives in
  `test/.chrome-test/`.
