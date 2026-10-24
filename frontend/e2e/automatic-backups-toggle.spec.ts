import { test, expect, type Page } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';

async function setupMockedSession(page: Page, puts: boolean[]): Promise<void> {
  let enabled = true;
  await page.addInitScript(() => {
    localStorage.setItem('token', 'automatic-backups-e2e-token');
  });
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (pathname === '/api/auth/me') {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          user: {
            id: 'e2e-owner',
            name: 'E2E Owner',
            email: 'owner@flo.local',
            role: 'owner',
            category_ids: [],
          },
          tenants: [
            {
              id: 1,
              business_name: 'E2E Cafe',
              role: 'owner',
              plan: 'free',
              status: 'active',
              business_type: 'restaurant',
              language: 'en',
            },
          ],
        }),
      });
      return;
    }
    if (pathname === '/api/db-tools/automatic-backups') {
      if (request.method() === 'PUT') {
        enabled = request.postDataJSON().enabled;
        puts.push(enabled);
      }
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ enabled }),
      });
      return;
    }
    await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
}

test('Settings -> Backup & Data turns all automatic backups off and back on', async ({ page }) => {
  const puts: boolean[] = [];
  await setupMockedSession(page, puts);

  await page.goto(`${BASE}/auth/login`);
  await page.waitForURL(/\/pos(?:\/|$)/, { timeout: 20000 });
  await page.goto(`${BASE}/settings?tab=data`);

  const card = page.getByTestId('automatic-backups-card');
  const toggle = card.getByRole('switch', { name: 'Automatic backups' });
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await expect(card).toContainText('Turn this off to stop them all.');

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await expect(card).toContainText('All scheduled backups are off');
  expect(puts).toEqual([false]);

  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  expect(puts).toEqual([false, true]);
});
