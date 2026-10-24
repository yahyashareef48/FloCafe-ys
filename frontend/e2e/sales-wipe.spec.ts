import { test, expect, type Page, type Route } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';

const OWNER = {
  user: { id: 'e2e-owner', name: 'E2E Owner', email: 'owner@flo.local', role: 'owner', category_ids: [] },
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
};

const json = (route: Route, body: unknown) =>
  route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

async function mockApi(page: Page, handle: (route: Route, pathname: string) => Promise<boolean>) {
  await page.addInitScript(() => {
    localStorage.setItem('token', 'sales-wipe-e2e-token');
  });
  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (pathname === '/api/auth/me') return json(route, OWNER);
    if (await handle(route, pathname)) return;
    await json(route, {});
  });
}

test('Settings -> Backup & Data turns the shift and day close data wipes on separately', async ({
  page,
}) => {
  const puts: unknown[] = [];
  let settings = { dayClose: false, shiftClose: false };
  await mockApi(page, async (route, pathname) => {
    if (pathname !== '/api/db-tools/sales-wipe') return false;
    if (route.request().method() === 'PUT') {
      const change = route.request().postDataJSON();
      puts.push(change);
      settings = { ...settings, ...change };
    }
    await json(route, settings);
    return true;
  });

  await page.goto(`${BASE}/auth/login`);
  await page.waitForURL(/\/pos(?:\/|$)/, { timeout: 20000 });
  await page.goto(`${BASE}/settings?tab=data`);

  const card = page.getByTestId('sales-wipe-card');
  const shift = card.getByRole('switch', { name: 'Wipe after shift close' });
  const day = card.getByRole('switch', { name: 'Wipe after day close' });
  await expect(shift).toHaveAttribute('aria-checked', 'false');
  await expect(day).toHaveAttribute('aria-checked', 'false');

  await shift.click();
  await expect(shift).toHaveAttribute('aria-checked', 'true');
  await expect(day).toHaveAttribute('aria-checked', 'false');
  expect(puts).toEqual([{ shiftClose: true }]);
});

test('closing a shift with the wipe on asks for confirmation before wiping', async ({ page }) => {
  const confirms: unknown[] = [];
  let shiftOpen = true;
  const session = {
    id: 7,
    opened_by: 'e2e-owner',
    opened_by_name: 'E2E Owner',
    opened_at: '2026-10-24T08:00:00.000Z',
    opening_float_cents: 0,
    status: 'open',
    expected_cash_cents: 0,
  };
  await mockApi(page, async (route, pathname) => {
    if (pathname === '/api/cash-sessions/current') {
      await json(route, shiftOpen ? session : null);
      return true;
    }
    if (pathname === '/api/cash-sessions/current/close-preview') {
      await json(route, {
        expected_cash_cents: 0,
        unpaid_in_shift: { count: 0, bill_count: 0, pending_cents: 0, sample: [] },
      });
      return true;
    }
    if (pathname === '/api/cash-sessions/7/close') {
      shiftOpen = false;
      await json(route, {
        ...session,
        status: 'closed',
        closure_id: 42,
        expected_cash_cents: 0,
        counted_cash_cents: 0,
        variance_cents: 0,
        sales_wipe_pending: true,
      });
      return true;
    }
    if (pathname === '/api/cash-closures/sales-wipe/pending') {
      await json(route, { pending: { trigger: 'shift', closureId: 42 } });
      return true;
    }
    if (pathname === '/api/cash-closures/sales-wipe/confirm') {
      confirms.push(route.request().postDataJSON());
      await json(route, { success: true });
      return true;
    }
    return false;
  });

  await page.goto(`${BASE}/auth/login`);
  await page.waitForURL(/\/pos(?:\/|$)/, { timeout: 20000 });
  await page.getByRole('button', { name: /close shift/i }).first().click();
  await page.locator('#shift-counted-cash').fill('0');
  await page.locator('button').filter({ hasText: /close shift/i }).last().click();

  const finish = page.getByTestId('sales-wipe-finish');
  await expect(finish).toBeVisible();
  await finish.click();

  const confirm = page.getByTestId('sales-wipe-confirm');
  await expect(confirm).toContainText('This cannot be undone.');
  expect(confirms).toEqual([]);
  await confirm.getByRole('button', { name: 'Wipe now' }).click();
  await expect.poll(() => confirms).toEqual([{ closure_id: 42 }]);
});
