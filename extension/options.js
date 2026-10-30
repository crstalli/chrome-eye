// Chrome Eye options page (CP-8: T8.2 + T8.3).
// T8.2 — persist the DSH server URL in chrome.storage.sync (key "dshUrl").
// T8.3 — "Test Connection" does a plain GET of the stored URL root:
//        any HTTP response = ✅ Connected; a TypeError/network error = ❌ Unreachable.
// The result + the tested URL are shown next to the button. No alert().
(function () {
  'use strict';

  var STORAGE_KEY = 'dshUrl';
  var DEFAULT_URL = 'http://127.0.0.1:3080';

  var urlInput = document.getElementById('dsh_url');
  var testButton = document.getElementById('test_connection');

  // A status span is appended next to the Test Connection button (options.html
  // is not modified). It is reused for both the load state and the test result.
  var status = document.createElement('span');
  status.id = 'connection-status';
  status.setAttribute('style',
    'margin-left: 12px; font-size: 14px; white-space: nowrap; color: #333;');
  if (testButton && testButton.parentNode) {
    testButton.parentNode.appendChild(status);
  }

  function normalizeUrl(value) {
    var v = (value || '').trim();
    if (!v) return DEFAULT_URL;
    // Ensure a scheme so fetch() can parse it; loopback defaults to http.
    if (!/^https?:\/\//i.test(v)) v = 'http://' + v;
    // Strip a trailing slash so the displayed/tested URL is canonical.
    if (v.length > 1 && v.charAt(v.length - 1) === '/') {
      v = v.slice(0, -1);
    }
    return v;
  }

  function setStatus(text, isError) {
    if (!status) return;
    status.textContent = text;
    status.style.color = isError ? '#b00020' : '#1a7f37';
  }

  // T8.2 — on load: read the stored URL (falling back to the default) and fill
  // the input. Then re-persist the canonical form so the first load seeds
  // storage if the user has never saved a value.
  function load() {
    if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.sync) {
      if (urlInput) urlInput.value = DEFAULT_URL;
      setStatus('chrome.storage unavailable — using default ' + DEFAULT_URL, true);
      return;
    }
    chrome.storage.sync.get({ [STORAGE_KEY]: DEFAULT_URL }, function (items) {
      var url = normalizeUrl(items && items[STORAGE_KEY]);
      if (urlInput) urlInput.value = url;
      // Seed storage on first run (idempotent: writing the same value is a no-op
      // for the user, but guarantees the key exists for the test + panel).
      chrome.storage.sync.set({ [STORAGE_KEY]: url }, function () {
        if (typeof chrome.runtime !== 'undefined' && chrome.runtime.lastError) {
          console.warn('Chrome Eye options: storage.set error', chrome.runtime.lastError);
        }
      });
    });
  }

  // T8.2 — persist the URL back on change / save.
  // While typing (input events) the raw text is stored untouched so the field
  // is never rewritten under the cursor; on blur (change) the field is
  // normalized (scheme + trailing slash) and the canonical form stored.
  function persist(value) {
    if (typeof chrome !== 'undefined' && chrome.storage && chrome.storage.sync) {
      chrome.storage.sync.set({ [STORAGE_KEY]: value }, function () {
        if (typeof chrome.runtime !== 'undefined' && chrome.runtime.lastError) {
          console.warn('Chrome Eye options: storage.set error', chrome.runtime.lastError);
        }
      });
    }
  }

  function saveWhileTyping() {
    if (urlInput) persist((urlInput.value || '').trim());
  }

  function saveOnCommit() {
    if (!urlInput) return;
    var url = normalizeUrl(urlInput.value);
    urlInput.value = url;
    persist(url);
  }

  // T8.3 — plain GET of the stored URL root. Any HTTP response (even 4xx/5xx)
  // proves the server is reachable; only a TypeError (network/CORS failure)
  // means unreachable.
  function testConnection() {
    var url = normalizeUrl(urlInput ? urlInput.value : DEFAULT_URL);
    if (!status) return;

    testButton.disabled = true;
    status.style.color = '#555';
    status.textContent = 'Testing ' + url + '…';

    fetch(url, { method: 'GET' })
      .then(function () {
        // An HTTP response came back → the origin answered.
        testButton.disabled = false;
        setStatus('✅ Connected — ' + url, false);
      })
      .catch(function (err) {
        testButton.disabled = false;
        var detail = (err && err.message) ? err.message : String(err);
        setStatus('❌ Unreachable — ' + url + ' (' + detail + ')', true);
      });
  }

  if (urlInput) {
    urlInput.addEventListener('input', saveWhileTyping);
    urlInput.addEventListener('change', saveOnCommit);
  }
  if (testButton) {
    testButton.addEventListener('click', testConnection);
  }

  load();
})();
