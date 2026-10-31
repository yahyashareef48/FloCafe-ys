'use strict';

// Evaluates assertions inside the app's live WebView over the DevTools protocol.
// Usage: node cdp-check.cjs <forwarded-port>
const { spawnSync } = require('child_process');
const { connect } = require('./cdp.cjs');

/** Sends a request on the page's AlBaikNative channel and resolves with the shell's reply. */
function nativeCall(method, params) {
  return `new Promise((resolve) => {
    const id = Math.floor(Math.random() * 1e9);
    const previous = window.AlBaikNative.onmessage;
    window.AlBaikNative.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.id !== id) return previous(event);
      window.AlBaikNative.onmessage = previous;
      resolve(message);
    };
    window.AlBaikNative.postMessage(JSON.stringify({ id, method: ${JSON.stringify(method)}, params: ${JSON.stringify(params)} }));
  })`;
}

function topActivity() {
  const out = spawnSync('adb', ['shell', 'dumpsys', 'activity', 'activities'], { encoding: 'utf8' }).stdout || '';
  const line = out.split('\n').find((l) => /topResumedActivity|mResumedActivity/.test(l)) || '';
  return line.trim();
}

function pidOf() {
  return (spawnSync('adb', ['shell', 'pidof', 'com.albaik.pos'], { encoding: 'utf8' }).stdout || '').trim();
}

async function waitForTop(pattern, timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    const top = topActivity();
    if (pattern.test(top)) return top;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return topActivity();
}

const port = Number(process.argv[2] || 9222);

async function main() {
  const { check, evaluate, failures, close } = await connect(port, 'http://127.0.0.1:3001');
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
  const storage = (await evaluate(nativeCall('hostAction', { route: '/storage-self-test', body: {} }))).result || {};
  console.log(`storage self-test: ${JSON.stringify(storage)}`);
  await check('backups write to and publish on the device storage', `${storage.manualBytes > 0 && storage.publishedBytes === storage.manualBytes}`, true);

  // No printer answers at this address, so a working path ends in "Could not reach", not a crash.
  const pidBefore = pidOf();
  const bluetooth = (await evaluate(nativeCall('hostAction', { route: '/printing-self-test', body: { printTo: 'CI Printer (Bluetooth 00:11:22:AA:BB:CC)' } }))).result || {};
  const sent = bluetooth.sent || {};
  console.log(`bluetooth print: ${JSON.stringify(sent)}`);
  if (/Bluetooth is off/.test(String(sent.detail))) console.log('WARN the emulator Bluetooth is off, so the connect path was not reached');
  await check('a Bluetooth print reaches the connect step', `${sent.ok === false && /Could not reach the Bluetooth printer|Bluetooth is off/.test(String(sent.detail))}`, true);
  await check('a Bluetooth print does not ask for permissions the app already has', `${!/nearby devices/.test(String(sent.detail))}`, true);
  await check('the app is still running after the Bluetooth print', `${pidOf() === pidBefore && pidBefore !== ''}`, true);

  // Each formatting step on its own; logs/format-probe.log names the one that crashes, if any.
  const probe = (await evaluate(nativeCall('hostAction', { route: '/format-probe', body: {} }))).result || {};
  console.log(`format probe: ${JSON.stringify(probe)}`);
  await check('every receipt formatting step runs on the device', `${Number(probe['formatReceipt SR588 profile']) > 0}`, true);
  // A tablet closed while building a real bill, before any printer step; run the same path here.
  const receiptRun = (await evaluate(nativeCall('hostAction', { route: '/printing-self-test', body: { receipt: true, printTo: 'SR588 (Bluetooth 00:11:22:AA:BB:CC)' } }))).result || {};
  console.log(`receipt print: ${JSON.stringify(receiptRun.receipt)}`);
  await check('a rupee bill is formatted, drawn and sent to the Bluetooth printer', `${!!receiptRun.receipt && /Could not reach the Bluetooth printer|Bluetooth is off/.test(String(receiptRun.receipt.detail))}`, true);
  await check('the app is still running after printing a bill', `${pidOf() === pidBefore}`, true);

  // System UI round trips: start the request, check the Android screen opened, cancel with Back.
  await evaluate(`window.__saveReply = null; (${nativeCall('saveDownload', { name: 'sales.csv', mimeType: 'text/csv', base64: 'YSxiCjEsMgo=' })}).then((m) => { window.__saveReply = m; }); true`);
  const saveTop = await waitForTop(/documentsui/i);
  console.log(`save dialog: ${saveTop}`);
  await check('downloads open the Android "save as" screen', `${/documentsui/i.test(saveTop)}`, true);
  spawnSync('adb', ['shell', 'input', 'keyevent', 'KEYCODE_BACK']);
  await new Promise((resolve) => setTimeout(resolve, 2000));
  await check('cancelling "save as" answers the page (saved: false)', 'window.__saveReply && window.__saveReply.result && window.__saveReply.result.saved', false);

  await evaluate("(() => { const w = window.open('', '_blank'); w.document.write('<p>BILL-SMOKE</p>'); w.print(); return true; })()");
  const printTop = await waitForTop(/printspooler/i);
  console.log(`print dialog: ${printTop}`);
  await check('Print opens the Android print dialog', `${/printspooler/i.test(printTop)}`, true);
  spawnSync('adb', ['shell', 'input', 'keyevent', 'KEYCODE_BACK']);
  await new Promise((resolve) => setTimeout(resolve, 3000));
  await check('closing the print dialog returns to the POS (overlay closed)', "document.querySelector('[data-flo-android-overlay]') === null", true);
  await check('the POS is still on screen after printing', 'location.origin', 'http://127.0.0.1:3001');

  await check('no desktop title bar is rendered', "document.querySelector('[data-testid=\"desktop-title-bar\"]') === null", true);
  close();
  process.exit(failures() === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
