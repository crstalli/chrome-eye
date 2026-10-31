# Brief B — T12.3 (+F5): Restyle panel chrome to the DSH dark theme (owns panel.html ONLY)

## Mission
The side panel's bottom bar, its buttons, and the "Workspaces ▾" dropdown are light
(`#f0f0f0` bar, `#ffffff` dropdown, white buttons) sitting on top of the DARK DSH GUI —
"pretty ugly and doesn't match the dsh css" + "Workspaces doesn't have contrast". Restyle
the panel chrome to a dark palette sourced from REAL DSH theme tokens so the panel looks
like part of the GUI.

**VISUAL TARGET (user order: "make sure this plugin works like the gemini plugin"):**
Read `scratch-t12/gemini-reference.png` with the read_image tool BEFORE writing CSS.
It shows the Gemini Chrome plugin: dark full-height chat; a slim DARK bottom bar holding
a "👁 Sharing '…'" chip (with its own subtle border/bg, plus a × close), a
"Type @ to add tabs" input, a + button, a model selector ("Flash-Lite"), a voice icon.
Match that DENSITY and DARKNESS: the panel's bottom bar should read as a quiet dark strip
(one subtle border, muted labels, compact clickable chips/buttons), NOT a bright gray band.

## Context (verified)
- File to modify: `extension/panel.html` ONLY. Current chrome (from the file):
  - `#dsh-iframe` → `http://127.0.0.1:3080`, `height: calc(100% - 60px)` (do NOT touch).
  - `#bottom-bar`: 60px tall, `background:#f0f0f0`, `border-top:1px solid #ccc`, contains
    `#share-status` (status text; JS sets green `#1a7f37` / red `#b00020` via panel.js),
    `#ws-controls` with `#ws-overlay-btn` ("⛶ workspace") + `#ws-tree-btn` ("Workspaces ▾").
  - `#ws-dropdown`: `position:absolute; bottom:64px; right:10px; width:320px;
    max-height:420px; background:#ffffff`, with `#ws-dd-head`/`#ws-dd-title`/
    `#ws-dd-status`/`#ws-dd-body`.
- panel.js (owned by ANOTHER agent, do not touch) sets `#share-status` color inline
  (`#1a7f37` green / `#b00020` red) and toggles `#ws-dropdown` visibility; keep those
  element IDs and the inline-color behavior working.
- DSH checkout (READ-ONLY): `/mnt/f/npm-global/lib/node_modules/@deepseek-ai/dsh/`. Real
  client bundle tree under `.../dsh/node_modules/@deepseek-ai/dsh-*/lib/`.

## Extract REAL DSH tokens first (do this before writing any CSS)
0. **Coordinator head-start (2026-09-12, verified):** the theme package is
   `dsh-client-ui-theme/lib/client.js`. Static palette (on `body`, in
   `design_platform_css_default`, ~L1053): `--dsw-static-neutral-00:#fff; -100:#f5f5f5;
   -150:#ededed; -200:#e5e5e5; -250:#dcdcdc; -300:#d4d4d4; -400:#a2a4a6; -500:#7f8287;
   -50:#fafafa; -550:#65676b; -1000:#000`; `--dsw-static-deepseek-500:#4176e6` (brand);
   `--dsw-static-green-400:#4ed17e; -500:#22c55e`; `--dsw-static-amber-400:#f7ad31;
   -500:#f59e0b`; `--dsw-static-blue-450:#4d93f8; -500:#3b82f6; -600:#2563eb`;
   `amber-900:#27241f`; `green-900:#233c2c`. The GUI CSS consumes ALIAS tokens
   (`--dsw-alias-border-l1/-l2/-l4`, `--dsw-alias-label-primary/-secondary/-tertiary/
   -caption`, `--dsw-alias-brand-primary`, `--dsw-alias-interactive-bg-hover`,
   `--dsw-alias-bg-module-platform` (sidebar/title-row bg), `--dsw-alias-bg-layer-1`,
   `--dsw-alias-state-error/-success/-warn-primary`); alias descriptors start ~L1165–1218.
   **YOUR job:** find the DARK-theme block (the theme resolves aliases to concrete hexes
   per theme; the dark block is below the static palette in the same file) and record the
   dark-resolved hex of each alias you actually use. The extension panel is a separate
   page — it CANNOT read the iframe's CSS variables — so you MUST hardcode the final hex
   values in panel.html's `<style>`, with a comment citing the alias + source file:line.
1. In the checkout, find theme/brand packages: look for `dsh-brand`, and any `dsh-client-*`
   / `dsh-theme*` packages. Grep for CSS custom properties (`--` names) and hex colors,
   especially dark-surface tokens, border tokens, text tokens, accent/primary, and
   success/error tokens.
2. Record the exact tokens + hex values + source file:line in your progress file. Prefer
   tokens the GUI actually uses for its dark theme. If the GUI is served with a dark
   default, mirror those exact values (bar background, panel background, borders, text
   primary/secondary, accent, success, danger).
3. If a token isn't cleanly extractable, derive the closest value from the brand palette
   and note it as "derived" with rationale. Do NOT invent arbitrary colors when a real
   token exists.

## Changes (panel.html only)
- `#bottom-bar`: dark background (DSH surface token, NOT `#f0f0f0`), subtle 1px top border
  using a DSH border token (NOT `#ccc`), text color = DSH text token.
- `#ws-overlay-btn` + `#ws-tree-btn`: dark button styling — DSH surface/border/accent;
  hover state using a DSH hover token; keep them clearly clickable.
- `#ws-dropdown` + `#ws-dd-*`: dark background (DSH elevated/surface token, NOT
  `#ffffff`), DSH border + shadow, scroll area styled (dark scrollbar if feasible).
  Ensure the dropdown has strong contrast against the GUI behind it (this is F5).
- Status text: the inline green/red set by panel.js may clash on dark; if so, adjust the
  BASE color via CSS so both remain readable, but do NOT edit panel.js. (You may add
  `color` overrides scoped to `#share-status` that panel.js's inline styles will still
  win — so if the inline red/green is unreadable on the new dark bar, note it as an open
  item for the facilitator to reconcile with agent A; do NOT fight it with !important
  hacks.)
- New classes must be prefixed `ce-`. Keep EVERY existing id stable:
  `#dsh-iframe #bottom-bar #share-status #ws-controls #ws-overlay-btn #ws-tree-btn
  #ws-dropdown #ws-dd-head #ws-dd-title #ws-dd-status #ws-dd-body`. Do NOT remove or
  rename elements or ids; do NOT restructure the DOM hierarchy in a way that breaks
  panel.js selectors.

## Hard constraints
- Modify ONLY `extension/panel.html`. Do not touch panel.js, sw.js, content.js, scraper.js
  (another agent owns them and is editing them in parallel).
- Read-only: everything else (test/*, bridge/, DSH checkout, all .md docs).
- No manifest changes. No new external assets/CSS files unless truly needed (prefer
  inline `<style>` in panel.html so it stays one file). No build step.
- Do not run `test/run.sh`. Do not start/kill the bridge.

## PERSIST-PROTOCOL (MANDATORY FIRST ACTIONS, before touching panel.html)
1. Create `scratch-t12/B-progress.md`: task outline, token-extraction plan, status
   (NOT STARTED).
2. `mkdir -p scratch-t12/backup-B` and copy `extension/panel.html` there (original).
3. After each step (token extraction done; CSS written; checks run), update B-progress.md.
   This file is the resume artifact.

## Acceptance (report all in your final message)
- `node --check` does not apply to HTML; instead: confirm all listed ids still present
  (grep the file; paste the id list).
- Paste the extracted DSH tokens (name, hex, source file:line) you used.
- grep confirms NO `#ffffff`, `#f0f0f0`, or `#ccc` remain in the panel chrome CSS.
- Before/after summary of the palette.
- Open items for the facilitator (e.g. inline green/red status color reconciliation with
  agent A; any token you had to derive).
- Exact user visual check: open panel, confirm bottom bar + buttons + dropdown are dark
  and match the GUI; confirm dropdown contrast is good over the GUI.
