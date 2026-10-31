#!/usr/bin/env node
// Diagnostic: raw bytes of session/list through bridge vs direct :3080 (unauthenticated behavior).
import { execFileSync } from 'node:child_process';

// 1) raw bytes through the bridge
const out1 = execFileSync('curl', ['-s', '-D-', '--max-time', '10', 'http://127.0.0.1:3081/api/session/list'], { maxBuffer: 20 * 1024 * 1024 });
const i1 = out1.indexOf('\r\n\r\n');
const head1 = out1.substring(0, i1);
const body1 = out1.substring(i1 + 4);
console.log('=== bridge /api/session/list ===');
console.log(head1);
console.log('body bytes:', body1.length);
console.log('body head:', JSON.stringify(body1.substring(0, 200)));
// 2) direct :3080 unauthenticated (the behavior the app would hit without the bridge cookie)
try {
  const out2 = execFileSync('curl', ['-s', '-D-', '--max-time', '8', 'http://127.0.0.1:3080/api/session/list'], { maxBuffer: 20 * 1024 * 1024 });
  const i2 = out2.indexOf('\r\n\r\n');
  console.log('=== direct :3080 (no cookie) ===');
  console.log(out2.substring(0, i2));
  console.log('body head:', JSON.stringify(out2.substring(i2 + 4, i2 + 220)));
} catch (e) {
  console.log('direct :3080 failed/hung:', e.message.substring(0, 200));
}
process.exit(0);
