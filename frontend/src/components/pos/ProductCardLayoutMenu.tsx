'use client';

import { LayoutGrid, Minus, Plus } from 'lucide-react';
import { useTranslations } from 'use-intl';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Toggle } from '@/components/settings/Toggle';
import {
  POS_CARD_TEXT_SCALE_MAX,
  POS_CARD_TEXT_SCALE_MIN,
  usePosSettingsStore,
} from '@/store/pos-settings';

const COLUMN_CHOICES = [2, 3, 4, 5, 6, 7, 8] as const;

/** Per-device product card layout: cards per row, text size, and pictures on or off. */
export default function ProductCardLayoutMenu() {
  const t = useTranslations('pos');
  const {
    posGridColumns,
    setPosGridColumns,
    posCardTextScale,
    setPosCardTextScale,
    showProductImages,
    setShowProductImages,
  } = usePosSettingsStore();
  const choiceClass = (active: boolean) =>
    `h-8 min-w-8 px-2 rounded-md border text-sm font-medium transition-colors ${
      active
        ? 'bg-brand text-white border-brand'
        : 'bg-card text-foreground border-border hover:border-brand/40'
    }`;

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          data-testid="pos-card-layout-button"
          aria-label={t('cardLayout')}
          title={t('cardLayout')}
          className="shrink-0 h-[38px] w-[38px] flex items-center justify-center rounded-xl border border-border bg-card text-muted-foreground hover:text-foreground hover:border-brand/40 transition-colors"
        >
          <LayoutGrid size={16} />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="end"
        className="w-72 p-3 space-y-4"
        data-testid="pos-card-layout-menu"
      >
        <div>
          <p className="text-sm font-semibold text-foreground mb-2">{t('cardsPerRow')}</p>
          <div className="flex flex-wrap gap-1.5">
            <button
              type="button"
              className={choiceClass(posGridColumns === null)}
              aria-pressed={posGridColumns === null}
              onClick={() => setPosGridColumns(null)}
            >
              {t('cardsPerRowAuto')}
            </button>
            {COLUMN_CHOICES.map((columns) => (
              <button
                key={columns}
                type="button"
                className={choiceClass(posGridColumns === columns)}
                aria-pressed={posGridColumns === columns}
                onClick={() => setPosGridColumns(columns)}
              >
                {columns}
              </button>
            ))}
          </div>
        </div>
        <div>
          <p className="text-sm font-semibold text-foreground mb-2">{t('cardTextSize')}</p>
          <div className="flex items-center gap-2">
            <button
              type="button"
              className={choiceClass(false)}
              aria-label={t('cardTextSmaller')}
              disabled={posCardTextScale <= POS_CARD_TEXT_SCALE_MIN}
              onClick={() => setPosCardTextScale(posCardTextScale - 0.1)}
            >
              <Minus size={14} />
            </button>
            <span
              className="w-14 text-center text-sm font-medium tabular-nums"
              data-testid="pos-card-text-size"
            >
              {Math.round(posCardTextScale * 100)}%
            </span>
            <button
              type="button"
              className={choiceClass(false)}
              aria-label={t('cardTextLarger')}
              disabled={posCardTextScale >= POS_CARD_TEXT_SCALE_MAX}
              onClick={() => setPosCardTextScale(posCardTextScale + 0.1)}
            >
              <Plus size={14} />
            </button>
          </div>
        </div>
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-semibold text-foreground">{t('cardShowPictures')}</p>
          <Toggle
            value={showProductImages}
            onChange={setShowProductImages}
            label={t('cardShowPictures')}
          />
        </div>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
