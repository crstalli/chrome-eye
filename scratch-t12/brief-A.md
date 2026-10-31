# Brief A — T12.1 + T12.2: Workspaces in the panel + overlay exit (owns sw.js, content.js, panel.js)

## Mission
Make the chrome-eye Chrome extension's "Workspaces ▾" dropdown and "⛶ workspace" overlay
work **inside the side panel itself** (its embedded DSH GUI iframe at `http://127.0.0.1:3080`),
instead of requiring a separate real :3080 browser tab. And make the overlay closable FROM
the panel (toggle). Target UX: "act just like gemini plugin for chrome" — self-contained panel.

## Context (all verified by the facilitator)
- Workspace: `/mnt/f/ai/chrome-eye`. Extension = pure files, MV3, no build step, loaded
  unpacked from `extension/`. Side panel = `extension/panel.html` embedding the REAL DSH GUI
  in `#dsh-iframe` → `http://127.0.0.1:3080`.
- Existing feature (T11.3/T11.4, working): `panel.js` → `swRequest()` → SW handlers
  (`chrome-eye:workspace-tree` L438, `chrome-eye:open-session` L451, `chrome-eye:expand-group`
  L463, `chrome-eye:overlay` L474 in sw.js) → `chrome.tabs.sendMessage` to a REAL :3080 tab's
  **content script** → scraper/overlay live in content.js (scraper ~L500–812, overlay code
  L634–812: `overlayEl`/`overlayAnchor`/`overlayStatusEl`/`overlayRaf`, `overlayEscape`
  keydown-capture, `data-chrome-eye-overlay="true"` marker).
- WHY it fails in the panel: content scripts do NOT run inside the panel's iframe (it is a
  frame of a `chrome-extension://` page). The panel can only drive its own iframe via
  `chrome.scripting.executeScript`.
- KEY ENABLER (no manifest change — `scripting`, `webNavigation`, `host_permissions
  :3080/*` all already present):
  1. Discover the panel's own GUI frame:
     `chrome.webNavigation.getAllFrames({url:'http://127.0.0.1:3080/*'})`
     → entries where `frameId > 0` are panel-iframe frames (a real GUI tab exposes :3080 as
     the TOP frame, `frameId === 0`). Prefer `frameId > 0`; if none, fall back to the
     existing real-GUI-tab path (keep it working — it's the fallback, and the
     pre-install-tab injection path in sw.js `captureTab`/`guiTabRoundTrip` must stay intact).
  2. `chrome.scripting.executeScript({target:{tabId, allFrames:false, frameId}, func, args})`
     where `func` is a SELF-CONTAINED plain-JS function: no closures over SW state, no
     `chrome.*` inside, pure DOM, args passed explicitly. It runs in the GUI page's context.
- The GUI's DOM structure is documented by the existing content.js scraper — READ it first.
- `:3080` answering 401 to curl is EXPECTED (DSH web auth gate, signed authority-bound
  cookie). The real browser iframe loads fine. Do not "fix" this.

## Changes (all in `extension/`)
1. **Extract the scraper into a self-contained module**: create `extension/scraper.js`
   (new file, allowed — extension files only) exposing plain functions that work with NO
   module state, e.g. `scrapeWorkspaceTree()` (reads `document`, returns
   `{workspaces:[{name, sessions:[{id,title}]}]}`-shape matching what content.js returns
   today — keep the EXACT existing return shape so panel.js needs no data-shape changes),
   `openSession(sessionId)`, `expandGroup(...)`, `overlayOpen()`, `overlayClose()` —
   each doing the same DOM work content.js does today (overlayClose must replicate the
   full teardown: remove overlay element + anchor, cancel rAF, remove keydown-capture
   listener, clear status).
   - SW loading: check sw.js module type in manifest. Classic service worker →
     `importScripts('scraper.js')` at top; if module → dynamic `import('scraper.js')`.
     (Do NOT change manifest `background` type if avoidable; importScripts on a classic
     worker is the low-risk path.)
   - content.js keeps working unchanged for real tabs (do not delete its logic; it may
     delegate to the same DOM code later, but for this task: leave content.js handlers as
     the fallback path, only ADD the injected-function equivalents in scraper.js).
2. **sw.js routing**: in each of the 4 message handlers, FIRST try the panel-frame path:
   discover frame (recipe above) → `executeScript` with the matching scraper.js function →
   return its result to the panel. If no panel frame found (panel closed / iframe not
   loaded), fall back to the existing `findGuiTabId()` + content-script path with today's
   status texts. Keep `chrome-eye:panel-open`/`panel-closed` tracking working.
3. **panel.js overlay toggle (T12.2)**: track `wsOverlayOpen` (set from the open/close
   result). `#ws-overlay-btn` click: if `wsOverlayOpen` → send `chrome-eye:overlay
   {open:false}`; else `{open:true}`. Update the button text/state and the status text
   accordingly. Do NOT add/remove elements in panel.html (another agent owns it); only
   textContent/classList changes in panel.js are allowed.
4. Keep ALL existing message names, capture flow, and `guiTabRoundTrip` behavior intact.

## Hard constraints
- Modify ONLY `extension/` files (sw.js, content.js, panel.js, new scraper.js).
- Read-only: `test/*`, `bridge/`, the DSH checkout
  (`/mnt/f/npm-global/lib/node_modules/@deepseek-ai/dsh/`), `PLAN.md`, `CP-3.5.md`,
  `DETAILED-PLAN.md`.
- NO manifest changes (no new permissions; no background-type flip unless strictly
  required — if you flip to module, say so loudly in your progress file).
- Do not run `test/run.sh`. Do not start/kill the bridge. Do not POST session ids to :3081.
- Plain JS only; no TypeScript; no JSX.

## PERSIST-PROTOCOL (MANDATORY FIRST ACTIONS, before touching extension/*)
1. Create `scratch-t12/A-progress.md` with: task outline (the numbered changes above),
   current status (NOT STARTED), and your plan for each change.
2. `mkdir -p scratch-t12/backup-A` and copy `extension/sw.js extension/content.js
   extension/panel.js` there (originals, byte-exact).
3. After EVERY step (each file changed, each check run), update A-progress.md: what was
   done, what remains, next step. This file is the resume artifact — a crash must lose
   nothing.

## Acceptance (report all in your final message)
- `node --check` passes on sw.js, content.js, panel.js, scraper.js (run it; paste output).
- Logic trace in A-progress.md: message flow for "no :3080 tab open" (panel-frame path)
  and for "panel closed" (fallback path) — name the exact functions/lines.
- Return-shape parity: injected scraper returns the SAME shape content.js returns today
  (quote both).
- Overlay close teardown checklist verified against content.js L634–812 (element removal,
  rAF cancel, listener removal).
- Open questions / risks for the facilitator + the exact user e2e steps for final
  verification (T12.6): fresh Chrome profile → open panel → click "Workspaces ▾" with no
  other :3080 tab → expect the panel's own GUI workspaces; click a session → opens in the
  panel; click "⛶ workspace" → overlay opens in panel; click it AGAIN → overlay closes.
