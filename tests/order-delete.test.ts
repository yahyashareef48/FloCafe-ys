/**
 * DELETE /api/orders/:id erases an order entered by mistake, in any state, as if it was never
 * placed: its items, bills, payments and audit rows go, its stock comes back, its table is freed,
 * and sales reports no longer count it. Only the owner's staff PIN approves it.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/order-delete.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-order-delete-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-order-delete';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const {
  initTestDb,
  createApp,
  startServer,
  seedCategory,
  seedProduct,
  api,
  assertOrThrow,
  assertEqualOrThrow,
  closeDatabase,
  now,
} = require('./helpers/test-setup');
const { getJWTSecret } = require('../main/routes/auth');
const { orderRoutes, resetPinRateLimitForTests } = require('../main/routes/orders');
const { billRoutes } = require('../main/routes/bills');
const { reportRoutes } = require('../main/routes/reports');

function seedUser(db: any, id: string, role: string, pin?: string) {
  const email = `${id}@test.local`;
  db.prepare(`
    INSERT INTO users (id, name, email, password, role, pin_hash, is_active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)
  `).run(
    id,
    id,
    email,
    bcrypt.hashSync('testpass123', 4),
    role,
    pin ? bcrypt.hashSync(pin, 4) : null,
    now(),
    now(),
  );
  return {
    Authorization: `Bearer ${jwt.sign({ userId: id, email, role }, getJWTSecret(), { expiresIn: '1h' })}`,
  };
}

async function main() {
  resetPinRateLimitForTests();
  const db = initTestDb();
  seedCategory(db, 'cat-del', 'Delete test');
  seedProduct(db, 'prod-del', 'cat-del', 'Paneer Tikka', 250, {
    track_inventory: true,
    stock_quantity: 20,
  });
  db.prepare(`INSERT INTO tables (id, number, capacity, status, created_at, updated_at)
    VALUES ('table-del', 'T9', 4, 'available', ?, ?)`).run(now(), now());

  const ownerAuth = seedUser(db, 'owner-del', 'owner', '5678');
  seedUser(db, 'manager-del', 'manager', '1234');
  const cashierAuth = seedUser(db, 'cashier-del', 'cashier', '9876');

  const app = createApp({
    '/api/orders': orderRoutes,
    '/api/bills': billRoutes,
    '/api/reports': reportRoutes,
  });
  const { baseUrl, server } = await startServer(app);
  const stock = () =>
    Number(
      (db.prepare("SELECT stock_quantity FROM products WHERE id = 'prod-del'").get() as any)
        .stock_quantity,
    );
  const count = (sql: string, ...args: unknown[]) =>
    Number((db.prepare(sql).get(...args) as any).n);
  const remove = (orderId: unknown, body: unknown, headers = cashierAuth) =>
    api(baseUrl, `/api/orders/${orderId}`, { method: 'DELETE', body, headers });

  try {
    console.log('\n--- A paid, completed order ---');
    const created = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: { type: 'takeaway', items: [{ product_id: 'prod-del', quantity: 2 }] },
      headers: cashierAuth,
    });
    assertEqualOrThrow(created.status, 201, 'order created');
    const orderId = created.data.order.id;
    assertEqualOrThrow(stock(), 18, 'the order took 2 from stock');
    const bill = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: orderId },
      headers: cashierAuth,
    });
    assertEqualOrThrow(bill.status, 201, 'bill generated');
    const paid = await api(baseUrl, `/api/bills/${bill.data.bill.id}/payment`, {
      method: 'POST',
      body: { method: 'cash', amount: bill.data.bill.total },
      headers: cashierAuth,
    });
    assertEqualOrThrow(paid.data.bill.payment_status, 'paid', 'bill paid');
    assertEqualOrThrow(
      (db.prepare('SELECT status FROM orders WHERE id = ?').get(orderId) as any).status,
      'completed',
      'paying completed the order',
    );
    const today = new Date().toISOString().slice(0, 10);
    const topBefore = await api(
      baseUrl,
      `/api/reports/topProducts?start_date=${today}&end_date=${today}`,
      { headers: ownerAuth },
    );
    assertEqualOrThrow(topBefore.data.topProducts.length, 1, 'top products counts the sale');

    console.log('\n--- Approval ---');
    assertEqualOrThrow((await remove(orderId, {})).status, 400, 'no PIN is refused');
    assertEqualOrThrow(
      (await remove(orderId, { approver_id: 'manager-del', override_pin: '1234' })).status,
      403,
      "a manager's own PIN is not enough",
    );
    assertEqualOrThrow(
      (await remove(orderId, { approver_id: 'cashier-del', override_pin: '9876' })).status,
      403,
      "a cashier's own PIN is not enough",
    );
    assertEqualOrThrow(
      (await remove(orderId, { approver_id: 'owner-del', override_pin: '0000' })).status,
      403,
      'a wrong owner PIN is refused',
    );
    assertEqualOrThrow(
      count('SELECT COUNT(*) AS n FROM orders WHERE id = ?', orderId),
      1,
      'refused attempts leave the order in place',
    );
    assertEqualOrThrow(
      (await remove(999999, { approver_id: 'owner-del', override_pin: '5678' })).status,
      404,
      'an unknown order is reported',
    );

    console.log('\n--- Deleting with the owner PIN ---');
    resetPinRateLimitForTests();
    const deleted = await remove(orderId, { approver_id: 'owner-del', override_pin: '5678' });
    assertEqualOrThrow(deleted.status, 200, 'a cashier can delete with the owner PIN');
    assertEqualOrThrow(
      count('SELECT COUNT(*) AS n FROM orders WHERE id = ?', orderId),
      0,
      'the order is gone',
    );
    assertEqualOrThrow(
      count('SELECT COUNT(*) AS n FROM order_items WHERE order_id = ?', orderId),
      0,
      'its items are gone',
    );
    assertEqualOrThrow(
      count('SELECT COUNT(*) AS n FROM bills WHERE order_id = ?', orderId),
      0,
      'its bill and payment are gone',
    );
    assertEqualOrThrow(
      count('SELECT COUNT(*) AS n FROM order_audit_log WHERE order_id = ?', orderId),
      0,
      'its audit rows are gone',
    );
    assertEqualOrThrow(stock(), 20, 'its stock is back');
    assertEqualOrThrow(
      count(
        "SELECT COUNT(*) AS n FROM inventory_movements WHERE product_id = 'prod-del' AND reason = 'Order deleted'",
      ),
      1,
      'the stock return is in the stock history',
    );
    const topAfter = await api(
      baseUrl,
      `/api/reports/topProducts?start_date=${today}&end_date=${today}`,
      { headers: ownerAuth },
    );
    assertEqualOrThrow(topAfter.data.topProducts.length, 0, 'top products no longer counts it');
    assertEqualOrThrow(
      (await remove(orderId, { approver_id: 'owner-del', override_pin: '5678' })).status,
      404,
      'deleting twice reports the order as gone',
    );

    console.log('\n--- An open dine-in order frees its table ---');
    const dineIn = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'dine_in',
        table_id: 'table-del',
        items: [{ product_id: 'prod-del', quantity: 1 }],
      },
      headers: cashierAuth,
    });
    assertEqualOrThrow(dineIn.status, 201, 'dine-in order created');
    assertOrThrow(
      (db.prepare("SELECT status FROM tables WHERE id = 'table-del'").get() as any).status !==
        'available',
      'the table is taken',
    );
    const freed = await remove(dineIn.data.order.id, {
      approver_id: 'owner-del',
      override_pin: '5678',
    });
    assertEqualOrThrow(freed.status, 200, 'an open order can be deleted');
    assertEqualOrThrow(
      (db.prepare("SELECT status FROM tables WHERE id = 'table-del'").get() as any).status,
      'available',
      'its table is free again',
    );
    assertEqualOrThrow(stock(), 20, 'its stock is back too');

    console.log('\norder-delete: all assertions passed');
  } finally {
    server.close();
    closeDatabase();
    Module._load = originalLoad;
    fs.rmSync(testDir, { recursive: true, force: true });
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
