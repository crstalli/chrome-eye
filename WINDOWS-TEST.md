# Chrome Eye — Windows Acceptance Checklist

One sitting, ~15 min. You need three windows open: **WSL terminal #1** (GUI),
**WSL terminal #2** (bridge), **PowerShell** (verifications). Task tags in
parentheses refer to `DETAILED-PLAN.md`.

## A. Preconditions

1. **WSL #1:** start the DSH GUI if it is not already running: `dsh web`.
   Verify: `curl -sI http://127.0.0.1:3080 | head -1` → `HTTP/1.1 200`.
2. **PowerShell:** verify the GUI is reachable from Windows:
   `curl.exe -sI http://127.0.0.1:3080` → `HTTP/1.1 200`.
   (Use `curl.exe` — bare `curl` in PowerShell is an alias for Invoke-WebRequest.)
3. **WSL #2:** start the bridge:
   `node /mnt/f/ai/chrome-eye/bridge/bridge.mjs`
   (same file as Windows path `F:\ai\chrome-eye\bridge\bridge.mjs`).
   Expect log line: `chrome-eye bridge listening on http://127.0.0.1:3081`.
4. **PowerShell:** `curl.exe http://127.0.0.1:3081/health` → `{"ok":true}` (T9.2).

## B. Load the extension

5. **Chrome:** open `chrome://extensions` → enable **Developer mode** (top right)
   → **Load unpacked** → select `F:\ai\chrome-eye\extension`.
   Accept: card appears with **no** manifest errors (T4.8, T9.1).
6. Click the **puzzle icon** → pin **Chrome Eye** to the toolbar.

## C. Side panel

7. Click the pinned **Chrome Eye** icon on any tab. The side panel opens.
8. Accept (T5.1): the **real DSH GUI renders inside the iframe** — sidebar,
   sessions, and login state intact, identical to the desktop view.
9. Accept (T5.2): a **60px bottom bar** sits below the iframe with the
   **Share this page** button; at narrow panel width there is **no horizontal
   scroll**. Note any layout breakage (feeds T5.4).
10. (T5.3, quick session-sharing proof) Open `http://127.0.0.1:3080` in a
    normal desktop browser tab, pick the same session, type a short prompt in
    the desktop browser → it appears in the panel's GUI too. (T9.4: type in the
    panel instead and watch the desktop browser stream the same response.)

## D. Share flow

11. Open any real web page (e.g. a news article) in a normal tab and make that
    tab **ACTIVE** (click it so it is focused).
12. **WSL #1:** `date +%s` — note the number (call it `TS`).
13. In the panel, click **Share this page**.
    Accept (T9.3): green status next to the button:
    `Shared "<page title>" (text + screenshot) → bridge HTTP 200`.
14. **WSL #1:** `ls -lt /mnt/f/ai/chrome-eye/captures/ | head -3`
    → a new file `<ts>.json` whose name ≈ `TS` (within a few seconds).
15. **WSL #1:** `cat /mnt/f/ai/chrome-eye/captures/<ts>.json | head -30`
    → JSON with `url`, `title`, `visibleText`, `links`, `headings`, and
    `image` (base64 PNG) — `visibleText` should contain words from the page.

## E. Failure mode: bridge down

16. **WSL #2:** press `Ctrl+C` to stop the bridge.
17. Click **Share this page** again.
    Accept: **red** status `Share failed: <error>` (network error).
18. **WSL #2:** restart with `node /mnt/f/ai/chrome-eye/bridge/bridge.mjs`.
    **PowerShell:** `curl.exe http://127.0.0.1:3081/health` → `{"ok":true}`.
    Click **Share this page** once more → green `... bridge HTTP 200` again.

## F. Options page

19. **Chrome:** right-click the Chrome Eye icon → **Options** (or
    `chrome://extensions` → Details → Options). Set **DSH Server URL** to
    `http://127.0.0.1:3999` → **Test Connection**.
    Accept: `❌ Unreachable — http://127.0.0.1:3999 (...)`.
20. Restore `http://127.0.0.1:3080` → **Test Connection** →
    `✅ Connected — http://127.0.0.1:3080`.

## G. Control parity

21. (T9.5) In the panel's embedded GUI: select a **different session** in the
    sidebar, check the model / permissions controls, and run one prompt.
    Accept: each control behaves identically to the standalone UI.

---

## Known limitations (expected, not failures)

- **Share falls back to `captures/` only when no session is open.** While a
  session is open in the panel's GUI, shares (the context chip row → `/share`)
  carry that `sessionId` and are injected via `session.prompt` (queue mode);
  with no session open, the bridge writes `captures/<ts>.json` instead.
- **Screenshot requires the target tab to be ACTIVE**
  (`chrome.tabs.captureVisibleTab` can only capture the active tab). If the
  screenshot is missing, the payload still contains the text.
- **No session deep-linking.** The iframe always loads `http://127.0.0.1:3080`
  root; to view a specific session, click it in the GUI sidebar inside the panel.
- **Options Test Connection** probes the GUI root directly (any HTTP response
  counts as Connected), not the bridge.
