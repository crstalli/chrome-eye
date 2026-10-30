# Chrome Eye

Chrome Eye is a Chrome MV3 extension that embeds the real DSH GUI
(`http://127.0.0.1:3080`) in a Chrome side panel. Because the panel just iframes
the actual GUI, it shares the same backend session as any desktop browser on the
same machine — pick a session in the sidebar and the same conversation, model,
permissions, and streaming responses are visible and editable in both places.
On top of that, while the side panel is open a **context chip row** appears at
the top of the embedded GUI: the current tab is staged as a chip automatically
(✕ removes it, **+** stages more tabs from the window), and **→ add to session**
sends each staged page's visible text (plus a screenshot for the active tab)
into the session you are viewing — `/share` with `sessionId` → `session.prompt`
queue — so the model sees those pages on your next prompt.

## How it fits together

- `extension/` — the MV3 extension (loaded unpacked from Windows).
  `panel.html`/`panel.js` wrap the GUI in an iframe + bottom actions bar;
  `content.js` extracts the page; `sw.js` (service worker) captures the tab and
  screenshots it; `options.html`/`options.js` store the server URL
  (`chrome.storage.sync` key `dshUrl`) and test reachability.
- `bridge/` — a tiny pure-Node loopback proxy on `127.0.0.1:3081` (runs in
  WSL). Extension-originated calls to the DSH API are blocked by the trust
  fence, so the service worker always POSTs to the bridge (`/share`), which
  forwards to `:3080/api` without an `Origin` header. The iframe's own traffic
  goes straight to `:3080` unmodified.

## Windows install (step by step)

1. **Start the bridge** in a WSL terminal and keep it running:

   ```bash
   node /mnt/f/ai/chrome-eye/bridge/bridge.mjs
   ```

   Verify with `curl http://127.0.0.1:3081/health` → `{"ok":true}`.

2. **Load the extension** in Chrome: open `chrome://extensions` → enable
   **Developer mode** → **Load unpacked** → select `F:\ai\chrome-eye\extension`.

3. **Start the DSH GUI** (in WSL) so `http://127.0.0.1:3080` is up:

   ```bash
   dsh web
   ```

4. **Open the side panel** on any tab (click the Chrome Eye icon in the
   toolbar → pin/open side panel). The embedded GUI shows a **chip row** at
   the top: the active tab becomes a chip automatically (add more with "+").
   Press **→** on a chip to share — the page's text (+ screenshot, if the
   target tab is active) lands in the session the GUI is showing. To switch
   sessions, use the always-present **"Workspaces ▾"** dropdown in the bottom
   bar, or **⛶ workspace** for the full-size overlay over the GUI chat window.

5. **Options page** (right-click the extension → Options): set the **DSH
   Server URL** (defaults to `http://127.0.0.1:3080`) and press **Test
   Connection** — ✅ Connected / ❌ Unreachable is shown next to the button.
   The URL is persisted in `chrome.storage.sync`.

## Troubleshooting

- **Share fails with a network error** — the bridge is not running (or is on a
  different port). Start it: `node /mnt/f/ai/chrome-eye/bridge/bridge.mjs`; the
  chip share reaches `http://127.0.0.1:3081/share` only.
- **`403` on `:3080/api`** — this is the DSH trust fence, working as designed:
  requests carrying `Origin: chrome-extension://…` are rejected. Extension
  calls must go through the bridge (step 1), never directly to `:3080/api`.
- **No screenshot in the shared payload (text only)** —
  `chrome.tabs.captureVisibleTab` can only capture the *active* tab. Make the
  target tab active, then press **→** on its chip. The text is still captured
  from the active tab.
- **GUI on a different port** — update the server URL on the options page
  (e.g. `http://127.0.0.1:3090`) and re-test. If the *bridge* target also
  changes, that is a bridge-side configuration concern.
