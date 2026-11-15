'use client';

import { Suspense, useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { ArrowLeft, Search, TrendingUp } from 'lucide-react';
import { useTranslations } from 'use-intl';
import api from '@/lib/api';
import { useAuthStore } from '@/store/auth';
import { tenantCan } from '@/lib/permissions';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { businessDateForInstant } from '@shared/business-date';

interface ProductSale {
  product_id: number | string;
  product_name: string;
  total_quantity: number;
  total_revenue: number;
  order_count: number;
  cost_status?: 'known' | 'partial' | 'unknown';
  ingredient_cost?: number | null;
  profit?: number | null;
  margin_percent?: number | null;
}

type SortKey = 'quantity' | 'revenue';

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_PATTERN = /^\d{4}-\d{2}$/;
const ALL_PRODUCTS_LIMIT = 1000;

function getMonthRange(month: string): { startDate: string; endDate: string } {
  const [year, monthNumber] = month.split('-').map(Number);
  const lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
  return { startDate: `${month}-01`, endDate: `${month}-${String(lastDay).padStart(2, '0')}` };
}

function ProductSalesContent() {
  const t = useTranslations('dashboard');
  const tCommon = useTranslations('common');
  const router = useRouter();
  const searchParams = useSearchParams();
  const { currentTenant } = useAuthStore();
  const fmt = useFormatCurrency();
  const isOwner = tenantCan(currentTenant, 'dashboard.view');
  const canViewFinancials = tenantCan(currentTenant, 'reports.financial.view');

  const [openedAt] = useState(() => new Date());
  const todayLocal = businessDateForInstant({
    instant: openedAt,
    timezone: currentTenant?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
    startTime: currentTenant?.business_day_start_time || '00:00',
  });
  const monthParam = searchParams.get('month');
  const dateParam = searchParams.get('date');
  const periodMode: 'day' | 'month' =
    monthParam && MONTH_PATTERN.test(monthParam) ? 'month' : 'day';
  const selectedMonth = periodMode === 'month' ? (monthParam as string) : todayLocal.slice(0, 7);
  const selectedDate = dateParam && DATE_PATTERN.test(dateParam) ? dateParam : todayLocal;
  const range =
    periodMode === 'month'
      ? getMonthRange(selectedMonth)
      : { startDate: selectedDate, endDate: selectedDate };

  const [products, setProducts] = useState<ProductSale[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState('');
  const [sortKey, setSortKey] = useState<SortKey>('quantity');

  useEffect(() => {
    if (currentTenant && !isOwner) router.replace('/pos');
  }, [currentTenant, isOwner, router]);

  const rangeKey = `${range.startDate}:${range.endDate}`;
  const [loadedKey, setLoadedKey] = useState(rangeKey);
  if (rangeKey !== loadedKey) {
    setLoadedKey(rangeKey);
    setLoading(true);
  }

  useEffect(() => {
    if (!isOwner) return;
    const controller = new AbortController();
    api
      .get('/reports/topProducts', {
        params: {
          start_date: range.startDate,
          end_date: range.endDate,
          limit: ALL_PRODUCTS_LIMIT,
        },
        signal: controller.signal,
      })
      .then((res) => setProducts(res.data.topProducts || []))
      .catch((err: unknown) => {
        if (err instanceof Error && (err.name === 'CanceledError' || err.name === 'AbortError'))
          return;
        setProducts([]);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [isOwner, range.startDate, range.endDate]);

  const totals = useMemo(
    () =>
      products.reduce(
        (acc, p) => ({
          quantity: acc.quantity + Number(p.total_quantity || 0),
          revenue: acc.revenue + Number(p.total_revenue || 0),
        }),
        { quantity: 0, revenue: 0 },
      ),
    [products],
  );

  const visibleProducts = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const filtered = needle
      ? products.filter((p) => p.product_name.toLowerCase().includes(needle))
      : products;
    return [...filtered].sort((a, b) =>
      sortKey === 'revenue'
        ? Number(b.total_revenue) - Number(a.total_revenue)
        : Number(b.total_quantity) - Number(a.total_quantity),
    );
  }, [products, query, sortKey]);

  const setPeriod = (next: { date?: string; month?: string }) => {
    const params = new URLSearchParams();
    if (next.month) params.set('month', next.month);
    else if (next.date) params.set('date', next.date);
    router.replace(`/dashboard/products?${params.toString()}`, { scroll: false });
  };

  if (!isOwner) return null;

  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4 md:p-6">
      <div className="flex flex-wrap items-center gap-3">
        <Link
          href="/dashboard"
          className="flex size-10 items-center justify-center rounded-xl border border-border bg-card text-foreground shadow-sm hover:bg-muted"
          aria-label={tCommon('back')}
        >
          <ArrowLeft size={18} className="rtl-flip" />
        </Link>
        <h1 className="flex-1 text-xl font-semibold text-foreground">
          {periodMode === 'month'
            ? t('topProductsMonth')
            : selectedDate === todayLocal
              ? t('topProductsToday')
              : t('topProducts')}
        </h1>
        <div className="flex h-10 rounded-xl border border-border bg-card p-1 shadow-sm">
          {(['day', 'month'] as const).map((mode) => (
            <button
              key={mode}
              type="button"
              onClick={() =>
                setPeriod(mode === 'month' ? { month: selectedMonth } : { date: todayLocal })
              }
              className={`min-w-16 rounded-lg px-3 text-sm font-medium transition-colors ${periodMode === mode ? 'bg-foreground text-background shadow-sm' : 'text-muted-foreground hover:bg-muted'}`}
              aria-pressed={periodMode === mode}
            >
              {t(mode)}
            </button>
          ))}
        </div>
        {periodMode === 'month' ? (
          <input
            type="month"
            value={selectedMonth}
            max={todayLocal.slice(0, 7)}
            onChange={(e) =>
              MONTH_PATTERN.test(e.target.value) && setPeriod({ month: e.target.value })
            }
            className="h-10 rounded-xl border border-border bg-card px-3 text-sm shadow-sm"
          />
        ) : (
          <input
            type="date"
            value={selectedDate}
            max={todayLocal}
            onChange={(e) =>
              DATE_PATTERN.test(e.target.value) && setPeriod({ date: e.target.value })
            }
            className="h-10 rounded-xl border border-border bg-card px-3 text-sm shadow-sm"
          />
        )}
      </div>

      <div className="rounded-2xl border border-border bg-card px-5 py-4 shadow-sm">
        <p className="text-sm text-muted-foreground">
          {t('productSalesTotals', {
            products: products.length,
            quantity: totals.quantity,
          })}
        </p>
        <p className="text-2xl font-semibold text-foreground">{fmt(totals.revenue)}</p>
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <div className="relative min-w-48 flex-1">
          <Search
            size={16}
            className="pointer-events-none absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('productSalesSearch')}
            className="h-10 w-full rounded-xl border border-border bg-card ps-9 pe-3 text-sm shadow-sm outline-none focus:ring-2 focus:ring-brand"
          />
        </div>
        <div className="flex h-10 rounded-xl border border-border bg-card p-1 shadow-sm">
          {(['quantity', 'revenue'] as const).map((key) => (
            <button
              key={key}
              type="button"
              onClick={() => setSortKey(key)}
              className={`rounded-lg px-3 text-sm font-medium transition-colors ${sortKey === key ? 'bg-foreground text-background shadow-sm' : 'text-muted-foreground hover:bg-muted'}`}
              aria-pressed={sortKey === key}
            >
              {key === 'quantity' ? t('productSalesSortQuantity') : t('productSalesSortRevenue')}
            </button>
          ))}
        </div>
      </div>

      <div className="overflow-hidden rounded-2xl border border-border bg-card shadow-sm">
        {loading ? (
          <p className="px-5 py-10 text-center text-sm text-muted-foreground">
            {tCommon('loading')}
          </p>
        ) : visibleProducts.length === 0 ? (
          <div className="flex min-h-48 flex-col items-center justify-center px-6 py-10 text-center">
            <span className="mb-3 flex size-12 items-center justify-center rounded-2xl bg-muted text-muted-foreground">
              <TrendingUp size={23} />
            </span>
            <p className="text-sm font-medium text-foreground">{t('productSalesEmpty')}</p>
          </div>
        ) : (
          <div className="divide-y divide-border">
            {visibleProducts.map((product, index) => {
              const revenue = Number(product.total_revenue || 0);
              const share = totals.revenue > 0 ? Math.round((revenue / totals.revenue) * 100) : 0;
              return (
                <div
                  key={product.product_id}
                  className="flex items-center justify-between gap-3 px-5 py-3"
                >
                  <div className="flex min-w-0 items-center gap-3">
                    <span className="w-6 shrink-0 text-end text-sm text-muted-foreground">
                      {index + 1}
                    </span>
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="text-sm font-medium text-foreground">
                          {product.product_name}
                        </span>
                        {canViewFinancials && product.cost_status === 'partial' && (
                          <span className="rounded-full bg-amber-100 px-2 py-0.5 text-[11px] font-medium text-amber-800 dark:bg-amber-950/60 dark:text-amber-300">
                            {t('partialCost')}
                          </span>
                        )}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {t('productSoldOrders', {
                          quantity: product.total_quantity,
                          orders: product.order_count,
                        })}
                      </p>
                      {canViewFinancials && product.cost_status && (
                        <p className="text-xs text-muted-foreground">
                          {product.cost_status === 'unknown' ||
                          product.ingredient_cost === null ||
                          product.ingredient_cost === undefined ? (
                            t('costUnknown')
                          ) : (
                            <>
                              {t('ingredientCostLabel', {
                                amount: fmt(Number(product.ingredient_cost)),
                              })}
                              {product.profit !== null && product.profit !== undefined && (
                                <>
                                  {' · '}
                                  {t('profitMarginLabel', {
                                    profit: fmt(Number(product.profit)),
                                    margin:
                                      product.margin_percent !== null &&
                                      product.margin_percent !== undefined
                                        ? `${product.margin_percent}%`
                                        : '—',
                                  })}
                                </>
                              )}
                            </>
                          )}
                        </p>
                      )}
                    </div>
                  </div>
                  <div className="shrink-0 text-end">
                    <span className="text-sm font-semibold text-foreground">{fmt(revenue)}</span>
                    <div className="text-xs text-muted-foreground">
                      {t('productSalesShare', { percent: `${share}%` })}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

export default function ProductSalesPage() {
  return (
    <Suspense fallback={null}>
      <ProductSalesContent />
    </Suspense>
  );
}
