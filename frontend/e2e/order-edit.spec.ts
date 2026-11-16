import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken, setLanguage } from './helpers/test-auth';

/**
 * Edit order: a paid order gets one more item from the order menu, the extra is put on a second
 * payment method, and the owner's staff PIN approves the change. A wrong PIN changes nothing.
 */
test('a paid order is corrected and re-split with the owner PIN', async ({ page, request }) => {
  const ownerToken = getE2eToken('e2e-owner', 'owner@flo.local', 'owner');
  const headers = { Authorization: `Bearer ${ownerToken}`, 'Content-Type': 'application/json' };
  const pinRes = await request.put(`${BASE}/api/staff/e2e-owner`, {
    headers,
    data: { pin: '1111' },
  });
  expect(pinRes.ok(), `setting the owner PIN (got ${pinRes.status()})`).toBeTruthy();

  const created = await request.post(`${BASE}/api/orders`, {
    headers,
    data: { type: 'takeaway', items: [{ product_id: 'e2e-product', quantity: 1 }] },
  });
  expect(created.ok()).toBeTruthy();
  const order = (await created.json()).order as { id: number; order_number: string };
  const generated = await request.post(`${BASE}/api/bills/generate`, {
    headers,
    data: { order_id: order.id },
  });
  expect(generated.ok()).toBeTruthy();
  const bill = (await generated.json()).bill as { id: number; total: number };
  const paid = await request.post(`${BASE}/api/bills/${bill.id}/payments`, {
    headers,
    data: { payments: [{ method: 'cash', amount: bill.total }] },
  });
  expect(paid.ok(), `paying the bill (got ${paid.status()})`).toBeTruthy();

  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('manager@flo.local');
  await page.locator('#password').fill(E2E_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('**/pos/**', { timeout: 20000 });
  await setLanguage(page, 'en');
  await page.goto(`${BASE}/orders`);
  await page.getByRole('button', { name: 'All', exact: true }).click();

  const row = page.getByRole('button').filter({ hasText: `#${order.order_number}` });
  await row.click();
  const panel = page.getByTestId('orders-detail-panel');
  await panel.locator('[aria-haspopup="menu"]').click();
  await page.getByRole('menuitem', { name: 'Edit order' }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText(`Edit order #${order.order_number}`)).toBeVisible();
  await expect(dialog.getByTestId('edit-order-qty')).toHaveText('1');
  await dialog.getByRole('button', { name: /^One more / }).click();
  await expect(dialog.getByTestId('edit-order-qty')).toHaveText('2');
  await expect(dialog.getByText(/Collect .* more from the customer/)).toBeVisible();
  await expect(dialog.getByTestId('edit-order-payment-status')).toHaveText(
    'Payments match the total',
  );

  // Keep the original cash and take the extra by UPI.
  await dialog.getByLabel('Cash', { exact: true }).fill(String(bill.total));
  await expect(dialog.getByTestId('edit-order-payment-status')).toContainText('still to split');
  const upiRow = dialog.locator('div', { has: page.locator('label', { hasText: 'UPI' }) }).last();
  await upiRow.getByRole('button', { name: 'Rest' }).click();
  await expect(dialog.getByTestId('edit-order-payment-status')).toHaveText(
    'Payments match the total',
  );

  const pin = dialog.locator('#editOrderPin');
  const save = dialog.getByRole('button', { name: 'Save changes' });
  await pin.fill('0000');
  await save.click();
  await expect(page.getByText('Wrong owner PIN')).toBeVisible();
  const unchanged = await request.get(`${BASE}/api/orders/${order.id}`, { headers });
  expect(Number((await unchanged.json()).order.total)).toBe(Number(bill.total));

  await pin.fill('1111');
  await save.click();
  await expect(page.getByText('Order updated')).toBeVisible();
  await expect(dialog).toHaveCount(0);

  const after = await request.get(`${BASE}/api/bills/order/${order.id}`, { headers });
  expect(after.ok()).toBeTruthy();
  const afterBody = await after.json();
  const afterBill = (afterBody.bills?.[0] ?? afterBody.bill ?? afterBody) as {
    total: number;
    paid_amount: number;
    payment_status: string;
    payment_details: { method: string; amount: number }[] | string;
  };
  expect(Number(afterBill.total)).toBeCloseTo(Number(bill.total) * 2, 2);
  expect(Number(afterBill.paid_amount)).toBeCloseTo(Number(afterBill.total), 2);
  expect(afterBill.payment_status).toBe('paid');
  const lines =
    typeof afterBill.payment_details === 'string'
      ? JSON.parse(afterBill.payment_details)
      : afterBill.payment_details;
  expect(lines.map((line: { method: string }) => line.method).sort()).toEqual(['UPI', 'cash']);
});
