'use client';

import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import toast from 'react-hot-toast';
import { useTranslations } from 'use-intl';
import { Button } from '@/components/ui/button';
import api from '@/lib/api';
import type { Order, Staff } from '@/lib/types';
import { useAuthStore } from '@/store/auth';

interface DeleteOrderModalProps {
  order: Order;
  onClose: () => void;
  onDeleted: () => void;
}

/** Erases an order entered by mistake once an owner approves with their staff PIN. */
export default function DeleteOrderModal({ order, onClose, onDeleted }: DeleteOrderModalProps) {
  const t = useTranslations('orders');
  const tCommon = useTranslations('common');
  const user = useAuthStore((state) => state.user);
  const [owners, setOwners] = useState<Staff[] | null>(null);
  const [ownerId, setOwnerId] = useState('');
  const [pin, setPin] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    let cancelled = false;
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
  }, [user?.id]);

  const selectedOwner = owners?.find((member) => String(member.id) === ownerId);
  const canSubmit = !submitting && !!selectedOwner && pin.length >= 4;

  const submit = async () => {
    if (!canSubmit) return;
    setSubmitting(true);
    try {
      await api.delete(`/orders/${order.id}`, {
        data: { approver_id: ownerId, override_pin: pin },
      });
      toast.success(t('orderDeleted'));
      onDeleted();
    } catch (error) {
      const status = (error as { response?: { status?: number } })?.response?.status;
      toast.error(status === 403 ? t('deleteOrderWrongPin') : t('deleteOrderFailed'));
      setPin('');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
      <div className="bg-card rounded-xl shadow-xl p-6 w-full max-w-sm mx-4 max-h-[90vh] overflow-y-auto">
        <h2 className="text-lg font-bold text-foreground mb-2">{t('deleteOrder')}</h2>
        <p className="text-sm text-muted-foreground mb-4">
          {t('deleteOrderWarning', { number: order.order_number })}
        </p>

        {owners === null && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 size={14} className="animate-spin" />
            {t('deleteOrderOwnerLabel')}
          </div>
        )}

        {owners !== null && owners.length === 0 && (
          <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
            {t('deleteOrderNoOwnerPin')}
          </p>
        )}

        {owners !== null && owners.length > 0 && (
          <div className="space-y-4">
            {owners.length > 1 ? (
              <div>
                <label
                  htmlFor="deleteOrderOwner"
                  className="block text-sm font-medium text-foreground mb-1"
                >
                  {t('deleteOrderOwnerLabel')}
                </label>
                <select
                  id="deleteOrderOwner"
                  value={ownerId}
                  onChange={(e) => {
                    setOwnerId(e.target.value);
                    setPin('');
                  }}
                  disabled={submitting}
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
              <p className="text-sm text-muted-foreground">
                {t('deleteOrderOwnerLabel')}:{' '}
                <span className="font-medium text-foreground">{owners[0].name}</span>
              </p>
            )}
            <div>
              <label
                htmlFor="deleteOrderPin"
                className="block text-sm font-medium text-foreground mb-1"
              >
                {t('deleteOrderPinLabel')}
              </label>
              <input
                id="deleteOrderPin"
                type="password"
                inputMode="numeric"
                autoComplete="off"
                value={pin}
                maxLength={6}
                onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submit();
                }}
                disabled={submitting}
                className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm"
              />
            </div>
          </div>
        )}

        <div className="flex justify-end gap-2 mt-6">
          <Button variant="outline" size="sm" onClick={onClose} disabled={submitting}>
            {tCommon('cancel')}
          </Button>
          <Button variant="destructive" size="sm" onClick={submit} disabled={!canSubmit}>
            {submitting ? <Loader2 size={14} className="animate-spin me-1.5" /> : null}
            {submitting ? t('deletingOrder') : t('deleteOrder')}
          </Button>
        </div>
      </div>
    </div>
  );
}
