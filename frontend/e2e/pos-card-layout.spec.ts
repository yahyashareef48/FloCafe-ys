import { test, expect, type Page } from '@playwright/test';
import { E2E_BASE_URL as BASE } from './helpers/urls';

const PRODUCT_NAMES = [
  'Cappuccino',
  'Flat White',
  'Iced Caramel Latte',
  'Masala Chai',
  'Blueberry Muffin',
  'Chocolate Croissant',
];

const SHOT_DIR = process.env.POS_CARD_LAYOUT_SHOTS;

async function shot(page: Page, name: string) {
  if (!SHOT_DIR) return;
  // Lets color transitions settle so the capture shows the final state.
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOT_DIR}/${name}.png` });
}

async function seedCatalog(page: Page) {
  await page.setViewportSize({ width: 1366, height: 820 });
  await page.goto(`${BASE}/auth/login`);
  await page.locator('#email').fill('owner@flo.local');
  await page.locator('#password').fill('E2ePass123!');
  await page.locator('button[type="submit"]').click();
  await page.waitForURL(/\/pos/, { timeout: 20000 });
  const token = await page.evaluate(() => localStorage.getItem('token'));
  const headers = { Authorization: `Bearer ${token}` };
  const category = await page.request.post(`${BASE}/api/categories`, {
    headers,
    data: { name: 'Card Layout Cafe' },
  });
  expect(category.ok()).toBeTruthy();
  const categoryId = (await category.json()).category.id as string;
  const productIds: string[] = [];
  const cleanup = async () => {
    for (const id of productIds) {
      await page.request.delete(`${BASE}/api/products/${id}`, { headers }).catch(() => {});
    }
    await page.request.delete(`${BASE}/api/categories/${categoryId}`, { headers }).catch(() => {});
  };
  try {
    for (const [index, name] of PRODUCT_NAMES.entries()) {
      const response = await page.request.post(`${BASE}/api/products`, {
        headers,
        data: {
          name,
          category_id: categoryId,
          price: 3 + index,
          tax_category_id: null,
          tax_behavior: 'exempt',
        },
      });
      expect(response.status()).toBe(201);
      productIds.push((await response.json()).product.id);
    }
    await page.reload();
    await page.getByRole('button', { name: 'Card Layout Cafe' }).click();
    await expect(page.getByTestId('pos-product-card')).toHaveCount(PRODUCT_NAMES.length);
  } catch (error) {
    await cleanup();
    throw error;
  }
  return cleanup;
}

test('POS card layout sets cards per row, text size, and text-only cards per device', async ({
  page,
}) => {
  const cleanup = await seedCatalog(page);
  try {
    const cards = page.getByTestId('pos-product-card');
    await shot(page, '1-default');

    const rowWidth = async () => {
      const boxes = await cards.evaluateAll((elements) =>
        elements.map((element) => element.getBoundingClientRect().top),
      );
      return boxes.filter((top) => top === boxes[0]).length;
    };

    await page.getByTestId('pos-card-layout-button').click();
    const menu = page.getByTestId('pos-card-layout-menu');
    await expect(menu).toBeVisible();
    await menu.getByRole('button', { name: '3', exact: true }).click();
    await menu.getByRole('button', { name: 'Larger text' }).click();
    await menu.getByRole('button', { name: 'Larger text' }).click();
    await expect(menu.getByTestId('pos-card-text-size')).toHaveText('120%');
    await shot(page, '2-menu-3-per-row-120');
    expect(await rowWidth()).toBe(3);

    await menu.getByRole('switch', { name: 'Show pictures' }).click();
    await expect(page.getByTestId('pos-product-text-tile')).toHaveCount(PRODUCT_NAMES.length);
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    const nameSize = await page
      .getByTestId('pos-product-text-tile')
      .first()
      .locator('h3')
      .evaluate((element) => parseFloat(getComputedStyle(element).fontSize));
    expect(nameSize).toBeCloseTo(16 * 1.2, 0);
    await shot(page, '3-text-cards-3-per-row');

    await page.getByTestId('pos-card-layout-button').click();
    await menu.getByRole('button', { name: '6', exact: true }).click();
    await menu.getByRole('button', { name: 'Smaller text' }).click();
    await menu.getByRole('button', { name: 'Smaller text' }).click();
    await menu.getByRole('button', { name: 'Smaller text' }).click();
    await expect(menu.getByTestId('pos-card-text-size')).toHaveText('90%');
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    expect(await rowWidth()).toBe(6);
    await shot(page, '4-text-cards-6-per-row-90');

    await page.reload();
    await page.getByRole('button', { name: 'Card Layout Cafe' }).click();
    await expect(page.getByTestId('pos-product-text-tile')).toHaveCount(PRODUCT_NAMES.length);
    expect(await rowWidth()).toBe(6);

    await page.getByTestId('pos-card-layout-button').click();
    await menu.getByRole('button', { name: '8', exact: true }).click();
    for (let i = 0; i < 7; i++) await menu.getByRole('button', { name: 'Larger text' }).click();
    await expect(menu.getByTestId('pos-card-text-size')).toHaveText('160%');
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    const overflowing = await cards.evaluateAll((elements) =>
      elements.flatMap((card) => {
        const box = card.getBoundingClientRect();
        return [...card.querySelectorAll('h3, p')]
          .filter((text) => {
            const r = text.getBoundingClientRect();
            return r.left < box.left - 1 || r.right > box.right + 1;
          })
          .map((text) => text.textContent);
      }),
    );
    expect(overflowing, 'names and prices stay inside narrow cards').toEqual([]);

    await page.getByTestId('pos-card-layout-button').click();
    await menu.getByRole('button', { name: 'Auto' }).click();
    await menu.getByRole('switch', { name: 'Show pictures' }).click();
    await expect(page.getByTestId('pos-product-text-tile')).toHaveCount(0);
  } finally {
    await cleanup();
  }
});

test('POS card shape switches between square, rectangle, tall, and rows', async ({ page }) => {
  const cleanup = await seedCatalog(page);
  try {
    const cards = page.getByTestId('pos-product-card');
    const menu = page.getByTestId('pos-card-layout-menu');
    const pick = async (shape: string, closeMenu = true) => {
      await page.getByTestId('pos-card-layout-button').click();
      await expect(menu).toBeVisible();
      await menu.getByTestId(`pos-card-shape-${shape}`).click();
      await expect(menu.getByTestId(`pos-card-shape-${shape}`)).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      if (closeMenu) {
        await page.keyboard.press('Escape');
        await expect(menu).toBeHidden();
      }
      await expect(cards.first()).toHaveAttribute('data-shape', shape);
    };
    const pictureRatio = () =>
      cards
        .first()
        .locator('div.rounded-lg')
        .first()
        .evaluate((element) => {
          const box = element.getBoundingClientRect();
          return box.width / box.height;
        });

    await page.getByTestId('pos-card-layout-button').click();
    await menu.getByRole('button', { name: '4', exact: true }).click();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();

    await pick('rectangle', false);
    await shot(page, '5-menu-rectangle');
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    expect(await pictureRatio()).toBeCloseTo(4 / 3, 1);

    await pick('tall');
    expect(await pictureRatio()).toBeCloseTo(3 / 4, 1);
    await shot(page, '6-tall');

    await pick('square');
    expect(await pictureRatio()).toBeCloseTo(1, 1);

    await page.getByTestId('pos-card-layout-button').click();
    await menu.getByRole('button', { name: 'Auto' }).click();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await pick('rows');
    const rowLefts = await cards.evaluateAll((elements) =>
      elements.map((element) => Math.round(element.getBoundingClientRect().left)),
    );
    expect(new Set(rowLefts).size, 'rows stack in one column').toBe(1);
    await expect(cards.first()).toContainText('Blueberry Muffin');
    await shot(page, '7-rows');

    await page.reload();
    await page.getByRole('button', { name: 'Card Layout Cafe' }).click();
    await expect(cards.first()).toHaveAttribute('data-shape', 'rows');
    await pick('square');
  } finally {
    await cleanup();
  }
});
