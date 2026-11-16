/**
 * POST /api/orders/:id/edit corrects an order entered wrongly: lines removed, quantities changed,
 * items added and the payment split moved between cash, UPI and the other methods, with stock,
 * bill, kitchen and cash drawer kept in step. Only the owner's staff PIN approves it, and removing
 * every line deletes the order.
 *
 * Usage: node tests/run-electron-node-test.cjs tests/order-edit.test.ts
 */
const Module = require('module');
const originalLoad = Module._load;
const fs = require('fs');
const os = require('os');
const path = require('path');
const testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'flo-order-edit-'));
Module._load = function (request: string, parent: unknown, isMain: boolean) {
  if (request === 'electron')
    return { app: { isPackaged: true, getPath: () => testDir, getVersion: () => 'test' } };
  return originalLoad.apply(this, arguments as any);
};

process.env.JWT_SECRET = 'test-secret-order-edit';

const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const {
  initTestDb,
  createApp,
  startServer,
  seedCategory,
  seedProduct,
  seedCustomer,
  api,
  assertOrThrow,
  assertEqualOrThrow,
  closeDatabase,
  now,
} = require('./helpers/test-setup');
const { getJWTSecret } = require('../main/routes/auth');
const { orderRoutes, resetPinRateLimitForTests } = require('../main/routes/orders');
const { billRoutes } = require('../main/routes/bills');

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

const OWNER = { approver_id: 'owner-edit', override_pin: '5678' };

async function main() {
  resetPinRateLimitForTests();
  const db = initTestDb();
  seedCategory(db, 'cat-edit', 'Edit test');
  seedProduct(db, 'prod-tea', 'cat-edit', 'Masala Tea', 250, {
    track_inventory: true,
    stock_quantity: 20,
  });
  seedProduct(db, 'prod-bun', 'cat-edit', 'Bun Maska', 100, {
    track_inventory: true,
    stock_quantity: 20,
  });

  const ownerAuth = seedUser(db, 'owner-edit', 'owner', '5678');
  seedUser(db, 'manager-edit', 'manager', '1234');
  const cashierAuth = seedUser(db, 'cashier-edit', 'cashier', '9876');

  const upi = db.prepare("SELECT id FROM payment_methods WHERE lower(name) = 'upi'").get() as
    | { id: number }
    | undefined;
  assertOrThrow(!!upi, 'UPI is a configured payment method');
  const upiId = Number(upi!.id);

  const app = createApp({ '/api/orders': orderRoutes, '/api/bills': billRoutes });
  const { baseUrl, server } = await startServer(app);
  const stock = (id: string) =>
    Number(
      (db.prepare('SELECT stock_quantity FROM products WHERE id = ?').get(id) as any)
        .stock_quantity,
    );
  const row = (sql: string, ...args: unknown[]) => db.prepare(sql).get(...args) as any;
  const billOf = (orderId: number) => {
    const bill = row('SELECT * FROM bills WHERE order_id = ?', orderId);
    return bill ? { ...bill, payment_details: JSON.parse(bill.payment_details || '[]') } : null;
  };
  const edit = (orderId: number, body: Record<string, unknown>) =>
    api(baseUrl, `/api/orders/${orderId}/edit`, { method: 'POST', body, headers: cashierAuth });
  const preview = async (
    orderId: number,
    items: unknown[],
    extra: Record<string, unknown> = {},
  ) => {
    const res = await edit(orderId, { preview: true, items, ...extra });
    assertEqualOrThrow(res.status, 200, `preview answers (${JSON.stringify(res.data)})`);
    return res.data;
  };
  const activeLines = (orderId: number) =>
    db
      .prepare(
        "SELECT * FROM order_items WHERE order_id = ? AND status NOT IN ('cancelled', 'voided', 'void_adjustment', 'refunded') ORDER BY id",
      )
      .all(orderId) as any[];

  async function paidOrder(items: { product_id: string; quantity: number }[], payments: unknown[]) {
    const created = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: { type: 'takeaway', items },
      headers: cashierAuth,
    });
    assertEqualOrThrow(created.status, 201, 'order created');
    const orderId = created.data.order.id as number;
    const bill = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: orderId },
      headers: cashierAuth,
    });
    assertEqualOrThrow(bill.status, 201, 'bill generated');
    if (payments.length > 0) {
      const paid = await api(baseUrl, `/api/bills/${bill.data.bill.id}/payments`, {
        method: 'POST',
        body: { payments },
        headers: cashierAuth,
      });
      assertEqualOrThrow(paid.status, 200, `bill paid (${JSON.stringify(paid.data)})`);
    }
    return orderId;
  }

  try {
    console.log('\n--- A paid order: one more tea, the extra paid by UPI ---');
    const orderId = await paidOrder(
      [{ product_id: 'prod-tea', quantity: 2 }],
      [{ method: 'cash', amount: 500 }],
    );
    assertEqualOrThrow(stock('prod-tea'), 18, 'the sale took 2 teas');
    const teaLine = activeLines(orderId)[0];
    const firstPreview = await preview(orderId, [{ id: teaLine.id, quantity: 3 }]);
    assertEqualOrThrow(firstPreview.bill_total, 750, 'the preview prices three teas');
    assertEqualOrThrow(firstPreview.paid_amount, 500, 'the preview shows what was paid');
    assertEqualOrThrow(firstPreview.payments_must_match_total, true, 'a paid bill must stay paid');
    assertEqualOrThrow(stock('prod-tea'), 18, 'a preview changes no stock');
    assertEqualOrThrow(activeLines(orderId)[0].quantity, 2, 'a preview changes no line');
    const version = firstPreview.version;

    const save = (body: Record<string, unknown>) =>
      edit(orderId, {
        expected_version: version,
        items: [{ id: teaLine.id, quantity: 3 }],
        payments: [
          { method: 'cash', amount: 500 },
          { method: 'custom', payment_method_id: upiId, amount: 250 },
        ],
        ...body,
      });
    assertEqualOrThrow((await save({})).status, 400, 'saving without a PIN is refused');
    assertEqualOrThrow(
      (await save({ approver_id: 'manager-edit', override_pin: '1234' })).status,
      403,
      "a manager's PIN is not enough",
    );
    assertEqualOrThrow(
      (await save({ approver_id: 'owner-edit', override_pin: '0000' })).status,
      403,
      'a wrong owner PIN is refused',
    );
    resetPinRateLimitForTests();
    const short = await save({
      ...OWNER,
      payments: [{ method: 'cash', amount: 500 }],
    });
    assertEqualOrThrow(short.status, 400, 'a paid order cannot be left short');
    assertEqualOrThrow(stock('prod-tea'), 18, 'a refused save changes no stock');

    const saved = await save(OWNER);
    assertEqualOrThrow(saved.status, 200, `the edit saves (${JSON.stringify(saved.data)})`);
    assertEqualOrThrow(stock('prod-tea'), 17, 'the extra tea came out of stock');
    let bill = billOf(orderId);
    assertEqualOrThrow(bill.total, 750, 'the bill total is three teas');
    assertEqualOrThrow(bill.paid_amount, 750, 'the bill is fully paid');
    assertEqualOrThrow(bill.payment_status, 'paid', 'the bill stays paid');
    assertEqualOrThrow(bill.payment_details.length, 2, 'the cash line stays and a UPI line joins');
    assertEqualOrThrow(bill.payment_details[0].amount, 500, 'the cash payment is untouched');
    assertEqualOrThrow(bill.payment_details[1].payment_method_id, upiId, 'the extra is UPI');
    assertEqualOrThrow(row('SELECT total FROM orders WHERE id = ?', orderId).total, 750, 'order');
    assertEqualOrThrow(
      row(
        "SELECT COUNT(*) AS n FROM order_audit_log WHERE order_id = ? AND action = 'order_edited'",
        orderId,
      ).n,
      1,
      'the edit is in the audit log',
    );
    assertEqualOrThrow(saved.data.kitchen_items.length, 1, 'the kitchen hears about the extra');
    assertEqualOrThrow(saved.data.kitchen_items[0].quantity, 1, 'only the one extra tea');

    console.log('\n--- A stale editor is refused ---');
    const stale = await save(OWNER);
    assertEqualOrThrow(stale.status, 409, 'an edit based on an old view is refused');

    console.log('\n--- Cash recorded by mistake: it was UPI ---');
    let current = await preview(orderId, [{ id: teaLine.id, quantity: 3 }]);
    const switched = await edit(orderId, {
      ...OWNER,
      expected_version: current.version,
      items: [{ id: teaLine.id, quantity: 3 }],
      payments: [{ method: 'custom', payment_method_id: upiId, amount: 750 }],
    });
    assertEqualOrThrow(switched.status, 200, 'switching the method saves');
    bill = billOf(orderId);
    assertOrThrow(
      bill.payment_details.every((line: any) => line.payment_method_id === upiId),
      'every line is UPI now',
    );
    assertEqualOrThrow(bill.paid_amount, 750, 'the amount paid is unchanged');
    assertEqualOrThrow(stock('prod-tea'), 17, 'a payment change touches no stock');

    console.log('\n--- Nothing changed ---');
    current = await preview(orderId, [{ id: teaLine.id, quantity: 3 }]);
    const nothing = await edit(orderId, {
      ...OWNER,
      expected_version: current.version,
      items: [{ id: teaLine.id, quantity: 3 }],
      payments: [{ method: 'custom', payment_method_id: upiId, amount: 750 }],
    });
    assertEqualOrThrow(nothing.status, 400, 'an edit that changes nothing is refused');

    console.log('\n--- Remove a line, add another, kitchen off ---');
    const mixedId = await paidOrder(
      [
        { product_id: 'prod-tea', quantity: 1 },
        { product_id: 'prod-bun', quantity: 2 },
      ],
      [{ method: 'cash', amount: 450 }],
    );
    const [tea, bun] = activeLines(mixedId);
    current = await preview(mixedId, [
      { id: bun.id, quantity: 1 },
      { product_id: 'prod-bun', quantity: 1, special_instructions: 'extra butter' },
    ]);
    assertEqualOrThrow(current.bill_total, 200, 'two buns are 200');
    const mixed = await edit(mixedId, {
      ...OWNER,
      expected_version: current.version,
      send_to_kitchen: false,
      items: [
        { id: bun.id, quantity: 1 },
        { product_id: 'prod-bun', quantity: 1, special_instructions: 'extra butter' },
      ],
      payments: [{ method: 'cash', amount: 200 }],
    });
    assertEqualOrThrow(mixed.status, 200, `the edit saves (${JSON.stringify(mixed.data)})`);
    assertEqualOrThrow(
      row('SELECT status FROM order_items WHERE id = ?', tea.id).status,
      'cancelled',
      'the removed tea is cancelled',
    );
    assertEqualOrThrow(stock('prod-tea'), 17, 'the removed tea went back to stock');
    assertEqualOrThrow(stock('prod-bun'), 18, 'buns: 2 sold, 1 back, 1 added');
    const lines = activeLines(mixedId);
    assertEqualOrThrow(lines.length, 2, 'two bun lines remain');
    assertEqualOrThrow(lines[1].status, 'served', 'without the kitchen the new line is served');
    assertEqualOrThrow(mixed.data.kitchen_items.length, 0, 'nothing goes to the kitchen');
    bill = billOf(mixedId);
    assertEqualOrThrow(bill.total, 200, 'bill total follows');
    assertEqualOrThrow(bill.paid_amount, 200, 'cash given back');
    assertEqualOrThrow(bill.payment_details[0].amount, 200, 'the cash line is lowered');
    assertEqualOrThrow(bill.payment_details[0].change_amount, 0, 'with no change on it');

    console.log('\n--- New items go to the kitchen ---');
    current = await preview(mixedId, [
      { id: lines[0].id, quantity: 1 },
      { id: lines[1].id, quantity: 1 },
      { product_id: 'prod-tea', quantity: 1 },
    ]);
    const toKitchen = await edit(mixedId, {
      ...OWNER,
      expected_version: current.version,
      items: [
        { id: lines[0].id, quantity: 1 },
        { id: lines[1].id, quantity: 1 },
        { product_id: 'prod-tea', quantity: 1 },
      ],
      payments: [
        { method: 'cash', amount: 200 },
        { method: 'cash', amount: 250 },
      ],
    });
    assertEqualOrThrow(toKitchen.status, 200, 'the edit saves');
    assertEqualOrThrow(toKitchen.data.kitchen_items.length, 1, 'the new tea is a kitchen ticket');
    assertEqualOrThrow(activeLines(mixedId)[2].status, 'pending', 'and waits in the kitchen');
    assertEqualOrThrow(billOf(mixedId).paid_amount, 450, 'the extra cash is recorded');

    console.log('\n--- Overpaying is refused ---');
    current = await preview(mixedId, [
      { id: lines[0].id, quantity: 1 },
      { id: lines[1].id, quantity: 1 },
    ]);
    const over = await edit(mixedId, {
      ...OWNER,
      expected_version: current.version,
      items: [
        { id: lines[0].id, quantity: 1 },
        { id: lines[1].id, quantity: 1 },
      ],
      payments: [{ method: 'cash', amount: 450 }],
    });
    assertEqualOrThrow(over.status, 400, 'payments above the new total are refused');

    console.log('\n--- Cash given back from an earlier shift leaves the open drawer ---');
    const shiftOrder = await paidOrder(
      [{ product_id: 'prod-bun', quantity: 3 }],
      [{ method: 'cash', amount: 300 }],
    );
    const sessionId = Number(
      db
        .prepare(
          "INSERT INTO cash_sessions (opened_by, opened_by_name, opened_at, opening_float_cents, status) VALUES ('owner-edit', 'owner', ?, 0, 'open')",
        )
        .run(now()).lastInsertRowid,
    );
    const shiftLine = activeLines(shiftOrder)[0];
    current = await preview(shiftOrder, [{ id: shiftLine.id, quantity: 1 }]);
    const returned = await edit(shiftOrder, {
      ...OWNER,
      expected_version: current.version,
      items: [{ id: shiftLine.id, quantity: 1 }],
      payments: [{ method: 'cash', amount: 100 }],
    });
    assertEqualOrThrow(returned.status, 200, 'the edit saves');
    bill = billOf(shiftOrder);
    assertEqualOrThrow(bill.paid_amount, 100, 'the bill is paid 100');
    assertEqualOrThrow(bill.payment_details[0].amount, 300, 'the earlier cash stays as counted');
    assertEqualOrThrow(bill.payment_details[1].amount, -200, 'the 200 given back is its own line');
    assertEqualOrThrow(
      bill.payment_details[1].cash_session_id,
      sessionId,
      'and leaves the open shift',
    );
    assertEqualOrThrow(
      row("SELECT COUNT(*) AS n FROM cash_drawer_movements WHERE movement_type = 'pay_out'").n,
      0,
      'no separate pay-out double counts it',
    );

    console.log('\n--- Cash given back in the same shift just lowers the payment ---');
    const sameShift = await paidOrder(
      [{ product_id: 'prod-bun', quantity: 2 }],
      [{ method: 'cash', amount: 200 }],
    );
    const sameLine = activeLines(sameShift)[0];
    current = await preview(sameShift, [{ id: sameLine.id, quantity: 1 }]);
    const sameEdit = await edit(sameShift, {
      ...OWNER,
      expected_version: current.version,
      items: [{ id: sameLine.id, quantity: 1 }],
      payments: [{ method: 'cash', amount: 100 }],
    });
    assertEqualOrThrow(sameEdit.status, 200, 'the edit saves');
    bill = billOf(sameShift);
    assertEqualOrThrow(bill.payment_details.length, 1, 'one cash line');
    assertEqualOrThrow(bill.payment_details[0].amount, 100, 'lowered to 100');

    console.log('\n--- Extra units on a started line keep its discount ---');
    const discounted = await paidOrder([{ product_id: 'prod-tea', quantity: 2 }], []);
    const discountedLine = activeLines(discounted)[0];
    const itemDiscount = await api(
      baseUrl,
      `/api/orders/${discounted}/items/${discountedLine.id}/discount`,
      {
        method: 'PATCH',
        body: { discount_type: 'percentage', discount_value: 10 },
        headers: ownerAuth,
      },
    );
    assertEqualOrThrow(
      itemDiscount.status,
      200,
      `item discount set (${JSON.stringify(itemDiscount.data)})`,
    );
    db.prepare("UPDATE order_items SET status = 'preparing' WHERE id = ?").run(discountedLine.id);
    const withKitchen = await preview(discounted, [{ id: discountedLine.id, quantity: 3 }]);
    const withoutKitchen = await preview(discounted, [{ id: discountedLine.id, quantity: 3 }], {
      send_to_kitchen: false,
    });
    assertEqualOrThrow(withKitchen.order_total, 675, 'three teas less 10% with the kitchen');
    assertEqualOrThrow(withoutKitchen.order_total, 675, 'and the same without it');

    console.log('\n--- Edit does not take more money on a part-paid bill ---');
    const partOrder = await paidOrder([{ product_id: 'prod-bun', quantity: 3 }], []);
    const partBill = billOf(partOrder);
    const partPay = await api(baseUrl, `/api/bills/${partBill.id}/payments`, {
      method: 'POST',
      body: { payments: [{ method: 'custom', payment_method_id: upiId, amount: 100 }] },
      headers: cashierAuth,
    });
    assertEqualOrThrow(partPay.data.bill.payment_status, 'partial', 'the bill is part paid');
    const partLine = activeLines(partOrder)[0];
    current = await preview(partOrder, [{ id: partLine.id, quantity: 3 }]);
    assertEqualOrThrow(current.payments_must_match_total, false, 'a part-paid bill may stay due');
    const settle = await edit(partOrder, {
      ...OWNER,
      expected_version: current.version,
      items: [{ id: partLine.id, quantity: 3 }],
      payments: [
        { method: 'custom', payment_method_id: upiId, amount: 100 },
        { method: 'cash', amount: 200 },
      ],
    });
    assertEqualOrThrow(settle.status, 400, 'settling through Edit is refused');
    const resplit = await edit(partOrder, {
      ...OWNER,
      expected_version: current.version,
      items: [{ id: partLine.id, quantity: 3 }],
      payments: [{ method: 'cash', amount: 100 }],
    });
    assertEqualOrThrow(resplit.status, 200, 'the part payment can be re-split');
    assertEqualOrThrow(billOf(partOrder).payment_status, 'partial', 'and the bill stays part paid');

    console.log('\n--- Cashback and a percentage discount follow the new total ---');
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('loyalty_enabled', 'true')",
    ).run();
    db.prepare(
      "INSERT OR REPLACE INTO settings (key, value) VALUES ('global_cashback_percent', '10')",
    ).run();
    db.prepare("UPDATE products SET cb_percent = NULL WHERE id = 'prod-bun'").run();
    seedCustomer(db, 'cust-edit', 'Asha', '9876543210');
    const loyal = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: {
        type: 'takeaway',
        customer_id: 'cust-edit',
        items: [{ product_id: 'prod-bun', quantity: 4 }],
      },
      headers: cashierAuth,
    });
    assertEqualOrThrow(loyal.status, 201, 'customer order created');
    const loyalId = loyal.data.order.id as number;
    db.prepare(
      "UPDATE orders SET discount_type = 'percentage', discount_value = 10, discount_amount = 40 WHERE id = ?",
    ).run(loyalId);
    db.prepare('UPDATE orders SET total = total - 40 WHERE id = ?').run(loyalId);
    const loyalBill = await api(baseUrl, '/api/bills/generate', {
      method: 'POST',
      body: { order_id: loyalId },
      headers: cashierAuth,
    });
    assertEqualOrThrow(loyalBill.data.bill.total, 360, '4 buns less 10% is 360');
    const loyalPaid = await api(baseUrl, `/api/bills/${loyalBill.data.bill.id}/payments`, {
      method: 'POST',
      body: { payments: [{ method: 'cash', amount: 360 }] },
      headers: cashierAuth,
    });
    assertEqualOrThrow(loyalPaid.status, 200, 'customer bill paid');
    const creditBefore = row(
      "SELECT amount FROM loyalty_ledger WHERE bill_id = ? AND type = 'credit'",
      loyalBill.data.bill.id,
    );
    assertEqualOrThrow(creditBefore?.amount, 36, 'cashback is 10% of 360');
    const loyalLine = activeLines(loyalId)[0];
    current = await preview(loyalId, [{ id: loyalLine.id, quantity: 2 }]);
    assertEqualOrThrow(current.bill_total, 180, 'the 10% discount scales to 2 buns');
    const loyalEdit = await edit(loyalId, {
      ...OWNER,
      expected_version: current.version,
      items: [{ id: loyalLine.id, quantity: 2 }],
      payments: [{ method: 'cash', amount: 180 }],
    });
    assertEqualOrThrow(loyalEdit.status, 200, `the edit saves (${JSON.stringify(loyalEdit.data)})`);
    assertEqualOrThrow(
      row(
        "SELECT amount FROM loyalty_ledger WHERE bill_id = ? AND type = 'credit'",
        loyalBill.data.bill.id,
      )?.amount,
      18,
      'cashback follows the new total',
    );
    assertEqualOrThrow(
      row('SELECT discount_amount FROM orders WHERE id = ?', loyalId).discount_amount,
      20,
      'the discount is 10% of the new subtotal',
    );

    console.log('\n--- An order with no bill yet ---');
    const open = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: { type: 'takeaway', items: [{ product_id: 'prod-bun', quantity: 1 }] },
      headers: cashierAuth,
    });
    const openId = open.data.order.id as number;
    const openLine = activeLines(openId)[0];
    current = await preview(openId, [{ id: openLine.id, quantity: 2 }]);
    assertEqualOrThrow(current.bill_total, null, 'no bill yet');
    const refusedPay = await edit(openId, {
      ...OWNER,
      expected_version: current.version,
      items: [{ id: openLine.id, quantity: 2 }],
      payments: [{ method: 'cash', amount: 200 }],
    });
    assertEqualOrThrow(refusedPay.status, 400, 'payment is not taken through Edit');
    const openSaved = await edit(openId, {
      ...OWNER,
      expected_version: current.version,
      items: [{ id: openLine.id, quantity: 2 }],
    });
    assertEqualOrThrow(openSaved.status, 200, 'the open order is edited');
    assertEqualOrThrow(row('SELECT total FROM orders WHERE id = ?', openId).total, 200, 'total');

    console.log('\n--- Removing every item deletes the order ---');
    const before = stock('prod-bun');
    current = await preview(openId, []);
    assertEqualOrThrow(current.deleted, true, 'the preview warns it becomes a delete');
    assertEqualOrThrow(
      row('SELECT COUNT(*) AS n FROM orders WHERE id = ?', openId).n,
      1,
      'a preview deletes nothing',
    );
    const emptied = await edit(openId, { ...OWNER, expected_version: current.version, items: [] });
    assertEqualOrThrow(emptied.status, 200, 'the empty edit saves');
    assertEqualOrThrow(emptied.data.deleted, true, 'and reports the delete');
    assertEqualOrThrow(
      row('SELECT COUNT(*) AS n FROM orders WHERE id = ?', openId).n,
      0,
      'the order is gone',
    );
    assertEqualOrThrow(stock('prod-bun'), before + 2, 'its buns are back in stock');

    console.log('\n--- A cancelled order cannot be edited ---');
    const toCancel = await api(baseUrl, '/api/orders', {
      method: 'POST',
      body: { type: 'takeaway', items: [{ product_id: 'prod-bun', quantity: 1 }] },
      headers: cashierAuth,
    });
    const cancelId = toCancel.data.order.id as number;
    const cancelled = await api(baseUrl, `/api/orders/${cancelId}/status`, {
      method: 'PATCH',
      body: { status: 'cancelled', reason: 'test' },
      headers: cashierAuth,
    });
    assertEqualOrThrow(
      cancelled.status,
      200,
      `order cancelled (${JSON.stringify(cancelled.data)})`,
    );
    const cancelledEdit = await edit(cancelId, {
      preview: true,
      items: [{ product_id: 'prod-bun', quantity: 1 }],
    });
    assertEqualOrThrow(cancelledEdit.status, 409, 'a cancelled order is refused');

    console.log('\n--- Unknown lines and orders ---');
    const unknownLine = await edit(orderId, {
      preview: true,
      items: [{ id: 999999, quantity: 1 }],
    });
    assertEqualOrThrow(unknownLine.status, 400, 'a line from elsewhere is refused');
    const unknownOrder = await edit(999999, { preview: true, items: [] });
    assertEqualOrThrow(unknownOrder.status, 404, 'an unknown order is reported');

    console.log('\norder-edit: all assertions passed');
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
