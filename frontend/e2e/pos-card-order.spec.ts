import { test, expect, type Page } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';
import { E2E_PASSWORD, getE2eToken, setLanguage } from './helpers/test-auth';

/**
 * POS card order: cards can follow how often they are used, be grouped under their category, and
 * be dragged into an order the POS keeps after a reload.
 */
const SHOTS = process.env.POS_CARD_ORDER_SHOTS;

async function shot(page: Page, name: string): Promise<void> {
  if (SHOTS) await page.screenshot({ path: `${SHOTS}/${name}.png` });
}

test('POS cards sort by use, group by category and keep a dragged order', async ({
  page,
  request,
}) => {
  test.setTimeout(120_000);
  const headers = {
    Authorization: `Bearer ${getE2eToken()}`,
    'Content-Type': 'application/json',
  };
  const suffix = Math.random().toString(36).slice(2, 6).toUpperCase();
  const seed: Record<string, string[]> = {
    [`Drinks ${suffix}`]: [`Chai ${suffix}`, `Kahwa ${suffix}`, `Lassi ${suffix}`],
    [`Snacks ${suffix}`]: [`Samosa ${suffix}`, `Pakora ${suffix}`, `Vada ${suffix}`],
  };
  const names: string[] = [];
  const productIds: string[] = [];
  const categoryIds: string[] = [];
  for (const [categoryName, products] of Object.entries(seed)) {
    const category = await request.post(`${BASE}/api/categories`, {
      headers,
      data: { name: categoryName },
    });
    expect(category.status()).toBe(201);
    const categoryId = (await category.json()).category.id as string;
    categoryIds.push(categoryId);
    for (const name of products) {
      const product = await request.post(`${BASE}/api/products`, {
        headers,
        data: { name, category_id: categoryId, price: 20 },
      });
      expect(product.status()).toBe(201);
      productIds.push((await product.json()).product.id as string);
      names.push(name);
    }
  }

  try {
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.goto(`${BASE}/auth/login`);
    await page.locator('#email').fill('owner@flo.local');
    await page.locator('#password').fill(E2E_PASSWORD);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL('**/pos/**', { timeout: 20000 });
    await setLanguage(page, 'en');
    await page.goto(`${BASE}/pos`);
    await page.getByTestId('pos-product-search').fill(suffix);

    const cards = page.getByTestId('pos-product-card');
    const ours = async () =>
      (await cards.allInnerTexts())
        .map((text) => names.find((name) => text.includes(name)))
        .filter((name): name is string => Boolean(name));
    await expect(cards).toHaveCount(6);
    const storeOrder = await ours();
    await shot(page, '1-default');

    const openMenu = async () => {
      await page.getByTestId('pos-card-layout-button').click();
      await expect(page.getByTestId('pos-card-layout-menu')).toBeVisible();
    };
    const closeMenu = async () => {
      await page.keyboard.press('Escape');
      await expect(page.getByTestId('pos-card-layout-menu')).toHaveCount(0);
    };

    // 1. Most used first.
    const vada = cards.filter({ hasText: `Vada ${suffix}` });
    const pakora = cards.filter({ hasText: `Pakora ${suffix}` });
    for (let i = 0; i < 3; i += 1) await vada.click();
    await pakora.click();
    await openMenu();
    await page.getByTestId('pos-card-order-popular').click();
    await expect(page.getByTestId('pos-card-order-popular')).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await page.mouse.move(0, 0);
    await page.waitForTimeout(300);
    await shot(page, '2-menu');
    await closeMenu();
    await expect
      .poll(ours)
      .toEqual([
        `Vada ${suffix}`,
        `Pakora ${suffix}`,
        ...storeOrder.filter((name) => !name.startsWith('Vada') && !name.startsWith('Pakora')),
      ]);
    await shot(page, '3-most-used');

    // 2. Grouped under category names.
    await openMenu();
    await page.getByRole('switch', { name: 'Group by category' }).click();
    await closeMenu();
    const titles = page.getByTestId('pos-category-section-title');
    await expect(titles.filter({ hasText: `Drinks ${suffix}` })).toBeVisible();
    await expect(titles.filter({ hasText: `Snacks ${suffix}` })).toBeVisible();
    const snacks = page
      .getByTestId('pos-category-section')
      .filter({ has: titles.filter({ hasText: `Snacks ${suffix}` }) });
    await expect(snacks.getByTestId('pos-product-card').first()).toContainText(`Vada ${suffix}`);
    await shot(page, '4-grouped');

    // 3. Drag a card to a new place.
    await openMenu();
    await page.getByTestId('pos-arrange-cards').click();
    await expect(page.getByTestId('pos-arrange-banner')).toBeVisible();
    await expect(page.getByTestId('pos-card-layout-menu')).toHaveCount(0);
    const before = await ours();
    expect(before.slice(3, 5), 'arranging starts from the order on screen').toEqual([
      `Vada ${suffix}`,
      `Pakora ${suffix}`,
    ]);
    const drinks = page
      .getByTestId('pos-category-section')
      .filter({ has: titles.filter({ hasText: `Drinks ${suffix}` }) });
    const drinkCards = drinks.getByTestId('pos-arrange-card');
    const first = await drinkCards.nth(0).boundingBox();
    const last = await drinkCards.nth(2).boundingBox();
    if (!first || !last) throw new Error('cards are not on screen');
    await page.mouse.move(last.x + last.width / 2, last.y + last.height / 2);
    await page.mouse.down();
    await page.mouse.move(last.x + last.width / 2 - 10, last.y + last.height / 2, { steps: 5 });
    await page.mouse.move(first.x + 10, first.y + first.height / 2, { steps: 20 });
    await page.waitForTimeout(300);
    await shot(page, '5-dragging');
    await page.mouse.up();
    const drinkNames = before.filter((name) => seed[`Drinks ${suffix}`].includes(name));
    const moved = drinkNames[2];
    await expect
      .poll(async () => (await ours()).filter((name) => drinkNames.includes(name)))
      .toEqual([moved, drinkNames[0], drinkNames[1]]);
    await shot(page, '6-arranged');
    await page.getByTestId('pos-arrange-done').click();
    await expect(page.getByTestId('pos-arrange-banner')).toHaveCount(0);
    const arranged = await ours();
    await openMenu();
    await expect(page.getByTestId('pos-card-order-custom')).toHaveAttribute('aria-pressed', 'true');
    await closeMenu();

    // The order stays after a reload.
    await page.reload();
    await page.getByTestId('pos-product-search').fill(suffix);
    await expect(cards).toHaveCount(6);
    await expect.poll(ours).toEqual(arranged);
    await shot(page, '7-after-reload');
  } finally {
    for (const id of productIds) await request.delete(`${BASE}/api/products/${id}`, { headers });
    for (const id of categoryIds) await request.delete(`${BASE}/api/categories/${id}`, { headers });
  }
});
