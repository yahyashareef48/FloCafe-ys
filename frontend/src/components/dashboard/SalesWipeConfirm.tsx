'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { Loader2, Trash2 } from 'lucide-react';
import { useTranslations } from 'use-intl';
import toast from 'react-hot-toast';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import api from '@/lib/api';

/** Replaces the Z screen's Close button while a data wipe waits on this close. */
export function SalesWipeConfirm({
  closureId,
  fallback,
}: {
  closureId: number | null | undefined;
  fallback: ReactNode;
}) {
  const t = useTranslations('settings');
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [wiping, setWiping] = useState(false);

  useEffect(() => {
    if (!closureId) return;
    let cancelled = false;
    api
      .get('/cash-closures/sales-wipe/pending')
      .then(({ data }) => {
        if (!cancelled) setPending(data?.pending?.closureId === closureId);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [closureId]);

  if (!pending || !closureId) return <>{fallback}</>;

  const wipe = async () => {
    setWiping(true);
    try {
      await api.post('/cash-closures/sales-wipe/confirm', { closure_id: closureId });
      toast.success(t('salesWipeDone'));
      window.location.reload();
    } catch {
      toast.error(t('salesWipeFailed'));
      setWiping(false);
    }
  };

  return (
    <>
      <Button
        variant="destructive"
        onClick={() => setConfirming(true)}
        data-testid="sales-wipe-finish"
      >
        <Trash2 size={14} />
        {t('salesWipeFinish')}
      </Button>
      <Dialog open={confirming} onOpenChange={(open) => !wiping && setConfirming(open)}>
        <DialogContent className="sm:max-w-md" data-testid="sales-wipe-confirm">
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <Trash2 size={18} className="text-destructive" />
              {t('salesWipeFinish')}
            </DialogTitle>
            <DialogDescription className="text-destructive">
              {t('salesWipeConfirmText')}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)} disabled={wiping}>
              {t('cancel')}
            </Button>
            <Button variant="destructive" onClick={() => void wipe()} disabled={wiping}>
              {wiping ? <Loader2 size={14} className="animate-spin" /> : <Trash2 size={14} />}
              {t('salesWipeConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
