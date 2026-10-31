#!/usr/bin/env node
// Diagnostic: decode the gzip session/list body from 3081 and verify it contains the 97 items.
import { readFileSync } from 'node:fs';
import { gunzipSync } from 'node:zlib';
const buf = readFileSync('/tmp/list-gzip-3081.bin');
const json = gunzipSync(buf);
console.log('decompressed:', json.length, 'bytes');
const data = JSON.parse(json.toString('utf8'));
const val = data.result.value;
console.log('items:', val.items.length);
// Count by workspace
const byWs = {};
for (const s of val.items) {
  const cwd = s.cwd || '?';
  byWs[cwd] = (byWs[cwd] || 0) + 1;
}
console.log('by cwd:', JSON.stringify(byWs, null, 1));
// Count non-blank, non-archived
let visible = 0;
for (const s of val.items) {
  if (!s.blank && !s.archived && s.origin !== 'subagent') visible++;
}
console.log('visible (non-blank, non-archived, non-subagent):', visible);
process.exit(0);
