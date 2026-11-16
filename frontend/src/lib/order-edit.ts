import type { Order } from '@/lib/types';

/** Edit can't fix orders whose money was refunded or split across checks. */
export function canEditOrder(order: Order): boolean {
  if (order.status === 'cancelled') return false;
  const bills =
    order.bills && order.bills.length > 0 ? order.bills : order.bill ? [order.bill] : [];
  return (
    bills.length <= 1 &&
    !bills.some(
      (bill) =>
        !!bill.split_group_id ||
        bill.payment_status === 'refunded' ||
        bill.payment_status === 'partially_refunded',
    )
  );
}
