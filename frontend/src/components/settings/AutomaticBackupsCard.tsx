'use client';

import { useEffect, useState } from 'react';
import { DatabaseBackup } from 'lucide-react';
import { useTranslations } from 'use-intl';
import toast from 'react-hot-toast';
import { Toggle } from '@/components/settings/Toggle';
import { Button } from '@/components/ui/button';
import api from '@/lib/api';

export function AutomaticBackupsCard() {
  const t = useTranslations('settings');
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    api
      .get('/db-tools/automatic-backups')
      .then(({ data }) => {
        if (!cancelled) {
          setEnabled(data.enabled);
          setLoadFailed(false);
        }
      })
      .catch(() => {
        if (!cancelled) setLoadFailed(true);
      })
      .finally(() => {
        if (!cancelled) setRetrying(false);
      });
    return () => {
      cancelled = true;
    };
  }, [loadAttempt]);

  if (enabled === null && !loadFailed) return null;

  const handleChange = async (value: boolean) => {
    setBusy(true);
    try {
      const { data } = await api.put('/db-tools/automatic-backups', { enabled: value });
      setEnabled(data.enabled);
    } catch {
      toast.error(t('localBackupUpdateFailed'));
    } finally {
      setBusy(false);
    }
  };

  const retryLoad = () => {
    if (retrying) return;
    setRetrying(true);
    setLoadAttempt((attempt) => attempt + 1);
  };

  return (
    <div className="bg-card rounded-xl border border-border p-6" data-testid="automatic-backups-card">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-2 mb-1">
            <DatabaseBackup size={20} className="text-muted-foreground" />
            <h2 className="font-semibold text-foreground">{t('automaticBackupsTitle')}</h2>
          </div>
          {enabled === null ? (
            <p role="alert" className="text-sm text-destructive">
              {t('localBackupLoadFailed')}
            </p>
          ) : (
            <p className="text-sm text-muted-foreground">
              {enabled ? t('automaticBackupsHintOn') : t('automaticBackupsHintOff')}
            </p>
          )}
        </div>
        {enabled === null ? (
          <Button variant="outline" size="sm" onClick={retryLoad} disabled={retrying}>
            {t('retry')}
          </Button>
        ) : (
          <Toggle
            value={enabled}
            onChange={(value) => void handleChange(value)}
            label={t('automaticBackupsTitle')}
            disabled={busy}
          />
        )}
      </div>
    </div>
  );
}
