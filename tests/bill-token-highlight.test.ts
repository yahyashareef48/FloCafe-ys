import * as assert from 'node:assert/strict';
import { renderClassicReceiptViaDocument } from '../main/printers/document-classic';
import { renderCompactReceiptViaDocument } from '../main/printers/document-compact';
import { tokenOf } from '../shared/print/document';

const order = {
  order_number: 'ORD-20261026-0358',
  type: 'takeaway',
  created_at: '2026-10-26 12:04:14',
  items: [{ product_name: 'Mini Shawarma', quantity: 1, unit_price: 100, total: 100, addons: [] }],
};
const bill = {
  bill_number: 'INV-20261026-0358',
  subtotal: 100,
  discount_amount: 0,
  tax_amount: 0,
  total: 100,
  payment_details: [{ method: 'cash', amount: 100 }],
};
const business = (extra: Record<string, unknown> = {}) => ({
  name: 'Al Baik',
  country: 'IN',
  currency: 'INR',
  ...extra,
});
const opts = {
  columns: 48,
  language: 'en',
  isReprint: false,
  useUnicode: false,
  arabicShaping: false,
  cutMode: 'full' as const,
};
const BIG_TOKEN = '{CENTER}{BOLD}{DOUBLE_HEIGHT}{DOUBLE_WIDTH}0358{/DOUBLE_WIDTH}{/DOUBLE_HEIGHT}{/BOLD}{/CENTER}';

assert.equal(tokenOf('INV-20261026-0358'), '0358');
assert.equal(tokenOf('ORD-12'), '12');
assert.equal(tokenOf('INV-ABC'), '');

for (const [name, render] of [
  ['classic', renderClassicReceiptViaDocument],
  ['compact', renderCompactReceiptViaDocument],
] as const) {
  const off = render(order, bill, business(), opts).lines;
  assert.ok(!off.includes(BIG_TOKEN), `${name}: token stays normal size by default`);

  const on = render(order, bill, business({ highlight_token: true }), opts).lines;
  assert.ok(on.includes(BIG_TOKEN), `${name}: token prints big and bold when highlighted`);
  assert.ok(
    on.some((line) => line.includes('INV-20261026-0358')),
    `${name}: full invoice number still prints`,
  );

  const noDigits = render(order, { ...bill, bill_number: 'INV-ABC' }, business({ highlight_token: true }), opts).lines;
  assert.ok(!noDigits.some((line) => line.includes('{DOUBLE_WIDTH}{/DOUBLE_WIDTH}')), `${name}: no empty token line`);
}

console.log('bill token highlight: ok');
