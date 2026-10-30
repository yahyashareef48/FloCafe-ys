/**
 * Android electronAPI shim — the Android shell injects
 * android/app/src/main/assets/electron-api-shim.js in place of main/preload.ts.
 * This pins that it exposes every preload method except the documented
 * omissions, never exposes getStatus (which draws the desktop title bar), and
 * routes each call to an action-server endpoint that exists.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as vm from 'node:vm';

const { assertOrThrow, assertEqualOrThrow } = require('./helpers/test-setup');

const root = path.resolve(__dirname, '..');
const shimSource = fs.readFileSync(path.join(root, 'android/app/src/main/assets/electron-api-shim.js'), 'utf8');
const preloadSource = fs.readFileSync(path.join(root, 'main/preload.ts'), 'utf8');
const actionServerSource = fs.readFileSync(path.join(root, 'main/android/action-server.ts'), 'utf8');

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

type Call = { url: string; init: { headers: Record<string, string>; body: string } };

function loadShim() {
  const fetchCalls: Call[] = [];
  const nativeCalls: Array<{ id: number; method: string; params: unknown }> = [];
  const channel: { onmessage: ((event: { data: string }) => void) | null; postMessage: (data: string) => void } = {
    onmessage: null,
    postMessage(data: string) {
      const message = JSON.parse(data);
      nativeCalls.push(message);
      setImmediate(() => channel.onmessage!({ data: JSON.stringify({ id: message.id, result: { ok: true } }) }));
    },
  };
  const fetchResponses: Record<string, unknown> = {
    '/backup': { success: true, path: '/data/docs/FloCafe/Manual Backups/flo-backup-x.db' },
    '/kds-info': { port: 3002 },
  };
  const window: Record<string, unknown> = { AlBaikNative: channel };
  const context = vm.createContext({
    window,
    Promise,
    JSON,
    Object,
    Boolean,
    fetch: async (url: string, init: Call['init']) => {
      fetchCalls.push({ url, init });
      const route = new URL(url).pathname;
      return { ok: true, json: async () => fetchResponses[route] ?? { success: true } };
    },
  });
  const source = shimSource.replaceAll('__FLO_HOST_CONFIG__', JSON.stringify({ actionPort: 45678, token: 'tok-123' }));
  vm.runInContext(source, context);
  return { api: window.electronAPI as Record<string, any>, fetchCalls, nativeCalls };
}

async function main(): Promise<void> {
  const { api, fetchCalls, nativeCalls } = loadShim();
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

  console.log('\n--- HTTP actions carry the token to existing routes ---');
  const httpCalls: Array<[string, () => Promise<unknown>, string]> = [
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
  for (const [name, invoke, route] of httpCalls) {
    const before = fetchCalls.length;
    await invoke();
    const call = fetchCalls[before];
    assertEqualOrThrow(call?.url, `http://127.0.0.1:45678${route}`, `${name} posts to ${route}`);
    assertEqualOrThrow(call.init.headers['x-flo-host-token'], 'tok-123', `${name} sends the host token`);
    assertOrThrow(
      new RegExp(`app\\.post\\(\\s*'${route}'`).test(actionServerSource),
      `${route} is served by the action server`,
    );
  }
  const restoreBody = JSON.parse(fetchCalls.find((c) => c.url.endsWith('/restore'))!.init.body);
  assertEqualOrThrow(restoreBody.backupPath, '/x.db', 'restore forwards a preset backup path');

  console.log('\n--- Native hand-offs ---');
  const backup = await api.backupDatabase('1234');
  assertEqualOrThrow(backup.success, true, 'backup returns the action result');
  const saveCall = nativeCalls.find((c) => c.method === 'saveFileCopy');
  assertOrThrow(Boolean(saveCall), 'a successful backup offers to save a copy through the shell');
  assertEqualOrThrow((saveCall!.params as { suggestedName: string }).suggestedName, 'flo-backup-x.db', 'save copy suggests the backup file name');
  await api.openKdsWindow();
  const overlay = nativeCalls.find((c) => c.method === 'openOverlay');
  assertEqualOrThrow((overlay!.params as { url: string }).url, 'http://127.0.0.1:3002/kds', 'KDS opens in a shell overlay');

  console.log('\n--- Safe no-ops ---');
  assertEqualOrThrow((await api.getUpdateStatus()).status, 'store-managed', 'updates report store-managed');
  assertEqualOrThrow((await api.getWindowState()).isFullScreen, true, 'window state reports full screen');
  assertEqualOrThrow((await api.getPostHogBootstrap()).enabled, false, 'PostHog stays disabled');
  assertEqualOrThrow(typeof api.onMenuAction(() => {}), 'function', 'onMenuAction returns an unsubscribe');
  assertEqualOrThrow(typeof api.onUpdateStatus(() => {}), 'function', 'onUpdateStatus returns an unsubscribe');
  assertEqualOrThrow(typeof api.onWindowStateChanged(() => {}), 'function', 'onWindowStateChanged returns an unsubscribe');

  console.log('\nandroid-electron-api-shim: all assertions passed');
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
