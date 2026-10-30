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
        if (message.method === 'pickFile') sendToNode({ id: message.id, result: { path: pickedRestorePath } });
        else if (message.method === 'confirm') sendToNode({ id: message.id, result: { confirmed: true } });
        else sendToNode({ id: message.id, result: null });
      } else if (typeof message.id === 'number') responses.set(message.id, message);
    }
  });
});

async function waitFor<T>(label: string, probe: () => T | undefined | null | false, timeoutMs = 60_000): Promise<T> {
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
  assertEqualOrThrow(helloToken, bridgeToken, 'Node authenticates to the shell with the launch token');
  const failed = () => events.find((e) => e.event === 'failed');
  const ready = await waitFor('ready event', () => {
    if (failed()) throw new Error(`runtime failed: ${JSON.stringify(failed()!.data)}\n${output()}`);
    if (child.exitCode !== null) throw new Error(`runtime exited early (${child.exitCode})\n${output()}`);
    return events.find((e) => e.event === 'ready');
  }, 120_000);
  const info = ready.data;
  assertEqualOrThrow(info.serverPort, ports.api, 'reports the POS API port');
  assertEqualOrThrow(info.kdsPort, ports.kds, 'reports the KDS port');
  assertEqualOrThrow(info.serverAppPort, ports.serverApp, 'reports the Server App port');
  assertOrThrow(!/blocked: the Android runtime must not load Electron/.test(output()), 'no code path tried to load Electron');

  const health = await fetch(`http://127.0.0.1:${ports.api}/api/health`);
  assertEqualOrThrow(health.status, 200, 'POS API answers /api/health');
  assertOrThrow(fs.existsSync(path.join(userData, 'flo.db')), 'database lives under the Android userData');
  assertOrThrow(fs.existsSync(path.join(userData, 'logs', 'main.log')), 'log file lives under the Android userData');

  console.log('\n--- Host actions run over the native bridge only ---');
  const appInfo = await hostAction('/app-info');
  assertEqualOrThrow(appInfo.result?.platform, 'android', 'app info reports android');
  const unknown = await hostAction('/no-such-action');
  assertOrThrow(typeof unknown.error === 'string' && unknown.error.includes('Unknown host action'), 'unknown actions are rejected');
  const prototypeKey = await hostAction('constructor');
  assertOrThrow(typeof prototypeKey.error === 'string', 'object prototype keys are not routes');

  const pinStatus = await hostAction('/master-pin-status');
  assertEqualOrThrow(pinStatus.result.available, true, 'master PIN is available through keyed storage');
  assertEqualOrThrow(pinStatus.result.isSet, true, 'master PIN sealed by the shell key is readable');

  const settings = await hostAction('/settings');
  assertEqualOrThrow(typeof settings.result, 'object', 'settings are returned');
  assertOrThrow(
    settings.result.jwt_secret === undefined || String(settings.result.jwt_secret).startsWith('****'),
    'the JWT secret is masked',
  );

  console.log('\n--- Backup and restore run the shared actions ---');
  const wrongPin = await hostAction('/backup', { pin: '0000' });
  assertEqualOrThrow(wrongPin.result.success, false, 'backup refuses a wrong master PIN');
  const backup = (await hostAction('/backup', { pin: '2468' })).result;
  assertEqualOrThrow(backup.success, true, `backup succeeds (${JSON.stringify(backup)})`);
  assertOrThrow(
    backup.path.startsWith(path.join(documents, 'FloCafe', 'Manual Backups')),
    'manual backup lands in the Android documents folder',
  );
  assertOrThrow(fs.existsSync(backup.path), 'backup file exists');

  pickedRestorePath = backup.path;
  const restore = (await hostAction('/restore', { pin: '2468' })).result;
  assertEqualOrThrow(restore.success, true, `restore succeeds (${JSON.stringify(restore)})`);
  assertOrThrow(nativeCalls.some((c) => c.method === 'pickFile'), 'restore asks the shell for the file');

  const picked = (await hostAction('/pick-restore-file')).result;
  assertEqualOrThrow(picked.canceled, false, 'pick-restore-file returns the shell pick');
  assertOrThrow(typeof picked.token === 'string' && picked.token.length > 0, 'pick-restore-file issues a selection token');

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
    ['--require', path.join(__dirname, 'fixtures', 'block-electron.cjs'), path.join(runtimeRoot, 'dist', 'main', 'android', 'entry.js')],
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
