/**
 * POS catalog sort: tenant setting normalisation (backend) and category/item ordering (frontend).
 */

import { strict as assert } from 'node:assert';
import { isPosCategorySort, isPosItemSort, readPosSortSettings } from '../main/lib/pos-sort';
import { sortCategories, sortProducts } from '../frontend/src/lib/pos-sort';
import { contrastWithWhite, nameToColor, tileLightness } from '../frontend/src/lib/image-utils';

const categories = [
  { id: 'c1', name: 'Mains' },
  { id: 'c2', name: 'Beverages' },
  { id: 'c3', name: 'desserts' },
] as any[];

const products = [
  { id: 'p1', name: 'Latte', price: 4.5 },
  { id: 'p2', name: 'Espresso', price: '3' },
  { id: 'p3', name: 'Cake', price: 4.5 },
  { id: 'p4', name: 'Item 10', price: 10 },
  { id: 'p5', name: 'Item 2', price: 10 },
] as any[];

const ids = (rows: { id: string }[]) => rows.map((r) => r.id).join(',');

assert.equal(isPosCategorySort('name'), true);
assert.equal(isPosCategorySort('price_asc'), false);
assert.equal(isPosItemSort('price_desc'), true);
assert.equal(isPosItemSort('alpha'), false);

assert.deepEqual(readPosSortSettings({}), { category_sort: 'saved', item_sort: 'saved' });
assert.deepEqual(readPosSortSettings({ pos_category_sort: 'name', pos_item_sort: 'price_asc' }), {
  category_sort: 'name',
  item_sort: 'price_asc',
});
assert.deepEqual(readPosSortSettings({ pos_category_sort: 'bogus', pos_item_sort: 'x' }), {
  category_sort: 'saved',
  item_sort: 'saved',
});

assert.equal(ids(sortCategories(categories, 'saved')), 'c1,c2,c3', 'saved keeps API order');
assert.equal(ids(sortCategories(categories, 'name')), 'c2,c3,c1', 'name is case-insensitive');

assert.equal(sortProducts(products, 'saved'), products, 'saved returns the input untouched');
assert.equal(ids(sortProducts(products, 'name')), 'p3,p2,p5,p4,p1', 'name is natural-numeric');
assert.equal(ids(sortProducts(products, 'price_asc')), 'p2,p3,p1,p5,p4', 'price asc, name ties');
assert.equal(ids(sortProducts(products, 'price_desc')), 'p5,p4,p3,p1,p2', 'price desc, name ties');
assert.equal(ids(products), 'p1,p2,p3,p4,p5', 'input array is not mutated');

// Per-device card order: most used, dragged order, moves inside a section, category sections.
{
  const {
    sortByUses,
    sortByCustomOrder,
    moveWithinOrder,
    groupByCategory,
  } = require('../frontend/src/lib/pos-sort');
  const items = [
    { id: 'a', name: 'Tea', category_id: 'drinks' },
    { id: 'b', name: 'Coffee', category_id: 'drinks' },
    { id: 'c', name: 'Samosa', category_id: 'snacks' },
    { id: 'd', name: 'Puff', category_id: 'snacks' },
    { id: 'e', name: 'Water', category_id: null },
  ] as any[];
  const cats = [
    { id: 'snacks', name: 'Snacks' },
    { id: 'drinks', name: 'Drinks' },
  ] as any[];

  assert.equal(
    ids(sortByUses(items, { c: 5, a: 2, d: 2 })),
    'c,a,d,b,e',
    'most used first, ties keep catalog order',
  );
  assert.equal(ids(sortByUses(items, {})), 'a,b,c,d,e', 'no uses keeps catalog order');

  assert.equal(
    ids(sortByCustomOrder(items, ['d', 'a'])),
    'd,a,b,c,e',
    'dragged cards first, the rest in catalog order',
  );
  assert.equal(
    ids(sortByCustomOrder(items, ['zz', 'b'])),
    'b,a,c,d,e',
    'ids of deleted products are ignored',
  );

  const full = ['a', 'b', 'c', 'd', 'e'];
  assert.deepEqual(
    moveWithinOrder(full, ['c', 'd'], 1, 0),
    ['a', 'b', 'd', 'c', 'e'],
    'a move inside a section keeps other cards in place',
  );
  assert.deepEqual(
    moveWithinOrder(full, full, 0, 4),
    ['b', 'c', 'd', 'e', 'a'],
    'a move across the whole grid',
  );
  assert.deepEqual(
    moveWithinOrder(full, ['c', 'd'], 0, 5),
    full,
    'an out-of-range move changes nothing',
  );

  const sections = groupByCategory(items, cats);
  assert.deepEqual(
    sections.map((section: any) => `${section.category?.id ?? 'other'}:${ids(section.products)}`),
    ['snacks:c,d', 'drinks:a,b', 'other:e'],
    'sections follow category order with products without a category last',
  );
  assert.equal(groupByCategory([], cats).length, 0, 'empty categories get no section');
}
{
  // Product tiles without a picture carry their name in white on a colour picked from the name.
  for (let hue = 0; hue < 360; hue += 1) {
    const contrast = contrastWithWhite(hue, 55, tileLightness(hue));
    assert.ok(
      contrast >= 4.5,
      `white text on hue ${hue} meets WCAG AA (got ${contrast.toFixed(2)})`,
    );
  }
  assert.ok(contrastWithWhite(90, 45, 65) < 2, 'the contrast check rejects a pale tile');
  assert.equal(nameToColor('Lemon Soda'), nameToColor('Lemon Soda'), 'a name keeps its colour');
  assert.match(nameToColor('Cola'), /^hsl\(\d+, 55%, \d+%\)$/, 'tile colours are opaque HSL');
}
console.log('pos-catalog-sort: all assertions passed');
