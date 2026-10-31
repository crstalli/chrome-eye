#!/usr/bin/env node
// Minimal Chrome DevTools Protocol client (Node >= 22: native fetch + WebSocket, no npm).
import fs from 'node:fs';

export async function listTargets(debugBase = 'http://127.0.0.1:9222') {
  const r = await fetch(`${debugBase}/json/list`);
  if (!r.ok) throw new Error(`/json/list -> ${r.status}`);
  return r.json();
}

export class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.handlers = new Map(); }

  static async connect(wsUrl, { timeoutMs = 15000 } = {}) {
    const ws = new WebSocket(wsUrl);
    const cdp = new Cdp(ws);
    cdp.timeoutMs = timeoutMs;
    await new Promise((res, rej) => {
      ws.onopen = res;
      ws.onerror = () => rej(new Error('ws error connecting ' + wsUrl));
    });
    ws.onmessage = (m) => {
      let msg; try { msg = JSON.parse(typeof m.data === 'string' ? m.data : m.data.toString()); } catch { return; }
      if (msg.id && cdp.pending.has(msg.id)) {
        const { resolve, reject, timer } = cdp.pending.get(msg.id);
        clearTimeout(timer); cdp.pending.delete(msg.id);
        msg.error ? reject(new Error(`CDP ${msg.error.message}`)) : resolve(msg.result);
      } else if (msg.method) {
        for (const fn of cdp.handlers.get(msg.method) ?? []) fn(msg.params);
      }
    };
    return cdp;
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
    return this;
  }

  send(method, params = {}, timeoutMs) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method} (id=${id})`));
      }, timeoutMs ?? this.timeoutMs ?? 15000);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  async close() { try { this.ws.close(); } catch { /* ignore */ } }
}

export async function screenshot(target, file) {
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  try {
    await cdp.send('Page.enable');
    const r = await cdp.send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    return file;
  } finally { await cdp.close(); }
}
