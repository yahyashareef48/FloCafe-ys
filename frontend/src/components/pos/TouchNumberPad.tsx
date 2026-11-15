'use client';

import { Delete, RotateCcw } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  allowCurrencyDecimalKey,
  type CurrencyAmountTarget,
  type CurrencyDiscountType,
} from '@/lib/currency-input';

interface QuickValue {
  label: string;
  value: string;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  ariaLabel: string;
  clearLabel: string;
  backspaceLabel: string;
  allowDecimal?: boolean;
  max?: number;
  quickValues?: QuickValue[];
  className?: string;
  /** Taller keys for full-screen checkout layouts. */
  large?: boolean;
}

function clampValue(value: string, max?: number) {
  if (max == null || value === '' || value === '.') return value;
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return value;
  return numeric > max ? String(max) : value;
}

function appendDigit(value: string, digit: string, allowDecimal: boolean, max?: number) {
  if (digit === '.') {
    if (!allowDecimal || value.includes('.')) return value;
    return value === '' ? '0.' : `${value}.`;
  }
  const next = value === '0' ? digit : `${value}${digit}`;
  return clampValue(next, max);
}

export default function TouchNumberPad({
  value,
  onChange,
  ariaLabel,
  clearLabel,
  backspaceLabel,
  allowDecimal = true,
  max,
  quickValues = [],
  className,
  large = false,
}: Props) {
  const keyHeight = large ? 'min-h-16 text-2xl' : 'text-lg';
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', allowDecimal ? '.' : '', '0'];

  return (
    <div
      className={cn(
        'rounded-xl border border-border bg-muted/40 p-2',
        large && 'flex h-full flex-col',
        className,
      )}
      aria-label={ariaLabel}
    >
      {/* Quick amounts and Clear share one row above the digits. */}
      <div className="mb-2 flex shrink-0 gap-2">
        {quickValues.map((quick) => (
          <button
            key={`${quick.label}-${quick.value}`}
            type="button"
            onClick={() => onChange(clampValue(quick.value, max))}
            className="touch-target flex-1 rounded-lg border border-border bg-card px-3 text-sm font-semibold text-foreground transition-colors active:bg-muted"
          >
            {quick.label}
          </button>
        ))}
        <button
          type="button"
          onClick={() => onChange('')}
          className="touch-target flex-1 gap-2 rounded-lg border border-border bg-card px-3 text-sm font-semibold text-muted-foreground transition-colors active:bg-muted"
        >
          <RotateCcw size={16} />
          {clearLabel}
        </button>
      </div>
      <div className={cn('grid grid-cols-3 gap-2', large && 'min-h-0 flex-1 grid-rows-4')}>
        {keys.map((key, index) =>
          key ? (
            <button
              key={key}
              type="button"
              onClick={() => onChange(appendDigit(value, key, allowDecimal, max))}
              className={cn(
                'touch-target rounded-lg border border-border bg-card font-bold tabular-nums text-foreground transition-colors active:bg-muted',
                keyHeight,
              )}
            >
              {key}
            </button>
          ) : (
            <span key={`blank-${index}`} aria-hidden="true" />
          ),
        )}
        <button
          type="button"
          onClick={() => onChange(value.slice(0, -1))}
          className={cn(
            'touch-target rounded-lg border border-border bg-card text-muted-foreground transition-colors active:bg-muted',
            large && 'min-h-16',
          )}
          aria-label={backspaceLabel}
          title={backspaceLabel}
        >
          <Delete size={18} />
        </button>
      </div>
    </div>
  );
}

interface CurrencyTouchNumberPadProps extends Omit<Props, 'allowDecimal'> {
  currencyMaxDecimals: number;
  amountTarget: CurrencyAmountTarget;
  discountType: CurrencyDiscountType;
}

export function CurrencyTouchNumberPad({
  currencyMaxDecimals,
  amountTarget,
  discountType,
  ...props
}: CurrencyTouchNumberPadProps) {
  return (
    <TouchNumberPad
      {...props}
      allowDecimal={allowCurrencyDecimalKey(currencyMaxDecimals, amountTarget, discountType)}
    />
  );
}
