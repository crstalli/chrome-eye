import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { decodeStorageRecord } = require("/mnt/f/npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js");

const F = "/home/cztl/.dsh/sessions/--mnt-f-ai--/session-95a1b7f2-ae9f-4377-9208-a3592e0f83df/session.jsonl.zstd";
const buf = execFileSync("zstd", ["-d", "-c", F], { maxBuffer: 1 << 30 });
const text = buf.toString("utf8");
const lines = text.split("\n");

// Header is line 0. Event rows start at line 1.
const events = []; // expanded logical events in file order
let running = 0; // this.events.length in the scanner
let issue = null;
const cleanCut = { running: 0, lineIdx: 0 }; // last line where running==expected held through the row

for (let i = 1; i < lines.length; i++) {
  const raw = lines[i];
  if (raw.length === 0) continue;
  let parsed;
  try { parsed = JSON.parse(raw); } catch { continue; }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) continue;
  // expand provenance (no-op if no sourceEventSeqs)
  let rec = parsed;
  if (parsed.sourceEventSeqs !== undefined) {
    // decodeSeqRanges(storageForm, seq)
    rec = { ...parsed, sourceEventSeqs: require("/mnt/f/npm-global/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-session/lib/index.js").decodeSeqRanges(parsed.sourceEventSeqs, parsed.seq) };
  }
  let decoded;
  try { decoded = decodeStorageRecord(rec); } catch (e) { decoded = [rec]; }
  const rowStart = running;
  for (const ev of decoded) {
    if (ev.seq !== running) {
      if (!issue) issue = { lineIdx: i, expected: running, got: ev.seq, type: ev.type, cleanCut };
      // scanner: truncate this row, stop committing (but keep scanning for reporting)
      running = rowStart;
      break;
    }
    running += 1;
  }
  if (!issue) cleanCut.running = running; cleanCut.lineIdx = i;
}

console.log("total lines:", lines.length);
console.log("final running (expanded) events:", running);
console.log("first issue:", JSON.stringify(issue, null, 2));

if (issue) {
  // Print the 8 lines around the issue
  const L = issue.lineIdx;
  console.log("\n=== context around issue line (0-based), seq+type ===");
  for (let i = Math.max(1, L - 6); i <= Math.min(lines.length - 1, L + 6); i++) {
    let o; try { o = JSON.parse(lines[i]); } catch { continue; }
    const seq = o.seq !== undefined ? o.seq : "(packed " + (o.type||"") + ")";
    console.log(`  line ${i}  seq=${seq}  ${o.type}`);
  }
  // What is the type at cleanCut.lineIdx and the next?
  const cc = issue.cleanCut;
  let ccLine; try { ccLine = JSON.parse(lines[cc.lineIdx]); } catch {}
  console.log("\n=== clean cut ===");
  console.log("  cleanCut.lineIdx (0-based, 1-based = +1):", cc.lineIdx, "→ 1-based", cc.lineIdx + 1);
  console.log("  running at cut (events kept):", cc.running);
  console.log("  last kept line type:", ccLine?.type, " seq:", ccLine?.seq);
  // 1-based file line to truncate AFTER (keep through cleanCut.lineIdx inclusive)
  // header line 0 + event lines 1..N. Keep lines 0..cleanCut.lineIdx inclusive → N+1 lines.
  console.log("  lines to KEEP (1-based count, incl header):", cc.lineIdx + 1);
}
