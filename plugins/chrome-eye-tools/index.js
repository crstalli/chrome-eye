// @local/chrome-eye-tools
//
// Chrome Eye tools: screenshot, readPage, listTabs, getElementRect,
// autoFormFill, click, type, navigate, getPageText.
// Each tool POSTs to the bridge /cmd endpoint, polls /cmd?cmd=<id>,
// and returns the result to the agent.
// No disk writes — images stay in the bridge's in-memory pending store.
//
// Bridge URL: reads CHROME_EYE_BRIDGE_URL env var (set by chrome-eye-bridge plugin),
// falls back to CHROME_EYE_BRIDGE_PORT env var (port only), or hardcoded default.

const BRIDGE = process.env.CHROME_EYE_BRIDGE_URL ||
  `http://127.0.0.1:${process.env.CHROME_EYE_BRIDGE_PORT || 3081}`;

function mintId() {
  return 'ce-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function pollResult(id, timeoutMs) {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const timer = setInterval(async () => {
      try {
        const r = await fetch(`${BRIDGE}/cmd?cmd=${encodeURIComponent(id)}`);
        if (!r.ok) { clearInterval(timer); reject(new Error(`bridge ${r.status}`)); return; }
        const j = await r.json();
        if (j.status && j.status !== 'pending') { clearInterval(timer); resolve(j); return; }
      } catch (e) { clearInterval(timer); reject(e); return; }
      if (Date.now() > deadline) { clearInterval(timer); resolve(null); }
    }, 500);
  });
}

function formatMetadata(result) {
  const parts = [];
  if (result.title) parts.push(`**${result.title}**`);
  if (result.url) parts.push(`URL: ${result.url}`);
  if (result.tabId !== undefined) parts.push(`Tab ID: ${result.tabId}`);
  if (result.text) parts.push(`\n--- Page Content (${result.length || 0} chars) ---\n${result.text}`);
  if (result.truncated) parts.push('\n*(truncated)*');
  return parts.join('\n');
}

// ===========================================================================
// chrome-eye.screenshot
// ===========================================================================
// Captures the currently active browser tab. Returns inline base64 PNG image.

const screenshotTool = {
  name: 'chrome-eye.screenshot',
  description: 'Capture a screenshot of the currently active browser tab. Returns a base64 PNG image inline with the result so the agent can see the rendered page. The tab is restored to its previous active state after capture.',
  parameters: {
    type: 'object',
    properties: {
      caption: { type: 'string', description: 'Optional caption for the screenshot' }
    },
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        image: { type: 'string', description: 'Base64 PNG image of the captured tab' },
        tabId: { type: 'number', description: 'Chrome tab ID' },
        url: { type: 'string', description: 'Page URL' },
        title: { type: 'string', description: 'Page title' },
      },
      additionalProperties: false,
    },
    render: (_args, result) => [{
      type: 'text',
      text: `Screenshot captured.${result.title ? ' Page: ' + result.title : ''}${result.url ? ' URL: ' + result.url : ''}${result.tabId ? ' Tab ID: ' + result.tabId : ''}`,
    }],
  },
  presentResult: (_args, result) => {
    const items = [];
    if (result.image) items.push({ type: 'image', name: 'screenshot.png', data: result.image });
    items.push({ type: 'text', text: `Screenshot captured.${result.title ? ' Page: ' + result.title : ''}${result.url ? ' URL: ' + result.url : ''}` });
    return items.length ? items : undefined;
  },
  isConcurrencySafe: () => false,
  async execute(args) {
    const id = mintId();
    await fetch(`${BRIDGE}/cmd`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action: 'screenshot', params: {} }),
    });
    const result = await pollResult(id, 30000);
    if (!result || result.status === 'error') {
      throw new Error(`Screenshot failed: ${result?.error || 'timeout or error'}`);
    }
    const r = result.result;
    return {
      image: r.image || undefined,
      tabId: r.tabId || undefined,
      url: r.url || undefined,
      title: r.title || undefined,
    };
  },
};

// ===========================================================================
// chrome-eye.readPage
// ===========================================================================
// Captures a specific tab: screenshot (base64) + DOM text.

const readPageTool = {
  name: 'chrome-eye.readPage',
  description: 'Read a specific browser tab: captures a screenshot (inline base64) and extracts the page text (DOM) from the tab. Requires the tab\'s numeric ID. Use chrome-eye.listTabs to find tab IDs.',
  parameters: {
    type: 'object',
    properties: {
      tabId: { type: 'number', description: 'Chrome tab ID to read' },
      maxChars: { type: 'number', description: 'Maximum characters of page text to return' },
    },
    required: ['tabId'],
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        image: { type: 'string', description: 'Base64 PNG image of the captured tab' },
        tabId: { type: 'number', description: 'Chrome tab ID' },
        url: { type: 'string', description: 'Page URL' },
        title: { type: 'string', description: 'Page title' },
        text: { type: 'string', description: 'Page text extracted from DOM' },
        length: { type: 'number', description: 'Length of page text' },
        truncated: { type: 'boolean', description: 'Whether text was truncated' },
      },
      additionalProperties: false,
    },
    render: (_args, result) => [{
      type: 'text',
      text: formatMetadata(result),
    }],
  },
  presentResult: (_args, result) => {
    const items = [];
    if (result.image) items.push({ type: 'image', name: 'screenshot.png', data: result.image });
    items.push({ type: 'text', text: formatMetadata(result) });
    return items.length ? items : undefined;
  },
  isConcurrencySafe: () => false,
  async execute(args) {
    const id = mintId();
    await fetch(`${BRIDGE}/cmd`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action: 'readPage', params: { tabId: args.tabId, maxChars: args.maxChars } }),
    });
    const result = await pollResult(id, 30000);
    if (!result || result.status === 'error') {
      throw new Error(`readPage failed: ${result?.error || 'timeout or error'}`);
    }
    const r = result.result;
    return {
      image: r.image || undefined,
      tabId: r.tabId,
      url: r.url || '',
      title: r.title || '',
      text: r.text || '',
      length: r.length || 0,
      truncated: r.truncated || false,
    };
  },
};

// ===========================================================================
// chrome-eye.getElementRect
// ===========================================================================
// Returns the x, y, width, height of an element on the page. Enables the
// agent's vision model to place bounding boxes on screenshots.

const getElementRectTool = {
  name: 'chrome-eye.getElementRect',
  description: 'Get the screen coordinates of an element on the page. Returns {x, y, width, height} for the matched element. Use this to locate clickable elements on a screenshot — the vision model can place bounding boxes on coordinates returned here.',
  parameters: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: 'CSS selector for the element' },
      tabId: { type: 'number', description: 'Tab ID (defaults to active tab)' },
    },
    required: ['selector'],
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        x: { type: 'number', description: 'X coordinate (top-left)' },
        y: { type: 'number', description: 'Y coordinate (top-left)' },
        width: { type: 'number', description: 'Element width in pixels' },
        height: { type: 'number', description: 'Element height in pixels' },
        tabId: { type: 'number', description: 'Tab ID the element belongs to' },
        found: { type: 'boolean', description: 'Whether the element was found' },
        error: { type: 'string', description: 'Error message if not found' },
      },
      additionalProperties: false,
    },
    render: (_args, result) => [{
      type: 'text',
      text: result.found
        ? `Element found: (${result.x}, ${result.y}) ${result.width}x${result.height}px on tab ${result.tabId}`
        : `Element not found: ${result.error || 'selector not found'}`,
    }],
  },
  isConcurrencySafe: () => false,
  async execute(args) {
    const id = mintId();
    await fetch(`${BRIDGE}/cmd`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action: 'getElementRect', params: { selector: args.selector, tabId: args.tabId } }),
    });
    const result = await pollResult(id, 15000);
    if (!result || result.status === 'error') {
      throw new Error(`getElementRect failed: ${result?.error || 'timeout or error'}`);
    }
    const r = result.result;
    return {
      x: r.x,
      y: r.y,
      width: r.width,
      height: r.height,
      tabId: r.tabId,
      found: r.found !== false,
      error: r.error || undefined,
    };
  },
};

// ===========================================================================
// chrome-eye.autoFormFill
// ===========================================================================
// Fill form fields by label text or field names. Maps form data to elements
// automatically by matching labels, placeholders, or field names.

const autoFormFillTool = {
  name: 'chrome-eye.autoFormFill',
  description: 'Automatically fill form fields on the page. Maps form data by matching field names/labels/placeholders to input elements. Useful for filling out forms without knowing exact CSS selectors.',
  parameters: {
    type: 'object',
    properties: {
      formData: {
        type: 'object',
        description: 'Object mapping field names to values. Keys match input name/label/placeholder attributes.',
        additionalProperties: { type: 'string' },
      },
      pressEnter: { type: 'boolean', description: 'Press Enter after filling the last field' },
      tabId: { type: 'number', description: 'Tab ID (defaults to active tab)' },
    },
    required: ['formData'],
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        filled: { type: 'number', description: 'Number of fields filled' },
        total: { type: 'number', description: 'Total fields requested' },
        failed: {
          type: 'array',
          items: { type: 'string' },
          description: 'Field names that failed to fill',
        },
        tabId: { type: 'number', description: 'Tab ID' },
      },
      additionalProperties: false,
    },
    render: (_args, result) => [{
      type: 'text',
      text: `Form fill: filled ${result.filled}/${result.total} fields.${result.failed?.length ? ' Failed: ' + result.failed.join(', ') : ''}`,
    }],
  },
  isConcurrencySafe: () => false,
  async execute(args) {
    const id = mintId();
    await fetch(`${BRIDGE}/cmd`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action: 'autoFormFill', params: { formData: args.formData, pressEnter: args.pressEnter, tabId: args.tabId } }),
    });
    const result = await pollResult(id, 15000);
    if (!result || result.status === 'error') {
      throw new Error(`autoFormFill failed: ${result?.error || 'timeout or error'}`);
    }
    const r = result.result;
    return {
      filled: r.filled || 0,
      total: r.total || Object.keys(args.formData).length,
      failed: r.failed || [],
      tabId: r.tabId,
    };
  },
};

// ===========================================================================
// chrome-eye.listTabs
// ===========================================================================
// Lists all browser tabs with their IDs, URLs, titles, and active status.

const listTabsTool = {
  name: 'chrome-eye.listTabs',
  description: 'List all browser tabs with their IDs, URLs, titles, and whether each is active. Useful for finding the tabId to pass to chrome-eye.readPage.',
  parameters: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Maximum number of tabs to return' },
    },
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        tabs: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              id: { type: 'number' },
              url: { type: 'string' },
              title: { type: 'string' },
              active: { type: 'boolean' },
              pinned: { type: 'boolean' },
            },
            additionalProperties: false,
          },
        },
        total: { type: 'number' },
      },
      additionalProperties: false,
    },
    render: (_args, result) => [{
      type: 'text',
      text: `Found ${result.total} tab(s):\n${result.tabs.map(t => `  [${t.id}] ${t.active ? '*' : ' '} ${t.pinned ? '📌' : '  '} ${t.title || '(no title)'} — ${t.url}`).join('\n')}`,
    }],
  },
  isConcurrencySafe: () => false,
  async execute(args) {
    const id = mintId();
    await fetch(`${BRIDGE}/cmd`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action: 'listTabs', params: { limit: args.limit } }),
    });
    const result = await pollResult(id, 15000);
    if (!result || result.status === 'error') {
      throw new Error(`listTabs failed: ${result?.error || 'timeout or error'}`);
    }
    const r = result.result;
    return {
      tabs: r.tabs || [],
      total: r.total || 0,
    };
  },
};

// ===========================================================================
// chrome-eye.click
// ===========================================================================
// Clicks an element on the page by CSS selector. Scrolls it into view and
// fires a click event. Returns confirmation with element tag and rect.

const clickTool = {
  name: 'chrome-eye.click',
  description: 'Click an element on the page by CSS selector. Scrolls the element into view and fires a click event. Returns the element tag and bounding rect.',
  parameters: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: 'CSS selector for the element to click (e.g., "#submit-btn", ".login-button", "a[href=\'/dashboard\']")' },
      tabId: { type: 'number', description: 'Tab ID (defaults to active tab)' },
    },
    required: ['selector'],
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        matched: { type: 'boolean', description: 'Whether the selector matched an element' },
        tag: { type: 'string', description: 'HTML tag of the clicked element' },
        x: { type: 'number', description: 'X coordinate' },
        y: { type: 'number', description: 'Y coordinate' },
        width: { type: 'number', description: 'Element width' },
        height: { type: 'number', description: 'Element height' },
        tabId: { type: 'number', description: 'Tab ID' },
        error: { type: 'string', description: 'Error message if not found' },
      },
      additionalProperties: false,
    },
    render: (_args, result) => [{
      type: 'text',
      text: result.matched
        ? `Clicked <${result.tag}> at (${result.x}, ${result.y}) on tab ${result.tabId}`
        : `Click failed: ${result.error || 'selector not found'}`,
    }],
  },
  isConcurrencySafe: () => false,
  async execute(args) {
    const id = mintId();
    await fetch(`${BRIDGE}/cmd`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action: 'click', params: { selector: args.selector, tabId: args.tabId } }),
    });
    const result = await pollResult(id, 15000);
    if (!result || result.status === 'error') {
      throw new Error(`click failed: ${result?.error || 'timeout or error'}`);
    }
    const r = result.result;
    return {
      matched: r.matched !== false,
      tag: r.tag || '',
      x: r.rect?.x,
      y: r.rect?.y,
      width: r.rect?.width,
      height: r.rect?.height,
      tabId: r.tabId,
      error: r.error || undefined,
    };
  },
};

// ===========================================================================
// chrome-eye.type
// ===========================================================================
// Types text into an input element. Clears existing value by default.
// Works with text inputs, textareas, contentEditable elements.

const typeTool = {
  name: 'chrome-eye.type',
  description: 'Type text into an input element on the page by CSS selector. Clears the existing value by default. Dispatches input and change events so frameworks detect the change.',
  parameters: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: 'CSS selector for the input element (e.g., "#username", "input[name=email]")' },
      text: { type: 'string', description: 'Text to type into the element' },
      clear: { type: 'boolean', description: 'Clear existing value before typing (default true)', default: true },
      tabId: { type: 'number', description: 'Tab ID (defaults to active tab)' },
    },
    required: ['selector', 'text'],
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        matched: { type: 'boolean', description: 'Whether the selector matched an input element' },
        tag: { type: 'string', description: 'HTML tag of the element' },
        valueLen: { type: 'number', description: 'Length of value after typing' },
        value: { type: 'string', description: 'The resulting value (first 200 chars)' },
        tabId: { type: 'number', description: 'Tab ID' },
        error: { type: 'string', description: 'Error message if failed' },
      },
      additionalProperties: false,
    },
    render: (_args, result) => [{
      type: 'text',
      text: result.matched
        ? `Typed into <${result.tag}> (${result.valueLen} chars) on tab ${result.tabId}: "${result.value?.slice(0, 100)}${result.value && result.value.length > 100 ? '...' : ''}"`
        : `Type failed: ${result.error || 'selector not found'}`,
    }],
  },
  isConcurrencySafe: () => false,
  async execute(args) {
    const id = mintId();
    await fetch(`${BRIDGE}/cmd`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action: 'type', params: { selector: args.selector, text: args.text, clear: args.clear, tabId: args.tabId } }),
    });
    const result = await pollResult(id, 15000);
    if (!result || result.status === 'error') {
      throw new Error(`type failed: ${result?.error || 'timeout or error'}`);
    }
    const r = result.result;
    return {
      matched: r.matched !== false,
      tag: r.tag || '',
      valueLen: r.valueLen || 0,
      value: r.value || '',
      tabId: r.tabId,
      error: r.error || undefined,
    };
  },
};

// ===========================================================================
// chrome-eye.navigate
// ===========================================================================
// Navigates the current tab to a URL. Returns from/to URLs.

const navigateTool = {
  name: 'chrome-eye.navigate',
  description: 'Navigate the current (or specified) tab to a URL. Returns the from and to URLs. Use chrome-eye.screenshot after navigating to see the new page.',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to navigate to (http:// or https://)' },
      tabId: { type: 'number', description: 'Tab ID to navigate (defaults to active tab)' },
    },
    required: ['url'],
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        from: { type: 'string', description: 'Previous URL' },
        to: { type: 'string', description: 'New URL' },
        tabId: { type: 'number', description: 'Tab ID' },
        note: { type: 'string', description: 'Note about navigation state' },
        error: { type: 'string', description: 'Error message' },
      },
      additionalProperties: false,
    },
    render: (_args, result) => [{
      type: 'text',
      text: result.from
        ? `Navigated tab ${result.tabId}: ${result.from} → ${result.to}`
        : `Navigate failed: ${result.error || 'unknown error'}`,
    }],
  },
  isConcurrencySafe: () => false,
  async execute(args) {
    const id = mintId();
    await fetch(`${BRIDGE}/cmd`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action: 'navigate', params: { url: args.url, tabId: args.tabId } }),
    });
    const result = await pollResult(id, 15000);
    if (!result || result.status === 'error') {
      throw new Error(`navigate failed: ${result?.error || 'timeout or error'}`);
    }
    const r = result.result;
    return {
      from: r.from || '',
      to: r.to || '',
      tabId: r.tabId,
      note: r.note || '',
      error: r.error || undefined,
    };
  },
};

// ===========================================================================
// chrome-eye.getPageText
// ===========================================================================
// Extracts visible text from the current page. Useful for understanding page
// content without a full readPage (no screenshot overhead).

const getPageTextTool = {
  name: 'chrome-eye.getPageText',
  description: 'Extract visible text content from the current page. Normalizes whitespace and caps at maxChars. Use this when you need the page text but not a screenshot.',
  parameters: {
    type: 'object',
    properties: {
      maxChars: { type: 'number', description: 'Maximum characters to return (default 10000)' },
      tabId: { type: 'number', description: 'Tab ID (defaults to active tab)' },
    },
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Visible page text' },
        length: { type: 'number', description: 'Length of text returned' },
        truncated: { type: 'boolean', description: 'Whether text was truncated' },
        url: { type: 'string', description: 'Page URL' },
        title: { type: 'string', description: 'Page title' },
        tabId: { type: 'number', description: 'Tab ID' },
        error: { type: 'string', description: 'Error message' },
      },
      additionalProperties: false,
    },
    render: (_args, result) => [{
      type: 'text',
      text: result.text
        ? `Page text (${result.length} chars): ${result.text.slice(0, 2000)}${result.text.length > 2000 ? '\n...(more)' : ''}${result.truncated ? '\n*(truncated)*' : ''}`
        : `getPageText failed: ${result.error || 'unknown error'}`,
    }],
  },
  isConcurrencySafe: () => false,
  async execute(args) {
    const id = mintId();
    await fetch(`${BRIDGE}/cmd`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action: 'getPageText', params: { maxChars: args.maxChars || 10000, tabId: args.tabId } }),
    });
    const result = await pollResult(id, 15000);
    if (!result || result.status === 'error') {
      throw new Error(`getPageText failed: ${result?.error || 'timeout or error'}`);
    }
    const r = result.result;
    return {
      text: r.text || '',
      length: r.length || 0,
      truncated: r.truncated || false,
      url: r.url || '',
      title: r.title || '',
      tabId: r.tabId,
      error: r.error || undefined,
    };
  },
};

// ===========================================================================
// chrome-eye.getPageContext
// ===========================================================================
// Gemini-like structured page context: headings, links, forms, tables, meta, visible text.

const getPageContextTool = {
  name: 'chrome-eye.getPageContext',
  description: 'Extract structured context from the current (or specified) tab: headings, links, forms, tables, meta data, and visible text. This gives the model a rich understanding of the page similar to Gemini\'s page reading. Use chrome-eye.listTabs to find tab IDs.',
  parameters: {
    type: 'object',
    properties: {
      maxChars: { type: 'number', description: 'Maximum characters of visible text (default 50000)' },
      maxLinks: { type: 'number', description: 'Maximum links to return (default 50)' },
      maxHeadings: { type: 'number', description: 'Maximum headings to return (default 30)' },
      maxForms: { type: 'number', description: 'Maximum forms to return (default 10)' },
      maxTables: { type: 'number', description: 'Maximum tables to return (default 5)' },
      tabId: { type: 'number', description: 'Tab ID (defaults to active tab)' },
    },
    additionalProperties: false,
  },
  output: {
    schema: {
      type: 'object',
      properties: {
        context: { type: 'object', description: 'Structured page context with headings, links, forms, tables, meta, and text' },
        url: { type: 'string', description: 'Page URL' },
        title: { type: 'string', description: 'Page title' },
        tabId: { type: 'number', description: 'Tab ID' },
        error: { type: 'string', description: 'Error message' },
      },
      additionalProperties: false,
    },
    render: (_args, result) => {
      if (result.error) return [{ type: 'text', text: `getPageContext failed: ${result.error}` }];
      const c = result.context || {};
      const parts = [];
      if (result.title) parts.push(`**${result.title}**`);
      if (result.url) parts.push(`URL: ${result.url}`);
      if (c.headings?.length) {
        parts.push('\n## Headings:');
        c.headings.forEach(h => parts.push(`  ${'  '.repeat(h.level - 1)}- ${h.text}`));
      }
      if (c.links?.length) {
        parts.push(`\n## Links (${c.links.length}):`);
        c.links.forEach(l => parts.push(`  - [${l.text}](${l.url})`));
      }
      if (c.forms?.length) {
        parts.push(`\n## Forms (${c.forms.length}):`);
        c.forms.forEach(f => {
          parts.push(`  - Form: ${f.action || '(no action)'} [${f.method}]`);
          f.fields.forEach(fi => parts.push(`    - <${fi.tag}> name="${fi.name}" type="${fi.type}"${fi.required ? ' required' : ''}${fi.placeholder ? ` placeholder="${fi.placeholder}"` : ''}`));
        });
      }
      if (c.tables?.length) {
        parts.push(`\n## Tables (${c.tables.length}):`);
        c.tables.forEach((t, i) => {
          parts.push(`  - Table ${i + 1}: ${t.totalRows} rows x ${t.totalCols} cols`);
          if (t.headers.length) parts.push(`    Headers: ${t.headers.join(', ')}`);
        });
      }
      if (c.visibleText) parts.push(`\n--- Visible text (${(c.visibleText.length / 1000).toFixed(1)}K chars) ---\n${c.visibleText.slice(0, 3000)}${c.truncated ? '\n...(truncated)' : ''}`);
      return [{ type: 'text', text: parts.join('\n') }];
    },
  },
  isConcurrencySafe: () => false,
  async execute(args) {
    const id = mintId();
    await fetch(`${BRIDGE}/cmd`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id,
        action: 'getPageContext',
        params: {
          maxChars: args.maxChars || 50000,
          maxLinks: args.maxLinks || 50,
          maxHeadings: args.maxHeadings || 30,
          maxForms: args.maxForms || 10,
          maxTables: args.maxTables || 5,
          tabId: args.tabId
        }
      }),
    });
    const result = await pollResult(id, 15000);
    if (!result || result.status === 'error') {
      throw new Error(`getPageContext failed: ${result?.error || 'timeout or error'}`);
    }
    const r = result.result;
    return {
      context: r.context || {},
      url: r.url || '',
      title: r.title || '',
      tabId: r.tabId,
      error: r.error || undefined,
    };
  },
};

// ===========================================================================
// Host plugin: registers the tools via ctx.tools.register()
// ===========================================================================

import { Service } from "@deepseek-ai/cordis";
import z from "@deepseek-ai/schemastery";

class ChromeEyeToolsPlugin extends Service {
  static Config = z.object({}).default({});
  static inject = ['tools'];

  apply(ctx) {
    console.error('[chrome-eye-tools] registering 10 tools');
    ctx.tools.register(screenshotTool);
    ctx.tools.register(readPageTool);
    ctx.tools.register(listTabsTool);
    ctx.tools.register(getElementRectTool);
    ctx.tools.register(autoFormFillTool);
    ctx.tools.register(clickTool);
    ctx.tools.register(typeTool);
    ctx.tools.register(navigateTool);
    ctx.tools.register(getPageTextTool);
    ctx.tools.register(getPageContextTool);
    console.error('[chrome-eye-tools] all 10 tools registered');
    return ctx.effect(() => {
      // Cleanup: tools auto-unregister on fiber disposal
    });
  }
}

export default ChromeEyeToolsPlugin;
