/**
 * Printers without a cutter, and the kitchen ticket's token and item layout.
 *
 * - Migration v119 adds printers.auto_cut (default on) without touching existing rows.
 * - The printers API stores auto_cut and no_cutter_mode. Without a cutter, `all` joins
 *   back-to-back jobs with a "Cut here" line and feeds once idle; `parts` prints the
 *   first part and holds the rest until /print-parts/next.
 * - /api/printers/print-kot prints the bill's token (or the order number's counter
 *   before billing) large under the banner when the store prints tokens.
 * - Item headings print bold at the ticket's normal text size, wrapped under their
 *   quantity; only the token is enlarged, and nothing is stretched to double height.
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
const TAIL_FEED = Buffer.from([0x1b, 0x64, 0x03]);
const { JOIN_WINDOW_MS, resetNoCutterJobs } = require('../main/printers/no-cutter-jobs');
const NORMAL_BOLD = Buffer.from([0x1b, 0x21, 0x08]);
const DOUBLE_WIDTH_HEIGHT_BOLD = Buffer.from([0x1b, 0x21, 0x38]);
const DOUBLE_HEIGHT_ONLY_BOLD = Buffer.from([0x1b, 0x21, 0x18]);

function countOccurrences(haystack: Buffer, needle: Buffer): number {
  let count = 0;
  for (let at = haystack.indexOf(needle); at >= 0; at = haystack.indexOf(needle, at + 1)) count++;
  return count;
}

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
  const { buildEscPos, tearLineText, tearLineBytes } = require('../main/printers/formatting-helpers');
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
  assertOrThrow(!none.toString('latin1').includes('Cut here'), 'a single job ends without a tear line');
  assertIncludesOrThrow(
    tearLineBytes(32, 'en').toString('latin1'),
    '----- Cut here -----',
    'the tear line between parts is a dashed Cut here line',
  );

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
    { product_name: 'Mini Shawarma Samoli Platter Large', quantity: 1, status: 'pending', addons: [{ name: 'Extra garlic' }] },
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
  const headings = result.lines.filter((line: string) => line.startsWith('{BOLD}'));
  const plain = (line: string) => line.replace(/\{\/?[A-Z_]+\}/g, '');
  assertEqualOrThrow(
    headings.map(plain).join('|'),
    '1x Mini Shawarma Samoli Platter|   Large|12x Nuggets',
    'item names wrap to the full width with a hanging indent',
  );
  assertOrThrow(
    result.lines.some((line: string) => line === '  + Extra garlic'),
    'add-ons follow the wrapped heading',
  );
  assertOrThrow(result.data.includes(NORMAL_BOLD), 'item headings print bold at the normal size');
  assertEqualOrThrow(
    countOccurrences(result.data, DOUBLE_WIDTH_HEIGHT_BOLD),
    1,
    'only the token is printed large',
  );
  assertOrThrow(!result.data.includes(DOUBLE_HEIGHT_ONLY_BOLD), 'no line is stretched to double height alone');
  assertOrThrow(!result.data.includes(GS_V), 'a KOT for a printer without a cutter sends no cut');
  assertOrThrow(
    !result.lines.slice(-3).some((line: string) => /^-+$/.test(line) || line === ''),
    'it ends on its last item: no blank line, closing rule, or tear line',
  );

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
    const badMode = await request(app).put(`/api/printers/${id}`).send({ no_cutter_mode: 'some' });
    assertEqualOrThrow(badMode.status, 400, 'an unknown no_cutter_mode is rejected');
    assertEqualOrThrow(created.body.printer.no_cutter_mode, 'all', 'no_cutter_mode defaults to all');

    const orderId = Number(
      db
        .prepare(
          `INSERT INTO orders (order_number, status, type, subtotal, total, created_at, updated_at)
           VALUES ('ORD-20261115-0007', 'pending', 'dine_in', 40, 40, datetime('now'), datetime('now'))`,
        )
        .run().lastInsertRowid,
    );
    const items = [{ product_name: 'Mini Shawarma Samoli', quantity: 1, status: 'pending' }];
    const postKot = async () => {
      const res = await request(app)
        .post('/api/printers/print-kot')
        .send({ orderId, stationName: 'Shawarma', items });
      assertEqualOrThrow(res.status, 200, 'print-kot succeeds');
      return res.body;
    };
    const printKot = async () => {
      const before = capture.jobs.length;
      await postKot();
      await waitForJobs(capture.jobs, before + 1);
      return capture.jobs[before];
    };

    console.log('\n--- Token on the KOT ---');
    setSetting('bill_highlight_token', 'false');
    const tokensOff = (await printKot()).toString('latin1');
    assertOrThrow(!printsToken(tokensOff, '0007'), 'no token when the store prints none');
    assertOrThrow(Buffer.from(tokensOff, 'latin1').includes(GS_V), 'a printer with a cutter still cuts');

    setSetting('bill_highlight_token', 'true');
    const beforeBill = (await printKot()).toString('latin1');
    assertOrThrow(printsToken(beforeBill, '0007'), 'an unbilled order shows its order number counter');
    db.prepare(
      `INSERT INTO bills (bill_number, order_id, subtotal, total, balance, payment_status, created_at, updated_at)
       VALUES ('INV-20261115-0003', ?, 40, 40, 0, 'paid', datetime('now'), datetime('now'))`,
    ).run(orderId);
    const afterBill = (await printKot()).toString('latin1');
    assertOrThrow(printsToken(afterBill, '0003'), 'a billed order shows the bill token');
    assertOrThrow(!printsToken(afterBill, '0007'), 'the bill token replaces the order counter');

    console.log('\n--- No cutter: print all at once ---');
    const allMode = await request(app)
      .put(`/api/printers/${id}`)
      .send({ auto_cut: false, no_cutter_mode: 'all' });
    assertEqualOrThrow(allMode.body.printer.auto_cut, 0, 'auto_cut is stored off');
    assertEqualOrThrow(allMode.body.printer.no_cutter_mode, 'all', 'all mode is stored');
    resetNoCutterJobs();
    const first = await printKot();
    const second = await printKot();
    assertOrThrow(!first.includes(GS_V) && !second.includes(GS_V), 'no cut command is sent');
    assertOrThrow(!first.toString('latin1').includes('Cut here'), 'the first part has no tear line');
    assertOrThrow(
      !first.subarray(-3).equals(TAIL_FEED),
      'the first part leaves the feed for later, so the next part follows tightly',
    );
    assertOrThrow(
      second.toString('latin1').indexOf('Cut here') >= 0 &&
        second.toString('latin1').indexOf('Cut here') < second.indexOf(Buffer.from([0x1b, 0x40])),
      'the next part starts with the tear line',
    );
    const jobsBeforeFeed = capture.jobs.length;
    await new Promise((resolve) => setTimeout(resolve, JOIN_WINDOW_MS + 500));
    await waitForJobs(capture.jobs, jobsBeforeFeed + 1);
    assertOrThrow(
      capture.jobs[jobsBeforeFeed]?.equals(TAIL_FEED) === true,
      'once the printer is idle, only a feed follows: no tear line at the end',
    );

    console.log('\n--- No cutter: print in parts ---');
    await request(app).put(`/api/printers/${id}`).send({ no_cutter_mode: 'parts' });
    resetNoCutterJobs();
    const partOne = await printKot();
    assertOrThrow(partOne.subarray(-3).equals(TAIL_FEED), 'the first part prints at once and feeds');
    const jobsAfterFirst = capture.jobs.length;
    const queued = await postKot();
    assertEqualOrThrow(queued.print_parts?.pending?.length, 1, 'the next part waits');
    assertEqualOrThrow(queued.print_parts?.printed, 1, 'one part is printed');
    assertEqualOrThrow(queued.print_parts?.total, 2, 'two parts in all');
    assertEqualOrThrow(queued.print_parts?.pending?.[0]?.kind, 'kot', 'the waiting part is a KOT');
    assertEqualOrThrow(queued.print_parts?.pending?.[0]?.station, 'Shawarma', 'it names its station');
    await postKot();
    await new Promise((resolve) => setTimeout(resolve, 200));
    assertEqualOrThrow(capture.jobs.length, jobsAfterFirst, 'waiting parts are not printed');
    const listed = await request(app).get('/api/printers/print-parts');
    assertEqualOrThrow(listed.body.print_parts.pending.length, 2, 'the banner can list waiting parts');

    const next = await request(app).post('/api/printers/print-parts/next');
    assertEqualOrThrow(next.status, 200, 'print next succeeds');
    await waitForJobs(capture.jobs, jobsAfterFirst + 1);
    assertEqualOrThrow(capture.jobs.length, jobsAfterFirst + 1, 'print next prints one part');
    assertEqualOrThrow(next.body.print_parts.printed, 2, 'two parts are printed');
    assertEqualOrThrow(next.body.print_parts.pending.length, 1, 'one part still waits');
    const last = await request(app).post('/api/printers/print-parts/next');
    assertEqualOrThrow(last.body.print_parts.pending.length, 0, 'nothing waits after the last part');

    const fresh = await printKot();
    assertOrThrow(fresh.subarray(-3).equals(TAIL_FEED), 'after the last part, a new print starts at once');
    await postKot();
    const discarded = await request(app).post('/api/printers/print-parts/discard');
    assertEqualOrThrow(discarded.body.print_parts.pending.length, 0, 'skip the rest clears waiting parts');
    resetNoCutterJobs();
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
