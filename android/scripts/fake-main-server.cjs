'use strict';

// Stand-in "main device" for the Screen-mode smoke test: serves a page at any
// path and logs each request, so the test can see the Screen load and reload it.
// WebView page loads are tagged "page"; the shell's connection probes are not.
// Usage: node fake-main-server.cjs <port>
const http = require('http');

const port = Number(process.argv[2] || 3902);
http
  .createServer((req, res) => {
    const kind = /Mozilla/.test(req.headers['user-agent'] || '') ? 'page' : 'probe';
    console.log(`GET ${req.url} ${kind}`);
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html><body><main id="screen-marker">Kitchen display</main></body></html>');
  })
  .listen(port, '127.0.0.1', () => console.log(`listening ${port}`));
