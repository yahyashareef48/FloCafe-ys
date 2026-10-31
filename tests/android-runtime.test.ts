/**
 * Android runtime — runs the compiled Android entry in plain Node with
 * `electron` unresolvable, against a fake shell speaking the native bridge
 * protocol, and drives the host actions the `electronAPI` shim reaches over it.
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';

const bcrypt = require('bcryptjs');
const { assertOrThrow, assertEqualOrThrow } = require('./helpers/test-setup');
const { createKeyedSafeStorage } = require('../main/platform/keyed-safe-storage');
const Database = require('better-sqlite3');

function getDatabaseRowCount(file: string, sql: string): number {
  const db = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return Number(db.prepare(sql).get().n);
  } finally {
    db.close();
  }
}

const root = path.resolve(__dirname, '..');
// Lets a packaging check run this suite against the staged Android bundle.
const runtimeRoot = process.env.FLO_ANDROID_RUNTIME_ROOT || root;
const work = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-android-runtime-'));
const userData = path.join(work, 'data');
const documents = path.join(work, 'documents');
fs.mkdirSync(userData, { recursive: true });
const key = randomBytes(32);
const bridgeToken = randomBytes(16).toString('hex');
const socketName = `flo-android-test-${process.pid}-${randomBytes(4).toString('hex')}`;
const ports = { api: 3301, kds: 3302, serverApp: 3303 };

type Message = Record<string, any>;
let shell: net.Socket | null = null;
let helloToken: string | null = null;
const events: Message[] = [];
const nativeCalls: Message[] = [];
const responses = new Map<number, Message>();
let pickedRestorePath: string | null = null;

function sendToNode(message: Message): void {
  shell!.write(`${JSON.stringify(message)}\n`);
}

const server = net.createServer((socket) => {
  shell = socket;
  let buffered = '';
  socket.setEncoding('utf8');
  socket.on('data', (chunk: string) => {
    buffered += chunk;
    let newline: number;
    while ((newline = buffered.indexOf('\n')) !== -1) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      const message = JSON.parse(line) as Message;
      if (message.type === 'hello') helloToken = message.token;
      else if (message.type === 'event') events.push(message);
      else if (typeof message.method === 'string') {
        nativeCalls.push(message);
        if (message.method === 'pickFile')
          sendToNode({ id: message.id, result: { path: pickedRestorePath } });
        else if (message.method === 'rasterRender') {
          const request = message.params.request;
          const pixels = Buffer.alloc(request.widthDots * 24, 1).toString('base64');
          sendToNode({
            id: message.id,
            result: {
              version: 1,
              requestId: request.requestId,
              ok: true,
              unit: {
                unitId: request.requestId,
                financial: request.financial,
                complete: true,
                bands: [{ widthDots: request.widthDots, heightDots: 24, pixelsBase64: pixels }],
              },
            },
          });
        } else if (message.method === 'printerSend') {
          sendToNode({
            id: message.id,
            result: { ok: false, detail: `no printer called ${message.params.name}` },
          });
        } else if (message.method === 'printerList') {
          sendToNode({
            id: message.id,
            result: [
              {
                name: 'SR588 (USB 0483:5720)',
                make: 'SR588',
                model: 'Posiflow',
                connectionType: 'usb',
                deviceUri: 'usb://0483/5720',
              },
            ],
          });
        } else if (message.method === 'confirm')
          sendToNode({ id: message.id, result: { confirmed: true } });
        else sendToNode({ id: message.id, result: null });
      } else if (typeof message.id === 'number') responses.set(message.id, message);
    }
  });
});

async function waitFor<T>(
  label: string,
  probe: () => T | undefined | null | false,
  timeoutMs = 60_000,
): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() - started > timeoutMs) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

let nextRequestId = 1;

async function hostAction(route: string, body: unknown = {}): Promise<Message> {
  const id = nextRequestId++;
  sendToNode({ id, method: 'hostAction', params: { route, body } });
  return waitFor(`host action ${route}`, () => responses.get(id), 60_000);
}

async function run(child: ChildProcess, output: () => string): Promise<void> {
  console.log('\n--- Boots without Electron and reports ready ---');
  await waitFor('bridge hello', () => helloToken);
  assertEqualOrThrow(
    helloToken,
    bridgeToken,
    'Node authenticates to the shell with the launch token',
  );
  const failed = () => events.find((e) => e.event === 'failed');
  const ready = await waitFor(
    'ready event',
    () => {
      if (failed())
        throw new Error(`runtime failed: ${JSON.stringify(failed()!.data)}\n${output()}`);
      if (child.exitCode !== null)
        throw new Error(`runtime exited early (${child.exitCode})\n${output()}`);
      return events.find((e) => e.event === 'ready');
    },
    120_000,
  );
  const info = ready.data;
  assertEqualOrThrow(info.serverPort, ports.api, 'reports the POS API port');
  assertEqualOrThrow(info.kdsPort, ports.kds, 'reports the KDS port');
  assertEqualOrThrow(info.serverAppPort, ports.serverApp, 'reports the Server App port');
  assertOrThrow(
    !/blocked: the Android runtime must not load Electron/.test(output()),
    'no code path tried to load Electron',
  );

  const health = await fetch(`http://127.0.0.1:${ports.api}/api/health`);
  assertEqualOrThrow(health.status, 200, 'POS API answers /api/health');
  assertOrThrow(
    fs.existsSync(path.join(userData, 'flo.db')),
    'database lives under the Android userData',
  );
  assertOrThrow(
    fs.existsSync(path.join(userData, 'logs', 'main.log')),
    'log file lives under the Android userData',
  );

  console.log('\n--- Host actions run over the native bridge only ---');
  const appInfo = await hostAction('/app-info');
  assertEqualOrThrow(appInfo.result?.platform, 'android', 'app info reports android');
  const unknown = await hostAction('/no-such-action');
  assertOrThrow(
    typeof unknown.error === 'string' && unknown.error.includes('Unknown host action'),
    'unknown actions are rejected',
  );
  const prototypeKey = await hostAction('constructor');
  assertOrThrow(typeof prototypeKey.error === 'string', 'object prototype keys are not routes');

  const pinStatus = await hostAction('/master-pin-status');
  assertEqualOrThrow(
    pinStatus.result.available,
    true,
    'master PIN is available through keyed storage',
  );
  assertEqualOrThrow(
    pinStatus.result.isSet,
    true,
    'master PIN sealed by the shell key is readable',
  );

  const settings = await hostAction('/settings');
  assertEqualOrThrow(typeof settings.result, 'object', 'settings are returned');
  assertOrThrow(
    settings.result.jwt_secret === undefined ||
      String(settings.result.jwt_secret).startsWith('****'),
    'the JWT secret is masked',
  );

  console.log('\n--- Printing self-test reaches the shell raster surface and printers ---');
  const selfTest = (await hostAction('/printing-self-test')).result;
  assertEqualOrThrow(selfTest.raster.ok, true, 'the shell raster surface renders a unit');
  assertEqualOrThrow(selfTest.raster.widthDots, 384, 'raster bands decode with their width');
  assertEqualOrThrow(selfTest.raster.inkPixels, 384 * 24, 'raster pixels decode from base64');
  assertEqualOrThrow(
    selfTest.printers[0]?.name,
    'SR588 (USB 0483:5720)',
    'printer discovery reaches the shell',
  );
  assertOrThrow(
    nativeCalls.some(
      (c) =>
        c.method === 'rasterRender' &&
        typeof c.params.pageHtml === 'string' &&
        c.params.pageHtml.includes('__floRaster'),
    ),
    'the raster page is sent to the shell',
  );
  assertEqualOrThrow(selfTest.sent, null, 'the self-test prints nothing unless asked');
  const printed = (
    await hostAction('/printing-self-test', { printTo: 'SR588 (Bluetooth C8:47:8C:E6:B0:DF)' })
  ).result;
  const job = nativeCalls.filter((c) => c.method === 'printerSend').pop();
  assertEqualOrThrow(
    job?.params.name,
    'SR588 (Bluetooth C8:47:8C:E6:B0:DF)',
    'the self-test job goes to the named printer',
  );
  assertOrThrow(
    Buffer.from(String(job?.params.data), 'base64')
      .toString('latin1')
      .includes('Al Baik POS self-test'),
    'the self-test job carries ESC/POS text',
  );
  assertEqualOrThrow(printed.sent.ok, false, 'a refused job is reported');
  assertEqualOrThrow(
    printed.sent.detail,
    'no printer called SR588 (Bluetooth C8:47:8C:E6:B0:DF)',
    'the shell reason reaches the caller',
  );
  const sendsBefore = nativeCalls.filter((c) => c.method === 'printerSend').length;
  const receipt = (
    await hostAction('/printing-self-test', {
      receipt: true,
      printTo: 'SR588 (Bluetooth C8:47:8C:E6:B0:DF)',
    })
  ).result;
  const receiptJob = nativeCalls.filter((c) => c.method === 'printerSend')[sendsBefore];
  assertEqualOrThrow(
    receiptJob?.params.name,
    'SR588 (Bluetooth C8:47:8C:E6:B0:DF)',
    'the self-test receipt goes through the full print path to the named printer',
  );
  const receiptBytes = Buffer.from(String(receiptJob?.params.data), 'base64');
  assertOrThrow(
    receiptBytes.length > 500 && receiptBytes[0] === 0x1b && receiptBytes[1] === 0x40,
    `the self-test receipt is a full ESC/POS bill (${receiptBytes.length} bytes)`,
  );
  assertEqualOrThrow(receipt.receipt.ok, false, 'the refused receipt is reported');
  assertEqualOrThrow(
    getDatabaseRowCount(
      path.join(userData, 'flo.db'),
      "SELECT COUNT(*) AS n FROM printers WHERE id = 'android-self-test-printer'",
    ),
    0,
    'the temporary printer is removed',
  );
  const probe = (await hostAction('/format-probe')).result;
  assertOrThrow(
    Number(probe['formatReceipt SR588 profile']) > 0,
    `the format probe runs every receipt formatting step (${JSON.stringify(probe)})`,
  );
  const mainLog = fs.readFileSync(path.join(userData, 'logs', 'main.log'), 'utf8');
  assertOrThrow(
    mainLog.includes('printViaUSB called') &&
      mainLog.includes('SR588 (Bluetooth C8:47:8C:E6:B0:DF)'),
    'printer console output reaches main.log for crash reports',
  );

  const storage = (await hostAction('/storage-self-test')).result;
  assertEqualOrThrow(
    storage.backupRefused,
    true,
    `the storage self-test is refused a backup (${storage.backupError})`,
  );
  assertEqualOrThrow(storage.backupLeftFile, false, 'a refused backup leaves no file');
  assertEqualOrThrow(
    storage.documentsWritable,
    true,
    'the documents folder for crash reports is writable',
  );
  assertEqualOrThrow(
    storage.documentsDir,
    documents,
    'the storage self-test uses the Android documents folder',
  );

  console.log('\n--- Backups are refused; restore still works ---');
  const refused = (await hostAction('/backup', { pin: '2468' })).result;
  assertEqualOrThrow(
    refused.success,
    false,
    `the Android app refuses a manual backup (${JSON.stringify(refused)})`,
  );
  const manualDir = path.join(documents, 'FloCafe', 'Manual Backups');
  assertEqualOrThrow(
    fs.existsSync(manualDir)
      ? fs.readdirSync(manualDir).filter((name) => name.endsWith('.db')).length
      : 0,
    0,
    'no manual backup file is written',
  );
  const privateBackups = path.join(userData, 'backups');
  assertEqualOrThrow(
    fs.existsSync(privateBackups)
      ? fs.readdirSync(privateBackups).filter((name) => /^flo-backup-.*\.db$/.test(name)).length
      : 0,
    0,
    'no backup is kept in the private folder, including before the first migration',
  );

  // A file the operator brings: a copy of the live database stamped like a backup.
  fs.mkdirSync(manualDir, { recursive: true });
  const broughtBackup = path.join(manualDir, 'brought-backup.db');
  const live = new Database(path.join(userData, 'flo.db'), { readonly: true });
  const schemaVersion = Number(live.pragma('user_version', { simple: true }));
  await live.backup(broughtBackup);
  live.close();
  const stamp = new Database(broughtBackup);
  stamp.pragma('journal_mode = DELETE');
  stamp.exec('CREATE TABLE IF NOT EXISTS _flo_meta (key TEXT PRIMARY KEY, value TEXT)');
  stamp
    .prepare("INSERT OR REPLACE INTO _flo_meta (key, value) VALUES ('schema_version', ?)")
    .run(String(schemaVersion));
  stamp.close();
  const backup = { path: broughtBackup };

  pickedRestorePath = backup.path;
  const restore = (await hostAction('/restore', { pin: '2468' })).result;
  assertEqualOrThrow(restore.success, true, `restore succeeds (${JSON.stringify(restore)})`);
  assertOrThrow(
    nativeCalls.some((c) => c.method === 'pickFile'),
    'restore asks the shell for the file',
  );

  const picked = (await hostAction('/pick-restore-file')).result;
  assertEqualOrThrow(picked.canceled, false, 'pick-restore-file returns the shell pick');
  assertOrThrow(
    typeof picked.token === 'string' && picked.token.length > 0,
    'pick-restore-file issues a selection token',
  );

  console.log('\n--- Shell-initiated shutdown drains the runtime ---');
  const shutdownId = nextRequestId++;
  sendToNode({ id: shutdownId, method: 'shutdown', params: null });
  const stopped = await waitFor('shutdown response', () => responses.get(shutdownId), 60_000);
  assertEqualOrThrow(stopped.result?.stopped, true, 'shutdown completes');
  let apiClosed = false;
  try {
    await fetch(`http://127.0.0.1:${ports.api}/api/health`);
  } catch {
    apiClosed = true;
  }
  assertOrThrow(apiClosed, 'POS API is closed after shutdown');
}

async function main(): Promise<void> {
  fs.writeFileSync(
    path.join(userData, 'master-pin.enc'),
    createKeyedSafeStorage(key).encryptString(
      JSON.stringify({ hash: bcrypt.hashSync('2468', 4), createdAt: 'x', updatedAt: 'x' }),
    ),
  );
  await new Promise<void>((resolve) => server.listen({ path: `\0${socketName}` }, resolve));

  let output = '';
  const child = spawn(
    process.execPath,
    [
      '--require',
      path.join(__dirname, 'fixtures', 'block-electron.cjs'),
      path.join(runtimeRoot, 'dist', 'main', 'android', 'entry.js'),
    ],
    {
      cwd: runtimeRoot,
      env: {
        PATH: process.env.PATH,
        HOME: work,
        TMPDIR: work,
        PORT: String(ports.api),
        KDS_PORT: String(ports.kds),
        SERVER_APP_PORT: String(ports.serverApp),
        FLO_ANDROID_USER_DATA: userData,
        FLO_ANDROID_DOCUMENTS: documents,
        FLO_ANDROID_VERSION: '3.13.0-android-test',
        FLO_ANDROID_LOCALE: 'en-IN',
        FLO_ANDROID_COUNTRY: 'IN',
        FLO_ANDROID_SECRET_KEY: key.toString('base64'),
        FLO_ANDROID_BRIDGE_SOCKET: socketName,
        FLO_ANDROID_BRIDGE_TOKEN: bridgeToken,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  );
  child.stdout!.on('data', (chunk) => (output += chunk));
  child.stderr!.on('data', (chunk) => (output += chunk));
  try {
    await run(child, () => output);
    console.log('\nandroid-runtime: all assertions passed');
  } catch (error) {
    console.error(output.slice(-4000));
    throw error;
  } finally {
    child.kill('SIGKILL');
    server.close();
    fs.rmSync(work, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
