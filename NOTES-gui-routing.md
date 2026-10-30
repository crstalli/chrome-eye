# Chrome Eye → DSH GUI: session routing & page-structure notes

Audience: downstream agents building the **workspace-tree session dropdown** and the
**context-chips UI** for the Chrome Eye side panel. Everything below was verified against
the installed harness checkout at
`/mnt/f/npm-global/lib/node_modules/@deepseek-ai/dsh/` (the DSH GUI served by
`pnpm run dev:web` / `dsh web` at `http://127.0.0.1:3080`). Treat this file as read-only
research output; do not modify the harness checkout.

---

## 1. TL;DR — canonical active-session-id recipe

```js
// Only valid on origin http://127.0.0.1:3080 (the GUI origin).
function readGuiSessionId() {
  try {
    const raw = localStorage.getItem('dsh.sessions.current');
    if (!raw) return null;
    const obj = JSON.parse(raw);
    const id = obj && typeof obj.sessionId === 'string' ? obj.sessionId : null;
    return id && id.length > 0 ? id : null; // '{}' → no session
  } catch { return null; }
}
```

- **Selector / JSON path:** `localStorage['dsh.sessions.current']` → `JSON.parse(...).sessionId`.
- **No URL route, no DOM attribute, no regex needed.** There is no routing layer at all (see §3).
- `sessionId` format: `session-<uuid>`, e.g. `session-eb9f1447-b5a4-4ae8-9c73-75ee225e19a7`.
- **How the id changes:** the GUI's own durable selection store writes this key to
  `localStorage` on *every* session-selection change (and on load rehydration). The id in
  the key is the single source of truth the whole app uses for "which session is open".
- **Observation strategy from a content script:** poll every ~2 s and report only on change.
  `storage` events do **not** fire in the document that wrote the key (spec: they fire only
  in *other* same-origin browsing contexts), so polling is the only same-document mechanism.
  Chrome Eye's `extension/content.js` implements exactly this
  (`GUI_POLL_MS = 2000`, report-only-on-change, message `chrome-eye:gui-session`).
- **Trust fence (hard rule):** extension pages must never call `:3080/api` directly.
  Only the loopback bridge at `:3081` may (it strips `Origin`/`Referer`/`Sec-Fetch-*`/`Host`
  and adds CORS). The session id flows panel → SW → bridge → `:3080/api/session.prompt`,
  never panel → `:3080`.

---

## 2. GUI architecture (why the recipe works)

The GUI at `:3080` is a **two-layer app**:

1. **Static shell** — `node_modules/@deepseek-ai/dsh-web-frontend/dist/`
   (`index.html` + hashed `assets/index-*.js`/`*.css`). It contains only
   `<div id="root"></div>`, markdown/KaTeX rendering infra, and a runtime module loader:
   `window.__ModuleLoader__.load({ id, factory })`. **No router, no `localStorage` use,
   zero `pushState`/`replaceState`/hash-routing code in the shell.**

2. **Runtime-injected client app** — per-plugin packages
   `node_modules/@deepseek-ai/dsh-client-*/lib/client.js` (readable, non-minified).
   Loaded through the module loader; owns all UI, state, and persistence.

Consequences for us:
- The DOM is built at runtime by React (JSX compiled to `React.createElement`), so any DOM
  scraping must go through the stable class names / data attributes documented in §5.
- Persistence is hand-rolled (no redux/localStorage libs): `defineStore({ init, persist:
  "<key>", actions })` and `createSnapshotStore(init, { persist: { name } })` in
  `dsh-client-runtime` (`attachPersistence`, `lib/client.js` lines 5436–5451) write
  **whole-value `JSON.stringify(state)` to `localStorage[name]` on every store change**
  and rehydrate on page load.
- The only `location.*` usage in the whole client is `?fixture` in `dsh-client-connection`
  (test fixture mode) — irrelevant for real sessions.

**Session runtime core:** `SessionRuntime` (`dsh-client-runtime/lib/client.js` ~line 8850)
holds the selection store:

```js
// line ~8899
this.selection = createSnapshotStore({}, { persist: { name: "dsh.sessions.current" } });
```

written in `projectList()` (~lines 9267–9273) on every selection change:

```js
// current === undefined  → set({})
// otherwise              → set({ sessionId: current,
//                                  ...(currentAddress ? { subagentAddress: currentAddress } : {}) })
```

and rehydrated into `SessionManager(api, remote, restored.sessionId, restored.subagentAddress, …)`
on page load (line ~8907). So: **the localStorage key is the GUI's own durable selection
record — the most stable extraction target available.**

---

## 3. How the active session id changes (routing mechanism)

There is **no routing mechanism** in any of the three usual senses:

| Mechanism | Present? | Evidence |
|---|---|---|
| URL routing (`pushState`/`replaceState`/hash) | **No** | Zero matches across all `dsh-*/lib/*.js`; shell has no router |
| DOM marker (`data-session*` etc.) | **No** | No session-id `data-*` attributes anywhere (§5 lists the data attributes that do exist — none carry a session id) |
| Same-document `localStorage` write | **Yes — the only one** | Selection store (§2) writes on every selection change; rehydrates on load |

Practical model for observers:

- User clicks another session in the workspace tree (or a subagent crumb, or opens the GUI
  fresh) → `projectList()` runs → selection store `set(...)` → `attachPersistence` writes
  `localStorage['dsh.sessions.current']` **synchronously in the same document**.
- A content script in that document sees the change **only by re-reading** the key
  (poll). A content script in a *different* same-origin tab would additionally get a
  `storage` event — but our content script lives in the very tab that writes, so poll.
- Multiple `:3080` tabs/windows share the one origin's localStorage → **latest selection
  across all windows wins** (Chrome Eye's SW cache follows the same "latest non-empty wins"
  rule; an empty selection never clears the cache).

---

## 4. Persist-key catalog (verified, exact shapes)

All keys written by the runtime-injected client app (whole-value `JSON.stringify`,
overwritten on every store change). These are the **only** localStorage keys the GUI uses:

| Key | Owner | Exact JSON shape |
|---|---|---|
| `dsh.sessions.current` | `dsh-client-runtime` `SessionRuntime` | `'{}'` **or** `'{"sessionId":"session-<uuid>","subagentAddress":{"childSessionId":"session-<uuid>","parentSessionId":"session-<uuid>","mode":"<mode>"}}'` — `subagentAddress` present only when a subagent session is selected |
| `dsh.workspace.view.v5` | `dsh-client-ui-workspace` | `'{"groupBy":"workspace","orderBy":"updated","groupExpansion":{"<key>":true},"sessionOrderByAccount":{"<accountKey>":["session-<uuid>",…]},"sessionUpdatedAtByAccount":{"<accountKey>":1735689600000}}'` — **view preferences only, no session data**; `groupBy: "workspace"`, `orderBy: "updated"` are the defaults; flat-order sentinel key `__flat_session_order__` |
| `dsh.conversation.chat` | `dsh-client-ui-conversation` | `'{"selection":null,"draft":"","view":null,"inspect":null}'` — per-session chat content/draft; `draft` is the composer text buffer |
| `dsh.trajectory.duration` | `dsh-client-ui-trajectory` | `'true'` / `'false'` — toggle to show trajectory durations |

Session rows themselves (`displayTitle`, `updatedAt`, …) are **not** persisted — they come
from the host API (§7). Sessions live on disk under `~/.dsh/sessions/<escaped-cwd>/`.

---

## 5. DOM structure facts

### 5.1 Layout skeleton

`AppFrame` (`dsh-client-ui-layout`, CSS module hash `pI_x6G`) registers into the built-in
`root` slot: a three-column grid.

```
#root
└─ .pI_x6G_frame
   ├─ .pI_x6G_sidebarCol   ← SidebarRoot (dsh-client-ui-sidebar, hash hHd-Xa)
   │    ├─ brand area (.hHd-Xa_brand, .hHd-Xa_brandIdentity, .hHd-Xa_brandMark, .hHd-Xa_brandName)
   │    ├─ renderSlot("sidebar.workspaces", …)  ← the workspace tree lives HERE
   │    └─ .hHd-Xa_footArea (slots sidebar.footer.action, sidebar.settings)
   ├─ .pI_x6G_handle       ← drag handle
   ├─ .pI_x6G_centerCol    ← conversation (ConversationRoot, hash wSkVaW)
   └─ .pI_x6G_detailsCol   ← details panel
   (.pI_x6G_overlayLayer for overlays)
```

### 5.2 Class-name pattern

All component classes are CSS-module hashed: **`<6-char-hash>_<logicalName>`**, e.g.
`YDXeBa_sessionRow`, `_7yHdaG_dock`, `uV2eYG_card`. The **logical name is stable across
builds; the 6-char prefix is a per-module build hash and may change on a rebuild.**
Scraping rules of thumb:

- Match by suffix: `[class*="_sessionRow"]`, `[class*="selected"]`, `:scope [data-composer-card]`.
- Or read the map at runtime — each `client.js` embeds its full
  `Xxx_module_css_default = { "logical": "hash_logical", … }` object (non-minified), so a
  Cordis client plugin can resolve exact names per build.

### 5.3 Workspace tree (dropdown source UI) — `dsh-client-ui-workspace`

CSS-module hashes: rows `YDXeBa_*`, browser `WorkspaceBrowser_*` (includes `treeBody`,
`list`, `empty`), picker `WorkspacePicker_*`.

| Element | Class (suffix) | Notes |
|---|---|---|
| Workspace/project group row | `YDXeBa_projectRow` (+ `YDXeBa_menuOpen`) | folder icon slot `YDXeBa_folder`/`YDXeBa_folderActive`, chevron `YDXeBa_chevron`/`YDXeBa_arrow`/`YDXeBa_arrowOpen`, title `YDXeBa_projectText > .YDXeBa_title`, actions `YDXeBa_rowActions > .YDXeBa_iconButton` |
| **Session row** | `YDXeBa_sessionRow` | `+ YDXeBa_selected` **iff it is the currently open session** — DOM alternative for "which session is visible"; inner `.YDXeBa_title`, `.YDXeBa_time`, `.YDXeBa_rowActions`, drag states `YDXeBa_dropBefore`/`YDXeBa_dropAfter` |
| Search results | `YDXeBa_searchResultRow` (+ `selected`), `YDXeBa_searchResultTitle`, `YDXeBa_searchResultWorkspace`, `YDXeBa_searchResultSnippet` | |
| Hover previews | `YDXeBa_hoverContent` > `.hoverTitle/.hoverPath/.hoverTime/.hoverStatus` | |

Tree semantics (from the package source): sessions group by workspace
(`groupBy: "workspace"`), label = basename of the cwd (`workspaceLabel`), ungrouped bucket
label `"Ungrouped"`, recency order `byRecency` (newest first, id tiebreak). Visibility rule:
subagent-origin sessions and archived sessions are hidden from the list; blank ("New
Session") rows show only when current. Session row objects carry
`{ id, displayTitle, updatedAt, blank, cwd, origin, … }` (host data, §7).

### 5.4 Conversation & composer (chip source UI) — `dsh-client-ui-conversation`

- **Composer card: stable hook `data-composer-card`** on the composer root (line ~3991).
  Composer CSS module hash `uV2eYG_*`: `uV2eYG_card` (the rounded input card,
  `--dsh-composer-card-max-width`), `uV2eYG_cardWorkspaceTrigger`, `uV2eYG_input`
  (textarea), `uV2eYG_scroll`, chips `uV2eYG_chip` / `uV2eYG_chipTrigger` /
  `uV2eYG_chipInvalid`, `uV2eYG_accessory`, `uV2eYG_overlayAnchor`, notices `uV2eYG_notice`.
  Design tokens used throughout: `--dsh-*` (e.g. `--dsh-composer-side-clearance`,
  `--dsh-composer-text-max-height`, `--dsh-chat-content-width`) and
  `--dsw-*` (e.g. `--dsw-alias-label-secondary`, `--dsw-specific-input-major`,
  `--dsw-alias-button-info-fill`, `--dsw-shadow-lv2`).
- **Conversation root** (`wSkVaW_*`): header `wSkVaW_header` (+ `headerActions`,
  `headerUtilities`), breadcrumb `wSkVaW_crumbs` (segments `crumbSeg`, subagent crumb
  `crumbSubagent`, current `crumbCurrent`), composer seat `wSkVaW_composerSeat` /
  `composerStack` / `composerHero`.
- **Queue dock** (pending queued messages) `_7yHdaG_*`: `dock`, `panel`, `header`, `lead`,
  `count`, `list`, `row`, `preview`, `editor`, `actions`, `action`, `chevron`.
  Render rule: **one item renders directly; multiple items collapse to a count header;
  empty queue renders nothing.** Items come from `s.queue` rows with
  `placement: "queued"` (steering rows use `placement: "steering"`).
- **Context-injection rows** (`pC0e7a_*`): `root`, `source` (producer name), `summary`,
  `body`, `chevron`, `sep` — how logged injected context is surfaced in the transcript
  (the model for how our shared-page context will appear).
- Message items `MessageItem_*` (`4263`), chat view `ChatView_*` (`5461`), context body
  `ContextBody_*` (`4363`), context meter ring beside send button `ContextMeter_*` (`3045`).
- Composer is registered under slot **`conversation.composer.bar`** (child slots
  `conversation.composer.dock`, `conversation.input.attachments`, `conversation.input.model`,
  `conversation.input.overlay`, `conversation.input.plan`, `conversation.input.dock`).

### 5.5 `data-*` attributes in use (none carry a session id)

`data-error`, `data-state`, `data-variant`, `data-tool`, `data-summary-scroll-region`,
`data-active`, `data-tip`, `data-slot-error`, `data-dragging`, `data-decoration`,
`data-cordis-switch`, `data-selected`, `data-role-icon`, `data-phase`, `data-cordis-status`,
`data-virtual-spacer`, `data-time-hover-root`, `data-status`, `data-source`, `data-slot`,
`data-plugin`, `data-member-status`, `data-goal-bar`, `data-expandable`,
`data-cordis-plugin-id`, and (composer) **`data-composer-card`**.

---

## 6. Slot topology (for inserting dropdown/chip UI)

Slots are the supported UI-extension surface (Cordis client plugins register into them;
the shell renders only `root`). Verified registered names:

- **Layout:** `root` (AppFrame), `sidebar` (+ `sidebar.brand.mark`, `sidebar.brand.name`,
  **`sidebar.workspaces`** ← workspace tree slot, `sidebar.footer.action`,
  `sidebar.settings`), `details`, `settings.*` (many).
- **Conversation:** `conversation`, `conversation.view`, `conversation.session`,
  `conversation.session.header` (+ `.actions`, `.lineage`), `conversation.chat.node`,
  `conversation.hero.brand.mark`, **`conversation.hero.workspace`**,
  `conversation.composer`, **`conversation.composer.bar`** (+ `.dock`),
  `conversation.input.*` (`attachments`, `dock`, `model`, `overlay`, `plan`),
  `conversation.message.images`, `conversation.details.tool`,
  `tool.call.toolview`.
- **Feature panels:** `goal`, `plan`, `skill`, `model`, `permission`, `reference`, `command`,
  `compact`, `echo`, `cordis`.

A workspace-tree dropdown belongs naturally in `conversation.composer.bar`/`dock` or
`conversation.input.overlay`; context chips fit `conversation.input.attachments` or the
composer accessory row. (These are suggestions from the topology; the slot contracts —
props/registration — must be re-queried with the Inspect Providers at build time.)

---

## 7. Host API (the data source behind the GUI)

`POST http://127.0.0.1:3080/api/<method>` with a JSON body (schema-validated; response is
`{ ok, value | error }`-style; SSE streams at `GET /api/events.mux` and
`/api/events.host`). **The bridge (:3081) is the only component allowed to call these —
see §1 trust fence.** Method catalog relevant to the dropdown/chips:

| Method | Request | Response `value` |
|---|---|---|
| `session.list` | `{}` (cursor reserved) | `{ items: [ { sessionId, updatedAt, running, blank, parentSessionId?, origin?: "subagent", cwd?, agentPreset?, projections? } ] }` |
| `workspace.list` | `{}` | rows `{ workspaceId, path, title, sessionIds[], createdAt, updatedAt }` |
| `session.search` | `{ query (1–500 chars, no NUL) }` | `{ items: [ { sessionId, snippet (≤240 cp) } ] (≤20), hasMore }` |
| `session.prompt` | `{ sessionId, mode: "queue" \| "steer", content: [ {type:"text",text} \| {type:"image", mediaType, data, name?} ] }` | `{ accepted: true, command? }` |
| `session.updateQueue` | `{ sessionId, itemId, action: {kind:"edit", content} \| {kind:"remove"} \| {kind:"steer"} }` | `{ accepted: true }` (error codes: `steer-unavailable`, `queue-item-not-found`) |
| `session.cancel` | `{ sessionId }` | `{ accepted: true }` |
| `session.create` | `{ workspaceId? }` XOR `{ cwd? }` | new session |

`projections` (when present) = `{ asOfSeq, values: { [key]: unknown } }` — includes the
session-list metadata projection `{ blank, lastPromptAt }`; `displayTitle` (the text the
tree row shows) is derived on the client from session meta/history, not in the summary row.

---

## 8. Queue semantics (what `mode:"queue"` does in the GUI)

- Chrome Eye's /share path sends `session.prompt` with **`mode:"queue"`** → the page is
  attached to the session's **transient queue**, not delivered immediately.
- The GUI renders queued items in the **QueueDock** strip in the composer area (§5.4):
  the pending page-context is *visibly queued there*, with per-item operations
  (`session.updateQueue`: edit / remove / steer).
- Delivery: the queued item is delivered **with the user's next prompt** (or the user
  steers it in immediately). Queue rows: `{ id, messageId, placement: "queued" |
  "steering", content: [blocks], preview, text }` (client projection,
  `SessionQueueMirror.replace`).
- Conversation UI submit defaults to `mode:"queue"` when the session is busy
  (`submit(mode="queue")`, `dsh-client-ui-conversation` ~line 1084; steer-all pending on
  completion ~1135–1137).

---

## 9. Current Chrome Eye implementation (state of the art)

Files: `extension/` (MV3) + `bridge/bridge.mjs` (:3081) + this repo's `test/` (untouched).

- `content.js` — on origin `http://127.0.0.1:3080` only: polls
  `dsh.sessions.current` every 2 s (§1 recipe), sends
  `{ type: "chrome-eye:gui-session", sessionId }` to the SW **only on change**
  (`lastSent` sentinel: `undefined` = never, `null` = no session). Captures
  `{url, title, text, links, headings}` unchanged.
- `sw.js` — caches latest non-empty `guiSessionId` (module var; **lost on SW restart**,
  documented comment; rebuilds within ~2 s of any wake); `/share` payload gains
  `sessionId` when cached; forwards upstream `injected`/`fallback`/`error` flags to panel.
- `bridge.mjs` `/share` — with `sessionId`: RPC `session.prompt` (mode `queue`) to
  `:3080/api` → `{ ok:true, injected:true, sessionId, value }`; upstream error →
  `{ ok:false, injected:false, error }`; fetch throw → 502 `{ ok:false, error:
  "upstream-unreachable: …" }`. Without `sessionId`: writes
  `captures/<unix-seconds>.json` → `{ ok:true, fallback:true, path }`; bad JSON → 400.
- `panel.js` — **frozen, minimal** (status text only, same `#share-status` span):
  injected → green `Added "<title>" to session context (queued for your next prompt)`;
  fallback → green `Saved "<title>" (no session open) → bridge HTTP <status>`;
  failure → red `Share failed: <error>`. Downstream work reworks the panel UI —
  do not extend it in this task line.

### Constraints (still in force)

- Extension files only + explicitly requested docs; do **not** touch `test/*` or `bridge/`
  (read-only reference), no manifest permission changes.
- Do **not** start another bridge (:3081 is live), do **not** run `test/run.sh`, do **not**
  POST any session id to :3081 (would inject into the user's live sessions).
- DSH checkout is read-only; workspace-write sandbox.
- Capture shape `{url,title,text,links,headings}` + key order are byte-exact (harness
  deep-equals) — don't reorder/add fields.
