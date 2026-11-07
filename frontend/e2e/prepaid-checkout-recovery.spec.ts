import {
  test,
  expect,
  request as playwrightRequest,
  type APIRequestContext,
  type Page,
  type Request,
} from '@playwright/test';
import { E2E_PASSWORD, getE2eToken, setLanguage } from './helpers/test-auth';
import { E2E_BASE_URL as BASE } from './helpers/urls';

/**
 * Prepaid POS checkout must always be able to finish: a fully discounted cart
 * settles at zero, and a saved retry whose order or bill is gone never locks
 * the cart.
 */
const managerHeaders = {
  Authorization: `Bearer ${getE2eToken('e2e-manager', 'manager@flo.local', 'manager')}`,
};
const ownerHeaders = {
  Authorization: `Bearer ${getE2eToken('e2e-owner', 'owner@flo.local', 'owner')}`,
  'Content-Type': 'application/json',
};
const OWNER_PIN = '1111';
const paymentsPath = /^\/api\/bills\/[^/]+\/payments$/;

let originalDiscountSettings: Record<string, unknown> = {};

test.beforeEach(async ({ request }) => {
  const res = await request.get(`${BASE}/api/settings/discount`, { headers: managerHeaders });
  expect(res.ok()).toBeTruthy();
  originalDiscountSettings = await res.json();
  const update = await request.put(`${BASE}/api/settings/discount`, {
    headers: managerHeaders,
    data: {
      discount_mode: 'both',
      discount_requires_approval: false,
      discount_max_percentage: 100,
    },
  });
  expect(update.ok()).toBeTruthy();
});

test.afterEach(async () => {
  const cleanup = await playwrightRequest.newContext();
  await cleanup.put(`${BASE}/api/settings/discount`, {
    headers: managerHeaders,
    data: originalDiscountSettings,
  });
  await cleanup.dispose();
});

async function chooseMethodForFullDue(page: Page, method: string): Promise<void> {
  await page.getByRole('button', { name: method, exact: true }).click();
  await page.getByRole('button', { name: 'Exact due' }).click();
}

async function openPos(page: Page): Promise<void> {
  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('manager@flo.local');
  await page.locator('#password').fill(E2E_PASSWORD);
  await page.locator('button[type="submit"]').click();
  await setLanguage(page, 'en');
  await page.goto(`${BASE}/pos`);
}

function countRequests(page: Page) {
  const counts = { orders: 0, payments: 0 };
  page.on('request', (req: Request) => {
    const path = new URL(req.url()).pathname;
    if (req.method() === 'POST' && path === '/api/orders') counts.orders += 1;
    if (req.method() === 'POST' && paymentsPath.test(path)) counts.payments += 1;
  });
  return counts;
}

/** Places the cart and makes its payment response fail without an outcome, leaving a saved retry with an order and a bill. */
async function failFirstPayment(page: Page): Promise<{ orderId: number; billId: number }> {
  await page.getByTestId('pos-product-card').click();
  await page.getByRole('button', { name: 'Place Order' }).click();
  await chooseMethodForFullDue(page, 'Cash');
  await page.route(
    (url) => paymentsPath.test(url.pathname),
    (route) => route.fulfill({ status: 500, contentType: 'application/json', body: '{}' }),
    { times: 1 },
  );
  const orderResponse = page.waitForResponse(
    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/orders',
  );
  const billResponse = page.waitForResponse(
    (r) => r.request().method() === 'POST' && new URL(r.url()).pathname === '/api/bills/generate',
  );
  await page.getByRole('button', { name: 'Confirm Payment · ฿64.20' }).click();
  const orderId = (await (await orderResponse).json()).order.id;
  const billId = (await (await billResponse).json()).bill.id;
  await expect(page.getByText('Failed to process order')).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss' }).click();
  return { orderId, billId };
}

async function payCartAndExpectPaid(page: Page, label: string): Promise<{ billId: number }> {
  await page.getByRole('button', { name: 'Place Order' }).click();
  const confirm = page.getByRole('button', { name: label });
  await expect(confirm).toBeVisible();
  await chooseMethodForFullDue(page, 'Cash');
  const paymentResponse = page.waitForResponse(
    (r) => r.request().method() === 'POST' && paymentsPath.test(new URL(r.url()).pathname),
  );
  await confirm.click();
  const payment = await paymentResponse;
  expect(payment.status()).toBe(200);
  const body = await payment.json();
  expect(body.bill.payment_status).toBe('paid');
  await expect(page.getByText(/Order #ORD-\d+-\d+ paid!/)).toBeVisible();
  return { billId: body.bill.id };
}

async function orderStatus(
  request: APIRequestContext,
  orderId: number,
  headers: Record<string, string>,
): Promise<number> {
  return (await request.get(`${BASE}/api/orders/${orderId}`, { headers })).status();
}

test('a 100% discount settles the prepaid order at zero', async ({ page }) => {
  await openPos(page);
  await page.getByTestId('pos-product-card').click();
  await page.getByRole('button', { name: 'Place Order' }).click();
  await page.getByRole('button', { name: 'Discounts' }).click();
  await page.locator('input[placeholder="0"]').fill('100');
  const confirm = page.getByRole('button', { name: 'Confirm Payment · ฿0.00' });
  await expect(confirm).toBeEnabled();

  const paymentRequest = page.waitForRequest(
    (r) => r.method() === 'POST' && paymentsPath.test(new URL(r.url()).pathname),
  );
  const paymentResponse = page.waitForResponse(
    (r) => r.request().method() === 'POST' && paymentsPath.test(new URL(r.url()).pathname),
  );
  await confirm.click();
  expect((await paymentRequest).postDataJSON().payments).toEqual([{ method: 'cash', amount: 0 }]);
  const payment = await paymentResponse;
  expect(payment.status()).toBe(200);
  const body = await payment.json();
  expect(body.bill.total).toBe(0);
  expect(body.bill.paid_amount).toBe(0);
  expect(body.bill.payment_status).toBe('paid');
  await expect(page.getByText(/Order #ORD-\d+-\d+ paid!/)).toBeVisible();
});

test('a deleted order no longer locks the cart that created it', async ({ page, request }) => {
  const pinRes = await request.put(`${BASE}/api/staff/e2e-owner`, {
    headers: ownerHeaders,
    data: { pin: OWNER_PIN },
  });
  expect(pinRes.ok()).toBeTruthy();
  await openPos(page);
  const counts = countRequests(page);
  const { orderId } = await failFirstPayment(page);

  const deleted = await request.delete(`${BASE}/api/orders/${orderId}`, {
    headers: { ...managerHeaders, 'Content-Type': 'application/json' },
    data: { override_pin: OWNER_PIN, approver_id: 'e2e-owner' },
  });
  expect(deleted.ok(), `deleting the order (got ${deleted.status()})`).toBeTruthy();
  expect(await orderStatus(request, orderId, managerHeaders)).toBe(404);

  await payCartAndExpectPaid(page, 'Confirm Payment · ฿64.20');
  expect(counts.orders).toBe(2);
});

test('a cancelled order no longer locks the cart that created it', async ({ page, request }) => {
  await openPos(page);
  const counts = countRequests(page);
  const { orderId } = await failFirstPayment(page);

  const cancelled = await request.patch(`${BASE}/api/orders/${orderId}/status`, {
    headers: { ...managerHeaders, 'Content-Type': 'application/json' },
    data: { status: 'cancelled', reason: 'e2e stuck retry' },
  });
  expect(cancelled.ok(), `cancelling the order (got ${cancelled.status()})`).toBeTruthy();

  await payCartAndExpectPaid(page, 'Confirm Payment · ฿64.20');
  expect(counts.orders).toBe(2);
});

test('a missing bill on a live order is rebuilt instead of locking checkout', async ({ page }) => {
  await openPos(page);
  const counts = countRequests(page);
  const { billId } = await failFirstPayment(page);

  await page.route(
    (url) => url.pathname === `/api/bills/${billId}`,
    (route) =>
      route.request().method() === 'GET'
        ? route.fulfill({
            status: 404,
            contentType: 'application/json',
            body: '{"error":"Bill not found"}',
          })
        : route.continue(),
    { times: 1 },
  );

  const paid = await payCartAndExpectPaid(page, 'Confirm Payment · ฿64.20');
  expect(paid.billId).toBe(billId);
  expect(counts.orders).toBe(1);
});

test('an unreadable saved payment on an unpaid bill is replaced, not locked', async ({ page }) => {
  await openPos(page);
  const counts = countRequests(page);
  const { billId } = await failFirstPayment(page);

  const rewritten = await page.evaluate(() => {
    let count = 0;
    for (const store of [localStorage, sessionStorage]) {
      const key = Object.keys(store).find((k) => k.startsWith('flo.prepaid.checkout.attempt'));
      if (!key) continue;
      const attempt = JSON.parse(store.getItem(key) || '{}');
      if (!attempt.bill || !attempt.paymentFingerprint) continue;
      attempt.paymentFingerprint = JSON.stringify({ payments: [], customer_id: null });
      store.setItem(key, JSON.stringify(attempt));
      count += 1;
    }
    return count > 0;
  });
  expect(rewritten).toBe(true);
  await page.reload();
  const placeOrder = page.getByRole('button', { name: 'Place Order' });
  await expect(placeOrder).toBeVisible();
  if (await placeOrder.isDisabled()) await page.getByTestId('pos-product-card').click();

  const paid = await payCartAndExpectPaid(page, 'Confirm Payment · ฿64.20');
  expect(paid.billId).toBe(billId);
  expect(counts.orders).toBe(1);
});

test('removing the discount after a rejected payment charges the full price', async ({
  page,
  request,
}, testInfo) => {
  const cardEnabled = await request.get(`${BASE}/api/settings/card_payments_enabled`, {
    headers: managerHeaders,
  });
  const originalCardEnabled = (await cardEnabled.json())?.setting?.value ?? 'false';
  const cardRef = await request.get(`${BASE}/api/settings/card_transaction_id_required`, {
    headers: managerHeaders,
  });
  const originalCardRef = (await cardRef.json())?.setting?.value === 'true';
  const cleanup = await playwrightRequest.newContext();
  try {
    await request.put(`${BASE}/api/settings/card_payments_enabled`, {
      headers: managerHeaders,
      data: { value: 'true' },
    });
    await request.put(`${BASE}/api/settings/card_transaction_id_required`, {
      headers: managerHeaders,
      data: { value: false },
    });
    await openPos(page);
    const counts = countRequests(page);
    await page.getByTestId('pos-product-card').click();
    await page.getByRole('button', { name: 'Place Order' }).click();
    await page.getByRole('button', { name: 'Discounts' }).click();
    await page.locator('input[placeholder="0"]').fill('10');
    await chooseMethodForFullDue(page, 'Card');
    await request.put(`${BASE}/api/settings/card_transaction_id_required`, {
      headers: managerHeaders,
      data: { value: true },
    });
    const rejected = page.waitForResponse(
      (r) => r.request().method() === 'POST' && paymentsPath.test(new URL(r.url()).pathname),
    );
    await page.getByRole('button', { name: 'Confirm Payment · ฿57.78' }).click();
    expect((await rejected).status()).toBe(400);
    await page.getByRole('button', { name: 'Dismiss' }).click();

    await page.getByRole('button', { name: 'Place Order' }).click();
    await expect(page.getByRole('button', { name: 'Confirm Payment · ฿57.78' })).toBeVisible();
    await page.locator('input[placeholder="0"]').fill('');
    await chooseMethodForFullDue(page, 'Card');
    await page
      .getByLabel('Terminal transaction number')
      .fill(`TXN-NODISC-${Date.now()}-${testInfo.retry}`);
    const paymentResponse = page.waitForResponse(
      (r) => r.request().method() === 'POST' && paymentsPath.test(new URL(r.url()).pathname),
    );
    await page.getByRole('button', { name: 'Confirm Payment · ฿64.20' }).click();
    const payment = await paymentResponse;
    expect(payment.status()).toBe(200);
    const body = await payment.json();
    expect(body.bill.total).toBe(64.2);
    expect(body.bill.payment_status).toBe('paid');
    expect(counts.orders).toBe(1);
    await expect(page.getByText(/Order #ORD-\d+-\d+ paid!/)).toBeVisible();
  } finally {
    await cleanup.put(`${BASE}/api/settings/card_transaction_id_required`, {
      headers: managerHeaders,
      data: { value: originalCardRef },
    });
    await cleanup.put(`${BASE}/api/settings/card_payments_enabled`, {
      headers: managerHeaders,
      data: { value: originalCardEnabled },
    });
    await cleanup.dispose();
  }
});
