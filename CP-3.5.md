# CP-3.5 — Deep-link investigation + wire protocol (checkpoint, 2026-07)

Resume artifact. After a restart: read PLAN.md, then this file. Everything below is
VERIFIED against the live GUI (shell rev `bde94f77f327`) and the DSH checkout — do not
re-run the sweeps.

## 1. Deep-link decision status

Question: can the side-panel iframe be made to open a *specific* DSH session
automatically (so "open panel" lands on my session)?

Mechanisms, in preference order:

| # | Mechanism | Verdict | Evidence |
|---|-----------|---------|----------|
| 1 | URL param deep-link | **RULED OUT** | No router in GUI: zero router APIs in index/vendor. Only `location.search` use is `fixtureOptionsFromLocation()` in dsh-client-connection (dev fixtures `?fixture=...`), not a session link. |
| 2 | RPC "activate/open session" | **RULED OUT** | Full remote-descriptor enumeration (below): no session-activate/open endpoint exists anywhere. Session lifecycle is NOT in the remote surface. |
| 3 | `window.postMessage` bridge | **RULED OUT** | No window `message` listener anywhere in client code; all `message` hits are WebSocket `socket.addEventListener("message")` (dsh-client-connection) and EventSource (dsh-client-hmr). Not viable without DSH code changes. |
| 4 | localStorage seed (scripting into iframe page) | **OPEN — 1 candidate left** | See §3. `dsh.workspace.view.v5` is the only untraced persisted store. |
| 5 | MVP fallback | **PLAN DEFAULT** | User clicks the session in the sidebar (state is shared backend-side, so the session is already there across browsers). Auto-open = stretch goal. |

## 2. Wire RPC — LOCKED SPEC (do not re-derive)

- Every unary call: `POST /api/<channel>/<endpoint>`, body exactly
  `{ type: 'client-request', rpcId, method, payload }` — client mints `rpcId` (uuid).
  Source: `dsh-client-connection_client.js_rev_70b02b2d3fc2` @ ~348829 (`call`) and
  `dsh-host-apiproxy/lib/types/fetch/client.js:172`.
- Response: `ServerResponse { type:'server-response'; rpcId; result: RpcResult<unknown> }`,
  `RpcResult<T> = { ok:true; value:T } | { ok:false; error:{ code; message; details } }`
  (`rpc.d.ts:189–195`). Client → host direction: `POST /api/respond`.
- `endpoint` = `namespace` + optional `method` joined by `/`; channel validated by
  `CHANNEL_PATTERN` (letters/digits/_/-, no empty/./.. segments) — same chunk @ ~348956.
- WS: `/api/events.mux` + `/api/events.host`; server-request frames carry
  `method: envelope.payload.type`.
- **Trust-fence consequence (binding):** extension `fetch` to `/api/*` carries
  `Origin: chrome-extension://…` → **403**. Only (a) the GUI iframe's own same-origin
  traffic or (b) a plain-Node loopback bridge with NO Origin header may call the wire
  API. The bridge is therefore mandatory for the extension's own calls.

## 3. Persistence sweep — exactly 2 persist keys (all 43 chunks)

1. `persist: "dsh.conversation.chat"` — `_deepseek-ai_dsh-client-ui-conversation_client.js_rev_cf4575517765`
   @ ~1101–1350: `defineStore({ init: () => ({ selection:null, draft:"", view:null, inspect:null }) })`.
   Doc: "**Per-session** chat store shared by conversation and details registrations."
   `selection` = details/inspect target (`openDetails` → `actions.select(target)`), **NOT**
   an active sessionId. Whole-chunk sweep for `activeSessionId|lastActive|focusSession|selectSession`
   → zero hits anywhere in the 43 chunks.
2. `persist: "dsh.workspace.view.v5"` — `_deepseek-ai_dsh-client-ui-workspace_client.js_rev_2e1cd4f55f0c`
   @ 1472 (chunk 113,317 B). **Shape NOT yet traced.** → NEXT STEP (a).

## 4. Remote-surface enumeration (the complete "direct" list, 25)

From `TYPERT_REMOTE` descriptor ids in `_deepseek-ai_dsh-api-remotes_client.js_rev_9a16f4532366`
(205,655 B):

```
commands/execute  commands/list
dynamicCordisRunner/{getClientCode,inventory,invoke,reportClientGuardFailure,
  reportRenderFailure,resolveInspectQuery,resolveRequestRun,runHostHalf,
  settleUserRun,stopFromPanel,syncInspectManifest,undefineFromPanel}
fileReferences/list
goals/{clear,complete,create,edit,pause,resume}
pluginInventory/list
messageFeedback/{delete,list,put}
sessionReferenceResolver/candidates
```

No `sessions/*` namespace → no session-activate/open RPC (kills mechanism 2).
Gateway chunk `_deepseek-ai_dsh-api-gateway_client.js_rev_965b70361a00` (18,560 B) has
zero method literals (pure dispatch plumbing).

WS frame types seen in `_deepseek-ai_dsh-client-connection_client.js_rev_70b02b2d3fc2`:
`session/event`, `session/subscribed`, `session/queue`, `session/jobs`,
`session/projection` (×12), `session/title` (×5), `sessionStats` — event/subscription
frames, not RPC.

Zod error schemas in the same chunk prove session/workspace RPCs exist server-side
(codes: `session-not-found` {sessionId}, `session-conflict` {sessionId, requestedCwd,
existingCwd?}, `model-unavailable`, `invalid-time-zone`, `workspace-attach-failed`,
`workspace-not-found`) — exact method names/payloads come from the typed surface, not
guessing (NEXT STEP (b)).

## 5. Live GUI inventory (for the wrapper page)

- Shell `GET /` rev `bde94f77f327`. Static: `/assets/index-ClqxG24t.js` (399,361 B),
  `/assets/vendor-D22_Mp1f.js` (744,872 B) + 2 CSS.
- 43 lazy plugin chunks `/plugins/@deepseek-ai/<name>/client.js?rev=<hash>` via inline
  `window.__ModuleLoader__` + `globalThis.__DSH_BOOT__`.
- No anti-iframe headers; `127.0.0.1` is potentially trustworthy → extension page may
  iframe plain-HTTP loopback (no mixed-content block).

## 6. Scratch artifacts (clean up before final delivery; under /mnt/f/ai)

`.gui.html` · `.gui-index.js` · `.gui-vendor.js` · `.gui-chunks.txt` (43 **relative**
chunk URLs) · `.guichunks/` (all 43 chunks, 3.4 MB, filenames
`_deepseek-ai_<name>_client.js_rev_<hash>`, NO `.js` suffix).
(scratch deleted 2026-07-02 per T10.1)

## 6.5 Build notes (2026-07-02, overnight)

- **Troubleshooting reference (user-specified):** https://github.com/Lum1104/dsh-browser —
  sanctioned repo to consult if stuck (esp. for step (b), wire injection).
- **Testing strategy:** podman abandoned (permanently broken in this WSL). Local
  chrome-for-testing full `chrome` binary (`--headless=new --no-sandbox`) + `dpkg -x` libs in
  `test/chrome-libs/`; see `test/chrome-setup.md`. Windows Chrome only for T4.8/T9.x (deferred).
- All implementation delegated to sub-agents; this file is updated at each checkpoint
  boundary. The CP-7 sub-agent writes its `api.d.ts` conclusion to a new **§7(b)** below.

## 7. Next steps (in order)

- **(a)** Trace `dsh.workspace.view.v5`: init shape; does it carry a last-active
  sessionId; how is a per-session store scoped to one shared persist key. → decides
  mechanism 4 vs MVP fallback (§1 #5).
- **(b)** Read `/mnt/f/npm-global/lib/node_modules/@deepseek-ai/dsh/dsh-client-connection/lib/types/client/api.d.ts`
  (`SessionsApi`, `HostApi`, `EventsApi`) for the exact bridge method + payload for
  "send context into a session".
- **(c)** Present the decision-complete plan via `exit_plan_mode` (must be the ONLY tool
  call in that response).
- **(d)** On approval, build `/mnt/f/ai/chrome-eye/` per PLAN.md CP-4…CP-9, keeping this
  checkpoint file updated at each checkpoint boundary.

## 8. Constraints still in force

- **Plan mode is ACTIVE for the plan step**: no code/build until the expanded plan is
  presented via `exit_plan_mode` and the user approves it in that tool result.
- Sandbox: workspace-write (`/mnt/f/ai` writable; `/tmp` is NOT persistent across bash
  calls → all scratch lives under `/mnt/f/ai/`).
- DSH checkout is inspect-only. No npm installs. No DSH modification.
- Extension pages must never `fetch` `http://127.0.0.1:3080/api/*` directly (403 per
  trust fence, §2).
- User restarts the agent frequently → this file is the resume artifact; keep it current.

## §7(b) Inject into session — verified

**Verdict: FOUND.** The exact unary call to inject a user message into a session (CP-7, T7.7),
read from `api.d.ts` (real path:
`dsh/node_modules/@deepseek-ai/dsh-client-connection/lib/types/client/api.d.ts`, a re-export
shim of `@deepseek-ai/dsh-host-apiproxy/api`) and **verified live** against `:3080`.

### The call (locked)

- Wire path: `POST /api/session.prompt` — a native dot-path RPC (rpc-map), NOT one of the
  remote slash endpoints of §4.
- Body envelope: `{ "type":"client-request", "rpcId":"<uuid>", "method":"session.prompt", "payload":{…} }`
  (method = the dot name, same rule as `session.list`).
- Payload (`SessionsApi.prompt`, `dsh-host-apiproxy/lib/types/api/sessions.d.ts:369`;
  zod `sessionPromptRequestSchema`):

  ```json
  {
    "sessionId": "session-<uuid>",
    "mode": "queue",              // 'queue' (send now) | 'steer'
    "content": [                  // PromptContentPart[] (api.d.ts export)
      { "type": "text",  "text": "…" },
      { "type": "image", "mediaType": "image/png", "data": "<base64>", "name": "shot.png" }
    ],
    "clientTimeZone": "America/New_York"   // optional IANA zone
  }
  ```

- `PromptContentPart` (`sessions.d.ts:85–94`):
  `{type:'text', text:string} | {type:'image', mediaType:'image/png'|'image/jpeg'|'image/webp'|'image/gif', data:string (base64), name?:string}`.
  Host promotes image bytes to durable references.
- Response value: `{ accepted: true, command?: { kind:'success', text?: string } }`
  (`sessionPromptValueSchema`, `sessions.schema.d.ts:~241`). The `command` slot only appears
  when the single text block is a `/`-slash command (consumed, never sent to the model).
- Wire key: `'session.prompt' → SessionsApi['prompt']` (`rpc-map.d.ts:31`).
- Caveat: session-backed **subagents** reject `session.prompt` with `agent-busy`
  (use `subagent.prompt` for them) — out of scope for the bridge.

### Live verification (against the running GUI, `:3080`)

- `POST /api/session.prompt`, method `session.prompt`, payload with a **fake** sessionId →
  HTTP 200 `server-response`, `result.ok:false`, `error.code:"session-not-found"` — proves the
  path routes, the method string matches, and the payload schema admits the shape (a shape
  violation would surface as `bad-request`, not `session-not-found`).
- `POST /api/session.list` → `ok:true` with live session rows; session ids are
  `session-<uuid>` (e.g. the live session this investigation ran in).
- Trust fence (why the bridge must strip headers): `Origin: chrome-extension://…` → **403**,
  `Origin: http://evil.example` → **403**, `Sec-Fetch-Site: cross-site` → **403**, no Origin
  + loopback `Host` → 200 (`isTrustedApiRequest`, `dsh-client-connection/lib/index.js`).
- No end-to-end injection into a live session was performed on purpose (it would inject a
  user message into a running conversation); the schema-level proof above plus the source
  contract is the verification.

### Bridge wiring (implemented in `bridge/bridge.mjs`)

- `POST :3081/share` accepts the spec payload `{url,title,visibleText,links,headings,image?}`
  plus an **optional `sessionId`**.
- With `sessionId`: assembles one text block (title/URL/headings/links/visible-text digest)
  + optional image part, calls `session.prompt` (`mode:"queue"`) against `:3080` —
  bridge→host is plain loopback Node, no Origin, so the fence is satisfied. Responds
  `{ok:true, injected:true, sessionId, value}` or `{ok:false, injected:false, error}`.
- Without `sessionId` (the spec'd payload shape): the bridge **cannot** know which session
  the GUI user is viewing — §3 proved no client-side active-session store exists — so it
  falls back to writing the payload to `captures/<unix-seconds>.json` and responding
  `{ok:true, fallback:true, path}`.
- Sanctioned reference (per §6.5, not needed for the build): https://github.com/Lum1104/dsh-browser.

### Open: who supplies the sessionId — **DECIDED 2026-09-08: in progress via T11.1** (sub-agent active)

MVP ships the `captures/` fallback (sw.js sends no sessionId). Candidate mechanisms to reach
real injection: (1) the manifest already injects `content.js` into `<all_urls>` — it therefore
also runs inside the panel's `:3080` GUI iframe, where it could read the persist keys
(`dsh.workspace.view.v5` / `dsh.conversation.chat`) and relay a sessionId to sw.js; (2) a small
session picker in the panel bottom bar. Decide with the user at the CP-9 boundary.

- **CORS decision (OVERRIDDEN 2026-07 by CP-7):** the bridge originally served NO
  `Access-Control-Allow-Origin`. The service worker POSTs to `:3081/share` from an origin
  whose host_permissions do NOT cover :3081, so CP-6 mandates CORS: the bridge now answers
  OPTIONS preflights for `/share` and `/api/*` (204, no body) and stamps
  `Access-Control-Allow-Origin: *` (+ `Access-Control-Allow-Content-Type: application/json`,
  Allow-Headers/Methods) on all JSON responses. Accepted trade-off: any page on this machine
  can reach :3081 cross-origin (bridge still binds loopback only). Granting
  `http://127.0.0.1:3081/*` in host_permissions is now optional, not required.
- **Payload field name (locked):** the share payload's text field is `visibleText` (spec name);
  sw.js was sending `text` — renamed 2026-07-02 (done).
## 9. T12 recon facts (2026-09-11, facilitator-verified)
- **`:3080/` 401 to plain curl is EXPECTED**, not an outage. DSH web auth gate:
  `dsh-client-connection/lib/index.js` ~L380–430 — `isAuthenticated(request)` requires an
  authority-bound signed session cookie (`sessionCookie(cookieName(authority), …)`, Host +
  Cookie + secret + expiry); `writeUnauthorized` → 401 text `dsh web authentication
  required; reopen the URL printed by dsh web.` (L424; body captured in
  `scratch-t12/index.html`, 68 bytes). The real browser iframe carries the cookie and
  loads fine. Never treat a curl 401 from :3080 as an error.
- **The string "disconnected" is NOT in any extension file** (grep `extension/*` = 0
  matches). It is the DSH GUI's own connection indicator:
  `ConnectionState = 'connected'|'disconnected'|'connecting'` — emitted in
  `dsh-client-connection/lib/client.js` L94/L126/L142 (`reconnect()` with exponential
  backoff around L60–221), rendered by `dsh-client-ui-settings-general/lib/client.js`
  L215–249 (`if (connectionState === "disconnected") connectionIndicator =
  "disconnected"`, `disconnectedLabel: t("connection.error")`). The user's F4
  ("button says disconnected") is this GUI-side state seen inside the panel iframe.
  DSH checkout is READ-ONLY → fix conditions (bridge liveness, panel iframe session
  health) + honest panel-side status, never the GUI.
- **Real DSH client bundle tree location** (was unknown): 
  `/mnt/f/npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-*/lib/`
  (non-minified `client.js`/`index.js`). The top-level checkout `lib/` has only 5 files
  (bin.js, dump-config-*, plugin-*, profile-boot-*).
- **Bridge :3081 was DOWN** at recon (2026-09-11): `curl :3081/health` → HTTP 000, no
  background jobs. Recovery = restart THE bridge as a managed background job (never
  nohup; no duplicate instances).
- **Panel iframe = separate GUI instance.** Content scripts do not run inside it (frame
  of a `chrome-extension://` page; manifest `content_scripts` has no `all_frames`).
  Enabler for in-panel workspaces (NO manifest change): `scripting` + `webNavigation` +
  `host_permissions :3080/*` already present → `chrome.webNavigation.getAllFrames({url:
  'http://127.0.0.1:3080/*'})` → prefer `frameId > 0` (panel's own iframe; real GUI tabs
  expose :3080 as top frame `frameId === 0`) → `chrome.scripting.executeScript({target:
  {tabId, allFrames:false, frameId}, func, args})` with a self-contained plain-JS `func`.
- **Storage-partitioning hypothesis (F6):** the panel's :3080 iframe is a third-party
  context inside a `chrome-extension://` page → Chrome storage partitioning may give it a
  separate `localStorage` → different `dsh.workspace.view.v5` / `dsh.sessions.current`
  view state than the web tab. Workspace/session data itself is backend-global (one DSH
  process) → the SET of workspaces should match; only view state may differ. (user)
  verification pending (T12.6).
