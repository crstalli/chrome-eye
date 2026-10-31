import { execFileSync } from "node:child_process";
import { writeFileSync, readFileSync, copyFileSync, statSync, renameSync } from "node:fs";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const ds = "/mnt/f/npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/";
const { decodeStorageRecord, decodeSeqRanges } = require(ds + "dsh-session/lib/index.js");
const { Session } = require(ds + "dsh-session/lib/index.js");

const F = "/home/cztl/.dsh/sessions/--mnt-f-ai--/session-95a1b7f2-ae9f-4377-9208-a3592e0f83df/session.jsonl.zstd";

// 1. Decompress full store.
const plain = execFileSync("zstd", ["-d", "-c", F], { maxBuffer: 1 << 30 }).toString("utf8");
const lines = plain.split("\n");
const headerLine = lines[0];
const eventLines = lines.slice(1).filter(l => l.length > 0); // no trailing empty

// 2. Walk original event rows; keep verbatim while the expanded events stay contiguous from 0.
const keptLines = [];
const keptEvents = []; // expanded events, for authoritative Session verification
let running = 0;
let cutAt = -1; // index in eventLines of first bad row
for (let i = 0; i < eventLines.length; i++) {
  let parsed;
  try { parsed = JSON.parse(eventLines[i]); } catch { cutAt = i; break; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) { cutAt = i; break; }
  let rec = parsed;
  if (parsed.sourceEventSeqs !== undefined) rec = { ...parsed, sourceEventSeqs: decodeSeqRanges(parsed.sourceEventSeqs, parsed.seq) };
  let decoded;
  try { decoded = decodeStorageRecord(rec); } catch { cutAt = i; break; }
  const rs = running;
  let bad = false;
  for (const ev of decoded) {
    if (ev.seq !== running) { bad = true; break; }
    running++;
    keptEvents.push(ev);
  }
  if (bad) { cutAt = i; break; }
  keptLines.push(eventLines[i]); // keep the ORIGINAL storage line verbatim
}
console.log("kept rows:", keptLines.length, " contiguous events:", running, " cutAt(eventLines idx):", cutAt);
if (running === 0) { console.log("ABORT: nothing kept"); process.exit(2); }

// 3. Authoritative verification: build a Session from the expanded kept events.
//    The Session constructor re-checks contiguity (seq===index), envelope, and
//    surface transitions — exactly what resume needs.
let verify = "skipped";
try {
  const hdr = JSON.parse(headerLine);
  const id = hdr.id;
  const s = Session.create(id, keptEvents, { version: 0, id, createdAt: hdr.createdAt || 0, cwd: hdr.cwd || "/mnt/f/ai", delegationDepth: hdr.delegationDepth || 0, agentPreset: hdr.agentPreset || "cordis", isSeeded: true }, 0);
  verify = "PASS Session.create accepted " + (s.eventsSnapshot ? s.eventsSnapshot.length : running) + " events";
} catch (e) {
  verify = "FAIL Session.create threw: " + e.message;
}
console.log("VERIFY:", verify);
if (!verify.startsWith("PASS")) { console.log("ABORT: verification failed, live file untouched"); process.exit(3); }

// 4. Rebuild plaintext = header + kept original lines, trailing newline.
const outText = headerLine + "\n" + keptLines.join("\n") + "\n";
const outBuf = Buffer.from(outText, "utf8");
writeFileSync("/tmp/repair-plain.jsonl", outBuf);
console.log("re-encoded plaintext bytes:", outBuf.length, " lines:", keptLines.length + 1);

// 5. Backup original, then re-encode to zstd and atomically replace.
const bak = F + ".corrupt-backup-" + Date.now();
copyFileSync(F, bak);
console.log("backup written:", bak, statSync(bak).size, "bytes");
execFileSync("zstd", ["-q", "-T1", "-19", "/tmp/repair-plain.jsonl", "-o", F + ".new"]);
renameSync(F + ".new", F);
console.log("live file replaced. new size:", statSync(F).size, "bytes");

// 6. Final re-verify the LIVE file: decompress + contiguous re-walk.
const livePlain = execFileSync("zstd", ["-d", "-c", F], { maxBuffer: 1 << 30 }).toString("utf8");
const L2 = livePlain.split("\n");
let run = 0, liveIssue = null;
for (let i = 1; i < L2.length; i++) {
  if (!L2[i]) continue;
  let p; try { p = JSON.parse(L2[i]); } catch { if (!liveIssue) liveIssue = "unparsable line " + (i + 1); break; }
  if (typeof p !== "object" || p === null) continue;
  let r2 = p;
  if (p.sourceEventSeqs !== undefined) r2 = { ...p, sourceEventSeqs: decodeSeqRanges(p.sourceEventSeqs, p.seq) };
  let dec; try { dec = decodeStorageRecord(r2); } catch { if (!liveIssue) liveIssue = "decode fail " + (i + 1); break; }
  const rs = run;
  for (const e of dec) { if (e.seq !== run) { liveIssue = "gap line " + (i + 1) + " expected " + run + " got " + e.seq; run = rs; break; } run++; }
  if (liveIssue) break;
}
const liveVerify = liveIssue ? "FAIL " + liveIssue : "PASS contiguous run=" + run + " (lines=" + L2.length + ")";
console.log("LIVE VERIFY:", liveVerify);
if (liveVerify.startsWith("FAIL")) { console.log("LIVE VERIFY FAILED — restoring backup"); renameSync(bak, F); process.exit(4); }
console.log("REPAIR COMPLETE");
