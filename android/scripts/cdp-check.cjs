'use strict';

// Evaluates assertions inside the app's live WebView over the DevTools protocol.
// Usage: node cdp-check.cjs <forwarded-port>
const WebSocket = require('ws');

const port = Number(process.argv[2] || 9222);

async function pageSocketUrl() {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
      const page = pages.find((p) => p.type === 'page' && String(p.url).startsWith('http://127.0.0.1:3001'));
      if (page) return page.webSocketDebuggerUrl;
    } catch {
      // DevTools socket not up yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error('POS WebView did not appear in DevTools');
}

function evaluator(ws) {
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
  return (expression) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true },
      }));
    });
}

async function main() {
  const ws = new WebSocket(await pageSocketUrl());
  await new Promise((resolve, reject) => {
    ws.once('open', resolve);
    ws.once('error', reject);
  });
  const evaluate = evaluator(ws);
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

  await check('POS loads from the on-device server', "location.origin", 'http://127.0.0.1:3001');
  await check('electronAPI shim is injected', "window.electronAPI && window.electronAPI.platform", 'android');
  await check('getStatus is absent (no desktop title bar)', "typeof window.electronAPI.getStatus", 'undefined');
  await check('shim reaches the action server with its token', "window.electronAPI.getAppInfo().then((i) => i.platform)", 'android');
  await check('master PIN storage is available (Android Keystore key)', "window.electronAPI.getMasterPinStatus().then((s) => s.available)", true);
  await check('settings load through the shim', "window.electronAPI.getSettings().then((s) => typeof s === 'object' && !s.error)", true);
  await check(
    'window.open shows an in-page overlay instead of leaving the POS',
    "(() => { const w = window.open('', '_blank'); const shown = !!document.querySelector('[data-flo-android-overlay]'); w.close(); return shown && location.origin; })()",
    'http://127.0.0.1:3001',
  );
  await check('overlay closes back to the POS', "document.querySelector('[data-flo-android-overlay]') === null", true);
  await check(
    'raster surface renders the rupee sign in the shell WebView',
    "new Promise((resolve) => { window.AlBaikNative.postMessage(JSON.stringify({ id: 9001, method: 'hostAction', params: { route: '/printing-self-test', body: {} } })); const previous = window.AlBaikNative.onmessage; window.AlBaikNative.onmessage = (event) => { const message = JSON.parse(event.data); if (message.id !== 9001) return previous(event); window.AlBaikNative.onmessage = previous; resolve(message.result && message.result.raster.ok && message.result.raster.widthDots === 384 && message.result.raster.inkPixels > 0); }; })",
    true,
  );
  await check(
    'printer discovery answers (no printers attached to the emulator)',
    "new Promise((resolve) => { window.AlBaikNative.postMessage(JSON.stringify({ id: 9002, method: 'hostAction', params: { route: '/printing-self-test', body: {} } })); const previous = window.AlBaikNative.onmessage; window.AlBaikNative.onmessage = (event) => { const message = JSON.parse(event.data); if (message.id !== 9002) return previous(event); window.AlBaikNative.onmessage = previous; resolve(Array.isArray(message.result && message.result.printers)); }; })",
    true,
  );
  await check('no desktop title bar is rendered', "document.querySelector('[data-testid=\"desktop-title-bar\"]') === null", true);
  ws.close();
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
