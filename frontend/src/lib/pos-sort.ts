import type { Category, Product } from '@/lib/types';
import {
  POS_CATEGORY_SORTS,
  POS_ITEM_SORTS,
  isPosCategorySort,
  isPosItemSort,
  type PosCategorySort,
  type PosItemSort,
} from '../../../shared/pos-sort';

export {
  POS_CATEGORY_SORTS,
  POS_ITEM_SORTS,
  isPosCategorySort,
  isPosItemSort,
  type PosCategorySort,
  type PosItemSort,
};

const nameCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' });

/** `saved` keeps the order the API returned (sort_order, then name). */
export function sortCategories(categories: Category[], sort: PosCategorySort): Category[] {
  if (sort !== 'name') return categories;
  return [...categories].sort((a, b) => nameCollator.compare(a.name, b.name));
}

export function sortProducts(products: Product[], sort: PosItemSort): Product[] {
  if (sort === 'saved') return products;
  const sorted = [...products];
  if (sort === 'name') return sorted.sort((a, b) => nameCollator.compare(a.name, b.name));
  const direction = sort === 'price_asc' ? 1 : -1;
  return sorted.sort(
    (a, b) =>
      direction * (Number(a.price) - Number(b.price)) || nameCollator.compare(a.name, b.name),
  );
}

/** Most added first; products added equally often keep the order they came in. */
export function sortByUses(products: Product[], uses: Record<string, number>): Product[] {
  return products
    .map((product, index) => ({ product, index, count: uses[String(product.id)] ?? 0 }))
    .sort((a, b) => b.count - a.count || a.index - b.index)
    .map((entry) => entry.product);
}

/** Products in the dragged order; ones never placed follow in the order they came in. */
export function sortByCustomOrder(products: Product[], order: string[]): Product[] {
  const position = new Map(order.map((id, index) => [id, index]));
  return products
    .map((product, index) => ({ product, index, at: position.get(String(product.id)) }))
    .sort((a, b) => {
      if (a.at === undefined && b.at === undefined) return a.index - b.index;
      if (a.at === undefined) return 1;
      if (b.at === undefined) return -1;
      return a.at - b.at;
    })
    .map((entry) => entry.product);
}

/**
 * Moves one card inside the cards on screen (a category section, a filter or a search) and
 * returns the whole order, so cards that were not on screen keep their places.
 */
export function moveWithinOrder(
  fullOrder: string[],
  visible: string[],
  from: number,
  to: number,
): string[] {
  if (from === to || from < 0 || to < 0 || from >= visible.length || to >= visible.length) {
    return fullOrder;
  }
  const moved = [...visible];
  const [card] = moved.splice(from, 1);
  moved.splice(to, 0, card);
  const onScreen = new Set(visible);
  let next = 0;
  return fullOrder.map((id) => (onScreen.has(id) ? moved[next++] : id));
}

export interface CategorySection {
  category: Category | null;
  products: Product[];
}

/** One section per category in category order, keeping each section's card order; no category last. */
export function groupByCategory(products: Product[], categories: Category[]): CategorySection[] {
  const known = new Set(categories.map((category) => category.id));
  const sections: CategorySection[] = categories
    .map((category) => ({
      category,
      products: products.filter((product) => product.category_id === category.id),
    }))
    .filter((section) => section.products.length > 0);
  const other = products.filter((product) => !known.has(product.category_id as Category['id']));
  if (other.length > 0) sections.push({ category: null, products: other });
  return sections;
}
