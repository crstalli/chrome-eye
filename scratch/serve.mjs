// Tiny static scratch server on 127.0.0.1:8899 — test page with a child :3080 iframe.
import http from 'node:http';
import fs from 'node:fs';
const PAGE = `<!doctype html><html><head><title>frame-topology-test</title></head>
<body><h1>top frame</h1><iframe id="f1" src="http://127.0.0.1:3080/" style="width:600px;height:400px"></iframe>
<script>
const f = document.getElementById('f1');
f.addEventListener('load', () => console.log('top: iframe load event fired'));
</script></body></html>`;
http.createServer((req, res) => {
  if (req.url === '/frame-test.html') {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(PAGE);
  } else {
    res.writeHead(404); res.end('nf');
  }
}).listen(8899, '127.0.0.1', () => console.log('scratch server on 8899'));
