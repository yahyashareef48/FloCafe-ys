'use strict';

// Minimal DevTools-protocol client for the app's WebViews, forwarded by adb to a local port.
const WebSocket = require('ws');

async function findPage(port, urlPrefix, attempts = 30) {
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = pages.find((p) => p.type === 'page' && String(p.url).startsWith(urlPrefix));
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // DevTools socket not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error(`No WebView page at ${urlPrefix}`);
}

async function connect(port, urlPrefix) {
  const ws = new WebSocket(await findPage(port, urlPrefix));
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  let nextId = 1;
  const pending = new Map();
  ws.on('message', (raw) => {
    const message = JSON.parse(raw);
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    if (message.error || message.result?.exceptionDetails) {
      entry.reject(new Error(JSON.stringify(message.error || message.result.exceptionDetails)));
    } else {
      entry.resolve(message.result.result.value);
    }
  });
  const evaluate = (expression) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    });
  let failed = 0;
  const check = async (label, expression, expected) => {
    try {
      const actual = await evaluate(expression);
      const ok = JSON.stringify(actual) === JSON.stringify(expected);
      if (!ok) failed++;
      console.log(`${ok ? 'PASS' : 'FAIL'} ${label}${ok ? '' : ` (got ${JSON.stringify(actual)})`}`);
    } catch (error) {
      failed++;
      console.log(`FAIL ${label} (${error.message})`);
    }
  };
  return { evaluate, check, failures: () => failed, close: () => ws.close() };
}

module.exports = { connect };
