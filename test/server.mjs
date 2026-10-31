#!/usr/bin/env node
// Minimal static file server for the Chrome Eye test fixture.
// No dependencies; serves ./fixture on 127.0.0.1 (default port 3456).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const flag = (name, dflt) => { const i = args.indexOf('--' + name); return i >= 0 ? args[i + 1] : dflt; };
const port = Number(flag('port', 3456));
const root = path.resolve(flag('root', path.join(here, 'fixture')));
const host = flag('host', '127.0.0.1');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
};

const server = http.createServer((req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    let p = decodeURIComponent(url.pathname);
    if (p === '/' || p === '') p = '/page.html';
    const file = path.normalize(path.join(root, p));
    if (!file.startsWith(root + path.sep) && file !== root) {
      res.writeHead(403); res.end('forbidden'); return;
    }
    fs.readFile(file, (err, data) => {
      if (err) { res.writeHead(404); res.end('not found: ' + p); return; }
      res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
      res.end(data);
    });
  } catch (e) {
    res.writeHead(500); res.end(String(e));
  }
});

server.listen(port, host, () => {
  console.log(`fixture server: http://${host}:${port}/page.html (root=${root})`);
});
