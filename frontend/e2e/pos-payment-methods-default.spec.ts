import { test, expect, type Page } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken, setLanguage } from './helpers/test-auth';

/**
 * Checkout tenders: a store offers Cash and UPI (with its icon) by default, and Card only once
 * Settings > Payments turns it on.
 */
const SHOTS = process.env.POS_PAYMENT_SHOTS;
const headers = { Authorization: `Bearer ${getE2eToken()}` };

async function openPayment(page: Page): Promise<void> {
  await page.goto(`${BASE}/pos`);
  await page.getByTestId('pos-product-card').filter({ hasText: 'E2E Coffee' }).first().click();
  await page.getByRole('button', { name: 'Place Order' }).click();
  await expect(page.getByRole('button', { name: /^Confirm Payment/ })).toBeVisible();
}

test('checkout offers Cash and UPI by default and Card only when turned on', async ({
  page,
  request,
}) => {
  const before = await request.get(`${BASE}/api/settings/card_payments_enabled`, { headers });
  expect(before.ok()).toBeTruthy();
  const cardBefore = (await before.json())?.setting?.value ?? 'false';
  await request.put(`${BASE}/api/settings/card_payments_enabled`, {
    headers,
    data: { value: 'false' },
  });
  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${BASE}/auth/login`);
    await page.locator('#email').fill('owner@flo.local');
    await page.locator('#password').fill(E2E_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL(/\/(pos|orders)/, { timeout: 20000 });
    await setLanguage(page, 'en');

    await openPayment(page);
    const upi = page.getByRole('button', { name: 'UPI', exact: true });
    await expect(page.getByRole('button', { name: 'Cash', exact: true })).toBeVisible();
    await expect(upi).toBeVisible();
    await expect(upi.locator('svg'), 'UPI shows its icon').toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Card', exact: true })).toHaveCount(0);
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/1-payment-default.png` });

    await page.goto(`${BASE}/settings?tab=payments`);
    const cardToggle = page.getByTestId('card-payments-enabled');
    await expect(cardToggle).not.toBeChecked();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/2-settings.png` });
    await cardToggle.check();
    await expect
      .poll(async () => {
        const res = await request.get(`${BASE}/api/payment-methods`, { headers });
        return (await res.json()).card_enabled;
      })
      .toBe(true);

    await openPayment(page);
    await expect(page.getByRole('button', { name: 'Card', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'UPI', exact: true })).toBeVisible();
  } finally {
    await request.put(`${BASE}/api/settings/card_payments_enabled`, {
      headers,
      data: { value: cardBefore },
    });
  }
});
