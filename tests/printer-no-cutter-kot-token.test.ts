/**
 * Printers without a cutter, and the kitchen ticket's token and item layout.
 *
 * - Migration v119 adds printers.auto_cut (default on) without touching existing rows.
 * - The printers API stores auto_cut; a printer with it off prints a "Cut here" tear
 *   line where every other printer sends the ESC/POS cut command.
 * - /api/printers/print-kot prints the bill's token (or the order number's counter
 *   before billing) large under the banner when the store prints tokens.
 * - Item headings print at double width and height, wrapped to half the columns,
 *   so glyphs keep their shape instead of being stretched tall.
 *
 * Usage: ts-node --transpile-only -P tests/tsconfig.json tests/printer-no-cutter-kot-token.test.ts
 */

import * as fs from 'node:fs';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-no-cutter-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const express = require('express');
const request = require('supertest');
const {
  assertOrThrow,
  assertEqualOrThrow,
  assertIncludesOrThrow,
  getResults,
} = require('./helpers/test-setup');
const {
  initDatabase,
  getDatabase,
  getCurrentSchemaVersion,
  MIGRATIONS,
  closeDatabase,
  now,
} = require('../main/db');

const GS_V = Buffer.from([0x1d, 0x56]);
const DOUBLE_WIDTH_HEIGHT_BOLD = Buffer.from([0x1b, 0x21, 0x38]);
const DOUBLE_HEIGHT_ONLY_BOLD = Buffer.from([0x1b, 0x21, 0x18]);

function printerColumns(): string[] {
  return getDatabase()
    .prepare('PRAGMA table_info(printers)')
    .all()
    .map((column: { name: string }) => column.name);
}

function runPendingMigrations(): void {
  const db = getDatabase();
  for (const migration of MIGRATIONS) {
    if (migration.version <= getCurrentSchemaVersion()) continue;
    db.transaction(() => {
      migration.up();
      db.pragma(`user_version = ${migration.version}`);
    })();
  }
}

function setSetting(key: string, value: string): void {
  getDatabase()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, value, now());
}

async function captureServer(): Promise<{ port: number; jobs: Buffer[]; close: () => Promise<void> }> {
  const jobs: Buffer[] = [];
  const server = net.createServer((socket) => {
    const chunks: Buffer[] = [];
    socket.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
    socket.on('end', () => jobs.push(Buffer.concat(chunks)));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const port = (server.address() as net.AddressInfo).port;
  return {
    port,
    jobs,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** A centred double-size bold token line in the captured job. */
function printsToken(job: string, token: string): boolean {
  return job.includes(`\x1b!\x38\x1bE\x01${token}\n`);
}

async function waitForJobs(jobs: Buffer[], count: number): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (jobs.length < count && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function migrationChecks(): void {
  console.log('\n--- Migration v119: printers.auto_cut ---');
  const originalMigrations = MIGRATIONS.slice();
  MIGRATIONS.length = 0;
  MIGRATIONS.push(...originalMigrations.filter((migration: any) => migration.version <= 118));
  initDatabase();
  assertEqualOrThrow(getCurrentSchemaVersion(), 118, 'setup: database starts at schema v118');
  const db = getDatabase();
  if (printerColumns().includes('auto_cut')) db.exec('ALTER TABLE printers DROP COLUMN auto_cut');
  assertOrThrow(!printerColumns().includes('auto_cut'), 'setup: v118 printers table has no auto_cut');
  db.prepare(
    `INSERT INTO printers (id, name, connection_type, paper_width, is_default, created_at, updated_at)
     VALUES ('legacy', 'Legacy printer', 'usb', 'cols-32', 1, ?, ?)`,
  ).run(now(), now());

  MIGRATIONS.length = 0;
  MIGRATIONS.push(...originalMigrations);
  runPendingMigrations();
  assertOrThrow(printerColumns().includes('auto_cut'), 'upgrade adds printers.auto_cut');
  const legacy = db.prepare("SELECT name, auto_cut FROM printers WHERE id = 'legacy'").get() as any;
  assertEqualOrThrow(legacy.name, 'Legacy printer', 'upgrade keeps the existing printer row');
  assertEqualOrThrow(legacy.auto_cut, 1, 'an existing printer keeps cutting after the upgrade');
  db.prepare("DELETE FROM printers WHERE id = 'legacy'").run();
}

function escPosChecks(): void {
  console.log('\n--- buildEscPos: cut command or tear line ---');
  const { buildEscPos, tearLineText } = require('../main/printers/formatting-helpers');
  const { GENERIC_THERMAL_CAPABILITIES, LATIN_THERMAL_CAPABILITIES } = require(
    '../shared/print/thermal-capabilities',
  );
  const lines = ['{INIT}', 'Hello', '{CUT}'];
  const full = buildEscPos(lines, false, { cutMode: 'full', columns: 32 });
  const partial = buildEscPos(lines, false, { cutMode: 'partial', columns: 32 });
  const none = buildEscPos(lines, false, { cutMode: 'none', columns: 32, language: 'en' });
  assertOrThrow(full.includes(Buffer.from([0x1d, 0x56, 0x00])), 'full cut sends GS V 0');
  assertOrThrow(partial.includes(Buffer.from([0x1d, 0x56, 0x42, 0x00])), 'partial cut sends GS V B 0');
  assertOrThrow(!none.includes(GS_V), 'a printer without a cutter gets no cut command');
  assertIncludesOrThrow(none.toString('latin1'), ' Cut here ', 'it prints a Cut here line instead');

  const english = tearLineText(32, 'en', GENERIC_THERMAL_CAPABILITIES);
  assertEqualOrThrow(english.length, 32, 'the tear line spans the paper width');
  assertOrThrow(/^-+ Cut here -+$/.test(english), `the tear line is dashed (${english})`);
  assertIncludesOrThrow(
    tearLineText(42, 'fr', LATIN_THERMAL_CAPABILITIES),
    'Couper ici',
    'the tear line uses the ticket language when the printer can encode it',
  );
  assertIncludesOrThrow(
    tearLineText(32, 'hi', GENERIC_THERMAL_CAPABILITIES),
    'Cut here',
    'a label the printer cannot encode falls back to English',
  );
}

function kotLayoutChecks(): void {
  console.log('\n--- KOT layout: token and item headings ---');
  const { renderKotViaDocument } = require('../main/printers/document-kot');
  const order = {
    order_number: 'ORD-20261115-0003',
    created_at: '2026-11-15 09:06:25',
    type: 'dine_in',
    kot_token: '0003',
  };
  const items = [
    { product_name: 'Mini Shawarma Samoli', quantity: 1, status: 'pending', addons: [{ name: 'Extra garlic' }] },
    { product_name: 'Nuggets', quantity: 12, status: 'pending' },
  ];
  const options = {
    columns: 32,
    language: 'en',
    timezone: 'Asia/Kolkata',
    useUnicode: false,
    arabicShaping: false,
    cutMode: 'none',
  };
  const result = renderKotViaDocument(order, items, 'Shawarma', options);
  const tokenLine = result.lines.find((line: string) => line.includes('0003') && !line.includes('ORD'));
  assertEqualOrThrow(
    tokenLine,
    '{CENTER}{BOLD}{DOUBLE_HEIGHT}{DOUBLE_WIDTH}0003{/DOUBLE_WIDTH}{/DOUBLE_HEIGHT}{/BOLD}{/CENTER}',
    'the token prints large and centred',
  );
  assertOrThrow(
    result.lines.indexOf(tokenLine) === result.lines.findIndex((l: string) => l.includes('KITCHEN')) + 1,
    'the token sits right under the banner',
  );
  const headings = result.lines.filter((line: string) => line.includes('{DOUBLE_WIDTH}') && !line.includes('{CENTER}'));
  const plain = (line: string) => line.replace(/\{\/?[A-Z_]+\}/g, '');
  assertEqualOrThrow(
    headings.map(plain).join('|'),
    '1x Mini Shawarma|   Samoli|12x Nuggets',
    'item names wrap to half the columns with a hanging indent',
  );
  assertOrThrow(
    result.lines.some((line: string) => line === '  + Extra garlic'),
    'add-ons follow the wrapped heading',
  );
  assertOrThrow(result.data.includes(DOUBLE_WIDTH_HEIGHT_BOLD), 'item headings print bold at double width and height');
  assertOrThrow(!result.data.includes(DOUBLE_HEIGHT_ONLY_BOLD), 'no line is stretched to double height alone');
  assertOrThrow(!result.data.includes(GS_V), 'the KOT ends with a tear line on a printer without a cutter');

  const withoutToken = renderKotViaDocument({ ...order, kot_token: '' }, items, 'Shawarma', options);
  assertOrThrow(
    !withoutToken.lines.some((line: string) => line.includes('{CENTER}{BOLD}{DOUBLE_HEIGHT}')),
    'no token line is printed when the order carries none',
  );
}

async function routeChecks(): Promise<void> {
  console.log('\n--- Printers API and /print-kot ---');
  const db = getDatabase();
  db.prepare(
    `INSERT OR IGNORE INTO users (id, name, email, password, role, is_active, created_at, updated_at)
     VALUES ('owner-1', 'Owner', 'owner@flo.local', 'unused', 'owner', 1, ?, ?)`,
  ).run(now(), now());
  setSetting('country', 'IN');
  setSetting('currency', 'INR');
  setSetting('timezone', 'Asia/Kolkata');
  setSetting('kot_printing_enabled', 'true');

  const { printerRoutes } = require('../main/routes/printers');
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.user = { userId: 'owner-1', email: 'owner@flo.local', role: 'owner' };
    next();
  });
  app.use('/api/printers', printerRoutes);

  const capture = await captureServer();
  try {
    const created = await request(app).post('/api/printers').send({
      name: 'Pocket printer',
      connection_type: 'network',
      ip_address: '127.0.0.1',
      port: capture.port,
      paper_width: 'cols-32',
      is_default: true,
    });
    assertEqualOrThrow(created.status, 201, 'printer is created');
    assertEqualOrThrow(created.body.printer.auto_cut, 1, 'auto_cut defaults on');
    const id = created.body.printer.id;

    const invalid = await request(app).put(`/api/printers/${id}`).send({ auto_cut: 'no' });
    assertEqualOrThrow(invalid.status, 400, 'a non-boolean auto_cut is rejected');
    const updated = await request(app).put(`/api/printers/${id}`).send({ auto_cut: false });
    assertEqualOrThrow(updated.status, 200, 'auto_cut can be turned off');
    assertEqualOrThrow(updated.body.printer.auto_cut, 0, 'auto_cut is stored off');
    const renamed = await request(app).put(`/api/printers/${id}`).send({ name: 'Pocket' });
    assertEqualOrThrow(renamed.body.printer.auto_cut, 0, 'an update without auto_cut keeps it');

    const orderId = Number(
      db
        .prepare(
          `INSERT INTO orders (order_number, status, type, subtotal, total, created_at, updated_at)
           VALUES ('ORD-20261115-0007', 'pending', 'dine_in', 40, 40, datetime('now'), datetime('now'))`,
        )
        .run().lastInsertRowid,
    );
    const items = [{ product_name: 'Mini Shawarma Samoli', quantity: 1, status: 'pending' }];
    const printKot = async () => {
      const before = capture.jobs.length;
      const res = await request(app)
        .post('/api/printers/print-kot')
        .send({ orderId, stationName: 'Shawarma', items });
      assertEqualOrThrow(res.status, 200, `print-kot succeeds (${JSON.stringify(res.body)})`);
      await waitForJobs(capture.jobs, before + 1);
      return capture.jobs[before].toString('latin1');
    };

    setSetting('bill_highlight_token', 'false');
    const tokensOff = await printKot();
    assertOrThrow(!printsToken(tokensOff, '0007'), 'no token when the store prints none');
    assertIncludesOrThrow(tokensOff, ' Cut here ', 'the route honours the printer without a cutter');
    assertOrThrow(!Buffer.from(tokensOff, 'latin1').includes(GS_V), 'the route sends no cut command');

    setSetting('bill_highlight_token', 'true');
    const beforeBill = await printKot();
    assertOrThrow(printsToken(beforeBill, '0007'), 'an unbilled order shows its order number counter');

    db.prepare(
      `INSERT INTO bills (bill_number, order_id, subtotal, total, balance, payment_status, created_at, updated_at)
       VALUES ('INV-20261115-0003', ?, 40, 40, 0, 'paid', datetime('now'), datetime('now'))`,
    ).run(orderId);
    const afterBill = await printKot();
    assertOrThrow(printsToken(afterBill, '0003'), 'a billed order shows the bill token');
    assertOrThrow(!printsToken(afterBill, '0007'), 'the bill token replaces the order counter');
  } finally {
    await capture.close();
  }
}

async function main(): Promise<void> {
  migrationChecks();
  escPosChecks();
  kotLayoutChecks();
  await routeChecks();
}

main()
  .then(() => {
    closeDatabase();
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
    const { failed } = getResults();
    process.exit(failed > 0 ? 1 : 0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
