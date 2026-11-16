'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Minus,
  Plus,
  Search,
  Trash2,
  Undo2,
} from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import { Button } from '@/components/ui/button';
import AddonModal from '@/components/pos/AddonModal';
import api from '@/lib/api';
import { getCurrencyFractionDigits } from '@countries';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { usePrinterStore } from '@/hooks/usePrinter';
import { checkoutPaymentMethods, type CustomPaymentMethod } from '@/lib/payment-methods';
import type { Addon, Order, OrderItem, Product, ProductVariant, Staff } from '@/lib/types';
import { useAuthStore } from '@/store/auth';

interface EditOrderModalProps {
  order: Order;
  onClose: () => void;
  onSaved: (result: { deleted: boolean }) => void;
}

interface PaymentLine {
  method: string;
  payment_method_id?: number | null;
  amount: number;
}

interface EditResult {
  deleted: boolean;
  version: string;
  order_total: number;
  bill_total: number | null;
  paid_amount: number;
  payments_must_match_total: boolean;
  payments: PaymentLine[];
  kitchen_items: OrderItem[];
}

interface ExistingLine {
  item: OrderItem;
  quantity: number;
  removed: boolean;
}

interface AddedLine {
  key: string;
  product: Product;
  variant: ProductVariant | null;
  addons: Addon[];
  quantity: number;
  special_instructions: string;
}

interface PaymentRow {
  key: string;
  label: string;
  method: string;
  payment_method_id: number | null;
  amount: string;
  locked: boolean;
}

const TERMINAL_STATUSES = new Set(['cancelled', 'voided', 'void_adjustment', 'refunded']);

function paymentKey(line: { method: string; payment_method_id?: number | null }): string {
  return line.payment_method_id
    ? `custom:${Number(line.payment_method_id)}`
    : `builtin:${line.method.toLowerCase()}`;
}

function newKey(): string {
  return typeof globalThis.crypto?.randomUUID === 'function'
    ? globalThis.crypto.randomUUID()
    : `line-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function errorMessage(error: unknown): string | null {
  const data = (error as { response?: { data?: { error?: unknown } } })?.response?.data;
  return typeof data?.error === 'string' ? data.error : null;
}

/**
 * Corrects an order entered wrongly: remove or re-count lines, add items, and re-split what was
 * paid between cash, UPI and the other methods. The backend prices every change; the owner's
 * staff PIN approves the save.
 */
export default function EditOrderModal({ order, onClose, onSaved }: EditOrderModalProps) {
  const t = useTranslations('orders');
  const tCommon = useTranslations('common');
  const tPos = useTranslations('pos');
  const fmt = useFormatCurrency();
  const user = useAuthStore((state) => state.user);
  const currentTenant = useAuthStore((state) => state.currentTenant);
  const decimals = getCurrencyFractionDigits(currentTenant?.currency || '');
  const minorFactor = 10 ** decimals;
  const toMinor = useCallback((value: number) => Math.round(value * minorFactor), [minorFactor]);
  const { printKot } = usePrinterStore();

  const [lines, setLines] = useState<ExistingLine[] | null>(null);
  const [added, setAdded] = useState<AddedLine[]>([]);
  const [sendToKitchen, setSendToKitchen] = useState(true);
  const [initial, setInitial] = useState<EditResult | null>(null);
  const [preview, setPreview] = useState<EditResult | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [rows, setRows] = useState<PaymentRow[]>([]);
  const [paymentsTouched, setPaymentsTouched] = useState(false);
  const [products, setProducts] = useState<Product[] | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [addonProduct, setAddonProduct] = useState<Product | null>(null);
  const [owners, setOwners] = useState<Staff[] | null>(null);
  const [ownerId, setOwnerId] = useState('');
  const [pin, setPin] = useState('');
  const [kotEnabled, setKotEnabled] = useState(false);
  const [saving, setSaving] = useState(false);
  const [loadError, setLoadError] = useState(false);

  const itemsPayload = useMemo(() => {
    if (!lines) return null;
    return [
      ...lines
        .filter((line) => !line.removed)
        .map((line) => ({ id: line.item.id, quantity: line.quantity })),
      ...added.map((line) => ({
        product_id: line.product.id,
        variant_id: line.variant?.id ?? null,
        quantity: line.quantity,
        addons:
          line.addons.length > 0
            ? line.addons.map((addon) => ({
                id: addon.id,
                name: addon.name,
                price: addon.price,
                quantity: addon.quantity || 1,
              }))
            : null,
        special_instructions: line.special_instructions || null,
      })),
    ];
  }, [lines, added]);

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      api.get(`/orders/${order.id}`),
      api.get('/payment-methods').catch(() => ({ data: {} })),
      api.get('/settings/kot_printing_enabled').catch(() => ({ data: {} })),
    ])
      .then(async ([orderRes, methodsRes, kotRes]) => {
        if (cancelled) return;
        const fresh = (orderRes.data?.order ?? orderRes.data) as Order;
        const active = (fresh.items ?? []).filter((item) => !TERMINAL_STATUSES.has(item.status));
        const startLines = active.map((item) => ({
          item,
          quantity: Number(item.quantity),
          removed: false,
        }));
        const firstPreview = await api.post(`/orders/${order.id}/edit`, {
          preview: true,
          items: active.map((item) => ({ id: item.id, quantity: Number(item.quantity) })),
        });
        if (cancelled) return;
        const result = firstPreview.data as EditResult;
        setLines(startLines);
        setInitial(result);
        setPreview(result);
        setKotEnabled(kotRes.data?.setting?.value !== 'false');

        const customMethods: CustomPaymentMethod[] = methodsRes.data?.payment_methods ?? [];
        const amounts = new Map<string, number>();
        for (const line of result.payments) {
          const key = paymentKey(line);
          amounts.set(key, (amounts.get(key) ?? 0) + toMinor(Number(line.amount) || 0));
        }
        const startRows: PaymentRow[] = [
          ...checkoutPaymentMethods(methodsRes.data?.card_enabled === true).map((method) => ({
            key: `builtin:${method.key}`,
            label: tPos(method.labelKey.replace('pos.', '') as 'methodCash'),
            method: method.key,
            payment_method_id: null,
            amount: '',
            locked: false,
          })),
          ...customMethods.map((method) => ({
            key: `custom:${method.id}`,
            label: method.name,
            method: 'custom',
            payment_method_id: method.id,
            amount: '',
            locked: false,
          })),
        ];
        for (const line of result.payments) {
          const key = paymentKey(line);
          if (startRows.some((row) => row.key === key)) continue;
          startRows.push({
            key,
            label: key === 'builtin:wallet' ? t('editOrderLoyalty') : line.method,
            method: line.payment_method_id ? 'custom' : line.method,
            payment_method_id: line.payment_method_id ?? null,
            amount: '',
            locked: key === 'builtin:wallet',
          });
        }
        setRows(
          startRows.map((row) => {
            const minor = amounts.get(row.key) ?? 0;
            return { ...row, amount: minor > 0 ? String(minor / minorFactor) : '' };
          }),
        );
      })
      .catch((error) => {
        if (cancelled) return;
        toast.error(errorMessage(error) ?? t('editOrderFailed'));
        setLoadError(true);
      });
    api
      .get('/staff/approvers')
      .then((res) => {
        if (cancelled) return;
        const staff: Staff[] = res.data?.approvers ?? res.data?.staff ?? [];
        const ownerList = staff.filter((member) => member.role === 'owner');
        const preferred =
          ownerList.find((member) => String(member.id) === String(user?.id)) ??
          (ownerList.length === 1 ? ownerList[0] : undefined);
        setOwners(ownerList);
        setOwnerId(preferred ? String(preferred.id) : '');
      })
      .catch(() => {
        if (!cancelled) setOwners([]);
      });
    return () => {
      cancelled = true;
    };
    // Loaded once per opened order.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [order.id]);

  const previewSeq = useRef(0);
  useEffect(() => {
    if (!initial || !itemsPayload) return;
    const seq = ++previewSeq.current;
    setPreviewing(true);
    const timer = setTimeout(() => {
      api
        .post(`/orders/${order.id}/edit`, {
          preview: true,
          items: itemsPayload,
          send_to_kitchen: sendToKitchen,
        })
        .then((res) => {
          if (seq !== previewSeq.current) return;
          setPreview(res.data as EditResult);
          setPreviewError(null);
        })
        .catch((error) => {
          if (seq !== previewSeq.current) return;
          setPreviewError(errorMessage(error) ?? t('editOrderFailed'));
        })
        .finally(() => {
          if (seq === previewSeq.current) setPreviewing(false);
        });
    }, 250);
    return () => clearTimeout(timer);
  }, [initial, itemsPayload, sendToKitchen, order.id, t]);

  const tookMoney = !!initial && (initial.payments_must_match_total || initial.paid_amount > 0);
  const newTotal = preview ? (preview.bill_total ?? preview.order_total) : 0;
  const newTotalMinor = toMinor(newTotal);
  const paidMinor = rows.reduce((sum, row) => sum + toMinor(Number(row.amount) || 0), 0);
  const allRemoved = !!itemsPayload && itemsPayload.length === 0;
  const mustMatch = !!initial?.payments_must_match_total;

  // While the cashier has not touched the split, a bill paid one way keeps being paid that way.
  useEffect(() => {
    if (!preview || !tookMoney || paymentsTouched || allRemoved) return;
    const paidRows = rows.filter((row) => toMinor(Number(row.amount) || 0) > 0);
    if (paidRows.length !== 1 || paidRows[0].locked || !mustMatch) return;
    const others = paidMinor - toMinor(Number(paidRows[0].amount) || 0);
    const next = Math.max(0, newTotalMinor - others) / minorFactor;
    if (Number(paidRows[0].amount) === next) return;
    setRows((current) =>
      current.map((row) => (row.key === paidRows[0].key ? { ...row, amount: String(next) } : row)),
    );
    // Only a new total should move the amounts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newTotalMinor]);

  const itemsChanged =
    !!lines &&
    (added.length > 0 ||
      lines.some((line) => line.removed || line.quantity !== Number(line.item.quantity)));
  const paymentsChanged = useMemo(() => {
    if (!initial) return false;
    const before = new Map<string, number>();
    for (const line of initial.payments) {
      const key = paymentKey(line);
      before.set(key, (before.get(key) ?? 0) + toMinor(Number(line.amount) || 0));
    }
    return rows.some((row) => (before.get(row.key) ?? 0) !== toMinor(Number(row.amount) || 0));
  }, [initial, rows, toMinor]);

  const difference = newTotalMinor - toMinor(initial?.paid_amount ?? 0);
  const remainder = newTotalMinor - paidMinor;
  // Edit re-splits money already taken; on a part-paid bill more money goes through Take payment.
  const capMinor = mustMatch
    ? newTotalMinor
    : Math.min(newTotalMinor, toMinor(initial?.paid_amount ?? 0));
  const overCap = paidMinor - capMinor;
  const paymentsOk = !tookMoney || allRemoved || (mustMatch ? remainder === 0 : overCap <= 0);
  const selectedOwner = owners?.find((member) => String(member.id) === ownerId);
  const canSave =
    !saving &&
    !previewing &&
    !previewError &&
    !!initial &&
    (itemsChanged || paymentsChanged) &&
    paymentsOk &&
    !!selectedOwner &&
    pin.length >= 4;
  const hasKitchenWork =
    added.length > 0 ||
    !!lines?.some((line) => !line.removed && line.quantity > Number(line.item.quantity));

  const setQuantity = (index: number, quantity: number) => {
    if (quantity < 1) return;
    setLines((current) =>
      current ? current.map((line, i) => (i === index ? { ...line, quantity } : line)) : current,
    );
  };
  const toggleRemoved = (index: number) => {
    setLines((current) =>
      current
        ? current.map((line, i) =>
            i === index
              ? { ...line, removed: !line.removed, quantity: Number(line.item.quantity) }
              : line,
          )
        : current,
    );
  };

  const openPicker = () => {
    setPickerOpen(true);
    if (products !== null) return;
    api
      .get('/products', { params: { active: 1, per_page: 200 } })
      .then(({ data }) => setProducts(data.products || []))
      .catch(() => {
        setProducts([]);
        toast.error(t('menuLoadFailed'));
      });
  };
  const pickProduct = (product: Product) => {
    if ((product.addon_groups || []).length > 0 || (product.variants || []).length > 0) {
      setAddonProduct(product);
      return;
    }
    setAdded((current) => {
      const same = current.find(
        (line) => line.product.id === product.id && !line.variant && line.addons.length === 0,
      );
      if (same) {
        return current.map((line) =>
          line === same ? { ...line, quantity: line.quantity + 1 } : line,
        );
      }
      return [
        ...current,
        {
          key: newKey(),
          product,
          variant: null,
          addons: [],
          quantity: 1,
          special_instructions: '',
        },
      ];
    });
  };

  const setRowAmount = (key: string, value: string) => {
    setPaymentsTouched(true);
    setRows((current) => current.map((row) => (row.key === key ? { ...row, amount: value } : row)));
  };
  const putRest = (key: string) => {
    const others = rows
      .filter((row) => row.key !== key)
      .reduce((sum, row) => sum + toMinor(Number(row.amount) || 0), 0);
    setRowAmount(key, String(Math.max(0, capMinor - others) / minorFactor));
  };

  const save = async () => {
    if (!canSave || !initial || !itemsPayload) return;
    setSaving(true);
    try {
      const { data } = await api.post(`/orders/${order.id}/edit`, {
        expected_version: initial.version,
        items: itemsPayload,
        send_to_kitchen: sendToKitchen,
        ...(tookMoney && !allRemoved
          ? {
              payments: rows.map((row) => ({
                method: row.method,
                ...(row.payment_method_id ? { payment_method_id: row.payment_method_id } : {}),
                amount: toMinor(Number(row.amount) || 0) / minorFactor,
              })),
            }
          : {}),
        approver_id: ownerId,
        override_pin: pin,
      });
      const result = data as EditResult;
      toast.success(result.deleted ? t('orderDeleted') : t('editOrderSaved'));
      if (!result.deleted && sendToKitchen && kotEnabled && result.kitchen_items.length > 0) {
        printKot(order, { items: result.kitchen_items }).catch(() =>
          toast.error(tPos('kotPrintFailed')),
        );
      }
      onSaved({ deleted: result.deleted });
    } catch (error) {
      const status = (error as { response?: { status?: number } })?.response?.status;
      if (status === 403) toast.error(t('deleteOrderWrongPin'));
      else if (status === 409 && /changed after you opened/.test(errorMessage(error) ?? ''))
        toast.error(t('editOrderChanged'));
      else toast.error(errorMessage(error) ?? t('editOrderFailed'));
      setPin('');
    } finally {
      setSaving(false);
    }
  };

  const filteredProducts = (products ?? []).filter(
    (product) => !search || product.name.toLowerCase().includes(search.toLowerCase()),
  );

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="editOrderTitle"
        className="bg-card rounded-xl shadow-xl w-full max-w-2xl mx-4 max-h-[92vh] flex flex-col"
      >
        <div className="px-5 pt-5 pb-3 border-b border-border">
          <h2 id="editOrderTitle" className="text-lg font-bold text-foreground">
            {t('editOrderTitle', { number: order.order_number })}
          </h2>
          <p className="text-sm text-muted-foreground">{t('editOrderHint')}</p>
        </div>

        <div className="flex-1 overflow-y-auto px-5 py-4 space-y-5">
          {!lines && !loadError && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 size={14} className="animate-spin" />
              {t('editOrderCalculating')}
            </div>
          )}

          {lines && (
            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase text-muted-foreground">
                {t('editOrderItems')}
              </h3>
              {lines.map((line, index) => (
                <div
                  key={line.item.id}
                  data-testid="edit-order-line"
                  className={`flex items-center gap-2 rounded-lg border border-border p-2 ${line.removed ? 'opacity-60' : ''}`}
                >
                  <div className="flex-1 min-w-0">
                    <span
                      className={`block truncate text-sm font-medium text-foreground ${line.removed ? 'line-through' : ''}`}
                    >
                      {line.item.variant_selection?.name
                        ? `${line.item.product_name} (${line.item.variant_selection.name})`
                        : line.item.product_name}
                    </span>
                    {(line.item.addons ?? []).length > 0 && (
                      <span className="block truncate text-xs text-muted-foreground">
                        {(line.item.addons ?? []).map((addon) => addon.name).join(', ')}
                      </span>
                    )}
                    <span className="text-xs text-muted-foreground">
                      {fmt(Number(line.item.unit_price))}
                      {line.removed ? ` · ${t('editOrderRemoved')}` : ''}
                    </span>
                  </div>
                  {!line.removed && (
                    <div className="flex items-center gap-1">
                      <Button
                        variant="outline"
                        size="icon"
                        className="size-9"
                        aria-label={t('editOrderLess', { name: line.item.product_name })}
                        onClick={() => setQuantity(index, line.quantity - 1)}
                        disabled={line.quantity <= 1}
                      >
                        <Minus size={14} />
                      </Button>
                      <span
                        className="w-8 text-center text-sm font-semibold"
                        data-testid="edit-order-qty"
                      >
                        {line.quantity}
                      </span>
                      <Button
                        variant="outline"
                        size="icon"
                        className="size-9"
                        aria-label={t('editOrderMore', { name: line.item.product_name })}
                        onClick={() => setQuantity(index, line.quantity + 1)}
                      >
                        <Plus size={14} />
                      </Button>
                    </div>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    className={`size-9 ${line.removed ? '' : 'text-red-500 hover:text-red-600'}`}
                    aria-label={
                      line.removed
                        ? `${t('editOrderUndo')} ${line.item.product_name}`
                        : `${tCommon('remove')} ${line.item.product_name}`
                    }
                    onClick={() => toggleRemoved(index)}
                  >
                    {line.removed ? <Undo2 size={15} /> : <Trash2 size={15} />}
                  </Button>
                </div>
              ))}

              {added.map((line) => (
                <div
                  key={line.key}
                  className="flex items-center gap-2 rounded-lg border border-green-300 bg-green-50/60 p-2 dark:border-green-800/50 dark:bg-green-950/30"
                >
                  <div className="flex-1 min-w-0">
                    <span className="block truncate text-sm font-medium text-foreground">
                      {line.variant
                        ? `${line.product.name} (${line.variant.name})`
                        : line.product.name}
                      <span className="ms-2 rounded bg-green-600 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-white">
                        {t('editOrderNew')}
                      </span>
                    </span>
                    {line.addons.length > 0 && (
                      <span className="block truncate text-xs text-muted-foreground">
                        {line.addons.map((addon) => addon.name).join(', ')}
                      </span>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="outline"
                      size="icon"
                      className="size-9"
                      aria-label={t('editOrderLess', { name: line.product.name })}
                      onClick={() =>
                        setAdded((current) =>
                          current.map((entry) =>
                            entry.key === line.key && entry.quantity > 1
                              ? { ...entry, quantity: entry.quantity - 1 }
                              : entry,
                          ),
                        )
                      }
                      disabled={line.quantity <= 1}
                    >
                      <Minus size={14} />
                    </Button>
                    <span className="w-8 text-center text-sm font-semibold">{line.quantity}</span>
                    <Button
                      variant="outline"
                      size="icon"
                      className="size-9"
                      aria-label={t('editOrderMore', { name: line.product.name })}
                      onClick={() =>
                        setAdded((current) =>
                          current.map((entry) =>
                            entry.key === line.key
                              ? { ...entry, quantity: entry.quantity + 1 }
                              : entry,
                          ),
                        )
                      }
                    >
                      <Plus size={14} />
                    </Button>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="size-9 text-red-500 hover:text-red-600"
                    aria-label={`${tCommon('remove')} ${line.product.name}`}
                    onClick={() =>
                      setAdded((current) => current.filter((entry) => entry.key !== line.key))
                    }
                  >
                    <Trash2 size={15} />
                  </Button>
                </div>
              ))}

              {!pickerOpen ? (
                <Button variant="outline" size="sm" onClick={openPicker}>
                  <Plus size={14} className="me-1.5" />
                  {t('editOrderAddItem')}
                </Button>
              ) : (
                <div className="rounded-lg border border-border">
                  <div className="relative border-b border-border">
                    <Search
                      size={15}
                      className="absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground"
                    />
                    <input
                      type="text"
                      autoFocus
                      placeholder={t('searchMenu')}
                      value={search}
                      onChange={(e) => setSearch(e.target.value)}
                      className="w-full bg-transparent ps-9 pe-3 py-2 text-sm outline-none"
                    />
                  </div>
                  <div className="max-h-48 overflow-y-auto">
                    {products === null && (
                      <div className="flex items-center gap-2 px-3 py-3 text-sm text-muted-foreground">
                        <Loader2 size={14} className="animate-spin" />
                      </div>
                    )}
                    {filteredProducts.map((product) => (
                      <button
                        key={product.id}
                        type="button"
                        onClick={() => pickProduct(product)}
                        className="flex w-full items-center justify-between border-b border-border/50 px-3 py-2 text-start last:border-0 hover:bg-muted"
                      >
                        <span className="text-sm font-medium text-foreground">{product.name}</span>
                        <span className="flex items-center gap-2 text-xs text-muted-foreground">
                          {product.price ? fmt(Number(product.price)) : null}
                          <Plus size={14} className="text-green-600" />
                        </span>
                      </button>
                    ))}
                    {products !== null && filteredProducts.length === 0 && (
                      <div className="px-3 py-3 text-center text-sm text-muted-foreground">
                        {t('noItemsFound')}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {hasKitchenWork && (
                <label className="flex items-center gap-2 pt-1 text-sm text-foreground">
                  <input
                    type="checkbox"
                    checked={sendToKitchen}
                    onChange={(e) => setSendToKitchen(e.target.checked)}
                    className="size-4"
                  />
                  {t('editOrderSendToKitchen')}
                </label>
              )}
            </section>
          )}

          {allRemoved && (
            <p className="flex items-start gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-800 dark:border-red-900/50 dark:bg-red-950/40 dark:text-red-200">
              <AlertTriangle size={16} className="mt-0.5 shrink-0" />
              {t('editOrderAllRemoved')}
            </p>
          )}

          {previewError && (
            <p
              role="alert"
              className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900 dark:border-amber-800/50 dark:bg-amber-950/40 dark:text-amber-100"
            >
              {previewError}
            </p>
          )}

          {initial && !allRemoved && (
            <section className="rounded-lg bg-muted/50 p-3 text-sm space-y-1">
              <div className="flex justify-between text-muted-foreground">
                <span>{t('editOrderWasTotal')}</span>
                <span>{fmt(initial.bill_total ?? initial.order_total)}</span>
              </div>
              <div className="flex justify-between font-semibold text-foreground">
                <span>{t('editOrderNewTotal')}</span>
                <span data-testid="edit-order-new-total">
                  {previewing ? (
                    <Loader2 size={14} className="inline animate-spin" />
                  ) : (
                    fmt(newTotal)
                  )}
                </span>
              </div>
              {tookMoney && (
                <div className="flex justify-between text-muted-foreground">
                  <span>{t('editOrderPaid')}</span>
                  <span>{fmt(initial.paid_amount)}</span>
                </div>
              )}
              {mustMatch && difference > 0 && (
                <p className="font-medium text-amber-700 dark:text-amber-300">
                  {t('editOrderCollectMore', { amount: fmt(difference / minorFactor) })}
                </p>
              )}
              {mustMatch && difference < 0 && (
                <p className="font-medium text-amber-700 dark:text-amber-300">
                  {t('editOrderGiveBack', { amount: fmt(-difference / minorFactor) })}
                </p>
              )}
            </section>
          )}

          {tookMoney && !allRemoved && rows.length > 0 && (
            <section className="space-y-2">
              <h3 className="text-xs font-semibold uppercase text-muted-foreground">
                {t('editOrderPayments')}
              </h3>
              {rows.map((row) => (
                <div key={row.key} className="flex items-center gap-2">
                  <label
                    htmlFor={`edit-pay-${row.key}`}
                    className="w-28 shrink-0 truncate text-sm font-medium text-foreground"
                  >
                    {row.label}
                  </label>
                  <input
                    id={`edit-pay-${row.key}`}
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    value={row.amount}
                    disabled={row.locked || saving}
                    placeholder="0"
                    onChange={(e) =>
                      setRowAmount(row.key, e.target.value.replace(/[^\d.]/g, '').slice(0, 12))
                    }
                    className="min-h-10 w-full rounded-lg border border-border bg-background px-3 py-2 text-end text-sm"
                  />
                  {!row.locked && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="shrink-0"
                      onClick={() => putRest(row.key)}
                      disabled={saving}
                    >
                      {t('editOrderUseRest')}
                    </Button>
                  )}
                </div>
              ))}
              <p
                data-testid="edit-order-payment-status"
                className={`flex items-center gap-1.5 text-sm font-medium ${
                  paymentsOk
                    ? 'text-green-700 dark:text-green-400'
                    : 'text-amber-700 dark:text-amber-300'
                }`}
              >
                {paymentsOk ? <CheckCircle2 size={15} /> : <AlertTriangle size={15} />}
                {remainder < 0
                  ? t('editOrderTooMuch', { amount: fmt(-remainder / minorFactor) })
                  : overCap > 0
                    ? t('editOrderTakePayment', { amount: fmt(overCap / minorFactor) })
                    : remainder === 0
                      ? t('editOrderBalanced')
                      : mustMatch
                        ? t('editOrderToAssign', { amount: fmt(remainder / minorFactor) })
                        : t('editOrderStaysDue', { amount: fmt(remainder / minorFactor) })}
              </p>
            </section>
          )}

          {owners !== null && owners.length === 0 && (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              {t('deleteOrderNoOwnerPin')}
            </p>
          )}
          {owners !== null && owners.length > 0 && (
            <section className="grid gap-3 sm:grid-cols-2">
              {owners.length > 1 ? (
                <div>
                  <label
                    htmlFor="editOrderOwner"
                    className="mb-1 block text-sm font-medium text-foreground"
                  >
                    {t('deleteOrderOwnerLabel')}
                  </label>
                  <select
                    id="editOrderOwner"
                    value={ownerId}
                    onChange={(e) => {
                      setOwnerId(e.target.value);
                      setPin('');
                    }}
                    disabled={saving}
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                  >
                    <option value="" />
                    {owners.map((member) => (
                      <option key={member.id} value={member.id}>
                        {member.name}
                      </option>
                    ))}
                  </select>
                </div>
              ) : (
                <p className="self-end text-sm text-muted-foreground">
                  {t('deleteOrderOwnerLabel')}:{' '}
                  <span className="font-medium text-foreground">{owners[0].name}</span>
                </p>
              )}
              <div>
                <label
                  htmlFor="editOrderPin"
                  className="mb-1 block text-sm font-medium text-foreground"
                >
                  {t('deleteOrderPinLabel')}
                </label>
                <input
                  id="editOrderPin"
                  type="password"
                  inputMode="numeric"
                  autoComplete="off"
                  value={pin}
                  maxLength={6}
                  onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') save();
                  }}
                  disabled={saving}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
                />
              </div>
            </section>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-3">
          {initial && !itemsChanged && !paymentsChanged && (
            <span className="me-auto text-xs text-muted-foreground">{t('editOrderNoChanges')}</span>
          )}
          <Button variant="outline" size="sm" onClick={onClose} disabled={saving}>
            {tCommon('cancel')}
          </Button>
          <Button
            size="sm"
            variant={allRemoved ? 'destructive' : 'default'}
            onClick={save}
            disabled={!canSave}
          >
            {saving ? <Loader2 size={14} className="me-1.5 animate-spin" /> : null}
            {saving ? t('editOrderSaving') : allRemoved ? t('deleteOrder') : t('editOrderSave')}
          </Button>
        </div>
      </div>

      {addonProduct && (
        <AddonModal
          product={addonProduct}
          currency={currentTenant?.currency || 'USD'}
          onlinePlatformSelected={Boolean(order.online_platform)}
          onAdd={(product, quantity, addons, instructions, variant) => {
            setAdded((current) => [
              ...current,
              {
                key: newKey(),
                product,
                variant,
                addons,
                quantity,
                special_instructions: instructions,
              },
            ]);
            setAddonProduct(null);
          }}
          onClose={() => setAddonProduct(null)}
        />
      )}
    </div>
  );
}
