/**
 * UPI QR at checkout: the upi://pay link, the store's upi_id setting, and
 * POST /api/payment-methods/upi-qr that draws the QR for one exact amount.
 *
 * Usage: ts-node --transpile-only -P tests/tsconfig.json tests/upi-qr.test.ts
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-upi-qr-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  }
  return originalLoad.apply(this, arguments as any);
};

const express = require('express');
const request = require('supertest');
const { assertOrThrow, assertEqualOrThrow, getResults } = require('./helpers/test-setup');
const { initDatabase, getDatabase, closeDatabase, now } = require('../main/db');
const { buildUpiPaymentLink, isValidUpiId } = require('../main/lib/upi-qr');

function setSetting(key: string, value: string): void {
  getDatabase()
    .prepare(
      `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, value, now());
}

function linkChecks(): void {
  console.log('\n--- upi://pay link ---');
  assertEqualOrThrow(
    buildUpiPaymentLink({ upiId: ' shop@oksbi ', payeeName: 'Al Baik Wraps', amount: 320 }),
    'upi://pay?pa=shop@oksbi&pn=Al%20Baik%20Wraps&am=320.00&cu=INR',
    'the link carries the UPI ID with a literal @, the name, a two-decimal amount, and INR',
  );
  assertEqualOrThrow(
    buildUpiPaymentLink({ upiId: 'shop@ybl', amount: 40.456, note: 'Order 0003' }),
    'upi://pay?pa=shop@ybl&am=40.46&cu=INR&tn=Order%200003',
    'the amount rounds to paise and a note is added when given',
  );
  assertOrThrow(isValidUpiId('yahya.s-48@oksbi') && !isValidUpiId('no-at-sign') && !isValidUpiId('a@1bank'), 'UPI IDs are checked');
  for (const amount of [0, -5, Number.NaN, 2e7]) {
    let threw = false;
    try {
      buildUpiPaymentLink({ upiId: 'shop@ybl', amount });
    } catch {
      threw = true;
    }
    assertOrThrow(threw, `amount ${amount} is refused`);
  }
}

async function routeChecks(): Promise<void> {
  console.log('\n--- Setting and QR endpoint ---');
  initDatabase();
  const db = getDatabase();
  db.prepare(
    `INSERT OR IGNORE INTO users (id, name, email, password, role, is_active, created_at, updated_at)
     VALUES ('owner-1', 'Owner', 'owner@flo.local', 'unused', 'owner', 1, ?, ?)`,
  ).run(now(), now());
  setSetting('country', 'IN');
  setSetting('currency', 'INR');
  setSetting('timezone', 'Asia/Kolkata');
  setSetting('business_name', 'Al Baik Shawarma Wraps');

  const { paymentMethodRoutes } = require('../main/routes/payment-methods');
  const { settingsRoutes } = require('../main/routes/settings');
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.user = { userId: 'owner-1', email: 'owner@flo.local', role: 'owner' };
    next();
  });
  app.use('/api/payment-methods', paymentMethodRoutes);
  app.use('/api/settings', settingsRoutes);

  const unset = await request(app).get('/api/settings/upi_id');
  assertEqualOrThrow(unset.body.setting?.value, '', 'upi_id reads as empty before it is set');
  const notConfigured = await request(app).post('/api/payment-methods/upi-qr').send({ amount: 320 });
  assertEqualOrThrow(notConfigured.status, 409, 'no QR without a UPI ID');
  assertEqualOrThrow(notConfigured.body.error, 'upi_not_configured', 'and the reason says so');

  const bad = await request(app).put('/api/settings/upi_id').send({ value: 'not a upi id' });
  assertEqualOrThrow(bad.status, 400, 'an invalid UPI ID is not saved');
  const saved = await request(app).put('/api/settings/upi_id').send({ value: 'shop@oksbi' });
  assertEqualOrThrow(saved.status, 200, 'a valid UPI ID is saved');

  const qr = await request(app).post('/api/payment-methods/upi-qr').send({ amount: 320 });
  assertEqualOrThrow(qr.status, 200, 'the QR is made');
  assertEqualOrThrow(
    qr.body.link,
    'upi://pay?pa=shop@oksbi&pn=Al%20Baik%20Shawarma%20Wraps&am=320.00&cu=INR',
    'for the exact amount, to the saved UPI ID, under the business name',
  );
  assertOrThrow(String(qr.body.qr_data_url).startsWith('data:image/png;base64,'), 'as a PNG data URL');
  assertEqualOrThrow(qr.body.upi_id, 'shop@oksbi', 'the response names the UPI ID for the cashier');

  const zero = await request(app).post('/api/payment-methods/upi-qr').send({ amount: 0 });
  assertEqualOrThrow(zero.status, 400, 'a zero amount is refused');

  setSetting('currency', 'AED');
  const foreign = await request(app).post('/api/payment-methods/upi-qr').send({ amount: 10 });
  assertEqualOrThrow(foreign.body.error, 'upi_requires_inr', 'UPI QR needs INR');

  const cleared = await request(app).put('/api/settings/upi_id').send({ value: '' });
  assertEqualOrThrow(cleared.status, 200, 'the UPI ID can be cleared');
}

linkChecks();
routeChecks()
  .then(() => {
    closeDatabase();
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
    process.exit(getResults().failed > 0 ? 1 : 0);
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
