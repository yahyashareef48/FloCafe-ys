'use client';

import { useEffect, useState } from 'react';
import { Loader2, QrCode, X } from 'lucide-react';
import { useTranslations } from 'use-intl';
import api from '@/lib/api';
import { useFormatCurrency } from '@/hooks/useFormatCurrency';

interface UpiQr {
  upi_id: string;
  payee_name: string;
  amount: number;
  qr_data_url: string;
}

/** The UPI QR for one exact amount; any UPI app that scans it opens with the amount filled in. */
export function UpiQrPanel({
  amount,
  onClose,
  compact = false,
  inline = false,
}: {
  amount: number;
  onClose: () => void;
  compact?: boolean;
  /** Short side-by-side card that fits where the checkout summary sits. */
  inline?: boolean;
}) {
  const t = useTranslations('pos');
  const formatCurrency = useFormatCurrency();
  const [qr, setQr] = useState<UpiQr | null>(null);
  const [error, setError] = useState<'not_configured' | 'not_inr' | 'failed' | null>(null);

  useEffect(() => {
    let active = true;
    api
      .post<UpiQr>('/payment-methods/upi-qr', { amount })
      .then((response) => active && setQr(response.data))
      .catch((err: unknown) => {
        if (!active) return;
        const code = (err as { response?: { data?: { error?: string } } })?.response?.data?.error;
        setError(
          code === 'upi_not_configured'
            ? 'not_configured'
            : code === 'upi_requires_inr'
              ? 'not_inr'
              : 'failed',
        );
      });
    return () => {
      active = false;
    };
  }, [amount]);

  const errorText =
    error === 'not_configured'
      ? t('upiQrNotConfigured')
      : error === 'not_inr'
        ? t('upiQrNotInr')
        : t('upiQrFailed');

  if (inline) {
    return (
      <div data-testid="upi-qr-panel" className="flex items-center gap-3">
        {qr ? (
          // eslint-disable-next-line @next/next/no-img-element -- a data: URL drawn locally
          <img
            src={qr.qr_data_url}
            alt={t('upiQrTitle')}
            className="aspect-square w-40 shrink-0 rounded-lg bg-white p-1.5"
          />
        ) : (
          <div className="flex aspect-square w-40 shrink-0 items-center justify-center rounded-lg bg-muted">
            {error ? null : <Loader2 className="animate-spin text-muted-foreground" />}
          </div>
        )}
        <div className="min-w-0 flex-1">
          <p className="flex items-center gap-1.5 text-xs font-semibold text-foreground">
            <QrCode size={14} className="shrink-0 text-brand" />
            {t('upiQrTitle')}
          </p>
          <p className="mt-1 text-2xl font-bold text-foreground" data-testid="upi-qr-amount">
            {formatCurrency(amount)}
          </p>
          {error ? (
            <p className="mt-1 text-xs text-red-600" role="alert">
              {errorText}
            </p>
          ) : (
            qr && (
              <>
                {qr.payee_name && (
                  <p className="mt-1 truncate text-xs font-medium text-foreground">
                    {qr.payee_name}
                  </p>
                )}
                <p className="truncate text-[11px] text-muted-foreground">{qr.upi_id}</p>
              </>
            )
          )}
          <button
            type="button"
            onClick={onClose}
            className="mt-2 w-full rounded-lg bg-brand py-2 text-sm font-semibold text-white hover:opacity-90"
          >
            {t('upiQrDone')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      data-testid="upi-qr-panel"
      className={`relative w-full rounded-2xl bg-card text-center ${compact ? 'max-w-xs border border-border p-3' : 'max-w-sm p-5 shadow-2xl'}`}
      onClick={(event) => event.stopPropagation()}
    >
      <button
        type="button"
        onClick={onClose}
        aria-label={t('upiQrClose')}
        className="absolute end-3 top-3 rounded-lg p-2 text-muted-foreground hover:bg-muted"
      >
        <X size={18} />
      </button>
      <div className="mb-3 flex items-center justify-center gap-2 text-sm font-semibold text-foreground">
        <QrCode size={18} className="text-brand" />
        {t('upiQrTitle')}
      </div>
      <p className="text-3xl font-bold text-foreground" data-testid="upi-qr-amount">
        {formatCurrency(amount)}
      </p>
      {qr ? (
        <>
          {/* eslint-disable-next-line @next/next/no-img-element -- a data: URL drawn locally */}
          <img
            src={qr.qr_data_url}
            alt={t('upiQrTitle')}
            className={`mx-auto aspect-square w-full rounded-lg bg-white p-2 ${compact ? 'my-2 max-w-[220px]' : 'my-4 max-w-[280px]'}`}
          />
          {qr.payee_name && <p className="text-sm font-medium text-foreground">{qr.payee_name}</p>}
          <p className="text-xs text-muted-foreground">{qr.upi_id}</p>
          {!compact && <p className="mt-3 text-xs text-muted-foreground">{t('upiQrHint')}</p>}
        </>
      ) : error ? (
        <p className="my-8 text-sm text-red-600" role="alert">
          {error === 'not_configured'
            ? t('upiQrNotConfigured')
            : error === 'not_inr'
              ? t('upiQrNotInr')
              : t('upiQrFailed')}
        </p>
      ) : (
        <div className="my-16 flex justify-center">
          <Loader2 className="animate-spin text-muted-foreground" />
        </div>
      )}
      <button
        type="button"
        onClick={onClose}
        className="mt-4 w-full rounded-xl bg-brand py-3 text-sm font-semibold text-white hover:opacity-90"
      >
        {t('upiQrDone')}
      </button>
    </div>
  );
}

/** The UPI QR over the checkout, for screens too narrow to show it beside the checkout. */
export default function UpiQrDialog({ amount, onClose }: { amount: number; onClose: () => void }) {
  const t = useTranslations('pos');

  // Keeps Enter/Space/Escape from reaching the checkout behind this dialog.
  useEffect(() => {
    const handleKey = (event: KeyboardEvent) => {
      if (!['Escape', 'Enter', ' '].includes(event.key)) return;
      event.stopImmediatePropagation();
      event.preventDefault();
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', handleKey, true);
    return () => window.removeEventListener('keydown', handleKey, true);
  }, [onClose]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t('upiQrTitle')}
      data-testid="upi-qr-dialog"
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/70 p-4"
      onClick={onClose}
    >
      <UpiQrPanel key={amount} amount={amount} onClose={onClose} />
    </div>
  );
}
