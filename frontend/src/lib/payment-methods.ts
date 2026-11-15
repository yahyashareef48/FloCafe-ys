import { Banknote, CreditCard, QrCode, type LucideIcon } from 'lucide-react';

export const PAYMENT_METHODS = Object.freeze([
  { key: 'cash' as const, labelKey: 'pos.methodCash', icon: Banknote },
  { key: 'card' as const, labelKey: 'pos.methodCard', icon: CreditCard },
]);

/** Built-in tenders offered at checkout: Card only when the store turned it on. */
export function checkoutPaymentMethods(cardEnabled: boolean) {
  return PAYMENT_METHODS.filter((method) => cardEnabled || method.key !== 'card');
}

/** True for a store-defined payment method named as UPI. */
export function isUpiMethodName(name: string): boolean {
  return /\bupi\b/i.test(name);
}

/** The icon of a store-defined payment method, when its name says what it is. */
export function customPaymentMethodIcon(name: string): LucideIcon | undefined {
  return isUpiMethodName(name) ? QrCode : undefined;
}

export interface CustomPaymentMethod {
  id: number;
  name: string;
  is_active: boolean;
  sort_order: number;
  usage_count?: number;
}
