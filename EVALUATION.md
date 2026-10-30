# Chrome Eye vs Gemini Chrome Extension — Feature Parity & Agent Control Evaluation

## 1. Feature Comparison Matrix

| Feature | Gemini Chrome Extension | Chrome Eye (Current) | Notes |
|---------|------------------------|---------------------|-------|
| **Side Panel UI** | ✅ Chat sidebar | ✅ DSH GUI embedded in panel | Gemini: lightweight chat. Chrome Eye: full DSH session context |
| **"Type @ to add tabs"** | ✅ Select tabs to share | ✅ "Add tabs" dropdown (checkable rows) | Both let user select tabs to share. Chrome Eye adds "→ Add to session" confirmation |
| **Screenshot capture** | ✅ Via AI request | ✅ `screenshot` action → base64 PNG | Chrome Eye returns inline base64 (no disk), Gemini sends to cloud |
| **Page text extraction** | ✅ Via AI request | ✅ `readPage` action + `getPageText` | Chrome Eye extracts DOM text. Gemini uses its own page parser |
| **Tab listing** | ✅ In sidebar | ✅ `listTabs` tool | Chrome Eye returns tab id/url/title/active/pinned |
| **Auto Browse** (agent controls browser) | ✅ Fill forms, navigate, click | ✅ `driveType`, `driveGetPageText`, `click`, `navigate` | Gemini: cloud AI controls. Chrome Eye: local agent controls |
| **Multi-tab comparison** | ✅ Summarize multiple tabs | ✅ "Add tabs" → capture staged tabs | Both can share multiple tabs |
| **Form filling** | ✅ Auto-fill from PDF/context | ✅ `driveType` with selectors | Gemini infers form fields. Chrome Eye needs CSS selectors |
| **Page summarization** | ✅ Native | ✅ Via prompt + page text/screenshot | Gemini: built-in. Chrome Eye: agent reads page then summarizes |
| **Session persistence** | ❌ No | ✅ Workspaces & Sessions | Chrome Eye saves conversations |
| **Context chips** | ✅ Visual tabs strip | ✅ Chip strip in GUI sidebar | Gemini: simple chips. Chrome Eye: chips in DSH sidebar |
| **Overlay/highlighter** | ❌ No | ✅ "⛶ workspace" overlay | Chrome Eye: DOM overlay for workspace context |
| **Multi-window** | ❌ Single window | ✅ Cross-window tab selection | Chrome Eye handles tabs across windows |
| **Content script injection** | ✅ Dynamic | ✅ Dynamic (best-effort fallback) | Chrome Eye injects content.js if missing |
| **Local processing** | ❌ Cloud (Google) | ✅ All local | Chrome Eye: no data leaves machine |
| **Model selection** | ✅ Gemini models | ✅ DSH models (any provider) | Chrome Eye: any LLM backend |
| **Image injection** | ✅ In chat | ✅ `presentResult` attaches image | Chrome Eye: base64 inline in tool result |

## 2. Chrome Eye Advantages Over Gemini

1. **Local-first**: All processing happens locally — screenshots, DOM extraction, AI inference. No cloud dependency.
2. **Multi-model**: Works with any DSH-connected model (local Ollama, OpenRouter, DeepSeek, etc.) vs Gemini's Google models.
3. **Full DSH integration**: Sessions, workspaces, subagents, tools — Chrome Eye is part of a complete agent ecosystem.
4. **No data loss**: Screenshots stay in memory, DOM text stays in context. No cloud upload.
5. **Agent-driven**: The agent can actively drive the browser (click, type, navigate) vs Gemini's passive analysis.
6. **Open**: Pure files, no build step, loaded unpacked. Easy to customize.
7. **Cross-window**: Handles tabs across multiple Chrome windows.
8. **Customizable**: Content scripts, panel, SW — all editable.

## 3. Gemini Advantages Over Chrome Eye

1. **Auto Browse UX**: Gemini's "auto browse" is more discoverable — users just ask "fill this form with info from this PDF" and it figures out the selectors.
2. **Form field inference**: Gemini detects form fields automatically. Chrome Eye needs explicit CSS selectors.
3. **Page summarization**: Gemini has built-in summarization. Chrome Eye returns raw DOM text or screenshot — the agent must summarize.
4. **Simplicity**: Gemini's sidebar is lightweight. Chrome Eye's panel has more UI (tabs, workspaces, overlay).
5. **Context awareness**: Gemini knows the full page context including rendered JavaScript. Chrome Eye gets DOM text + screenshot (same but more explicit).

## 4. Agent-Driven Browser Control Evaluation

### 4.1 Current Agent Capabilities (via Chrome Eye)

The agent (running in DSH) can:

| Action | Tool | Description |
|--------|------|-------------|
| **Screenshot** | `chrome-eye.screenshot()` | Capture active tab → inline PNG in tool result |
| **Read Page** | `chrome-eye.readPage({tabId})` | Capture specific tab: screenshot + DOM text |
| **List Tabs** | `chrome-eye.listTabs()` | Get all tab IDs for targeting |
| **Click** | `chrome-eye.click({selector})` | Click element by CSS selector |
| **Type** | `chrome-eye.type({selector, text})` | Type text into element |
| **Navigate** | `chrome-eye.navigate({url})` | Navigate tab to URL |
| **Drive Type** | `chrome-eye.driveType({selector, text})` | Type with enter/clear options |
| **Drive GetPageText** | `chrome-eye.driveGetPageText()` | Get page text from specific tab |
| **Get Element Rect** | `chrome-eye.getElementRect({selector})` | Return x, y, width, height of element — for vision model bounding boxes |
| **Auto Form Fill** | `chrome-eye.autoFormFill({formData})` | Fill form fields by name/label/placeholder matching |

### 4.2 Browser Control Scenarios

#### Scenario A: "Fill this form for me"
```
1. agent.listTabs() → find tab with form
2. agent.readPage({tabId}) → get page text + screenshot
3. agent.type({selector: "#name", text: "John Doe"})
4. agent.type({selector: "#email", text: "john@example.com"})
5. agent.click({selector: "#submit"})
```
**Verdict**: ✅ Works, but requires the agent to infer CSS selectors from page text or screenshot.

#### Scenario B: "Book a flight from this airline page"
```
1. agent.readPage({tabId}) → get page content
2. agent.click({selector: "#departure"}) → open date picker
3. agent.type({selector: "#departure-date", text: "2025-01-15"})
4. agent.click({selector: "#search-flights"})
5. agent.readPage({tabId}) → verify results
```
**Verdict**: ✅ Works if selectors are known or can be inferred.

#### Scenario C: "Compare these 3 tabs and tell me which is cheaper"
```
1. agent.listTabs() → get all tab IDs
2. agent.readPage({tabId: tab1}) → page 1 screenshot + text
3. agent.readPage({tabId: tab2}) → page 2 screenshot + text
4. agent.readPage({tabId: tab3}) → page 3 screenshot + text
5. Agent compares results → response
```
**Verdict**: ✅ Works well — user can select tabs in panel, agent reads each one.

#### Scenario D: Agent controls browser autonomously (self-help)
```
User: "Check my email inbox"
Agent:
1. Navigate to gmail.com
2. Wait for page load
3. Take screenshot
4. Click "Inbox" button
5. Take screenshot
6. Summarize visible emails
```
**Verdict**: ✅ Works, but requires:
- Page load detection (timeout-based)
- Screenshot analysis for element locations
- Error handling for dynamic content

### 4.3 Gap Analysis: What's Needed for Full Agent Control

| Gap | Current State | Needed |
|-----|--------------|--------|
| **Element location from screenshot** | Agent gets screenshot but no element coordinates | Need OCR/vision model to locate clickable elements |
| **Form field detection** | Manual selectors | Auto-detect form fields from DOM structure |
| **Page load detection** | Manual timeout | Detect DOM ready / network idle |
| **Error recovery** | Manual retry | Auto-detect stale elements, reload |
| **Multi-step workflows** | Manual chaining | Agent orchestrates sequences |
| **Dynamic content** | DOM snapshot at capture time | Wait for JS-rendered content |

### 4.4 Recommended Additions for Full Agent Control

1. **`chrome-eye.getElementRect({selector})`** — Return element's x, y, width, height from content script
   - Enables vision models to place bounding boxes on screenshots
   
2. **`chrome-eye.waitForSelector({selector, timeout})`** — Poll for element presence
   - Handles dynamic content loading
   
3. **`chrome-eye.autoFormFill({formData})`** — Map form data to fields
   - Smart field matching by label/placeholder/id
   
4. **`chrome-eye.pageReady()`** — Return DOM ready state
   - Tell agent when page is loaded before taking actions

5. **Vision-based element detection** — Content script returns element tree with coordinates
   - Agent's vision model can "see" clickable elements on screenshot

## 5. Image Flow Verification

### Current Flow (no disk)
```
Agent calls chrome-eye.screenshot()
  → POST /cmd?action=screenshot
  → Extension SW captures PNG
  → SW POSTs {id, result:{image:"base64..."}} to /cmd/result
  → Bridge stores in pending store (memory only)
  → Agent polls GET /cmd?cmd=<id>
  → Gets {status:"done", result:{image:"base64...", url, title}}
  → Tool's presentResult() attaches {type:"image", data:"base64..."}
  → Image appears inline in agent's prompt context
```

### Verified Properties
- ✅ No disk writes — images in bridge's in-memory pending store only
- ✅ 2-minute TTL on pending entries (auto-cleaned)
- ✅ Base64 inline in tool result — agent sees image directly
- ✅ `presentResult()` attaches image as first item in result
- ✅ Tab restoration after capture works (original tab restored)

## 6. Tab Injection Verification

### User Flow (via panel)
```
1. User opens panel
2. Clicks "Add tabs" → dropdown shows all browser tabs
3. User checks tabs to share
4. Clicks "→ Add to session"
5. SW stages selected tabs
6. When user submits prompt in DSH GUI, staged tabs are captured
7. Staged tabs appear as context chips in sidebar
8. Agent can then read each staged tab by ID
```

### Agent Flow (via tools)
```
1. Agent calls chrome-eye.listTabs()
2. Gets list with tab IDs
3. Agent calls chrome-eye.readPage({tabId: N})
4. Gets screenshot + DOM text for that specific tab
5. Tab is restored after capture
```

### Verified Properties
- ✅ User can select specific tabs to share
- ✅ Agent can target any tab by ID
- ✅ Tab restoration preserves user's browsing context
- ✅ Staged tabs clear after one use (one-shot)

## 7. Recommendations

### High Priority
1. **Add `chrome-eye.getElementRect({selector})`** — Enables vision-based element targeting
2. **Add `chrome-eye.autoFormFill({formData})`** — Simplifies form filling for agents
3. **Document the tool API** — Agents need to know what tools exist and how to use them

### Medium Priority
4. **Add `chrome-eye.pageReady()`** — Let agent know when page is loaded
5. **Improve selector inference** — Agent should be able to guess selectors from page text
6. **Add screenshot annotation** — Draw rectangles on screenshot showing clickable elements

### Low Priority
7. **Multi-tab comparison UI** — Visual comparison of staged tabs
8. **History of past captures** — Review previous screenshots
9. **Export captures** — Download screenshots to disk if needed

## 8. Conclusion

Chrome Eye is **more capable** than Gemini in agent-driven browser control:
- **Local processing** (no cloud dependency)
- **Multi-model** (any LLM backend)
- **Full DSH integration** (sessions, workspaces, subagents, tools)
- **No data loss** (in-memory only)

The main gap is **discoverability of page elements** — Gemini auto-infers form fields and clickable elements, while Chrome Eye requires the agent to know CSS selectors. Adding `getElementRect()` and improving selector inference would close this gap.

For the **agent self-help** goal (agent controlling browser to do tasks for the user), Chrome Eye is already functional. The agent can:
- List tabs → read pages → click elements → type text → navigate
- With vision model integration, the agent can also see rendered pages and locate elements visually

The combination of screenshot + DOM text + drive actions gives the agent full visibility and control of the browser.
