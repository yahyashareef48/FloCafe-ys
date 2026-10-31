'use client';

import {
  GripVertical,
  LayoutGrid,
  Minus,
  Plus,
  RectangleHorizontal,
  RectangleVertical,
  Rows3,
  Square,
} from 'lucide-react';
import { useTranslations } from 'use-intl';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { Toggle } from '@/components/settings/Toggle';
import {
  POS_CARD_TEXT_SCALE_MAX,
  POS_CARD_TEXT_SCALE_MIN,
  usePosSettingsStore,
  type PosCardOrder,
  type PosCardShape,
} from '@/store/pos-settings';

const COLUMN_CHOICES = [2, 3, 4, 5, 6, 7, 8] as const;
const SHAPE_CHOICES = [
  { shape: 'square', label: 'cardShapeSquare', Icon: Square },
  { shape: 'rectangle', label: 'cardShapeRectangle', Icon: RectangleHorizontal },
  { shape: 'tall', label: 'cardShapeTall', Icon: RectangleVertical },
  { shape: 'rows', label: 'cardShapeRows', Icon: Rows3 },
] as const satisfies readonly { shape: PosCardShape; label: string; Icon: typeof Square }[];
const ORDER_CHOICES = [
  { order: 'store', label: 'cardOrderStore' },
  { order: 'popular', label: 'cardOrderPopular' },
  { order: 'custom', label: 'cardOrderCustom' },
] as const satisfies readonly { order: PosCardOrder; label: string }[];

/**
 * Per-device product card layout: cards per row, shape, text size, pictures, card order (catalog,
 * most used, or dragged), category sections, and the drag-to-arrange mode.
 */
export default function ProductCardLayoutMenu() {
  const t = useTranslations('pos');
  const {
    posGridColumns,
    setPosGridColumns,
    posCardTextScale,
    setPosCardTextScale,
    showProductImages,
    setShowProductImages,
    posCardShape,
    setPosCardShape,
    posCardOrder,
    setPosCardOrder,
    posGroupByCategory,
    setPosGroupByCategory,
    setPosArrangingCards,
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
          <p className="text-sm font-semibold text-foreground mb-2">{t('cardShape')}</p>
          <div className="grid grid-cols-4 gap-1.5">
            {SHAPE_CHOICES.map(({ shape, label, Icon }) => (
              <button
                key={shape}
                type="button"
                data-testid={`pos-card-shape-${shape}`}
                className={`${choiceClass(posCardShape === shape)} h-auto py-1.5 flex flex-col items-center gap-1 text-xs`}
                aria-pressed={posCardShape === shape}
                onClick={() => setPosCardShape(shape)}
              >
                <Icon size={16} />
                {t(label)}
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
        <div>
          <p className="text-sm font-semibold text-foreground mb-2">{t('cardOrder')}</p>
          <div className="grid grid-cols-3 gap-1.5">
            {ORDER_CHOICES.map(({ order, label }) => (
              <button
                key={order}
                type="button"
                data-testid={`pos-card-order-${order}`}
                className={`${choiceClass(posCardOrder === order)} h-auto py-1.5 text-xs`}
                aria-pressed={posCardOrder === order}
                onClick={() => setPosCardOrder(order)}
              >
                {t(label)}
              </button>
            ))}
          </div>
        </div>
        <div className="flex items-center justify-between gap-3">
          <p className="text-sm font-semibold text-foreground">{t('cardGroupByCategory')}</p>
          <Toggle
            value={posGroupByCategory}
            onChange={setPosGroupByCategory}
            label={t('cardGroupByCategory')}
          />
        </div>
        <DropdownMenuItem
          data-testid="pos-arrange-cards"
          onSelect={() => setPosArrangingCards(true)}
          className="justify-center gap-2 rounded-md border border-border py-2 text-sm font-medium"
        >
          <GripVertical size={16} />
          {t('arrangeCards')}
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
