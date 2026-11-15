'use client';

import { useState, useEffect, useMemo, useRef } from 'react';
import {
  X,
  Sparkles,
  ArrowLeftRight,
  CheckCircle2,
  Percent,
  Wallet,
  ChevronDown,
  QrCode,
} from 'lucide-react';
import UpiQrDialog, { UpiQrPanel } from '@/components/pos/UpiQrDialog';
import { useIsMobile } from '@/hooks/use-mobile';
import { Button } from '@/components/ui/button';
import api from '@/lib/api';
import { useCartStore } from '@/store/cart';
import { chargesForOrderType, useChargesStore } from '@/store/charges';
import { useAuthStore } from '@/store/auth';
import { useTaxPreview } from '@/hooks/use-tax-preview';
import { useTranslations, type AppConfig } from 'use-intl';
import TaxBreakdown from '@/components/pos/TaxBreakdown';
import toast from 'react-hot-toast';
import {
  PAYMENT_METHODS,
  checkoutPaymentMethods,
  customPaymentMethodIcon,
  isUpiMethodName,
  type CustomPaymentMethod,
} from '@/lib/payment-methods';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';
import { useFormatNumber } from '@/hooks/useFormatNumber';
import { useCurrencyUnitAdapter } from '@/hooks/useCurrencyUnitAdapter';
import { getCountryByCode, getCurrencyMinorUnitFactor } from '@/lib/countries';
import { getDiscountInputStep, normalizeFixedDiscountValue } from '@/lib/currency-input';
import { CurrencyTouchNumberPad } from '@/components/pos/TouchNumberPad';
import {
  defaultDiscountTypeForMode,
  isDiscountTypeAllowed,
  normalizeDiscountMode,
  type DiscountMode,
  type DiscountType,
} from '@/lib/discount-settings';
import { ApproverSelect } from '@/components/ApproverSelect';
import { useManagerApprovers } from '@/hooks/useManagerApprovers';

interface LoyaltySettings {
  loyalty_enabled: boolean;
}

export interface PrepaidPayment {
  method: string;
  payment_method_id?: number;
  amount: number;
  transaction_id?: string;
}

export interface PrepaidDiscount {
  type: DiscountType;
  value: number;
  reason?: string;
  override_pin?: string;
  approver_id?: string;
}

interface Props {
  currency: string;
  initialCardTransactionIdRequired?: boolean;
  initialDiscount?: PrepaidDiscount | null;
  discountCommitted?: boolean;
  onClose: () => void;
  onConfirm: (
    payments: PrepaidPayment[],
    walletAmount: number,
    discount: PrepaidDiscount | null,
  ) => void;
}

// Loyalty points are 1:1 with currency units. Must match LOYALTY_REDEMPTION_RATE in main/routes/bills.ts.
const LOYALTY_REDEMPTION_RATE = 1;

type PosKey = keyof AppConfig['Messages']['pos'];

type OrderType = 'dine_in' | 'takeaway' | 'delivery' | 'online';

// Exhaustively typed lookup for the order-type suffix (no template-literal keys).
const ORDER_TYPE_SUFFIX_KEYS = {
  dine_in: 'orderTypeSuffix_dine_in',
  takeaway: 'orderTypeSuffix_takeaway',
  delivery: 'orderTypeSuffix_delivery',
  online: 'orderTypeSuffix_online',
} as const satisfies Record<OrderType, PosKey>;

// Built-in payment method label keys mapped to typed `pos` leaf keys.
const BUILT_IN_PAYMENT_KEYS = {
  cash: 'methodCash',
  card: 'methodCard',
} as const satisfies Record<'cash' | 'card', PosKey>;

interface Payment {
  method: string;
  payment_method_id?: number;
  amount: string;
  transaction_id?: string;
}

type AmountTarget =
  | { kind: 'payment'; index: number }
  | { kind: 'wallet' }
  | { kind: 'discount' }
  | null;

type CheckoutLayout = 'half' | 'third' | 'full-split' | 'full-3col' | 'tender' | 'centered';

/** Layout trial: picked per device from localStorage `flo-checkout-layout`. */
function readCheckoutLayout(): CheckoutLayout {
  try {
    const value =
      typeof window === 'undefined' ? null : window.localStorage.getItem('flo-checkout-layout');
    return value === 'third' ||
      value === 'full-split' ||
      value === 'full-3col' ||
      value === 'tender' ||
      value === 'centered'
      ? value
      : 'half';
  } catch {
    return 'half';
  }
}

export default function PrepaidCheckoutModal({
  initialCardTransactionIdRequired,
  initialDiscount = null,
  discountCommitted = false,
  onClose,
  onConfirm,
}: Props) {
  const cart = useCartStore();
  const customer = cart.customer;
  const t = useTranslations('pos');
  const tCommon = useTranslations('common');
  const currencyFmt = useFormatCurrency();
  const fmtNum = useFormatNumber();
  const unitAdapter = useCurrencyUnitAdapter();
  const {
    toDisplay: toDisplayUnit,
    toStored: toStoredUnit,
    label: inputCurrencyLabel,
    step: inputCurrencyStep,
    formatInput,
  } = unitAdapter;
  const { currentTenant } = useAuthStore();
  const charges = useChargesStore((s) => s.charges);
  const loadCharges = useChargesStore((s) => s.load);
  const currencyCode =
    currentTenant?.currency ||
    (currentTenant?.country ? getCountryByCode(currentTenant.country)?.currency : undefined) ||
    'INR';
  const minorFactor = getCurrencyMinorUnitFactor(currencyCode);
  const toMinorUnits = (amount: number) => Math.round(amount * minorFactor);

  const [loyaltySettings, setLoyaltySettings] = useState<LoyaltySettings | null>(null);
  const [walletBalance, setWalletBalance] = useState<number | null>(null);
  const [walletLoadFailed, setWalletLoadFailed] = useState(false);
  const [walletAmount, setWalletAmount] = useState('');
  const [processing, setProcessing] = useState(false);
  const isNarrowScreen = useIsMobile();
  const [layout] = useState<CheckoutLayout>(readCheckoutLayout);
  const [customMethods, setCustomMethods] = useState<CustomPaymentMethod[]>([]);
  const [cardTransactionIdRequired, setCardTransactionIdRequired] = useState(
    Boolean(initialCardTransactionIdRequired),
  );

  // Discount state (applied to the order once checkout is confirmed)
  const hasInitialDiscount = Boolean(initialDiscount && initialDiscount.value > 0);
  const [discountOpen, setDiscountOpen] = useState(hasInitialDiscount);
  const [discountType, setDiscountType] = useState<DiscountType>(
    hasInitialDiscount && initialDiscount ? initialDiscount.type : 'percentage',
  );
  const [discountValue, setDiscountValue] = useState(() => {
    if (!hasInitialDiscount || !initialDiscount) return '';
    return initialDiscount.type === 'amount'
      ? formatInput(toDisplayUnit(initialDiscount.value))
      : String(initialDiscount.value);
  });
  const [discountReason, setDiscountReason] = useState(
    hasInitialDiscount && initialDiscount?.reason ? initialDiscount.reason : '',
  );
  const [discountMode, setDiscountMode] = useState<DiscountMode>('percentage');
  const [discountModeLoaded, setDiscountModeLoaded] = useState(false);
  const managerApprovers = useManagerApprovers();
  const [discountRequiresApproval, setDiscountRequiresApproval] = useState(false);
  const [discountPin, setDiscountPin] = useState('');
  const [discountApproverId, setDiscountApproverId] = useState<string | null>(null);
  const [amountTarget, setAmountTarget] = useState<AmountTarget>(null);
  const [upiQrAmount, setUpiQrAmount] = useState<number | null>(null);
  const [upiQrEnabled, setUpiQrEnabled] = useState(false);

  const previewDiscount = useMemo(() => {
    const rawValue = Number.parseFloat(discountValue);
    if (!Number.isFinite(rawValue) || rawValue <= 0) return null;
    const normalizedValue =
      discountType === 'amount'
        ? normalizeFixedDiscountValue(rawValue, unitAdapter.maxDecimals)
        : Math.min(100, Math.max(0, rawValue));
    if (discountType === 'amount' && normalizedValue <= 0) return null;
    return {
      type: discountType,
      value: discountType === 'percentage' ? normalizedValue : toStoredUnit(normalizedValue),
    };
  }, [discountType, discountValue, toStoredUnit, unitAdapter.maxDecimals]);
  const committedInitialDiscountUnchanged = Boolean(
    discountCommitted &&
    initialDiscount &&
    initialDiscount.value > 0 &&
    previewDiscount &&
    previewDiscount.type === initialDiscount.type &&
    previewDiscount.value === initialDiscount.value &&
    (discountReason || undefined) === (initialDiscount.reason || undefined),
  );
  const discountNeedsApprovalPin = discountRequiresApproval && !committedInitialDiscountUnchanged;
  const chargeContext = useMemo(
    () => ({
      orderType: cart.orderType,
      onlinePlatform: cart.onlinePlatform,
      waivedChargeIds: Array.from(cart.waivedChargeIds),
      optedInChargeIds: Array.from(cart.optedInChargeIds),
    }),
    [cart.orderType, cart.onlinePlatform, cart.waivedChargeIds, cart.optedInChargeIds],
  );
  const applicableCharges = chargesForOrderType(charges, cart.orderType);
  const addableCharges = applicableCharges.filter(
    (charge) => !charge.is_default_active && !cart.optedInChargeIds.has(charge.id),
  );
  const rawDiscountValue = Number.parseFloat(discountValue);
  const normalizedFixedDiscountValue =
    discountType === 'amount' && Number.isFinite(rawDiscountValue) && rawDiscountValue > 0
      ? normalizeFixedDiscountValue(rawDiscountValue, unitAdapter.maxDecimals)
      : null;
  const hasInvalidFixedDiscount = normalizedFixedDiscountValue === 0;
  const { tax, loading: taxLoading } = useTaxPreview(
    cart.items,
    cart.customerId,
    undefined,
    previewDiscount,
    chargeContext,
  );

  useEffect(() => {
    void loadCharges();
  }, [loadCharges]);

  const [payments, setPayments] = useState<Payment[]>(
    checkoutPaymentMethods(false).map((method) => ({ method: method.key, amount: '' })),
  );
  // Tracks whether the cashier has manually typed a split amount — once true, we stop
  // auto-rescaling payment splits (e.g. on discount edits) so we don't clobber their entry.
  const [paymentsTouched, setPaymentsTouched] = useState(false);

  // Same one-shot reconciliation as PaymentModal: `none` forbids every type, so
  // its cleanup runs once on entry instead of rescheduling every render.
  const [reconciledDiscountMode, setReconciledDiscountMode] = useState(discountMode);
  if (discountMode !== reconciledDiscountMode) {
    setReconciledDiscountMode(discountMode);
    if (discountMode === 'none' && !committedInitialDiscountUnchanged) {
      setDiscountType(defaultDiscountTypeForMode(discountMode));
      setDiscountValue('');
      setDiscountReason('');
      setDiscountPin('');
      setPaymentsTouched(false);
      setAmountTarget((target) => (target?.kind === 'discount' ? null : target));
    }
  }

  if (
    discountModeLoaded &&
    !committedInitialDiscountUnchanged &&
    discountMode !== 'none' &&
    !isDiscountTypeAllowed(discountMode, discountType)
  ) {
    setDiscountType(defaultDiscountTypeForMode(discountMode));
    setDiscountValue('');
    setDiscountReason('');
    setDiscountPin('');
    setPaymentsTouched(false);
    setAmountTarget((target) => (target?.kind === 'discount' ? null : target));
  }

  useEffect(() => {
    api
      .get('/settings/loyalty')
      .then((res) => setLoyaltySettings(res.data))
      .catch(() => {});
    api
      .get('/settings/discount')
      .then((res) => {
        setDiscountMode(normalizeDiscountMode(res.data.discount_mode));
        setDiscountRequiresApproval(!!res.data.discount_requires_approval);
      })
      .catch(() => {})
      .finally(() => setDiscountModeLoaded(true));
    api
      .get('/settings/card_transaction_id_required')
      .then((res) => setCardTransactionIdRequired(res.data?.setting?.value === 'true'))
      .catch(() => {});
    api
      .get('/payment-methods')
      .then((res) => {
        const methods: CustomPaymentMethod[] = res.data.payment_methods || [];
        setCustomMethods(methods);
        setUpiQrEnabled(res.data.upi_qr_enabled === true);
        setPayments((current) => [
          ...checkoutPaymentMethods(res.data.card_enabled === true).map(
            (method) =>
              current.find(
                (row) => row.method === method.key && row.payment_method_id === undefined,
              ) || { method: method.key, amount: '' },
          ),
          ...methods.map(
            (method) =>
              current.find((row) => row.payment_method_id === method.id) || {
                method: 'custom',
                payment_method_id: method.id,
                amount: '',
              },
          ),
        ]);
      })
      .catch(() => setCustomMethods([]));
  }, []);

  // Reset stale wallet balance during render when customer changes
  // to avoid flashing previous customer balance.
  const [syncedCustomerId, setSyncedCustomerId] = useState(customer?.id ?? null);
  if ((customer?.id ?? null) !== syncedCustomerId) {
    setSyncedCustomerId(customer?.id ?? null);
    setWalletLoadFailed(false);
    setWalletBalance(null);
    setWalletAmount('');
    setAmountTarget(null);
  }

  useEffect(() => {
    if (customer?.id) {
      api
        .get(`/customers/${customer.id}/wallet`)
        .then((res) => {
          setWalletBalance(Number(res.data.balance) || 0);
        })
        .catch(() => setWalletLoadFailed(true));
    }
  }, [customer?.id]);

  // The backend preview is the settlement source of truth: it applies the same
  // discount/tax rules and active-pack payable rounding used by bill generation.
  const preview = useMemo(() => {
    if (!tax) return null;
    return {
      subtotal: tax.subtotal,
      discountAmount: tax.discount_amount,
      discountedSubtotal: tax.discounted_subtotal,
      taxAmount: tax.tax_amount,
      taxBreakdown: tax.tax_breakdown,
      packagingCharge: tax.packaging_charge,
      charges: tax.charges_breakdown || [],
      roundOff: tax.round_off,
      total: tax.total,
    };
  }, [tax]);

  const remaining = preview?.total ?? 0;

  // Auto-fill splits to match net total during render when total changes,
  // unless cashier has already edited inputs manually.
  const [syncedRemaining, setSyncedRemaining] = useState(remaining);
  if (preview && !paymentsTouched && remaining !== syncedRemaining) {
    setSyncedRemaining(remaining);
    const walletUsed = toStoredUnit(parseFloat(walletAmount) || 0);
    const cashRemaining = Math.max(0, remaining - walletUsed);
    const totalAllocated = payments.reduce((sum, p) => sum + (parseFloat(p.amount) || 0), 0);
    if (totalAllocated > 0) {
      const displayRemaining = toDisplayUnit(cashRemaining);
      setPayments(
        payments.map((p) => {
          const ratio = (parseFloat(p.amount) || 0) / totalAllocated;
          return { ...p, amount: formatInput(displayRemaining * ratio) };
        }),
      );
    }
  }

  const walletAmt = toStoredUnit(parseFloat(walletAmount) || 0);
  const totalPaymentMinor =
    payments.reduce((s, p) => s + toMinorUnits(toStoredUnit(parseFloat(p.amount) || 0)), 0) +
    toMinorUnits(walletAmt);
  const remainingMinor = toMinorUnits(remaining);

  const updatePaymentTransactionId = (idx: number, value: string) => {
    setPayments((current) =>
      current.map((payment, index) =>
        index === idx ? { ...payment, transaction_id: value } : payment,
      ),
    );
  };

  const needsTransactionId = (payment: Payment) =>
    cardTransactionIdRequired &&
    payment.method === 'card' &&
    payment.payment_method_id === undefined;

  const updatePaymentAmount = (idx: number, value: string) => {
    setPaymentsTouched(true);
    setPayments((current) =>
      current.map((payment, index) => (index === idx ? { ...payment, amount: value } : payment)),
    );
  };

  const allocateRemainingTo = (idx: number) => {
    const allocatedElsewhere = payments.reduce(
      (sum, payment, index) =>
        index === idx ? sum : sum + toStoredUnit(parseFloat(payment.amount) || 0),
      walletAmt,
    );
    const dueStored = Math.max(0, remaining - allocatedElsewhere);
    const dueDisplay = toDisplayUnit(dueStored);
    setPaymentsTouched(true);
    setPayments(
      payments.map((payment, index) =>
        index === idx ? { ...payment, amount: dueDisplay > 0 ? String(dueDisplay) : '' } : payment,
      ),
    );
  };

  const hasCash = payments.some((p) => p.method === 'cash' && (parseFloat(p.amount) || 0) > 0);
  const change =
    hasCash && totalPaymentMinor > remainingMinor
      ? (totalPaymentMinor - remainingMinor) / minorFactor
      : 0;

  // The number pad stays on screen; until a field is chosen it types into Cash.
  const cashIndex = payments.findIndex(
    (payment) => payment.method === 'cash' && payment.payment_method_id === undefined,
  );
  const padTarget: AmountTarget =
    amountTarget ?? (cashIndex >= 0 ? { kind: 'payment', index: cashIndex } : null);

  const activeAmountValue =
    padTarget?.kind === 'payment'
      ? payments[padTarget.index]?.amount || ''
      : padTarget?.kind === 'wallet'
        ? walletAmount
        : padTarget?.kind === 'discount'
          ? discountValue
          : '';

  const updateActiveAmount = (value: string) => {
    if (!padTarget) return;
    if (padTarget.kind === 'payment') {
      updatePaymentAmount(padTarget.index, value);
      return;
    }
    if (padTarget.kind === 'wallet') {
      const maxWalletCurrencyStored = Math.floor((walletBalance || 0) / LOYALTY_REDEMPTION_RATE);
      const maxDisplay = toDisplayUnit(Math.min(maxWalletCurrencyStored, remaining));
      const clamped = parseFloat(value) > maxDisplay ? String(maxDisplay) : value;
      setWalletAmount(clamped);
      setPaymentsTouched(true);
      return;
    }
    setDiscountValue(value);
  };

  const activeAmountMax =
    padTarget?.kind === 'discount'
      ? discountType === 'percentage'
        ? 100
        : preview
          ? toDisplayUnit(preview.subtotal)
          : undefined
      : padTarget?.kind === 'wallet'
        ? toDisplayUnit(
            Math.min(Math.floor((walletBalance || 0) / LOYALTY_REDEMPTION_RATE), remaining),
          )
        : undefined;

  const activeAmountQuickValues = (() => {
    if (padTarget?.kind === 'payment') {
      const allocatedElsewhere = payments.reduce(
        (sum, payment, index) =>
          index === padTarget.index ? sum : sum + toStoredUnit(parseFloat(payment.amount) || 0),
        walletAmt,
      );
      const dueDisplay = toDisplayUnit(Math.max(0, remaining - allocatedElsewhere));
      return dueDisplay > 0 ? [{ label: t('exactAmount'), value: String(dueDisplay) }] : [];
    }
    if (padTarget?.kind === 'wallet') {
      const allocatedElsewhere = payments.reduce(
        (sum, payment) => sum + toStoredUnit(parseFloat(payment.amount) || 0),
        0,
      );
      const maxWalletStored = Math.floor((walletBalance || 0) / LOYALTY_REDEMPTION_RATE);
      const dueDisplay = toDisplayUnit(
        Math.min(maxWalletStored, Math.max(0, remaining - allocatedElsewhere)),
      );
      return dueDisplay > 0 ? [{ label: t('exactAmount'), value: String(dueDisplay) }] : [];
    }
    return [];
  })();

  const handleConfirm = (paymentRows = payments) => {
    if (hasInvalidFixedDiscount) {
      toast.error(unitAdapter.maxDecimals === 0 ? t('fixedDiscountMinimum') : t('discountInvalid'));
      return;
    }
    if (!preview) return;
    const decimalPart =
      unitAdapter.maxDecimals > 0 ? `(?:\\.\\d{1,${unitAdapter.maxDecimals}})?` : '';
    const amountPattern = new RegExp(`^\\d+${decimalPart}$`);
    const amountIsValid = (value: string) =>
      value.trim() === '' || amountPattern.test(value.trim());
    if (
      paymentRows.some(
        (p) =>
          (!PAYMENT_METHODS.some((allowed) => allowed.key === p.method) &&
            !customMethods.some((method) => method.id === p.payment_method_id)) ||
          !amountIsValid(p.amount),
      )
    ) {
      toast.error(t('paymentFailed'));
      return;
    }
    if (walletAmount.trim() && !amountPattern.test(walletAmount.trim())) {
      toast.error(t('paymentFailed'));
      return;
    }
    if (
      paymentRows.some(
        (p) =>
          needsTransactionId(p) && (parseFloat(p.amount) || 0) > 0 && !p.transaction_id?.trim(),
      )
    ) {
      toast.error(t('cardTransactionIdMissing'));
      return;
    }
    const paymentTotalMinor =
      paymentRows.reduce(
        (sum, payment) => sum + toMinorUnits(toStoredUnit(Number(payment.amount) || 0)),
        0,
      ) + toMinorUnits(walletAmt);
    const nonCashTotalMinor =
      paymentRows
        .filter((p) => p.method !== 'cash')
        .reduce((sum, p) => sum + toMinorUnits(toStoredUnit(Number(p.amount) || 0)), 0) +
      toMinorUnits(walletAmt);
    if (nonCashTotalMinor > remainingMinor) {
      toast.error(t('paymentAboveBalance'));
      return;
    }
    if (paymentTotalMinor < remainingMinor) {
      toast.error(t('paymentBelowBalance'));
      return;
    }
    if (walletAmt > 0 && walletBalance === null) {
      toast.error(t('paymentFailed'));
      return;
    }
    if (walletAmt > 0 && walletBalance !== null) {
      const walletPointsRequired = walletAmt * LOYALTY_REDEMPTION_RATE;
      if (walletPointsRequired > walletBalance) {
        const maxCurrency = Math.floor(walletBalance / LOYALTY_REDEMPTION_RATE);
        toast.error(t('walletMaxAmount', { max: currencyFmt(maxCurrency) }));
        return;
      }
    }
    const effectiveDiscountApproverId = discountApproverId ?? managerApprovers.selectedApproverId;
    if (preview.discountAmount > 0 && discountNeedsApprovalPin) {
      if (
        !discountPin ||
        managerApprovers.loading ||
        managerApprovers.loadFailed ||
        managerApprovers.approvers.length === 0 ||
        !effectiveDiscountApproverId
      ) {
        toast.error(t('managerPinRequired'));
        return;
      }
    }
    if (
      preview.discountAmount > 0 &&
      !committedInitialDiscountUnchanged &&
      !isDiscountTypeAllowed(discountMode, discountType)
    ) {
      toast.error(t('discountInvalid'));
      return;
    }

    setProcessing(true);
    const splitLines: PrepaidPayment[] = paymentRows
      .map((p) => ({
        method: p.payment_method_id === undefined ? p.method : 'custom',
        ...(p.payment_method_id !== undefined ? { payment_method_id: p.payment_method_id } : {}),
        amount: toStoredUnit(parseFloat(p.amount) || 0),
        ...(needsTransactionId(p) && p.transaction_id?.trim()
          ? { transaction_id: p.transaction_id.trim() }
          : {}),
      }))
      .filter((p) => p.amount > 0 && !isNaN(p.amount));

    const finalDiscount: PrepaidDiscount | null =
      preview.discountAmount > 0
        ? {
            type: discountType,
            value: previewDiscount?.value ?? 0,
            reason: discountReason || undefined,
            override_pin: discountNeedsApprovalPin && discountPin ? discountPin : undefined,
            approver_id:
              discountNeedsApprovalPin && discountPin
                ? effectiveDiscountApproverId || undefined
                : undefined,
          }
        : null;

    onConfirm(splitLines, walletAmt, finalDiscount);
  };

  const modalRef = useRef<HTMLDivElement>(null);
  const handleConfirmRef = useRef(handleConfirm);
  useEffect(() => {
    handleConfirmRef.current = handleConfirm;
  });

  useEffect(() => {
    if (
      typeof document !== 'undefined' &&
      modalRef.current &&
      document.activeElement &&
      !modalRef.current.contains(document.activeElement) &&
      typeof (document.activeElement as HTMLElement).blur === 'function'
    ) {
      (document.activeElement as HTMLElement).blur();
    }
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const tag = target?.tagName;
      const isInput =
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        Boolean(target?.isContentEditable);
      const isInsideModal =
        !modalRef.current ||
        !target ||
        (typeof Node !== 'undefined' && !(target instanceof Node)) ||
        modalRef.current.contains(target as Node);
      const isInteractive =
        isInput ||
        (isInsideModal &&
          (tag === 'BUTTON' ||
            tag === 'A' ||
            target?.getAttribute?.('role') === 'button' ||
            Boolean(target?.closest?.('button, a, [role="button"]'))));

      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
        return;
      }

      if (isInput) return;

      if (e.key === ' ' || e.code === 'Space' || e.key === 'Enter') {
        if (e.repeat) {
          e.preventDefault();
          return;
        }
        if (isInteractive) return;
        e.preventDefault();
        if (processing || taxLoading || !preview || hasInvalidFixedDiscount) return;

        if (totalPaymentMinor < remainingMinor) {
          const cashIdx = payments.findIndex((p) => p.method === 'cash');
          if (cashIdx !== -1) {
            const allocatedElsewhere = payments.reduce(
              (sum, payment, index) =>
                index === cashIdx ? sum : sum + toStoredUnit(parseFloat(payment.amount) || 0),
              walletAmt,
            );
            const dueStored = Math.max(0, remaining - allocatedElsewhere);
            const dueDisplay = toDisplayUnit(dueStored);
            const updated = payments.map((p, i) =>
              i === cashIdx ? { ...p, amount: String(dueDisplay) } : p,
            );
            setPayments(updated);
            handleConfirmRef.current(updated);
            return;
          }
        }

        handleConfirmRef.current();
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [
    onClose,
    processing,
    taxLoading,
    preview,
    hasInvalidFixedDiscount,
    totalPaymentMinor,
    remainingMinor,
    payments,
    walletAmt,
    remaining,
    toDisplayUnit,
    toStoredUnit,
  ]);

  // Checkout pieces, arranged differently by each layout below.
  const titleRow = (
    <>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-lg font-bold text-foreground">{t('checkout')}</h2>
          <p className="mt-0.5 truncate text-xs capitalize text-muted-foreground">
            {t(ORDER_TYPE_SUFFIX_KEYS[cart.orderType])}
            {customer ? ` · ${customer.name}` : ''}
          </p>
        </div>
        <button
          onClick={onClose}
          className="touch-target rounded-full bg-muted text-muted-foreground transition-colors hover:bg-muted hover:text-foreground active:bg-muted"
          aria-label={t('close')}
        >
          <X size={16} />
        </button>
      </div>
    </>
  );
  const summaryBlock = (
    <>
      {taxLoading || !preview ? (
        <div className="mt-3 h-24 animate-pulse rounded-xl bg-muted" />
      ) : (
        <div
          className="mt-3 space-y-1 text-sm tabular-nums md:mt-2"
          data-testid="prepaid-checkout-summary"
        >
          <div className="flex justify-between text-foreground">
            <span>{t('itemCount', { count: cart.itemCount() })}</span>
            <span>{currencyFmt(preview.subtotal)}</span>
          </div>
          {preview.discountAmount > 0 && (
            <div className="flex justify-between font-medium text-emerald-600">
              <span>{t('discount')}</span>
              <span>− {currencyFmt(preview.discountAmount)}</span>
            </div>
          )}
          <div className="flex justify-between text-muted-foreground">
            <span>{t('subtotal')}</span>
            <span>{currencyFmt(preview.discountedSubtotal)}</span>
          </div>
          <TaxBreakdown
            taxAmount={preview.taxAmount}
            taxBreakdown={preview.taxBreakdown}
            theme="light"
          />
          {preview.charges.map((charge) => {
            const definition = applicableCharges.find((candidate) => candidate.id === charge.id);
            const optedIn = cart.optedInChargeIds.has(charge.id);
            return (
              <div
                key={charge.id}
                data-testid={`prepaid-charge-${charge.id}`}
                className="flex justify-between items-center gap-2 text-muted-foreground"
              >
                <span className={charge.waived ? 'line-through' : undefined}>{charge.name}</span>
                <span className="flex items-center gap-2">
                  <span className={charge.waived ? 'line-through' : undefined}>
                    {currencyFmt(charge.amount)}
                  </span>
                  {definition?.is_optional && (
                    <button
                      type="button"
                      onClick={() => cart.toggleWaiveCharge(charge.id)}
                      aria-pressed={charge.waived}
                      className="text-xs px-2 py-0.5 rounded border border-border hover:text-foreground"
                    >
                      {charge.waived ? t('applyCharge') : t('waiveCharge')}
                    </button>
                  )}
                  {definition && !definition.is_default_active && optedIn && (
                    <button
                      type="button"
                      onClick={() => cart.toggleOptedInCharge(charge.id)}
                      aria-pressed={optedIn}
                      className="text-xs px-2 py-0.5 rounded border border-border hover:text-foreground"
                    >
                      {t('removeCharge')}
                    </button>
                  )}
                </span>
              </div>
            );
          })}
          {addableCharges.map((charge) => (
            <div
              key={charge.id}
              data-testid={`prepaid-charge-${charge.id}`}
              className="flex justify-between items-center gap-2 text-muted-foreground"
            >
              <span>{charge.name}</span>
              <button
                type="button"
                onClick={() => cart.toggleOptedInCharge(charge.id)}
                className="text-xs px-2 py-0.5 rounded border border-border hover:text-foreground"
              >
                {t('addCharge')}
              </button>
            </div>
          ))}
          {preview.packagingCharge > 0 &&
            !preview.charges.some((charge) => charge.id === 'packaging_charge') && (
              <div className="flex justify-between text-muted-foreground">
                <span>{t('packaging')}</span>
                <span>{currencyFmt(preview.packagingCharge)}</span>
              </div>
            )}
          {preview.roundOff !== 0 && (
            <div className="flex justify-between text-muted-foreground">
              <span>{t('roundOff')}</span>
              <span>
                {preview.roundOff > 0 ? '+' : ''}
                {currencyFmt(preview.roundOff)}
              </span>
            </div>
          )}
          <div className="mt-2 flex items-end justify-between border-t border-border pt-2 font-bold text-foreground">
            <span className="text-xs uppercase tracking-wide text-muted-foreground">
              {t('totalDue')}
            </span>
            <span className="text-xl leading-none">{currencyFmt(remaining)}</span>
          </div>
        </div>
      )}
    </>
  );
  const discountToggle = (
    <>
      {discountModeLoaded && discountMode !== 'none' && (
        <button
          type="button"
          onClick={() => setDiscountOpen((open) => !open)}
          className="mt-2 inline-flex h-7 items-center gap-1 rounded-md border border-border bg-muted px-2 text-xs font-medium text-foreground transition-colors hover:border-brand hover:text-brand"
          aria-expanded={discountOpen}
        >
          {preview?.discountAmount
            ? `${t('discount')}: -${currencyFmt(preview.discountAmount)}`
            : t('discounts')}
          <ChevronDown
            size={12}
            className={`transition-transform ${discountOpen ? 'rotate-180' : ''}`}
          />
        </button>
      )}
    </>
  );
  const discountEditor = (
    <>
      {/* Cart-level discount editor. */}
      {discountOpen && discountModeLoaded && discountMode !== 'none' && (
        <div className="overflow-hidden rounded-xl border border-purple-200 dark:border-purple-800/40 bg-purple-50 dark:bg-purple-950/40 p-3 space-y-2">
          <div className="flex rounded-lg overflow-hidden border border-purple-200 dark:border-purple-800/40">
            {isDiscountTypeAllowed(discountMode, 'percentage') && (
              <button
                onClick={() => setDiscountType('percentage')}
                className={`touch-target flex-1 gap-1.5 text-sm font-medium transition-colors ${discountType === 'percentage' ? 'bg-purple-600 text-white' : 'bg-card text-muted-foreground hover:bg-muted'}`}
              >
                <Percent size={14} />
                {t('percentage')}
              </button>
            )}
            {isDiscountTypeAllowed(discountMode, 'amount') && (
              <button
                onClick={() => setDiscountType('amount')}
                className={`touch-target flex-1 gap-1.5 text-sm font-medium transition-colors ${discountType === 'amount' ? 'bg-purple-600 text-white' : 'bg-card text-muted-foreground hover:bg-muted'}`}
              >
                {t('flatAmount')}
              </button>
            )}
          </div>
          <div className="relative">
            <span className="absolute start-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">
              {discountType === 'percentage' ? '%' : inputCurrencyLabel}
            </span>
            <input
              type="number"
              value={discountValue}
              onFocus={() => setAmountTarget({ kind: 'discount' })}
              onChange={(e) => setDiscountValue(e.target.value)}
              placeholder={discountType === 'percentage' ? '0' : '0.00'}
              min="0"
              max={
                discountType === 'percentage'
                  ? 100
                  : preview
                    ? toDisplayUnit(preview.subtotal)
                    : undefined
              }
              step={getDiscountInputStep(unitAdapter.maxDecimals, discountType)}
              inputMode="none"
              className="w-full min-h-11 ps-8 pe-3 py-2 text-sm border border-purple-200 dark:border-purple-800/40 rounded-lg outline-none focus:ring-2 focus:ring-purple-400 bg-card"
            />
          </div>
          <input
            type="text"
            value={discountReason}
            onChange={(e) => setDiscountReason(e.target.value)}
            placeholder={t('discountReasonPlaceholder')}
            className="w-full min-h-11 px-3 py-2 text-sm border border-purple-200 dark:border-purple-800/40 rounded-lg outline-none focus:ring-2 focus:ring-purple-400 bg-card"
          />
          {discountNeedsApprovalPin && parseFloat(discountValue) > 0 && (
            <div className="space-y-2">
              <ApproverSelect
                id="prepaidDiscountApprover"
                approvers={managerApprovers.approvers}
                selectedApproverId={discountApproverId ?? managerApprovers.selectedApproverId}
                onSelectApprover={(id) => {
                  setDiscountApproverId(id);
                  setDiscountPin('');
                }}
                loading={managerApprovers.loading}
                loadFailed={managerApprovers.loadFailed}
                disabled={processing}
              />
              <input
                type="password"
                value={discountPin}
                onChange={(e) => setDiscountPin(e.target.value)}
                placeholder={t('managerPin')}
                maxLength={6}
                className="w-full min-h-11 px-3 py-2 text-sm border border-purple-200 dark:border-purple-800/40 rounded-lg outline-none focus:ring-2 focus:ring-purple-400 bg-card"
              />
            </div>
          )}
          {discountValue && (
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => {
                setDiscountValue('');
                setDiscountReason('');
                setDiscountPin('');
                setDiscountApproverId(null);
                setPaymentsTouched(false);
              }}
            >
              {t('remove')}
            </Button>
          )}
        </div>
      )}
    </>
  );
  const paymentRows = (
    <>
      {/* Every method has one compact amount row; clicking its label fills the unallocated balance. */}
      <div className="space-y-2">
        {payments.map((payment, idx) => {
          const builtIn = PAYMENT_METHODS.find(
            (method) => method.key === payment.method && payment.payment_method_id === undefined,
          );
          const custom = customMethods.find((method) => method.id === payment.payment_method_id);
          const label = builtIn
            ? t(BUILT_IN_PAYMENT_KEYS[builtIn.key])
            : custom?.name || tCommon('unknown');
          const Icon = builtIn?.icon ?? (custom ? customPaymentMethodIcon(custom.name) : undefined);
          const active = (parseFloat(payment.amount) || 0) > 0;
          return (
            <div
              key={
                payment.payment_method_id === undefined
                  ? payment.method
                  : `custom:${payment.payment_method_id}`
              }
              className="space-y-1"
            >
              <div className="flex min-h-12 md:min-h-11">
                <button
                  type="button"
                  title={label}
                  onClick={() => {
                    setAmountTarget({ kind: 'payment', index: idx });
                    allocateRemainingTo(idx);
                  }}
                  className={`touch-target w-36 shrink-0 justify-start rounded-s-xl border px-3 gap-2 text-sm font-semibold transition-colors ${active ? 'bg-brand text-white border-brand' : 'bg-muted text-foreground border-border hover:border-brand hover:text-brand'}`}
                >
                  {Icon && <Icon size={15} />}
                  <span className="truncate">{label}</span>
                </button>
                <div className="flex min-w-0 flex-1 items-center border border-s-0 border-border rounded-e-xl bg-card focus-within:ring-2 focus-within:ring-brand focus-within:border-transparent">
                  <span className="ps-3 text-muted-foreground text-xs">{inputCurrencyLabel}</span>
                  <input
                    type="number"
                    value={payment.amount}
                    onFocus={() => setAmountTarget({ kind: 'payment', index: idx })}
                    onChange={(e) => updatePaymentAmount(idx, e.target.value)}
                    placeholder="0.00"
                    inputMode="none"
                    className="min-w-0 flex-1 px-2 py-2 text-end text-base font-semibold outline-none rounded-e-xl"
                    step={inputCurrencyStep}
                    min="0"
                  />
                </div>
              </div>
              {custom && isUpiMethodName(custom.name) && upiQrEnabled && (
                <button
                  type="button"
                  data-testid="show-upi-qr"
                  disabled={!active}
                  onClick={() => setUpiQrAmount(toStoredUnit(parseFloat(payment.amount) || 0))}
                  className="flex w-full min-h-11 items-center justify-center gap-2 rounded-xl border border-brand px-3 py-2 text-sm font-semibold text-brand hover:bg-brand/10 disabled:cursor-not-allowed disabled:border-border disabled:bg-muted disabled:text-muted-foreground disabled:hover:bg-muted"
                >
                  <QrCode size={16} />
                  {t('upiQrShow')}
                </button>
              )}
              {needsTransactionId(payment) && active && (
                <input
                  type="text"
                  value={payment.transaction_id ?? ''}
                  onChange={(e) => updatePaymentTransactionId(idx, e.target.value)}
                  placeholder={t('cardTransactionIdLabel')}
                  aria-label={t('cardTransactionIdLabel')}
                  maxLength={256}
                  autoComplete="off"
                  className="w-full min-h-11 rounded-xl border border-border bg-card px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-brand"
                />
              )}
            </div>
          );
        })}
      </div>
    </>
  );
  const walletBlock = (
    <>
      {/* Loyalty Wallet Section */}
      {loyaltySettings?.loyalty_enabled && customer && walletBalance !== null && (
        <div className="space-y-1">
          <div className="flex min-h-12">
            <button
              type="button"
              disabled={walletBalance <= 0}
              onClick={() => {
                const allocatedElsewhere = payments.reduce(
                  (sum, payment) => sum + toStoredUnit(parseFloat(payment.amount) || 0),
                  0,
                );
                const maxWalletStored = Math.floor(walletBalance / LOYALTY_REDEMPTION_RATE);
                const dueStored = Math.min(
                  maxWalletStored,
                  Math.max(0, remaining - allocatedElsewhere),
                );
                const dueDisplay = toDisplayUnit(dueStored);
                setWalletAmount(dueDisplay > 0 ? String(dueDisplay) : '');
                setAmountTarget({ kind: 'wallet' });
              }}
              className={`touch-target w-36 shrink-0 justify-start rounded-s-xl border px-3 gap-2 text-sm font-semibold ${walletAmt > 0 ? 'bg-purple-600 text-white border-purple-600' : 'bg-purple-50 text-purple-800 border-purple-200 dark:bg-purple-950/40 dark:text-purple-300 dark:border-purple-800/40 disabled:bg-muted disabled:text-muted-foreground disabled:border-border'}`}
            >
              <Wallet size={15} />
              <span className="truncate">{t('loyaltyWallet')}</span>
            </button>
            <div className="flex min-w-0 flex-1 items-center border border-s-0 border-purple-200 dark:border-purple-800/40 rounded-e-xl bg-card focus-within:ring-2 focus-within:ring-purple-400">
              <span className="ps-3 text-muted-foreground text-xs">{inputCurrencyLabel}</span>
              <input
                type="number"
                value={walletAmount}
                onFocus={() => setAmountTarget({ kind: 'wallet' })}
                onChange={(e) => {
                  const v = e.target.value;
                  const maxWalletCurrencyStored = Math.floor(
                    walletBalance / LOYALTY_REDEMPTION_RATE,
                  );
                  const maxDisplay = toDisplayUnit(Math.min(maxWalletCurrencyStored, remaining));
                  const clamped = parseFloat(v) > maxDisplay ? String(maxDisplay) : v;
                  setWalletAmount(clamped);
                }}
                placeholder="0.00"
                disabled={walletBalance <= 0}
                inputMode="none"
                className="min-w-0 flex-1 px-2 py-2 text-end text-base font-semibold outline-none rounded-e-xl disabled:bg-muted"
                step={inputCurrencyStep}
                min="0"
                max={toDisplayUnit(
                  Math.min(Math.floor(walletBalance / LOYALTY_REDEMPTION_RATE), remaining),
                )}
              />
            </div>
          </div>
          <p className="px-1 text-[11px] text-muted-foreground text-end">
            {walletBalance > 0
              ? t('pointsApproxValue', {
                  count: fmtNum(walletBalance),
                  value: currencyFmt(Math.floor(walletBalance / LOYALTY_REDEMPTION_RATE)),
                })
              : t('noBalance')}
          </p>
        </div>
      )}

      {/* Loyalty Info Strip (staff reference) */}
      {loyaltySettings?.loyalty_enabled && customer && !walletLoadFailed && (
        <div className="flex items-center gap-2 px-3.5 py-2.5 bg-muted border border-border rounded-xl">
          <Sparkles size={13} className="text-muted-foreground shrink-0" />
          <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5 text-xs">
            <span className="text-foreground font-medium">{t('loyalty')}</span>
            <span className="font-semibold text-foreground">
              {walletBalance !== null
                ? t('pointsApproxValue', {
                    count: fmtNum(walletBalance),
                    value: currencyFmt(Math.floor(walletBalance / LOYALTY_REDEMPTION_RATE)),
                  })
                : '…'}
            </span>
          </div>
        </div>
      )}
    </>
  );
  const renderPad = (large = false) => (
    <>
      {padTarget && (
        <CurrencyTouchNumberPad
          large={large}
          value={activeAmountValue}
          onChange={updateActiveAmount}
          ariaLabel={t('numericKeypad')}
          clearLabel={t('clearAmount')}
          backspaceLabel={t('backspaceAmount')}
          // Percentage discounts are dimensionless rates, so they retain decimal input for zero-decimal currencies.
          currencyMaxDecimals={unitAdapter.maxDecimals}
          amountTarget={padTarget.kind}
          discountType={discountType}
          max={activeAmountMax}
          quickValues={activeAmountQuickValues}
        />
      )}
    </>
  );
  const changeBlock = (
    <>
      {/* Change stays at the bottom of all payment controls. */}
      {hasCash && (
        <div
          className={`rounded-xl px-4 py-2.5 flex items-center justify-between border transition-all duration-200 ${
            change > 0
              ? 'bg-emerald-50 dark:bg-emerald-950/40 border-emerald-200 dark:border-emerald-800/40'
              : 'bg-muted border-border'
          }`}
        >
          <div className="flex items-center gap-2.5">
            <div
              className={`w-7 h-7 rounded-full flex items-center justify-center ${
                change > 0 ? 'bg-emerald-100 dark:bg-emerald-950/60' : 'bg-gray-200 dark:bg-muted'
              }`}
            >
              {change > 0 ? (
                <CheckCircle2 size={15} className="text-emerald-600 dark:text-emerald-400" />
              ) : (
                <ArrowLeftRight size={13} className="text-muted-foreground" />
              )}
            </div>
            <span
              className={`text-sm font-semibold ${
                change > 0 ? 'text-emerald-800 dark:text-emerald-300' : 'text-muted-foreground'
              }`}
            >
              {t('changeReturned')}
            </span>
          </div>
          <span
            className={`text-lg font-bold tabular-nums ${
              change > 0 ? 'text-emerald-600' : 'text-gray-300'
            }`}
          >
            {currencyFmt(change)}
          </span>
        </div>
      )}
    </>
  );
  const confirmButton = (
    <>
      <Button
        onClick={() => handleConfirm()}
        disabled={
          processing ||
          taxLoading ||
          !preview ||
          hasInvalidFixedDiscount ||
          totalPaymentMinor < remainingMinor ||
          Boolean(
            preview.discountAmount > 0 &&
            discountNeedsApprovalPin &&
            (!discountPin ||
              managerApprovers.loading ||
              managerApprovers.loadFailed ||
              managerApprovers.approvers.length === 0 ||
              !(discountApproverId ?? managerApprovers.selectedApproverId)),
          )
        }
        className="w-full h-12 text-base font-semibold rounded-xl"
        size="lg"
      >
        {taxLoading
          ? t('calculatingTax')
          : processing
            ? t('processingPayment')
            : t('confirmPaymentAmount', { amount: currencyFmt(remaining) })}
      </Button>
    </>
  );

  const upiPayment = payments.find((payment) => {
    const method = customMethods.find((candidate) => candidate.id === payment.payment_method_id);
    return Boolean(method && isUpiMethodName(method.name));
  });
  const upiAmountStored = upiPayment ? toStoredUnit(parseFloat(upiPayment.amount) || 0) : 0;
  const cashPaymentIndex = payments.findIndex(
    (payment) => payment.method === 'cash' && payment.payment_method_id === undefined,
  );
  const dueDisplay = toDisplayUnit(remaining);
  const quickCashNotes = Array.from(
    new Set([1, 50, 100, 200, 500, 2000].map((step) => Math.ceil(dueDisplay / step) * step)),
  )
    .filter((value) => value >= dueDisplay)
    .slice(0, 6);
  const quickCashPanel = cashPaymentIndex >= 0 && dueDisplay > 0 && (
    <div className="grid grid-cols-3 gap-2" data-testid="quick-cash">
      {quickCashNotes.map((value) => (
        <button
          key={value}
          type="button"
          onClick={() => {
            setAmountTarget({ kind: 'payment', index: cashPaymentIndex });
            updatePaymentAmount(cashPaymentIndex, String(value));
          }}
          className="touch-target min-h-14 rounded-xl border border-border bg-card text-lg font-bold tabular-nums text-foreground active:bg-muted"
        >
          {currencyFmt(toStoredUnit(value))}
        </button>
      ))}
    </div>
  );
  const qrPanel =
    upiQrAmount !== null ? (
      <UpiQrPanel key={upiQrAmount} amount={upiQrAmount} onClose={() => setUpiQrAmount(null)} />
    ) : null;
  const closeButtonOnly = (
    <button
      onClick={onClose}
      className="touch-target rounded-full bg-muted text-muted-foreground hover:text-foreground"
      aria-label={t('close')}
    >
      <X size={16} />
    </button>
  );

  if (!isNarrowScreen && layout === 'full-split') {
    return (
      <div
        ref={modalRef}
        data-testid="prepaid-checkout-modal"
        className="fixed inset-0 z-50 flex bg-card"
      >
        <div className="flex w-1/2 min-h-0 flex-col border-e border-border">
          <div className="shrink-0 border-b border-border px-6 pb-3 pt-4">
            {titleRow}
            {summaryBlock}
            {discountToggle}
          </div>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-6 py-3">
            {discountEditor}
            {paymentRows}
            {walletBlock}
            {changeBlock}
          </div>
        </div>
        <div className="flex w-1/2 min-h-0 flex-col">
          <div className="min-h-0 flex-1 px-6 py-4">
            {qrPanel ? (
              <div className="flex h-full items-center justify-center">{qrPanel}</div>
            ) : (
              renderPad(true)
            )}
          </div>
          <div className="shrink-0 border-t border-border px-6 pb-4 pt-3">{confirmButton}</div>
        </div>
      </div>
    );
  }

  if (!isNarrowScreen && layout === 'full-3col') {
    return (
      <div
        ref={modalRef}
        data-testid="prepaid-checkout-modal"
        className="fixed inset-0 z-50 flex bg-card"
      >
        <div className="flex w-1/3 min-h-0 flex-col border-e border-border bg-muted/30">
          {qrPanel ? (
            <div className="flex h-full items-center justify-center p-4">{qrPanel}</div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-3 pt-4">
              {titleRow}
              {summaryBlock}
              {discountToggle}
              <div className="mt-3">{discountEditor}</div>
            </div>
          )}
        </div>
        <div className="flex w-1/3 min-h-0 flex-col border-e border-border">
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-5 pt-4">
            {paymentRows}
            {walletBlock}
          </div>
          <div className="shrink-0 space-y-2 border-t border-border px-5 pb-4 pt-3">
            {changeBlock}
            {confirmButton}
          </div>
        </div>
        <div className="flex w-1/3 min-h-0 flex-col px-5 py-4">{renderPad(true)}</div>
      </div>
    );
  }

  if (!isNarrowScreen && layout === 'tender') {
    return (
      <div
        ref={modalRef}
        data-testid="prepaid-checkout-modal"
        className="fixed inset-0 z-50 flex flex-col bg-card"
      >
        <div className="flex shrink-0 items-center justify-between gap-4 border-b border-border px-6 py-3">
          <div className="min-w-0">
            <h2 className="text-lg font-bold text-foreground">{t('checkout')}</h2>
            <p className="text-xs text-muted-foreground">
              {t(ORDER_TYPE_SUFFIX_KEYS[cart.orderType])}
            </p>
          </div>
          <div className="flex items-center gap-4">
            <div className="text-end">
              <p className="text-xs uppercase tracking-wide text-muted-foreground">
                {t('totalDue')}
              </p>
              <p className="text-3xl font-bold tabular-nums text-foreground">
                {currencyFmt(remaining)}
              </p>
            </div>
            {closeButtonOnly}
          </div>
        </div>
        <div className="flex min-h-0 flex-1">
          <div className="flex w-3/5 min-h-0 gap-4 border-e border-border px-6 py-4">
            <div className="flex min-w-0 flex-1 flex-col gap-2 overflow-y-auto">
              <div>{discountToggle}</div>
              {discountEditor}
              {paymentRows}
              {walletBlock}
            </div>
            <div className="flex w-[44%] shrink-0 flex-col items-center gap-2 overflow-y-auto">
              {upiAmountStored > 0 ? (
                <UpiQrPanel
                  compact
                  key={upiAmountStored}
                  amount={upiAmountStored}
                  onClose={() => updatePaymentAmount(payments.indexOf(upiPayment!), '')}
                />
              ) : (
                <div className="w-full">{quickCashPanel}</div>
              )}
            </div>
          </div>
          <div className="flex w-2/5 min-h-0 flex-col">
            <div className="min-h-0 flex-1 px-6 pt-4">{renderPad(true)}</div>
            <div className="shrink-0 space-y-2 border-t border-border px-6 pb-4 pt-3">
              {changeBlock}
              {confirmButton}
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!isNarrowScreen && layout === 'third') {
    return (
      <div
        ref={modalRef}
        data-testid="prepaid-checkout-modal"
        className="fixed inset-0 z-50 flex bg-black/60 backdrop-blur-sm"
      >
        {/* Left two thirds: the bill summary, with the UPI QR below it while shown. */}
        <div className="flex w-2/3 min-h-0 flex-col items-center gap-4 overflow-y-auto p-6 portrait:w-1/2">
          <div className="w-full max-w-md rounded-2xl bg-card p-5 shadow-2xl">
            {summaryBlock}
            {discountToggle}
            {discountOpen && <div className="mt-3">{discountEditor}</div>}
          </div>
          {upiQrAmount !== null && (
            <UpiQrPanel
              compact
              key={upiQrAmount}
              amount={upiQrAmount}
              onClose={() => setUpiQrAmount(null)}
            />
          )}
        </div>
        {/* Right third: payment amounts, keypad and Confirm. */}
        <div className="flex w-1/3 min-h-0 flex-col bg-card shadow-2xl portrait:w-1/2">
          <div className="shrink-0 border-b border-border px-5 pb-2 pt-3">{titleRow}</div>
          <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-5 py-2">
            {paymentRows}
            {walletBlock}
          </div>
          <div className="shrink-0 space-y-2 px-5 pb-1">
            {renderPad()}
            {changeBlock}
          </div>
          <div className="shrink-0 border-t border-border px-5 pb-3 pt-2">{confirmButton}</div>
        </div>
      </div>
    );
  }

  if (!isNarrowScreen && layout === 'centered') {
    return (
      <div
        ref={modalRef}
        data-testid="prepaid-checkout-modal"
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      >
        <div className="flex max-h-full w-full max-w-5xl overflow-hidden rounded-2xl bg-card shadow-2xl">
          <div className="flex w-1/2 min-h-0 flex-col border-e border-border">
            <div className="shrink-0 border-b border-border px-5 pb-3 pt-4">
              {titleRow}
              {summaryBlock}
              {discountToggle}
            </div>
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-5 py-3">
              {discountEditor}
              {paymentRows}
              {walletBlock}
            </div>
          </div>
          <div className="flex w-1/2 min-h-0 flex-col">
            <div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-5 pt-4">
              {/* While the QR is shown it takes the keypad's place; Done brings the keypad back. */}
              {upiQrAmount !== null ? (
                <div className="flex justify-center">
                  <UpiQrPanel
                    compact
                    key={upiQrAmount}
                    amount={upiQrAmount}
                    onClose={() => setUpiQrAmount(null)}
                  />
                </div>
              ) : (
                renderPad()
              )}
              {changeBlock}
            </div>
            <div className="shrink-0 border-t border-border px-5 pb-4 pt-3">{confirmButton}</div>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      ref={modalRef}
      data-testid="prepaid-checkout-modal"
      className="fixed inset-0 bg-black/60 backdrop-blur-sm flex items-end sm:items-center justify-center z-50 p-0 sm:p-4 md:items-stretch md:p-0"
    >
      {upiQrAmount !== null && isNarrowScreen && (
        <UpiQrDialog amount={upiQrAmount} onClose={() => setUpiQrAmount(null)} />
      )}
      {/* On wide screens the checkout docks right; the free side holds the UPI QR. */}
      <div
        className={`hidden md:flex items-center justify-center p-6 ${layout === 'third' ? 'md:w-2/3' : 'md:w-1/2'}`}
      >
        {upiQrAmount !== null && !isNarrowScreen && (
          <UpiQrPanel key={upiQrAmount} amount={upiQrAmount} onClose={() => setUpiQrAmount(null)} />
        )}
      </div>
      <div
        className={`bg-card flex max-h-[95vh] w-full flex-col overflow-hidden rounded-t-3xl shadow-2xl sm:max-w-md sm:rounded-2xl md:h-full md:max-h-none md:max-w-none md:rounded-e-none ${layout === 'third' ? 'md:w-1/3' : 'md:w-1/2'}`}
      >
        <div className="shrink-0 border-b border-border px-5 pb-3 pt-4 md:pb-2 md:pt-3">
          {titleRow}
          {summaryBlock}
          {discountToggle}
        </div>
        <div className="min-h-0 space-y-3 overflow-y-auto px-5 py-3 md:flex-1 md:space-y-2 md:py-2">
          {discountEditor}
          {paymentRows}
          {walletBlock}
        </div>
        <div className="shrink-0 space-y-2 px-5 pb-2 md:pb-1">
          {renderPad()}
          {changeBlock}
        </div>
        <div className="shrink-0 border-t border-border px-5 pb-6 pt-3 md:pb-3 md:pt-2">
          {confirmButton}
        </div>
      </div>
    </div>
  );
}
