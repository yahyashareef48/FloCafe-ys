/**
 * The actions behind the Android `electronAPI` shim. The shim reaches them only
 * through the shell's WebView message channel and the UID- and token-checked
 * native bridge, so LAN clients of the POS servers can never call these
 * Master-PIN-level actions.
 */
import * as fs from 'fs';
import * as path from 'path';
import {
  applyDatabaseSafeFixes,
  backupDatabase,
  databaseHealthCheck,
  getRendererSettings,
  initializeDatabase,
  kdsInfo,
  listPrinters,
  logTail,
  masterPinStatus,
  openWhatsAppShare,
  pickRestoreFile,
  postHogBootstrap,
  reportRendererError,
  restoreDatabaseBackup,
  setRendererSetting,
  whatsAppStatus,
  type HostDialogs,
} from '../host-actions';
import { platformApp, platformPrinters, platformRasterRenderer } from '../platform';
import { createBackup, getDatabase } from '../db';
import {
  formatReceipt,
  printReceipt,
  printViaUSB,
  resolvePrinterContext,
} from '../printers/thermal';
import { getCurrencySymbol } from '../countries';
import { graphemeSegments } from '../../shared/print/width';
import { callNative } from './native-bridge';

/** Folder for manual backups; the shell then offers to copy the file anywhere the operator picks. */
export function manualBackupDir(): string {
  return path.join(platformApp().getPath('documents'), 'FloCafe', 'Manual Backups');
}

export function androidHostDialogs(): HostDialogs {
  return {
    async chooseBackupDestination(defaultFileName) {
      const dir = manualBackupDir();
      fs.mkdirSync(dir, { recursive: true });
      return path.join(dir, defaultFileName);
    },
    async chooseRestoreFile() {
      const picked = await callNative<{ path?: string } | null>(
        'pickFile',
        { purpose: 'restore' },
        { timeoutMs: 0 },
      );
      return picked?.path ?? null;
    },
    async confirmSchemaMismatch(backupVersion, currentVersion) {
      const answer = await callNative<{ confirmed?: boolean } | null>(
        'confirm',
        {
          title: 'Schema Version Mismatch',
          message: `Backup was created with Schema v${backupVersion}`,
          detail: `Current database uses Schema v${currentVersion}.\n\nRestoring will import data only (common fields) to preserve new database structure.\n\nDo you want to continue?`,
          confirmLabel: 'Restore Anyway',
          cancelLabel: 'Cancel',
        },
        { timeoutMs: 0 },
      );
      return answer?.confirmed === true;
    },
  };
}

type HostActionBody = Record<string, unknown>;
export type HostActionHandler = (route: string, body: unknown) => Promise<unknown>;

export function createHostActionHandler(options: {
  dialogs: HostDialogs;
  shutdownSignal?: AbortSignal;
  appInfo: () => Record<string, unknown>;
  extraRoutes?: Record<string, (body: HostActionBody) => unknown>;
}): HostActionHandler {
  const str = (value: unknown) => (typeof value === 'string' ? value : undefined);
  const routes: Record<string, (body: HostActionBody) => unknown> = {
    '/pick-restore-file': () => pickRestoreFile(options.dialogs),
    '/backup': (b) => backupDatabase(str(b.pin), options.dialogs, options.shutdownSignal),
    '/restore': (b) =>
      restoreDatabaseBackup(str(b.pin), str(b.backupPath), options.dialogs, options.shutdownSignal),
    '/health-check': () => databaseHealthCheck(),
    '/safe-fixes': (b) =>
      applyDatabaseSafeFixes(
        str(b.pin),
        Array.isArray(b.findingIds)
          ? b.findingIds.filter((id): id is string => typeof id === 'string')
          : undefined,
      ),
    '/master-pin-status': () => masterPinStatus(),
    '/initialize': (b) =>
      initializeDatabase(
        { pin: str(b.pin), confirmationPhrase: str(b.confirmationPhrase) },
        options.shutdownSignal,
      ),
    '/settings': () => getRendererSettings(),
    '/set-setting': (b) => setRendererSetting(b.key as string, b.value as string),
    '/whatsapp-status': () => whatsAppStatus(),
    '/whatsapp-share': (b) => openWhatsAppShare(b.url),
    '/kds-info': () => kdsInfo(),
    '/app-info': () => options.appInfo(),
    '/log-tail': () => logTail(),
    '/report-renderer-error': () => reportRendererError(),
    '/posthog-bootstrap': () => postHogBootstrap(),
    '/printers': () => listPrinters(),
    ...options.extraRoutes,
  };
  return async (route, body) => {
    const action = Object.prototype.hasOwnProperty.call(routes, route) ? routes[route] : undefined;
    if (!action) throw new Error(`Unknown host action ${route}`);
    const payload = body && typeof body === 'object' ? (body as HostActionBody) : {};
    return (await action(payload)) ?? null;
  };
}

/**
 * Exercises the shell's raster surface and printer discovery once, for diagnostics and CI. With
 * `printTo`, also sends a short job to that printer through the same path as a real print.
 */
export async function androidPrintingSelfTest(body: HostActionBody = {}) {
  const renderer = platformRasterRenderer();
  const raster = renderer
    ? await renderer.render({
        version: 1,
        requestId: `self-test-${Date.now()}`,
        text: 'Total ₹1,250.00',
        widthDots: 384,
        maxBandHeight: 24,
        direction: 'ltr',
        style: 'bold',
        financial: true,
        maxLines: 2,
      })
    : null;
  const printers = await platformPrinters()?.list();
  const printTo = typeof body.printTo === 'string' ? body.printTo : '';
  const receipt = body.receipt === true ? await printSelfTestReceipt(printTo) : null;
  const sent = printTo
    ? await printViaUSB(Buffer.from('\x1b@Al Baik POS self-test\n\n\n', 'latin1'), printTo)
    : null;
  return {
    raster: raster?.ok
      ? {
          ok: true,
          widthDots: raster.unit.bands[0]?.widthDots ?? 0,
          inkPixels: raster.unit.bands.reduce(
            (sum, band) => sum + band.pixels.filter((p) => p !== 0).length,
            0,
          ),
        }
      : { ok: false, detail: raster?.detail ?? 'No raster renderer' },
    printers: printers ?? [],
    sent,
    receipt,
  };
}

/**
 * Prints a rupee bill through the full receipt path (format, raster, dispatch) to `printTo`, set
 * up like a generic 80 mm profile at 32 columns. A temporary default printer is used only when
 * none is configured.
 */
async function printSelfTestReceipt(printTo: string) {
  const db = getDatabase();
  const tempId = 'android-self-test-printer';
  const configured = db
    .prepare("SELECT 1 FROM printers WHERE connection_type != 'webusb' LIMIT 1")
    .get();
  if (!configured) {
    db.prepare(
      "INSERT INTO printers (id, name, connection_type, is_default, paper_width) VALUES (?, ?, 'usb', 1, 'cols-32')",
    ).run(tempId, printTo || 'SR588 (Bluetooth 00:11:22:AA:BB:CC)');
  }
  const order = {
    order_number: 'ORD-SELFTEST-0001',
    token_number: 7,
    created_at: '2026-10-31 14:51:43',
    type: 'dine_in',
    items: [
      {
        product_name: 'Paneer Tikka',
        quantity: 1,
        unit_price: 250,
        total: 250,
        tax_amount: 0,
        addons: [],
      },
      {
        product_name: 'Jeera Rice',
        quantity: 2,
        unit_price: 150,
        total: 300,
        tax_amount: 0,
        addons: [],
      },
    ],
  };
  const bill = {
    bill_number: 'INV-SELFTEST-0001',
    subtotal: 550,
    discount_amount: 0,
    tax_amount: 0,
    total: 550,
    payment_details: [{ method: 'cash', amount: 550 }],
    order,
  };
  const business = {
    name: 'Al Baik',
    address: '',
    phone: '',
    taxRegistrationNumber: '',
    currency: 'INR',
    currency_symbol: '₹',
    country: 'IN',
    highlight_token: true,
  };
  try {
    return await printReceipt(order, bill, business, 'classic');
  } finally {
    db.prepare('DELETE FROM printers WHERE id = ?').run(tempId);
  }
}

/**
 * Runs the steps a bill's formatting takes, one at a time, writing each step's name to
 * logs/format-probe.log and syncing it before the step runs, so after a native crash the last
 * line names the step that crashed.
 */
export function androidFormatProbe() {
  const file = path.join(platformApp().getPath('userData'), 'logs', 'format-probe.log');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '');
  const order = {
    order_number: 'ORD-PROBE-0001',
    created_at: '2026-10-31 14:51:43',
    items: [
      {
        product_name: 'Paneer Tikka',
        quantity: 1,
        unit_price: 250,
        total: 250,
        tax_amount: 0,
        addons: [],
      },
    ],
  };
  const bill = { bill_number: 'INV-PROBE-0001', subtotal: 250, tax_amount: 0, total: 250, order };
  const business = { name: 'Al Baik', currency: 'INR', country: 'IN', timezone: 'Asia/Kolkata' };
  const date = new Date('2026-10-31T09:21:43Z');
  const steps: [string, () => unknown][] = [
    [
      'icu versions',
      () => `${process.versions.icu} ${process.versions.unicode} ${process.versions.tz}`,
    ],
    ['currency symbol INR en-IN', () => getCurrencySymbol('INR', 'en-IN')],
    [
      'Intl.NumberFormat en-IN INR',
      () => new Intl.NumberFormat('en-IN', { style: 'currency', currency: 'INR' }).format(550),
    ],
    ['regex Script=Latin', () => /\p{Script=Latin}/u.test('Paneer')],
    ['regex Letter', () => /\p{Letter}/u.test('Paneer')],
    ['toLocaleDateString en-IN', () => date.toLocaleDateString('en-IN-u-nu-latn')],
    ['toLocaleTimeString en-IN', () => date.toLocaleTimeString('en-IN-u-nu-latn')],
    [
      'toLocaleDateString Asia/Kolkata',
      () => date.toLocaleDateString('en-IN-u-nu-latn', { timeZone: 'Asia/Kolkata' }),
    ],
    [
      'toLocaleTimeString Asia/Kolkata',
      () => date.toLocaleTimeString('en-IN-u-nu-latn', { timeZone: 'Asia/Kolkata' }),
    ],
    ['toLocaleString en-US', () => date.toLocaleString('en-US-u-nu-latn')],
    ['String.normalize NFD', () => 'café'.normalize('NFD').length],
    ['grapheme segments (print width helper)', () => graphemeSegments('₹250 पनीर').length],
    ['regex Extended_Pictographic', () => /\p{Extended_Pictographic}/u.test('🍕')],
    ['regex Mark', () => /\p{Mark}/u.test('\u0301')],
    ['localeCompare', () => 'Paneer'.localeCompare('paneer')],
    ['localeCompare hi', () => 'पनीर'.localeCompare('चाय', 'hi')],
    ['Intl.Collator en', () => new Intl.Collator('en').compare('a', 'B')],
    [
      'Intl.DateTimeFormat formatToParts',
      () =>
        new Intl.DateTimeFormat('en-US', {
          timeZone: 'Asia/Kolkata',
          hour: 'numeric',
        }).formatToParts(date).length,
    ],
    ['Intl.DisplayNames region', () => new Intl.DisplayNames(['en'], { type: 'region' }).of('IN')],
    ['Intl.supportedValuesOf timeZone', () => Intl.supportedValuesOf('timeZone').length],
    [
      'Intl.NumberFormat hi-IN',
      () => new Intl.NumberFormat('hi-IN', { style: 'currency', currency: 'INR' }).format(1250),
    ],
    ['formatReceipt generic', () => formatReceipt(order, bill, business, 'classic', 32).length],
    [
      'formatReceipt SR588 profile',
      () => {
        const { capabilities } = resolvePrinterContext({
          name: 'SR588 (Bluetooth 00:11:22:AA:BB:CC)',
          paper_width: 'cols-32',
        });
        return formatReceipt(
          order,
          bill,
          business,
          'classic',
          32,
          false,
          false,
          'full',
          [],
          false,
          'en',
          undefined,
          capabilities,
        ).length;
      },
    ],
  ];
  const results: Record<string, unknown> = {};
  for (const [name, run] of steps) {
    const fd = fs.openSync(file, 'a');
    fs.writeSync(fd, `${name}\n`);
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    try {
      results[name] = run();
    } catch (error) {
      results[name] = `threw: ${(error as Error).message}`;
    }
    fs.appendFileSync(file, `  -> ${JSON.stringify(results[name])}\n`);
  }
  return results;
}

/**
 * Checks, on the device's real storage, that backups are refused and leave no file behind, and
 * that the documents folder (where crash reports go) is writable, for diagnostics and CI.
 */
export async function androidStorageSelfTest() {
  const documentsDir = platformApp().getPath('documents');
  const backupPath = path.join(manualBackupDir(), `self-test-${Date.now()}.db`);
  let backupError = '';
  try {
    await createBackup(backupPath);
  } catch (error) {
    backupError = (error as Error).message;
  }
  const backupLeftFile = fs.existsSync(backupPath);
  fs.rmSync(backupPath, { force: true });
  const probe = path.join(documentsDir, 'logs', `.storage-self-test-${Date.now()}`);
  let documentsWritable = false;
  try {
    fs.mkdirSync(path.dirname(probe), { recursive: true });
    fs.writeFileSync(probe, 'ok');
    documentsWritable = fs.readFileSync(probe, 'utf8') === 'ok';
  } finally {
    fs.rmSync(probe, { force: true });
  }
  return {
    documentsDir,
    backupRefused: backupError !== '',
    backupError,
    backupLeftFile,
    documentsWritable,
  };
}

export function createAndroidHostActionHandler(shutdownSignal?: AbortSignal): HostActionHandler {
  return createHostActionHandler({
    dialogs: androidHostDialogs(),
    shutdownSignal,
    extraRoutes: {
      '/printing-self-test': (b) => androidPrintingSelfTest(b),
      '/storage-self-test': () => androidStorageSelfTest(),
      '/format-probe': () => androidFormatProbe(),
    },
    appInfo: () => ({
      version: platformApp().getVersion(),
      name: 'Al Baik POS',
      node: process.versions.node,
      platform: 'android',
    }),
  });
}
