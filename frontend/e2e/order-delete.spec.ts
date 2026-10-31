import { test, expect } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken, setLanguage } from './helpers/test-auth';

/**
 * Delete order: the order detail menu erases an order entered by mistake once the owner's staff
 * PIN approves it. A wrong PIN leaves the order in place.
 */
test('an order entered by mistake is deleted with the owner PIN', async ({ page, request }) => {
  const ownerToken = getE2eToken('e2e-owner', 'owner@flo.local', 'owner');
  const ownerHeaders = {
    Authorization: `Bearer ${ownerToken}`,
    'Content-Type': 'application/json',
  };
  const pinRes = await request.put(`${BASE}/api/staff/e2e-owner`, {
    headers: ownerHeaders,
    data: { pin: '1111' },
  });
  expect(pinRes.ok(), `setting the owner PIN (got ${pinRes.status()})`).toBeTruthy();

  const created = await request.post(`${BASE}/api/orders`, {
    headers: ownerHeaders,
    data: {
      type: 'takeaway',
      special_instructions: 'Entered by mistake',
      items: [{ product_id: 'e2e-product', quantity: 1 }],
    },
  });
  expect(created.ok()).toBeTruthy();
  const order = (await created.json()).order as { id: number; order_number: string };

  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('manager@flo.local');
  await page.locator('#password').fill(E2E_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('**/pos/**', { timeout: 20000 });
  await setLanguage(page, 'en');
  await page.goto(`${BASE}/orders`);

  const row = page.getByRole('button').filter({ hasText: `#${order.order_number}` });
  await row.click();
  const panel = page.getByTestId('orders-detail-panel');
  await panel.locator('[aria-haspopup="menu"]').click();
  await page.getByRole('menuitem', { name: 'Delete order' }).click();

  await expect(page.getByText(`Erase order #${order.order_number}`)).toBeVisible();
  const pin = page.locator('#deleteOrderPin');
  const confirm = page.getByRole('button', { name: 'Delete order' });

  await pin.fill('0000');
  await confirm.click();
  await expect(page.getByText('Wrong owner PIN')).toBeVisible();
  const stillThere = await request.get(`${BASE}/api/orders/${order.id}`, { headers: ownerHeaders });
  expect(stillThere.status()).toBe(200);

  await pin.fill('1111');
  await confirm.click();
  await expect(page.getByText('Order deleted')).toBeVisible();
  await expect(row).toHaveCount(0);
  const gone = await request.get(`${BASE}/api/orders/${order.id}`, { headers: ownerHeaders });
  expect(gone.status()).toBe(404);
});
