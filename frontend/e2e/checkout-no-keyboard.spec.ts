import { test, expect } from '@playwright/test';
import { E2E_PASSWORD, setLanguage } from './helpers/test-auth';
import { E2E_BASE_URL as BASE } from './helpers/urls';

/**
 * On a touch-only tablet the checkout amount fields must never open the system keyboard: Android
 * ignores `inputMode="none"` on number fields, so they are read-only there and the on-screen
 * number pad fills them.
 */
test.use({ hasTouch: true, viewport: { width: 1340, height: 800 } });

test('checkout amounts on a touch tablet take the number pad, not the keyboard', async ({
  page,
}) => {
  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('manager@flo.local');
  await page.locator('#password').fill(E2E_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await page.waitForURL('**/pos/**', { timeout: 20000 });
  await setLanguage(page, 'en');

  await page.getByRole('button', { name: 'Takeaway' }).click();
  await page.getByTestId('pos-product-card').first().click();
  await expect(page.getByTestId('cart-item').first()).toBeVisible({ timeout: 5000 });
  await page.locator('body').click({ position: { x: 10, y: 10 } });
  await page.keyboard.press('F4');

  const checkout = page.getByTestId('prepaid-checkout-modal');
  await expect(checkout).toBeVisible({ timeout: 5000 });
  const amounts = checkout.locator('input[inputmode="none"]');
  await expect(amounts.first()).toBeVisible();
  const count = await amounts.count();
  expect(count).toBeGreaterThan(0);
  for (let index = 0; index < count; index += 1) {
    await expect(amounts.nth(index), 'no keyboard on any amount field').toHaveAttribute(
      'readonly',
      '',
    );
  }

  const cash = amounts.first();
  await cash.tap();
  await expect(cash).toBeFocused();
  const pad = checkout.getByRole('button', { name: '7', exact: true });
  await pad.tap();
  await expect(cash).toHaveValue(/7/);
});
