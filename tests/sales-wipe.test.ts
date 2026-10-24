import * as assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const Module = require('module');
const originalLoad = Module._load;
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-sales-wipe-'));

Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron') {
    return {
      app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' },
      safeStorage: { isEncryptionAvailable: () => false },
    };
  }
  return originalLoad.apply(this, arguments as any);
};

import { getDatabase, initDatabase, upsertSettings } from '../main/db';
import {
  getPendingSalesWipe,
  getSalesWipeSettings,
  markSalesWipePending,
  setSalesWipeSettings,
  wipeSalesData,
} from '../main/services/sales-wipe';

const WIPED = [
  'orders',
  'order_items',
  'order_audit_log',
  'bills',
  'refunds',
  'customers',
  'loyalty_ledger',
  'held_orders',
  'cash_sessions',
  'cash_closures',
  'cash_drawer_movements',
  'expenses',
  'expense_payments',
  'inventory_movements',
  'supply_movements',
  'whatsapp_messages',
];
const KEPT = ['users', 'categories', 'products', 'supplies', 'tables', 'expense_categories'];

function count(table: string): number {
  return (getDatabase().prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c;
}

function seed(): void {
  const db = getDatabase();
  const at = '2026-10-24T10:00:00.000Z';
  db.prepare(
    "INSERT INTO users (id, name, password, role) VALUES ('u1', 'Owner', 'x', 'owner')",
  ).run();
  db.prepare("INSERT INTO categories (id, name) VALUES ('c1', 'Drinks')").run();
  db.prepare(
    "INSERT INTO products (id, category_id, name, price, stock_quantity) VALUES ('p1', 'c1', 'Latte', 4, 7)",
  ).run();
  db.prepare("INSERT INTO supplies (id, name, base_unit) VALUES ('s1', 'Milk', 'ml')").run();
  db.prepare("INSERT INTO customers (id, name) VALUES ('cu1', 'Ana')").run();
  db.prepare(
    "INSERT INTO tables (id, number, status, reservation_customer_id) VALUES ('t1', '1', 'occupied', 'cu1')",
  ).run();
  db.prepare(
    "INSERT INTO orders (id, order_number, table_id, customer_id, user_id, status, total) VALUES (1, 'A-1', 't1', 'cu1', 'u1', 'completed', 4)",
  ).run();
  db.prepare(
    "INSERT INTO orders (id, order_number, user_id, status, total) VALUES (2, 'A-2', 'u1', 'pending', 4)",
  ).run();
  db.prepare(
    "INSERT INTO order_items (id, order_id, product_id, product_name, unit_price, subtotal, total) VALUES (1, 1, 'p1', 'Latte', 4, 4, 4)",
  ).run();
  db.prepare(
    "INSERT INTO order_audit_log (order_id, order_item_id, actor_user_id, action) VALUES (1, 1, 'u1', 'created')",
  ).run();
  db.prepare(
    "INSERT INTO bills (id, bill_number, order_id, total, paid_amount, payment_status) VALUES (1, 'B-1', 1, 4, 4, 'paid')",
  ).run();
  db.prepare('INSERT INTO bill_items (bill_id, order_item_id, quantity) VALUES (1, 1, 1)').run();
  db.prepare(
    "INSERT INTO refunds (bill_id, order_item_id, amount_cents, method, approved_by, created_by, created_at) VALUES (1, 1, 100, 'cash', 'u1', 'u1', ?)",
  ).run(at);
  db.prepare(
    "INSERT INTO loyalty_ledger (customer_id, bill_id, type, amount) VALUES ('cu1', 1, 'earn', 4)",
  ).run();
  db.prepare("INSERT INTO held_orders (id, table_id, items) VALUES ('h1', 't1', '[]')").run();
  db.prepare(
    "INSERT INTO whatsapp_messages (bill_id, customer_id, phone_e164, direction, body) VALUES (1, 'cu1', '+15550000000', 'outbound', 'Receipt')",
  ).run();
  db.prepare(
    "INSERT INTO inventory_movements (product_id, quantity_delta, movement_type, reference_type, reference_id, actor_user_id, stock_after) VALUES ('p1', -1, 'sale', 'order_item', '1', 'u1', 7)",
  ).run();
  db.prepare(
    "INSERT INTO supply_movements (supply_id, quantity_delta, movement_type, unit, stock_after, actor_user_id, reference_type, reference_id) VALUES ('s1', -200, 'recipe_depletion', 'ml', 800, 'u1', 'order_item', '1')",
  ).run();
  db.prepare(
    "INSERT INTO cash_closures (id, scope, business_date, period_start, period_end, expected_cash_cents, counted_cash_cents, variance_cents, gross_collected_cents, refunded_cents, net_collected_cents, bill_count, refund_count, z_number, closed_by) VALUES (1, 'session', '2026-10-24', ?, ?, 400, 400, 0, 400, 100, 300, 1, 1, 1, 'u1')",
  ).run(at, at);
  db.prepare(
    "INSERT INTO cash_sessions (opened_by, opened_at, status, closed_at, closed_by, closure_id) VALUES ('u1', ?, 'closed', ?, 'u1', 1)",
  ).run(at, at);
  db.prepare("INSERT INTO cash_sessions (opened_by, opened_at) VALUES ('u1', ?)").run(at);
  const movement = db
    .prepare(
      "INSERT INTO cash_drawer_movements (business_date, movement_type, amount_cents, created_by) VALUES ('2026-10-24', 'pay_out', 500, 'u1')",
    )
    .run();
  db.prepare(
    "INSERT INTO expense_categories (id, name, name_key, created_by, updated_by, created_at, updated_at) VALUES ('ec1', 'Supplies', 'supplies', 'u1', 'u1', ?, ?)",
  ).run(at, at);
  db.prepare(
    "INSERT INTO expenses (id, category_id, category_name, description, amount_minor, currency_code, incurred_on, created_by, created_at) VALUES ('e1', 'ec1', 'Supplies', 'Milk', 500, 'USD', '2026-10-24', 'u1', ?)",
  ).run(at);
  db.prepare(
    "INSERT INTO expense_payments (id, expense_id, amount_minor, method, business_date, cash_movement_id, created_by, created_at) VALUES ('ep1', 'e1', 500, 'cash', '2026-10-24', ?, 'u1', ?)",
  ).run(movement.lastInsertRowid, at);
}

async function closeAndConfirmThroughApi(): Promise<void> {
  const express = require('express');
  const jwt = require('jsonwebtoken');
  const request = require('supertest');
  const { getJWTSecret } = require('../main/routes/auth');
  const { cashSessionRoutes } = require('../main/routes/cash-sessions');
  const { cashClosureRoutes } = require('../main/routes/cash-closures');
  const db = getDatabase();
  upsertSettings({ country: 'IN', currency: 'INR', timezone: 'UTC' });
  db.prepare(
    "INSERT INTO users (id, name, email, password, role, is_active) VALUES ('cashier-1', 'Cashier', 'cashier@test.local', 'x', 'cashier', 1)",
  ).run();
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: unknown, next: () => void) => {
    req.user = jwt.verify(String(req.headers.authorization).split(' ')[1], getJWTSecret());
    next();
  });
  app.use('/api/cash-sessions', cashSessionRoutes);
  app.use('/api/cash-closures', cashClosureRoutes);
  const auth = `Bearer ${jwt.sign({ userId: 'cashier-1', email: 'cashier@test.local', role: 'cashier' }, getJWTSecret())}`;

  const opened = await request(app)
    .post('/api/cash-sessions/open')
    .set('Authorization', auth)
    .send({ opening_float_cents: 0 });
  assert.equal(opened.status, 200, JSON.stringify(opened.body));
  db.prepare("INSERT INTO customers (id, name) VALUES ('cu-api', 'Ben')").run();

  const closed = await request(app)
    .post(`/api/cash-sessions/${opened.body.id}/close`)
    .set('Authorization', auth)
    .send({ counted_cash_cents: 0 });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  assert.equal(closed.body.sales_wipe_pending, true, 'shift close reports the waiting wipe');
  assert.equal(count('customers'), 1, 'nothing is wiped before the operator confirms');
  assert.ok(count('cash_closures') > 0, 'the Z report stays printable until confirmed');

  const pending = await request(app)
    .get('/api/cash-closures/sales-wipe/pending')
    .set('Authorization', auth);
  assert.deepEqual(pending.body.pending, { trigger: 'shift', closureId: closed.body.closure_id });

  const wrong = await request(app)
    .post('/api/cash-closures/sales-wipe/confirm')
    .set('Authorization', auth)
    .send({ closure_id: closed.body.closure_id + 1 });
  assert.equal(wrong.status, 409, 'a confirm for another close is refused');
  assert.equal(count('customers'), 1);

  const confirmed = await request(app)
    .post('/api/cash-closures/sales-wipe/confirm')
    .set('Authorization', auth)
    .send({ closure_id: closed.body.closure_id });
  assert.equal(confirmed.status, 200);
  for (const table of ['customers', 'cash_sessions', 'cash_closures']) {
    assert.equal(count(table), 0, `${table} is wiped after confirming`);
  }
  assert.ok(count('users') > 0, 'users are kept');
}

async function main(): Promise<void> {
  initDatabase();

  assert.deepEqual(
    getSalesWipeSettings(),
    { dayClose: false, shiftClose: false },
    'off by default',
  );
  assert.equal(markSalesWipePending('day', 1), false, 'a close does not queue a wipe while off');
  assert.equal(getPendingSalesWipe(), null);

  setSalesWipeSettings({ shiftClose: true });
  assert.deepEqual(getSalesWipeSettings(), { dayClose: false, shiftClose: true });
  assert.equal(markSalesWipePending('day', 1), false, 'day close wipe stays off independently');
  assert.equal(markSalesWipePending('shift', 1), true);
  assert.deepEqual(getPendingSalesWipe(), { trigger: 'shift', closureId: 1 });

  seed();
  for (const table of [...WIPED, ...KEPT]) assert.ok(count(table) > 0, `${table} is seeded`);
  const keptBefore = Object.fromEntries(KEPT.map((table) => [table, count(table)]));

  wipeSalesData();

  for (const table of WIPED) assert.equal(count(table), 0, `${table} is wiped`);
  for (const table of KEPT) assert.equal(count(table), keptBefore[table], `${table} is kept`);
  const db = getDatabase();
  assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), [], 'no dangling references');
  assert.deepEqual(
    db.prepare("SELECT status, reservation_customer_id FROM tables WHERE id = 't1'").get(),
    { status: 'available', reservation_customer_id: null },
    'tables are freed',
  );
  assert.equal(
    (db.prepare("SELECT stock_quantity FROM products WHERE id = 'p1'").get() as any).stock_quantity,
    7,
    'stock levels are kept',
  );
  assert.equal(getPendingSalesWipe(), null, 'the pending marker is cleared');
  assert.deepEqual(getSalesWipeSettings(), { dayClose: false, shiftClose: true }, 'settings kept');

  await closeAndConfirmThroughApi();

  console.log('sales-wipe: all assertions passed');
}

main().then(
  () => process.exit(0),
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
