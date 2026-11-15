'use client';

import { useEffect, useState } from 'react';
import { Printer, X } from 'lucide-react';
import { useTranslations } from 'use-intl';
import toast from 'react-hot-toast';
import api from '@/lib/api';
import { usePrintPartsStore, type PrintPartLabel, type PrintPartsState } from '@/store/print-parts';

/** Asks the operator to print each waiting part of a no-cutter printer set to print in parts. */
export default function PrintPartsBanner() {
  const t = useTranslations('pos');
  const parts = usePrintPartsStore((state) => state.parts);
  const setParts = usePrintPartsStore((state) => state.setParts);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api
      .get<{ print_parts?: PrintPartsState }>('/printers/parts-queue')
      .then((response) => setParts(response.data.print_parts))
      .catch(() => undefined);
  }, [setParts]);

  if (!parts) return null;
  const next = parts.pending[0];

  const partName = (part: PrintPartLabel) =>
    part.kind === 'bill'
      ? t('printPartsBill')
      : part.kind === 'kot'
        ? t('printPartsKitchen', { station: part.station || '' })
        : t('printPartsOther');

  const run = async (path: 'next' | 'discard') => {
    setBusy(true);
    try {
      const response = await api.post<{ print_parts?: PrintPartsState }>(
        `/printers/parts-queue/${path}`,
      );
      setParts(response.data.print_parts);
    } catch (error: unknown) {
      const data = (error as { response?: { data?: { print_parts?: PrintPartsState } } })?.response
        ?.data;
      if (data?.print_parts) setParts(data.print_parts);
      toast.error(t('printPartsFailed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      role="status"
      className="fixed inset-x-0 bottom-4 z-50 flex justify-center px-4 pointer-events-none"
    >
      <div className="pointer-events-auto flex w-full max-w-md items-center gap-3 rounded-xl border border-border bg-card p-3 shadow-lg">
        <Printer size={20} className="shrink-0 text-brand" aria-hidden />
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-foreground">
            {t('printPartsPrinted', { printed: parts.printed, total: parts.total })}
          </p>
          <p className="truncate text-xs text-muted-foreground">
            {t('printPartsNext', { part: partName(next) })}
          </p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => run('next')}
          className="shrink-0 rounded-lg bg-brand px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
        >
          {t('printPartsPrintNext')}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => run('discard')}
          title={t('printPartsSkip')}
          aria-label={t('printPartsSkip')}
          className="shrink-0 rounded-lg p-2 text-muted-foreground hover:bg-muted disabled:opacity-50"
        >
          <X size={16} />
        </button>
      </div>
    </div>
  );
}
