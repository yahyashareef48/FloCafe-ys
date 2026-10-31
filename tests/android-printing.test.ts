/**
 * Android printing — with the Android platform host installed, USB/Bluetooth
 * printers are discovered and printed to through the shell instead of the OS
 * spooler. This pins that:
 *   - discovery returns the shell's printers, annotated like desktop ones;
 *   - the bytes reaching the shell for a bill (big token on), a KOT, a
 *     shift-close Z and a day-close Z on a 58 mm / 32-column printer are
 *     byte-identical to what the desktop app sends to a raw TCP printer;
 *   - the bridge adapter delivers those bytes to the shell unchanged.
 */
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-android-printing-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const {
  assertOrThrow,
  assertEqualOrThrow,
  initTestDb,
  closeDatabase,
  getDatabase,
} = require('./helpers/test-setup');
const platform = require('../main/platform');
const { createAndroidPlatformHost } = require('../main/platform/android-host');
const thermal = require('../main/printers/thermal');
const { buildParityFixtures } = require('./print-parity.test');

const USB_NAME = 'SR588 Posiflow (USB 0483:5720)';
const sentToShell: Array<{ name: string; data: Buffer }> = [];
const rasterRequests: unknown[] = [];

function installAndroidHost(): void {
  platform.setPlatformHost(
    createAndroidPlatformHost({
      userDataDir: testDir,
      documentsDir: testDir,
      version: 'test',
      locale: 'en-IN',
      countryCode: 'IN',
      secretKey: randomBytes(32),
      openExternal: async () => undefined,
      printers: {
        list: async () => [
          {
            name: USB_NAME,
            make: 'SR588',
            model: 'Posiflow',
            connectionType: 'usb',
            deviceUri: 'usb://0483/5720',
          },
          {
            name: 'SR588 (Bluetooth 66:22:33:44:55:66)',
            make: '',
            model: '',
            connectionType: 'bluetooth',
            deviceUri: 'bt://66:22:33:44:55:66',
          },
        ],
        send: async (name: string, data: Buffer) => {
          sentToShell.push({ name, data: Buffer.from(data) });
          return { ok: true };
        },
      },
      // Deterministic stand-in for the shell's raster page: one full-width, 8-dot band per unit.
      rasterRenderer: {
        render: async (request: { requestId: string; financial: boolean; widthDots: number }) => {
          rasterRequests.push(request);
          const pixels = new Uint8Array(request.widthDots * 8).map((_, i) => (i % 3 === 0 ? 1 : 0));
          return {
            version: 1,
            requestId: request.requestId,
            ok: true,
            unit: {
              unitId: request.requestId,
              financial: request.financial,
              complete: true,
              bands: [{ widthDots: request.widthDots, heightDots: 8, pixels }],
            },
          };
        },
      },
    }),
  );
}

async function startTcpPrinter(): Promise<{ port: number; jobs: Buffer[]; close: () => void }> {
  const jobs: Buffer[] = [];
  const server = net.createServer((socket) => {
    const chunks: Buffer[] = [];
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('end', () => jobs.push(Buffer.concat(chunks)));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { port: (server.address() as net.AddressInfo).port, jobs, close: () => server.close() };
}

function usePrinter(row: Record<string, unknown>): any {
  const db = getDatabase();
  db.prepare('DELETE FROM printers').run();
  db.prepare(
    `INSERT INTO printers (id, name, connection_type, ip_address, port, paper_width, is_default, created_at, updated_at)
     VALUES (@id, @name, @connection_type, @ip_address, @port, 'cols-32', 1, datetime('now'), datetime('now'))`,
  ).run({ ip_address: null, port: 9100, ...row });
  return db.prepare('SELECT * FROM printers WHERE id = ?').get(row.id);
}

async function waitForJob(jobs: Buffer[], count: number): Promise<Buffer> {
  for (let i = 0; i < 100 && jobs.length < count; i++) await new Promise((r) => setTimeout(r, 20));
  assertOrThrow(jobs.length >= count, 'the TCP printer received the job');
  return jobs[count - 1];
}

function zSnapshot(zNumber: number, closedBy: string) {
  return {
    z_number: zNumber,
    business_date: '2026-10-30',
    period_start: '2026-10-30T03:30:00Z',
    period_end: '2026-10-30T16:30:00Z',
    closed_by: 'u-1',
    closed_by_name: closedBy,
    opening_float_cents: 50000,
    expected_cash_cents: 182000,
    counted_cash_cents: 181500,
    variance_cents: -500,
    pay_in_cents: 0,
    pay_out_cents: 2000,
    safe_drop_cents: 0,
    refund_count: 1,
    refunded_cents: 12000,
    payment_methods: [
      { method: 'cash', count: 12, total_cents: 132000 },
      { method: 'upi', count: 5, total_cents: 64000 },
    ],
    staff_sales: [{ name: closedBy, count: 17, total_cents: 196000 }],
    tax_components: [],
  };
}

async function main(): Promise<void> {
  initTestDb();
  const db = getDatabase();
  db.exec(
    "INSERT OR REPLACE INTO settings (key, value) VALUES ('country', 'IN'), ('currency', 'INR'), ('currency_symbol', '₹')",
  );
  installAndroidHost();
  const tcp = await startTcpPrinter();

  try {
    console.log('\n--- Discovery comes from the shell ---');
    const detected = await thermal.detectConnectedPrinters();
    assertEqualOrThrow(detected.length, 2, 'both shell printers are listed');
    assertEqualOrThrow(detected[0].name, USB_NAME, 'the USB printer keeps its addressable name');
    assertEqualOrThrow(
      detected[1].connectionType,
      'bluetooth',
      'the Bluetooth printer is listed as Bluetooth',
    );
    assertOrThrow(
      typeof detected[0].paperWidth === 'string' && detected[0].paperWidth.length > 0,
      'detected printers get a paper width, as on desktop',
    );

    // Includes Persian item text and the rupee sign, which a generic 58 mm printer
    // can only print as raster, so the raster encoding path is part of the comparison.
    const { order, bill, business } = buildParityFixtures();
    const documents: Array<[string, (printer: any) => Promise<{ ok: boolean; detail?: string }>]> =
      [
        [
          'bill with the big token',
          () =>
            thermal.printReceipt(order, bill, { ...business, highlight_token: true }, 'classic'),
        ],
        ['KOT', (printer) => thermal.printKOT(order, order.items, 'Kitchen', false, printer)],
        [
          'shift-close Z report',
          (printer) => thermal.printZReport(zSnapshot(41, 'Cashier One'), undefined, printer),
        ],
        [
          'day-close Z report',
          (printer) => thermal.printZReport(zSnapshot(42, 'Owner'), undefined, printer),
        ],
      ];

    console.log('\n--- Android USB bytes equal desktop raw TCP bytes (58 mm, 32 columns) ---');
    for (const [label, print] of documents) {
      const jobsBefore = tcp.jobs.length;
      const networkPrinter = usePrinter({
        id: 'p-net',
        name: 'Kitchen TCP',
        connection_type: 'network',
        ip_address: '127.0.0.1',
        port: tcp.port,
      });
      const desktopResult = await print(networkPrinter);
      assertEqualOrThrow(
        desktopResult.ok,
        true,
        `${label}: desktop raw TCP print succeeds (${desktopResult.detail ?? ''})`,
      );
      const desktopBytes = await waitForJob(tcp.jobs, jobsBefore + 1);

      const before = sentToShell.length;
      const usbPrinter = usePrinter({ id: 'p-usb', name: USB_NAME, connection_type: 'usb' });
      const androidResult = await print(usbPrinter);
      assertEqualOrThrow(
        androidResult.ok,
        true,
        `${label}: Android USB print succeeds (${androidResult.detail ?? ''})`,
      );
      const job = sentToShell[before];
      assertEqualOrThrow(
        job?.name,
        USB_NAME,
        `${label}: the shell is asked to print to the configured printer`,
      );
      assertOrThrow(job.data.length > 64, `${label}: the job carries ESC/POS bytes`);
      assertOrThrow(
        job.data.equals(desktopBytes),
        `${label}: Android bytes are identical to desktop bytes (${job.data.length} bytes)`,
      );
    }

    assertOrThrow(
      rasterRequests.length > 0,
      'text the printer cannot encode goes through the platform raster renderer',
    );

    console.log('\n--- The big token prints large and bold ---');
    const tokenText = thermal.escPosToText(sentToShell[0].data);
    assertOrThrow(
      tokenText.split('\n').some((line: string) => line.trim() === '001'),
      'the bill token 001 has its own line',
    );
    const bytes = sentToShell[0].data;
    const doubleSize = bytes.some(
      (b: number, i: number) =>
        b === 0x1b && bytes[i + 1] === 0x21 && (bytes[i + 2] & 0x30) === 0x30,
    );
    assertOrThrow(
      doubleSize,
      'the bill selects double-width, double-height print (ESC ! with bits 0x30)',
    );
  } finally {
    tcp.close();
    platform.resetPlatformHost();
  }

  console.log('\n--- Raster results decode from the bridge wire format ---');
  const { decodeRasterWireResult } = require('../main/android/printing');
  const pixels = Uint8Array.from([1, 0, 1, 1, 0, 0]);
  const decoded = decodeRasterWireResult(
    {
      version: 1,
      requestId: 'r1',
      ok: true,
      unit: {
        unitId: 'r1',
        financial: true,
        complete: true,
        bands: [
          { widthDots: 3, heightDots: 2, pixelsBase64: Buffer.from(pixels).toString('base64') },
        ],
      },
    },
    'r1',
  );
  assertEqualOrThrow(decoded.ok, true, 'a well-formed band decodes');
  assertOrThrow(
    decoded.ok &&
      decoded.unit.bands[0].pixels instanceof Uint8Array &&
      Buffer.from(decoded.unit.bands[0].pixels).equals(Buffer.from(pixels)),
    'band pixels are restored exactly',
  );
  const wrongSize = decodeRasterWireResult(
    {
      version: 1,
      requestId: 'r1',
      ok: true,
      unit: {
        unitId: 'r1',
        financial: true,
        complete: true,
        bands: [
          { widthDots: 4, heightDots: 2, pixelsBase64: Buffer.from(pixels).toString('base64') },
        ],
      },
    },
    'r1',
  );
  assertEqualOrThrow(
    wrongSize.ok,
    false,
    'a band whose pixel count does not match its size is rejected',
  );
  assertEqualOrThrow(
    decodeRasterWireResult(
      { version: 1, requestId: 'other', ok: false, code: 'render-failed', detail: 'x' },
      'r1',
    ).ok,
    false,
    'a result for another request is rejected',
  );

  console.log('\n--- The bridge adapter hands bytes to the shell unchanged ---');
  await bridgeRoundTrip();
  console.log('\nandroid-printing: all assertions passed');
}

async function bridgeRoundTrip(): Promise<void> {
  const bridge = require('../main/android/native-bridge');
  const { androidPrinters } = require('../main/android/printing');
  const socketName = `flo-android-printing-${process.pid}-${randomBytes(4).toString('hex')}`;
  const received: any[] = [];
  const server = net.createServer((socket) => {
    let buffered = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk: string) => {
      buffered += chunk;
      let newline: number;
      while ((newline = buffered.indexOf('\n')) !== -1) {
        const message = JSON.parse(buffered.slice(0, newline));
        buffered = buffered.slice(newline + 1);
        if (message.method === 'printerSend') {
          received.push(message.params);
          socket.write(`${JSON.stringify({ id: message.id, result: { ok: true } })}\n`);
        } else if (message.method === 'printerList') {
          socket.write(
            `${JSON.stringify({ id: message.id, result: [{ name: USB_NAME, connectionType: 'usb', make: 'SR588', model: 'Posiflow', deviceUri: 'usb://0483/5720' }, { name: 'bad entry' }] })}\n`,
          );
        }
      }
    });
  });
  await new Promise<void>((resolve) => server.listen({ path: `\0${socketName}` }, resolve));
  try {
    await bridge.connectNativeBridge(socketName, 'token');
    const payload = Buffer.from(Array.from({ length: 4096 }, (_, i) => i % 256));
    const result = await androidPrinters.send(USB_NAME, payload);
    assertEqualOrThrow(result.ok, true, 'the shell acknowledges the job');
    assertEqualOrThrow(received[0].name, USB_NAME, 'the printer name reaches the shell');
    assertOrThrow(
      Buffer.from(received[0].data, 'base64').equals(payload),
      'all 256 byte values survive the bridge',
    );
    const listed = await androidPrinters.list();
    assertEqualOrThrow(listed.length, 1, 'malformed shell entries are dropped');
  } finally {
    server.close();
  }
}

main()
  .then(() => {
    closeDatabase();
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
    process.exit(0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
