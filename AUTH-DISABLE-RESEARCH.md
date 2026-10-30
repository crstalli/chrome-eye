# Research: DSH web auth vs the chrome-eye side-panel iframe

**Bottom line:** No documented way exists to disable core web auth — and even if it could, the side-panel iframe cannot pass the official cookie flow (a `SameSite=Strict` cookie is withheld in a cross-site iframe context). The practical fix is a **loopback-only proxy that injects a self-minted cookie**: zero DSH changes, no restart.

## Q1 — What the gate is; can it be disabled?
The gate is `BrowserAuth` in the core `client-connection` plugin (`@deepseek-ai/dsh-client-connection`, repo `packages/client/connection/src/browser-auth.ts`), instantiated unconditionally in `apply()`; config exposes only `trustedHosts` / `cookieMaxAgeDays` / `maxRequestBodyBytes`. No opt-out flag, config key, or env pin exists — maintainer-verified against master in [#5828](https://github.com/deepseek-ai/deepseek-harness/discussions/5828) (open Ideas request). The guessed bundles (`dsh-login`, `dsh-auth-tunnel`, `dsh-auth-gate`) are third-party add-ons **not installed** in this profile; `dsh plugin --profile web remove @islibaodong/dsh-login` is a no-op, and they sit on top of core auth regardless. Disabling the `client-connection` row would kill the entire `/api` channel and index glue, not just the gate.

## Q2 — Hot reload
The web profile's `cordis.patch.yml` **hot-reloads**: `patchReload` defaults to `"live"` for the web template; HMR re-applies patches without a restart. Nothing recommended here requires a restart at all.

## Q3 — Can the iframe load the GUI?
**No, not via the official flow.** The auth cookie is `HttpOnly; SameSite=Strict` (hardcoded, unconfigurable). The side panel's top-level site is `chrome-extension://…`, so the embed is cross-site: the cookie is stored but never sent in the iframe → permanent 401 even after the user opens the token URL in a normal tab. Proven with Edge in [#5063](https://github.com/deepseek-ai/deepseek-harness/discussions/5063) (`crossSiteIframeApiCookie: NONE`); the maintainer declined to generalize to cross-site iframe support. Nothing else blocks framing: no `X-Frame-Options`/`frame-ancestors` in server source or live 401 headers (frame-denial proposal [#4514](https://github.com/deepseek-ai/deepseek-harness/discussions/4514) still open). No per-tab session isolation — one authority-bound cookie shared across tabs.

**Working path (recommended):** a loopback-only proxy (e.g. `127.0.0.1:3081` → `:3080`) that injects a cookie it mints. All inputs are locally readable: the signing secret persists in `$DSH_HOME/.credentials.yaml` under `records["client-connection/browser-session"].payload.secret`; cookie name = `dsh-auth-` + base64url(sha256(host)); value = `v1.<b64url({version:1,authority,issuedAt,expiresAt})>.<b64url(HMAC-SHA256(secret, body))>`. If the proxy presents requests with Host `127.0.0.1:3081` (loopback → passes the fence) and mints for that authority, **no header rewriting is needed** — the iframe's same-origin XHR/WS passes the Host/Origin fence untouched; forward WebSocket upgrades. The secret survives `dsh` restarts; re-mint on expiry (TTL ≤ `cookieMaxAgeDays`). This is what DSH Desktop does per #5063 (patching compiled code) — except we don't touch the DSH install at all.

## Q4 — Documented extension / embed mode?
None. Zero issues/docs mention iframe/embed/side-panel. [#5063](https://github.com/deepseek-ai/deepseek-harness/discussions/5063) requests a supported embed contract (open); the Desktop shell's compiled-code bypass is explicitly a temporary measure, "not a suitable upstream contract".

## Recommendation for chrome-eye
1. Add a small Node proxy as above; point the side-panel iframe at `http://127.0.0.1:3081`. No DSH config change, no restart, upgrade-safe.
2. Fallback: open the GUI in a full browser tab (token flow works top-level; cookie persists 30 days).
3. Optionally push #5828/#5063 upstream for a real opt-out / embed contract.

**Sources:** [#5828](https://github.com/deepseek-ai/deepseek-harness/discussions/5828) · [#5063](https://github.com/deepseek-ai/deepseek-harness/discussions/5063) · [#4514](https://github.com/deepseek-ai/deepseek-harness/discussions/4514) · [docs/subsystems/web-server.md](https://raw.githubusercontent.com/deepseek-ai/deepseek-harness/master/docs/subsystems/web-server.md) · local code: `@deepseek-ai/dsh-client-connection/lib/index.js` L196–425 (BrowserAuth), `@deepseek-ai/dsh-app-boot` (patchReload "live"), `/home/cztl/.dsh/.credentials.yaml`.
