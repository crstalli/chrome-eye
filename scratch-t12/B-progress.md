# B-progress — T12.3 (+F5): Restyle panel chrome to DSH dark theme

Status: DONE — CSS written + verified; final report sent to parent
User note (this session): "I'm always going to use dark mode" → pure dark, NO light fallback.

## Task outline (from brief-B.md)
1. MANDATORY: read brief-B.md ✔, read extension/panel.html ✔
2. MANDATORY: create B-progress.md (this file) + backup-B/panel.html ✔
3. Extract REAL DSH theme tokens (name, hex, source file:line) ✔
4. Rewrite the `<style>` block in extension/panel.html ✔
5. Checks: ids present (grep + list), no #ffffff/#f0f0f0/#ccc in chrome CSS,
   before/after palette summary, open items, user visual check. (in progress)

## Token source (READ-ONLY, authoritative)
- Package: `@deepseek-ai/dsh-client-ui-theme` (the REAL theme package;
  `dsh-brand` is only nominal typing helpers — NOT the theme).
- File: `/mnt/f/npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/
  @deepseek-ai/dsh-client-ui-theme/lib/client.js`
- `design_platform_css_default` = **client.js:1053**. Inside it:
  - static scale: `body` block (73 vars)
  - light alias:  `body` block (89 vars)
  - **dark alias: `body[data-ds-dark-theme]` block (89 vars) ← used**
- Dark theme is selected via the `body[data-ds-dark-theme]` attribute
  (NOT `:root`). `DEFAULT_PREFERENCE = "system"` (client.js:888).
- Extracted artifacts: scratch-t12/tokens/design-platform.css (+ .json, 4 blocks).

## Extracted DARK tokens (resolved) — token | hex | usage here
| token | resolved | used for |
|---|---|---|
| --dsw-alias-bg-base | #151517 (neutral-bluish-950) | iframe/GUI base (context, not set here) |
| --dsw-alias-bg-layer-1 | #232324 (neutral-bluish-875) | **#bottom-bar** bg |
| --dsw-alias-bg-layer-3 | #353638 (neutral-bluish-800) | **#ws-dropdown** bg |
| --dsw-alias-bg-module-platform | #353638 (neutral-bluish-800) | **#ws-controls button** base bg |
| --dsw-alias-border-l2 | #ffffff1f → rgba(255,255,255,.12) | #ws-dd-head border |
| --dsw-alias-border-l3 | #ffffff29 → rgba(255,255,255,.16) | bar top border, button border |
| --dsw-alias-border-l4 | #fff3 (= #ffffff33) → rgba(255,255,255,.2) | dropdown border (F5), button hover border |
| --dsw-alias-label-primary | #f9fafb (neutral-bluish-50) | title / button text / dd-body rows |
| --dsw-alias-label-secondary | #cfd3d6 (neutral-bluish-300) | bar base text / #share-status |
| --dsw-alias-label-tertiary | #adb2b8 (neutral-bluish-400) | #ws-dd-status base |
| --dsw-alias-button-elevated-fill | #43454a (neutral-bluish-750) | button hover bg |
| --dsw-alias-scrollbar-bg-l1 | #3c3c3d (neutral-700) | dd scrollbar thumb |
| --dsw-alias-scrollbar-hover-l1 | #545557 (neutral-600) | dd scrollbar thumb hover |
| --dsw-alias-state-success-primary | #22c55e (green-500) | (reference) |
| --dsw-alias-state-error-primary | #f25a5a (red-400) | (reference) |
| --dsw-alias-brand-primary-new-colorprimary-new-color | #5686fe (deepseek-450) | (reference, accent) |

NOTE on borders: dark border tokens ship as white+alpha; written as
rgba(255,255,255,α) (identical color) so the chrome CSS contains NO literal
`#ffffff`. Original token hex cited in CSS comments for traceability.

## Design decisions
- Pure dark, no @media light fallback (user: always dark).
- Elevation hierarchy: iframe #151517 < bar #232324 (layer-1) <
  buttons+dropdown #353638 (layer-3) → clear chrome/interactive separation.
- F5: dropdown = #353638 + 20%-white border (border-l4) + strong black shadow
  (0 2px 6px rgba(0,0,0,.45), 0 10px 28px rgba(0,0,0,.55)) over near-black
  iframe → strong contrast.
- No new classes needed (styled by existing stable ids → minimal diff, ids stable).
- Did NOT touch: body/html, #dsh-iframe (calc(100% - 60px)), DOM, any js.

## Steps
- [x] Read brief + panel.html
- [x] Backup original → scratch-t12/backup-B/panel.html
- [x] Extract tokens (table above)
- [x] Write new CSS in panel.html
- [x] Verify ids + grep for forbidden hexes
  - ids: all 11 present exactly once (dsh-iframe, bottom-bar, share-status,
    ws-controls, ws-overlay-btn, ws-tree-btn, ws-dropdown, ws-dd-head,
    ws-dd-title, ws-dd-status, ws-dd-body)
  - forbidden: grep -Ei '#(ffffff|f0f0f0|ccc)([^0-9a-f]|$)' → none (PASS);
    #ccc/#eee/#bbb/#f5f5f5 clean; only #666/#151517 appear in COMMENTS
  - #dsh-iframe calc(100% - 60px) untouched; DOM (lines 140-161) untouched;
    CSS braces balanced 17/17; diff vs backup: 11 lines removed, 53 added
- [x] Update progress + final report (send_message to parent)
- [x] FOLLOW-UP (user screenshot feedback): mojibake in button labels
  ("Workspaces â¬¾", "â†† close overlay"). Root cause: panel.html had NO
  <meta charset> at all → browser fell back to windows-1252 and decoded the
  UTF-8 file's multibyte glyphs as Latin-1 (also affected panel.js string
  literals, since external scripts fall back to the document encoding).
  Fix: added `<meta charset="utf-8">` as first element of <head> (line 4,
  within the first 1024 bytes). Verified: file+js valid UTF-8 on disk
  (iconv PASS), glyphs ▾ ⛶ ✕ present, meta within 1024-byte window.
  panel.html-only change; no other files touched.

## Open items (for facilitator / agent A — panel.js owns these, B must not edit)
panel.js injects LIGHT-theme inline colors that will clash on the now-always-dark chrome:
- #share-status inline green #1a7f37 / red #b00020 (setStatus) — low on dark bar.
- #ws-dd-status inline #666 (non-error) — low on dark.
- dropdown body rows (buildWsTree): project head color #555 (very low);
  current-session row background rgba(26,127,55,.10) + color #116329 (dark green,
  near-invisible); row hover background #f0f4ff (light-blue patch on dark);
  error text #b00020.
Recommend: agent A switches these injected values to the dark state tokens above
(success #22c55e / error #f25a5a, row hover rgba(255,255,255,.08), head #cfd3d6).
