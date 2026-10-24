'use client';

import { useEffect, useState } from 'react';
import { Eraser } from 'lucide-react';
import { useTranslations } from 'use-intl';
import toast from 'react-hot-toast';
import { Toggle } from '@/components/settings/Toggle';
import api from '@/lib/api';

type SalesWipeSettings = { dayClose: boolean; shiftClose: boolean };

export function SalesWipeCard() {
  const t = useTranslations('settings');
  const [settings, setSettings] = useState<SalesWipeSettings | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    api
      .get('/db-tools/sales-wipe')
      .then(({ data }) => {
        if (!cancelled) setSettings(data);
      })
      .catch(() => {
        if (!cancelled) toast.error(t('salesWipeLoadFailed'));
      });
    return () => {
      cancelled = true;
    };
  }, [t]);

  if (!settings) return null;

  const update = async (change: Partial<SalesWipeSettings>) => {
    setBusy(true);
    try {
      const { data } = await api.put('/db-tools/sales-wipe', change);
      setSettings(data);
    } catch {
      toast.error(t('salesWipeUpdateFailed'));
    } finally {
      setBusy(false);
    }
  };

  const rows: { key: keyof SalesWipeSettings; label: string }[] = [
    { key: 'shiftClose', label: t('salesWipeShiftClose') },
    { key: 'dayClose', label: t('salesWipeDayClose') },
  ];

  return (
    <div className="bg-card rounded-xl border border-border p-6" data-testid="sales-wipe-card">
      <div className="flex items-center gap-2 mb-1">
        <Eraser size={20} className="text-muted-foreground" />
        <h2 className="font-semibold text-foreground">{t('salesWipeTitle')}</h2>
      </div>
      <p className="text-sm text-muted-foreground mb-4">{t('salesWipeHint')}</p>
      <div className="space-y-3">
        {rows.map((row) => (
          <div key={row.key} className="flex items-center justify-between gap-4">
            <span className="text-sm text-foreground">{row.label}</span>
            <Toggle
              value={settings[row.key]}
              onChange={(value) => void update({ [row.key]: value })}
              label={row.label}
              disabled={busy}
            />
          </div>
        ))}
      </div>
    </div>
  );
}
