/**
 * Android electronAPI shim — the Android shell injects
 * android/app/src/main/assets/electron-api-shim.js in place of main/preload.ts.
 *
 * Part 1 (always): it exposes every preload method except the documented
 * omissions, never exposes getStatus (which draws the desktop title bar), and
 * routes each action over the shell channel to a backend route that exists.
 * Part 2 (Chromium): window.open() bills show in an in-page overlay whose
 * print goes to the shell and then closes back to the POS, and <a download>
 * blobs go to the shell's save dialog. Required when REQUIRE_VISUAL_EVIDENCE=1.
 */
import * as fs from 'node:fs';
import * as http from 'node:http';
import * as path from 'node:path';
import * as vm from 'node:vm';

const { assertOrThrow, assertEqualOrThrow } = require('./helpers/test-setup');

const root = path.resolve(__dirname, '..');
const shimSource = fs.readFileSync(path.join(root, 'android/app/src/main/assets/electron-api-shim.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'main/preload.ts'), 'utf8');
const hostRoutesSource = fs.readFileSync(path.join(root, 'main/android/host-action-routes.ts'), 'utf8');

const DELIBERATELY_OMITTED = [
  'getStatus',
  'rasterizePrintDocument',
  'rasterizeKotDocument',
  'saveHtmlAsPdf',
  'getBetaChannel',
  'setBetaChannel',
  'getAutoUpdateCheck',
  'setAutoUpdateCheck',
];

function preloadMethods(): string[] {
  const body = preloadSource.slice(preloadSource.indexOf("exposeInMainWorld('electronAPI', {"));
  return [...body.matchAll(/^ {2}([A-Za-z]+):/gm)].map((match) => match[1]);
}

type NativeCall = { id: number; method: string; params: any };

function loadShimInVm() {
  const nativeCalls: NativeCall[] = [];
  const hostResults: Record<string, unknown> = {
    '/backup': { success: true, path: '/data/docs/FloCafe/Manual Backups/flo-backup-x.db' },
  };
  const channel: { onmessage: ((event: { data: string }) => void) | null; postMessage: (data: string) => void } = {
    onmessage: null,
    postMessage(data: string) {
      const message = JSON.parse(data) as NativeCall;
      nativeCalls.push(message);
      const result =
        message.method === 'hostAction' ? (hostResults[message.params.route] ?? { success: true }) : { ok: true };
      setImmediate(() => channel.onmessage!({ data: JSON.stringify({ id: message.id, result }) }));
    },
  };
  function HTMLAnchorElement() {}
  const window: Record<string, unknown> = { AlBaikNative: channel };
  const context = vm.createContext({
    window,
    Promise,
    JSON,
    Object,
    Boolean,
    String,
    Map,
    URL,
    Blob,
    setTimeout,
    HTMLAnchorElement,
    location: { href: 'http://127.0.0.1:3001/pos' },
    document: { addEventListener() {} },
  });
  vm.runInContext(shimSource, context);
  return { api: window.electronAPI as Record<string, any>, nativeCalls };
}

async function contract(): Promise<void> {
  const { api, nativeCalls } = loadShimInVm();
  const preload = preloadMethods();
  assertOrThrow(preload.length >= 30, `read the preload method list (${preload.length} methods)`);

  console.log('\n--- Method coverage ---');
  const exposed = Object.keys(api).sort();
  const expected = preload.filter((name) => !DELIBERATELY_OMITTED.includes(name)).sort();
  assertEqualOrThrow(JSON.stringify(exposed), JSON.stringify(expected), 'shim exposes every preload method except the documented omissions');
  for (const name of DELIBERATELY_OMITTED) {
    assertOrThrow(preload.includes(name), `omitted ${name} still exists in preload (omission list is current)`);
    assertOrThrow(shimSource.includes(name), `omission of ${name} is documented in the shim header`);
  }
  assertEqualOrThrow(api.getStatus, undefined, 'getStatus is absent, so no desktop title bar is drawn');
  assertEqualOrThrow(api.platform, 'android', 'platform is android');
  assertOrThrow(Object.isFrozen(api), 'the bridge object is frozen');

  console.log('\n--- Actions go over the shell channel to existing backend routes ---');
  const actionCalls: Array<[string, () => Promise<unknown>, string]> = [
    ['restoreBackup', () => api.restoreBackup('1234', '/x.db'), '/restore'],
    ['pickRestoreFile', () => api.pickRestoreFile(), '/pick-restore-file'],
    ['dbHealthCheck', () => api.dbHealthCheck(), '/health-check'],
    ['dbApplySafeFixes', () => api.dbApplySafeFixes('1234', ['a']), '/safe-fixes'],
    ['dbInitialize', () => api.dbInitialize('1234', 'INITIALIZE'), '/initialize'],
    ['getMasterPinStatus', () => api.getMasterPinStatus(), '/master-pin-status'],
    ['getSettings', () => api.getSettings(), '/settings'],
    ['setSetting', () => api.setSetting('theme_mode', 'dark'), '/set-setting'],
    ['getKdsInfo', () => api.getKdsInfo(), '/kds-info'],
    ['getAppInfo', () => api.getAppInfo(), '/app-info'],
    ['getLogTail', () => api.getLogTail(), '/log-tail'],
    ['reportRendererError', () => api.reportRendererError({}), '/report-renderer-error'],
    ['openWhatsAppShare', () => api.openWhatsAppShare('https://wa.me/1'), '/whatsapp-share'],
    ['getPrinters', () => api.getPrinters(), '/printers'],
  ];
  for (const [name, invoke, route] of actionCalls) {
    const before = nativeCalls.length;
    await invoke();
    const call = nativeCalls[before];
    assertEqualOrThrow(call?.method, 'hostAction', `${name} goes over the shell channel`);
    assertEqualOrThrow(call.params.route, route, `${name} calls ${route}`);
    assertOrThrow(hostRoutesSource.includes(`'${route}':`), `${route} is a backend host action`);
  }
  const restoreCall = nativeCalls.find((c) => c.method === 'hostAction' && c.params.route === '/restore')!;
  assertEqualOrThrow(restoreCall.params.body.backupPath, '/x.db', 'restore forwards a preset backup path');
  assertOrThrow(!/fetch\(|XMLHttpRequest|127\.0\.0\.1:\d/.test(shimSource.replace(/\/\*[\s\S]*?\*\//, '')), 'the shim makes no network calls of its own');

  console.log('\n--- Native hand-offs and safe no-ops ---');
  const backup = await api.backupDatabase('1234');
  assertEqualOrThrow(backup.success, true, 'backup returns the action result');
  const saveCall = nativeCalls.find((c) => c.method === 'saveFileCopy');
  assertOrThrow(Boolean(saveCall), 'a successful backup offers to save a copy through the shell');
  assertEqualOrThrow((saveCall!.params as { suggestedName: string }).suggestedName, 'flo-backup-x.db', 'save copy suggests the backup file name');
  assertEqualOrThrow((await api.getUpdateStatus()).status, 'store-managed', 'updates report store-managed');
  assertEqualOrThrow((await api.getWindowState()).isFullScreen, true, 'window state reports full screen');
  assertEqualOrThrow((await api.getPostHogBootstrap()).enabled, false, 'PostHog stays disabled');
  assertEqualOrThrow(typeof api.onMenuAction(() => {}), 'function', 'onMenuAction returns an unsubscribe');
  assertEqualOrThrow(typeof api.onUpdateStatus(() => {}), 'function', 'onUpdateStatus returns an unsubscribe');
  assertEqualOrThrow(typeof api.onWindowStateChanged(() => {}), 'function', 'onWindowStateChanged returns an unsubscribe');
}

function launchChromium(): Promise<any> {
  const playwright = require(path.resolve(root, 'frontend/node_modules/@playwright/test'));
  const executablePath = process.env.FLO_TEST_CHROMIUM_PATH || undefined;
  return playwright.chromium.launch({ headless: true, ...(executablePath ? { executablePath } : {}) });
}

async function browserBehaviour(): Promise<void> {
  let browser: any;
  try {
    browser = await launchChromium();
  } catch (error: any) {
    if (process.env.REQUIRE_VISUAL_EVIDENCE === '1') throw error;
    console.warn(`  ! Chromium not available; overlay and download checks skipped: ${error?.message || error}`);
    return;
  }
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<!doctype html><html><body><main id="pos">POS order screen</main></body></html>');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  try {
    const page = await browser.newPage();
    await page.addInitScript(`
      window.__nativeCalls = [];
      window.AlBaikNative = {
        onmessage: null,
        postMessage(data) {
          const message = JSON.parse(data);
          window.__nativeCalls.push(message);
          const delay = message.method === 'printHtml' ? 300 : 0;
          setTimeout(() => this.onmessage({ data: JSON.stringify({ id: message.id, result: {} }) }), delay);
        },
      };
    `);
    await page.addInitScript(shimSource);
    await page.goto(`http://127.0.0.1:${port}/pos`);
    const overlayCount = () => page.locator('[data-flo-android-overlay]').count();
    const calls = (method: string) =>
      page.evaluate((m: string) => window.__nativeCalls.filter((c: any) => c.method === m), method);

    console.log('\n--- Bill pop-up prints and returns to the POS ---');
    await page.evaluate(() => {
      const w = window.open('', '_blank')!;
      (window as any).__bill = w;
      w.document.open();
      w.document.write('<!doctype html><html><body><p id="bill">BILL-42</p></body></html>');
      w.document.close();
      w.print();
    });
    assertEqualOrThrow(await overlayCount(), 1, 'window.open shows the bill in an in-page overlay');
    assertEqualOrThrow(page.url(), `http://127.0.0.1:${port}/pos`, 'the POS page is not navigated away');
    const prints = await calls('printHtml');
    assertEqualOrThrow(prints.length, 1, 'print() goes to the shell once');
    assertIncludes(prints[0].params.html, 'BILL-42', 'the shell receives the bill document');
    await page.waitForFunction(() => !document.querySelector('[data-flo-android-overlay]'), null, { timeout: 5000 });
    assertEqualOrThrow(await page.evaluate(() => (window as any).__bill.closed), true, 'the bill window reports closed after printing');
    assertEqualOrThrow(await page.locator('#pos').isVisible(), true, 'the POS order screen is back');

    console.log('\n--- The bill page own Print button and the toolbar both work ---');
    await page.evaluate(() => {
      const w = window.open('', '_blank')!;
      w.document.open();
      w.document.write('<html><body><button id="own" onclick="window.print()">Print Bill</button></body></html>');
      w.document.close();
    });
    await page.frameLocator('[data-flo-android-overlay] iframe').locator('#own').click();
    await page.waitForFunction(() => window.__nativeCalls.filter((c: any) => c.method === 'printHtml').length === 2);
    assertEqualOrThrow((await calls('printHtml')).length, 2, "the bill's own Print Bill button prints through the shell");
    await page.waitForFunction(() => !document.querySelector('[data-flo-android-overlay]'), null, { timeout: 5000 });

    await page.evaluate(() => {
      window.open('', '_blank')!.document.write('<p>preview</p>');
    });
    await page.locator('[data-flo-android-overlay] button', { hasText: 'Close' }).click();
    assertEqualOrThrow(await overlayCount(), 0, 'Close returns to the POS without printing');
    assertEqualOrThrow((await calls('printHtml')).length, 2, 'Close does not print');

    console.log('\n--- External links and downloads ---');
    const external = await page.evaluate(() => window.open('https://wa.me/911234567890'));
    assertEqualOrThrow(external, null, 'external links do not open in the WebView');
    assertEqualOrThrow((await calls('openExternal'))[0]?.params.url, 'https://wa.me/911234567890', 'external links go to the shell');

    await page.evaluate(() => {
      const url = URL.createObjectURL(new Blob(['a,b\n1,2\n'], { type: 'text/csv' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = 'sales.csv';
      link.click();
      URL.revokeObjectURL(url);
    });
    await page.waitForFunction(() => window.__nativeCalls.some((c: any) => c.method === 'saveDownload'));
    const saved = (await calls('saveDownload'))[0].params;
    assertEqualOrThrow(saved.name, 'sales.csv', 'download keeps its file name');
    assertEqualOrThrow(saved.mimeType, 'text/csv', 'download keeps its type');
    assertEqualOrThrow(Buffer.from(saved.base64, 'base64').toString('utf8'), 'a,b\n1,2\n', 'download content survives an immediate revokeObjectURL');
  } finally {
    await browser.close().catch(() => undefined);
    server.close();
  }
}

function assertIncludes(haystack: string, needle: string, message: string): void {
  assertOrThrow(typeof haystack === 'string' && haystack.includes(needle), message);
}

declare global {
  interface Window {
    __nativeCalls: any[];
  }
}

async function main(): Promise<void> {
  await contract();
  await browserBehaviour();
  console.log('\nandroid-electron-api-shim: all assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
