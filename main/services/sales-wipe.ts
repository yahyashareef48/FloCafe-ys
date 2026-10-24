import { getDatabase, getSettingValue, upsertSettings } from '../db';

export const DAY_CLOSE_WIPE_SETTING_KEY = 'day_close_wipe_enabled';
export const SHIFT_CLOSE_WIPE_SETTING_KEY = 'shift_close_wipe_enabled';

export type SalesWipeTrigger = 'day' | 'shift';

export type SalesWipeSettings = { dayClose: boolean; shiftClose: boolean };

export function getSalesWipeSettings(): SalesWipeSettings {
  return {
    dayClose: getSettingValue(DAY_CLOSE_WIPE_SETTING_KEY) === 'true',
    shiftClose: getSettingValue(SHIFT_CLOSE_WIPE_SETTING_KEY) === 'true',
  };
}

export function setSalesWipeSettings(input: Partial<SalesWipeSettings>): SalesWipeSettings {
  const updates: Record<string, string> = {};
  if (input.dayClose !== undefined) updates[DAY_CLOSE_WIPE_SETTING_KEY] = String(input.dayClose);
  if (input.shiftClose !== undefined) {
    updates[SHIFT_CLOSE_WIPE_SETTING_KEY] = String(input.shiftClose);
  }
  if (Object.keys(updates).length > 0) upsertSettings(updates);
  return getSalesWipeSettings();
}

export function isSalesWipeEnabled(trigger: SalesWipeTrigger): boolean {
  const settings = getSalesWipeSettings();
  return trigger === 'day' ? settings.dayClose : settings.shiftClose;
}

// Children before parents so every DELETE satisfies foreign keys.
const WIPED_TABLES = [
  'whatsapp_messages',
  'print_logs',
  'payment_transaction_refs',
  'payment_transaction_ref_conflicts',
  'payment_idempotency',
  'payment_method_merges',
  'refund_idempotency',
  'refunds',
  'bill_items',
  'bills',
  'loyalty_ledger',
  'order_audit_log',
  'order_item_addons',
  'order_items',
  'orders',
  'order_idempotency',
  'held_orders',
  'customers',
  'expense_payments',
  'expenses',
  'expense_mutations',
  'cash_sessions',
  'cash_drawer_movements',
  'cash_closures',
  'inventory_movements',
  'supply_movements',
  'cloud_sync_outbox',
  'sequences',
  'local_diagnostics',
  'diagnostics_hourly_aggregates',
  'diagnostics_delivery_gaps',
  'store_diagnostics_outbox',
] as const;

const PENDING_SETTING_KEY = 'sales_wipe_pending';

export type SalesWipePending = { trigger: SalesWipeTrigger; closureId: number };

/**
 * Removes every order, sale, customer, expense, cash, stock-history, counter, and diagnostic
 * record, restarts their row ids, and zeroes stock counts; keeps catalog, configuration, and
 * users. VACUUM then rewrites the file so no deleted row survives in free pages, search indexes,
 * or the WAL.
 */
export function wipeSalesData(): void {
  const db = getDatabase();
  db.transaction(() => {
    for (const table of WIPED_TABLES) db.prepare(`DELETE FROM ${table}`).run();
    db.prepare("INSERT INTO orders_search_fts(orders_search_fts) VALUES ('delete-all')").run();
    db.prepare(
      "INSERT INTO customers_search_fts(customers_search_fts) VALUES ('delete-all')",
    ).run();
    for (const table of ['products', 'product_variants', 'addons', 'supplies']) {
      db.prepare(`UPDATE ${table} SET stock_quantity = 0 WHERE stock_quantity != 0`).run();
    }
    db.prepare(
      "UPDATE tables SET status = 'available', reservation_customer_id = NULL WHERE status != 'available' OR reservation_customer_id IS NOT NULL",
    ).run();
    db.prepare('DELETE FROM settings WHERE key = ?').run(PENDING_SETTING_KEY);
    db.prepare(
      `DELETE FROM sqlite_sequence WHERE name IN (${WIPED_TABLES.map(() => '?').join(', ')})`,
    ).run(...WIPED_TABLES);
  })();
  db.exec('VACUUM');
  db.pragma('wal_checkpoint(TRUNCATE)');
}

export function getPendingSalesWipe(): SalesWipePending | null {
  const raw = getSettingValue(PENDING_SETTING_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (
      (parsed?.trigger === 'day' || parsed?.trigger === 'shift') &&
      Number.isInteger(parsed.closureId)
    ) {
      return { trigger: parsed.trigger, closureId: parsed.closureId };
    }
  } catch {}
  return null;
}

/** Called after a committed close; the wipe itself waits until the operator confirms on the Z screen. */
export function markSalesWipePending(trigger: SalesWipeTrigger, closureId: number): boolean {
  if (!isSalesWipeEnabled(trigger)) return false;
  upsertSettings({
    [PENDING_SETTING_KEY]: JSON.stringify({ trigger, closureId }),
  });
  return true;
}
