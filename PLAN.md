# Chrome Eye — Plan & Checkpoints (v2: embed model)

**This file is the persisted checkpoint.** After any restart: read this file top-to-bottom,
skip §5 (already verified — do not re-run those checks), and continue at the first `pending`
checkpoint. Do not re-explain established context to the user.

**Status:** CP-3 approved — building (2026-07-02). CP-1–CP-4 done (T4.8 + Windows-side
T5.x/T9.x deferred to the end — user present). CP-6 ✅ COMPLETE (harness GREEN 10/10 ×3,
exit 0, report 2026-09-07T20:37:33Z). CP-7 bridge DONE
(bridge/bridge.mjs + test.sh, ALL PASS, 16 checks). CP-8 DONE (options.js + README.md).
Test infra DONE (test/chrome + test/chrome-libs + cdp-proxy.mjs). CP-9 (Windows) deferred to the end.

**Troubleshooting reference (user-specified):** if stuck, consult
https://github.com/Lum1104/dsh-browser (sanctioned repo for DSH client/browser questions,
esp. wire injection at CP-7).

**Testing strategy (settled 2026-07-02):** podman is permanently dead in this WSL
(setuid-nobody newuidmap + no_new_privs blocks sudo) — abandoned. Use a local
chrome-for-testing **full** `chrome` binary (`--headless=new`; headless-shell/legacy do NOT
run MV3 service workers) in `/mnt/f/ai/chrome-eye/test/chrome/`, missing libs extracted via
`dpkg -x` from archive.ubuntu.com (resolute) into `test/chrome-libs/` + `LD_LIBRARY_PATH`,
run with `--no-sandbox`. See `test/chrome-setup.md`. User's Windows Chrome is reserved for
manual CP-9 end-to-end (deferred to the end).

**North star (user's words):** embed the DSH GUI itself into the extension — "If I open 2
browsers, it shares the context. That's pretty much what I would like to do." The extension
adds page access (screenshot + text of the active tab) on top of the real GUI.

Additonal  requirements

- User should have the ability to select session, model, permissions, and commands just like dsh UI.

- Input and status of a prompt should be visible in dsh stand alone UI as well as the extension, assuming they are operating in the same session.
	- it should be streamed to both places. 


---

## 1. Design (v2)

```
Windows Chrome — "Chrome Eye" side panel (Gemini-style, bottom actions bar)
  └─ extension page iframes  http://127.0.0.1:3080   ← the REAL DSH GUI
        (same backend as desktop browser → shared session context, for free)

"Share this page" (bottom actions)
  └─ content script: visible text ≤120k chars, ≤200 links {t,h}, ≤60 headings {level,t},
     url, title  +  chrome.tabs.captureVisibleTab → PNG
  └─ service worker POSTs to  Node bridge  127.0.0.1:3081
        └─ bridge forwards to DSH /api as plain Node request (no Origin header → passes fence)
              └─ page context lands in the active DSH session (the one I'm in)
```

- **MV3 extension**, pure files, loaded unpacked from `F:\ai\chrome-eye\extension`.
- **No DSH modification.** The iframe loads the GUI unmodified (no anti-iframe headers — §5.1).
- **Bridge** = minimal Node loopback proxy (WSL), forwards HTTP + WS upgrades to
  `127.0.0.1:3080`, strips/omits `Origin`. Needed only because the trust fence (§5.3)
  rejects extension-originated `/api` calls; the iframe's own traffic passes untouched.
  Bridge protocol = the DSH wire protocol itself (reuse `dsh-client-connection` client code —
  do NOT guess REST routes; gateway is Typert Remote over Cordis, §5.4).
- **MVP for share** (fallback; wire injection is SOLVED — CP-3.5 §7(b) — but sw.js sends no
  sessionId yet): bridge writes the capture to `/mnt/f/ai/chrome-eye/captures/` and I read it; chat
  continues in the embedded GUI.

## 2. Checkpoints

| CP  | What                                                                                      | Status                     |
| --- | ----------------------------------------------------------------------------------------- | -------------------------- |
| 1   | Feasibility audit (iframe-ability, multi-client, trust fence, wire protocol)              | **done** — evidence §5     |
| 2   | Rewrite plan to embed model (this file)                                                   | **done**                   |
| 3   | User reviews & approves plan                                                              | **done** — approved 2026-07-01 |
| 4   | Extension skeleton: manifest, side-panel page iframing `http://127.0.0.1:3080`            | **done** — manifest + panel.html + options.html (stubs) |
| 5   | Verify: GUI loads in panel, responsive at ~400px, same session visible as desktop browser | **done** — harness check 4 (WSL chrome) executed, test/run.sh green |
| 6   | Tab-context extraction (content script) + `captureVisibleTab` screenshot                  | **✅ done** — harness GREEN 10/10 ×3 (2026-09-07); all 6 checks execute, check 3 = real sw↔content round-trip vs fixture |
| 7   | Bridge + share-page injection into the session via wire protocol (or captures/ fallback)  | **done** — bridge/bridge.mjs + test.sh ALL PASS (16 checks); /share injects when sessionId present, else captures/ fallback |
| 8   | Options page (server URL, connection test) + README                                       | **done** — options.js (storage + connection test) + README.md |
| 9   | Windows end-to-end: load unpacked, share a page from Chrome, I see it in this session     | **DEFERRED to the end** (needs user present) |

## 2A. T11 — Gemini-style integration (user request 2026-09-08)

**User constraint (verbatim):** "settings/UI should only be present when the extension is being used. It should not completely change the DSH harness."

- T11.1 sessionId → /share → session.prompt (queue mode) wiring — **IN PROGRESS** (sub-agent active)
- T11.2 context chips inside the GUI — current tab auto-added as chip with ✕, "+" tab picker, chips added to the viewed session for the next prompt — pending
- T11.3 always-present workspace-tree dropdown in the panel (extension-side; reads GUI state; NO DSH harness changes) — pending
- T11.4 (stretch) workspace/settings overlay above the GUI chat window (div class pattern `Md3f7G_root`) — dropdown (T11.3) is the guaranteed floor
- T11.5 check-1 harness retry fix (test/harness.mjs)
- T11.6 remove the always-present "Share this page" bottom-bar button (absorbed into T11.2 chips)

## 3. Layout (to be created after CP-3)

```
/mnt/f/ai/chrome-eye/
  PLAN.md            ← this file (checkpoints)
  extension/
    manifest.json    MV3, side_panel + activeTab + scripting + storage + host perms http://127.0.0.1:3080/* + :3081/*
    panel.html/js    wrapper page: <iframe src="http://127.0.0.1:3080"> + bottom actions bar
    content.js       page extraction
    sw.js            service worker: capture + POST to bridge
    options.html/js  server URL + test button
  bridge/
    bridge.mjs       pure-Node loopback proxy :3081 → :3080 (HTTP + WS upgrade, no Origin)
  captures/          MVP fallback drop zone
  README.md          Windows load steps
```

## 4. Process rules (binding)

1. Plan reviewed and approved by user **before** any code (CP-3 gate).
2. Gemini-style UI: side panel, bottom actions toggle; per-action confirm on destructive ops.
3. Deep DSH integration — the chat surface IS the DSH GUI; no standalone LLM backend.
4. Screenshot + text when model supports vision; text-only fallback.
5. Resume silently: no re-explanation after restart.

## 5. Verified facts (do NOT re-verify)

1. **No anti-iframe headers.** Whole-tree grep for `x-frame-options|frame-ancestors` across
   the DSH checkout `lib/` + all `node_modules/@deepseek-ai/*` → zero matches.
   `127.0.0.1` is potentially trustworthy → extension page iframing plain-HTTP loopback is
   not mixed-content-blocked.
2. **No single-client lockout.** Greps (`multiple client|second client|concurrent client|
   already connected|client limit`) across `dsh-host-webserver`, `dsh-client-connection`,
   `dsh-session-projection` → no matches. Second GUI client attaching = shared context.
3. **Trust fence — implementation read** (`dsh-client-connection/lib/index.js:184`,
   `isTrustedApiRequest`). Rules: Host must be loopback or `trustedHosts`;
   `sec-fetch-site: cross-site` → reject; **no Origin header → pass**; Origin present →
   `new URL(origin).host` must equal Host's host. Consequences:
   - **Iframe GUI passes everything** (incl. WS upgrades): inside the iframe the origin is
     `http://127.0.0.1:3080` = same host as Host header.
   - **Extension service-worker fetches to `/api` fail 403** (`Origin: chrome-extension://<id>`
     ≠ host, plus cross-site marker). Settled, not open: extension-originated API calls must
     go through the bridge (plain Node request, no Origin → passes).
4. **Wire protocol:** route prefix `/api` (`API_PATH`); WS paths `/api/events.mux`
   (browser mux frame) and `/api/events.host` (host frame) — `api-path.d.ts`.
   `dsh-api-gateway` is Typert Remote dispatch over Cordis Services — **do not guess REST
   routes**; use the `dsh-client-connection` public client (exports: `HostConnectionService`,
   `WebSocketDownlinks`, `API_PATH`, `MUX_EVENTS_PATH`, `HOST_EVENTS_PATH`, `Config`,
   `bridge`, `apply`, `inject`, `assertTrustedAuthority`, `isTrustedApiRequest`,
   `isLoopbackHostname`, `rejectWebSocketUpgrade`). Client types incl. `SessionsApi`,
   `HostApi`, `EventsApi` in `lib/types/client/api.d.ts` (inspect at CP-7).
5. **Windows→WSL reachability proven**: the user is using the DSH GUI from Windows right now
   (`DSH_WEB_URL=http://127.0.0.1:3080`; WSL2 mirrored networking; WSL IP `192.168.86.211`
   only matters for NAT fallback).
6. **Env:** DSH checkout `/mnt/f/npm-global/lib/node_modules/@deepseek-ai/dsh` v0.1.1-rc.2
   (inspect-only, never modify); `DSH_HOME=/home/cztl/.dsh`; Node v24.19.0, pure Node,
   **no npm installs**; `/mnt/f/ai` = Windows `F:\ai` (extension loads with no copy step).
7. **`dsh-headless`** = one-shot bundle (direct Agent/Session runner, no Host/HTTP/browser
   layer) — fallback only if wire attach somehow fails.

## 6. Open items (resolve at build time, not before)

- GUI CSS responsiveness in a ~400px panel → check at CP-5; if broken, width/zoom shim in
  the wrapper page (still no DSH modification).
- Exact wire call(s) for "inject text into the active session" → **SOLVED**:
  `POST /api/session.prompt` (CP-3.5 §7(b)).
- Whether bridge needs WS at all for MVP (maybe unary `/api` POST suffices for share).
- `captureVisibleTab` requires the tab to be active; confirm panel-open interaction.

## 7. Do not disturb

`/mnt/f/ai/gpu-intel-arc-pro-b65.md`, `/mnt/f/ai/searxng/`, Obsidian vault dirs,
the DSH checkout (inspect-only).
