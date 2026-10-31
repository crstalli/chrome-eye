// A1 behavior verification (throwaway scratch file; NOT part of the extension).
// Tests the REAL code: probeGuiFrameDocument is extracted from sw.js and
// eval'd; the sw.js error string and the panel.js mapping are read from the
// files and simulated end-to-end for the 401-gate and real-GUI scenarios.
'use strict';
var fs = require('fs');
var path = '/mnt/f/ai/chrome-eye/extension/';
var swSrc = fs.readFileSync(path + 'sw.js', 'utf8');
var panelSrc = fs.readFileSync(path + 'panel.js', 'utf8');
var fails = 0;
function check(name, ok, detail) {
  console.log((ok ? 'PASS' : 'FAIL') + ': ' + name + (detail ? ' — ' + detail : ''));
  if (!ok) fails++;
}

// --- 1. Extract the REAL probe function from sw.js ---
var m = swSrc.match(/function probeGuiFrameDocument\(\) \{[\s\S]*?\n\}/);
check('sw.js defines probeGuiFrameDocument', !!m);
if (!m) process.exit(1);
var probe = eval('(' + m[0] + ')');
check('probe is a plain function', typeof probe === 'function');

function runProbe(doc) {
  global.document = doc;
  return probe();
}

// --- 2. Probe scenarios (live-verified 401 gate shape from curl :3080) ---
var gateDoc = {
  contentType: 'text/plain',
  body: { textContent: 'dsh web authentication required; reopen the URL printed by dsh web.' }
};
var gateDocHtml = {
  contentType: 'text/html',
  body: { textContent: 'dsh web authentication required; reopen the URL printed by dsh web.' }
};
var guiDoc = {
  contentType: 'text/html',
  body: { textContent: 'My WorkspacesaiMy Sessionchrome-eye' }
};
var emptyHtmlDoc = { contentType: 'text/html', body: null }; // first-click race, app still booting
check('probe rejects live 401 gate (text/plain)', runProbe(gateDoc) === false);
check('probe rejects HTML gate variant (gate text)', runProbe(gateDocHtml) === false);
check('probe accepts real GUI document', runProbe(guiDoc) === true);
check('probe accepts empty text/html (app booting) — pre-fix behavior preserved', runProbe(emptyHtmlDoc) === true);
check('probe survives missing document body', (function () { try { return runProbe({}) === false; } catch (e) { return false; } })());

// --- 3. The fallback error string in sw.js (guiTabRoundTrip) ---
var mErr = swSrc.match(/throw new Error\('([^']*no DSH GUI tab[^']*)'\)/);
check('sw.js throws the no-GUI-tab error', !!mErr);
var swErr = mErr ? mErr[1] : '';
check('sw.js error string is the actionable one', swErr.indexOf('open http://127.0.0.1:3080 in a browser tab') >= 0, swErr);

// --- 4. panel.js renderTree mapping of that exact string ---
function panelErrorText(msg) {
  var text;
  if (msg.indexOf('no DSH GUI tab') === 0) {
    var br = panelSrc.match(/text = 'No DSH GUI tab found[^\n]*?';/);
    text = br ? br[0].slice(8, br[0].length - 2) : '<missing branch>';
  } else if (msg.indexOf('no live content script') >= 0) {
    text = 'reload-tab text';
  } else if (msg === 'sidebar-not-visible') {
    text = 'sidebar text';
  } else {
    text = 'generic: ' + msg;
  }
  return text;
}
var mapped = panelErrorText(swErr);
check('panel.js maps the sw.js 401/no-tab error to actionable dropdown text',
  mapped.indexOf('open http://127.0.0.1:3080 in a browser tab') >= 0, mapped);
check('panel.js error path uses .ce-ws-err', /errDiv\.className = 'ce-ws-err'/.test(panelSrc));

// --- 5. Scenario A: panel iframe = 401 gate, no real tab ---
// findPanelGuiFrame: URL match (gate commits at :3080/) → probe false → null
// → guiFrameAction fallback → guiTabRoundTrip → no tab → swErr thrown.
var probeResult = runProbe(gateDoc);
var frameAfterProbe = probeResult ? { id: 1, frameId: 0 } : null; // exactly what sw.js returns
check('scenario A: gate frame is rejected (findPanelGuiFrame → null)', frameAfterProbe === null);
var dropdownTextA = panelErrorText(swErr);
check('scenario A: dropdown shows actionable error',
  dropdownTextA.indexOf('open http://127.0.0.1:3080 in a browser tab') >= 0);

// --- 6. Scenario B: panel iframe = real GUI → accepted, scraper path ---
var probeResultB = runProbe(guiDoc);
var frameAfterProbeB = probeResultB ? { id: 1, frameId: 0 } : null;
check('scenario B: real GUI frame is accepted', frameAfterProbeB !== null && frameAfterProbeB.frameId === 0);

// --- 7. findPanelGuiFrame actually invokes the probe (code wiring) ---
check('findPanelGuiFrame runs executeScript with func: probeGuiFrameDocument',
  /func: probeGuiFrameDocument/.test(swSrc));
check('findPanelGuiFrame returns null when probe is false',
  /return realGui \? \{ id: tab\.id, frameId: candidate\.frameId \} : null;/.test(swSrc));
check('probe failure (frame vanished) also falls through to real-tab path',
  /frame vanished mid-flight/.test(swSrc));

console.log(fails === 0 ? '\nALL CHECKS PASSED' : '\n' + fails + ' CHECK(S) FAILED');
process.exit(fails === 0 ? 0 : 1);
