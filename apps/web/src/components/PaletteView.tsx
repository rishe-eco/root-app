import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import { pick } from '@/lib/format';
import type { DesignPaletteItem } from '@/lib/queries';
import { fontFamilyFor, readableOn, specimenLines } from '@/lib/design';

/**
 * One palette item as its reader sees it (journeys build plan J8), used by both
 * the customer's page and the designer's, so what the designer sets is drawn
 * exactly as the customer reads it.
 *
 * - **A colour is a swatch** with its hex beside it (the hex is an identifier,
 *   Latin whatever the page's language — house rule 14).
 * - **A font is a specimen, and a specimen is always Persian as well as Latin**
 *   (`specimenLines`): a typeface chosen from a Latin sample can lack every
 *   Persian glyph, and the first place that shows is the mockup. The stack ends
 *   in a generic family, never Root's own Persian face — a fallback would hide
 *   the very thing the specimen is for.
 * - **Logo usage is a sentence**, with the picture if the designer attached one.
 *
 * The colour and font values are data the designer typed, so they are set as
 * inline style; the API only stores a `#rrggbb` and a name of letters, digits,
 * spaces, dots and hyphens (`lib/palette.ts`), and `fontFamilyFor` drops quotes
 * regardless.
 */

export function Swatch({ item }: { item: DesignPaletteItem }) {
  const locale = useLocale();
  return (
    <div className="palette-swatch" data-testid="palette-swatch" data-role={item.role}>
      <span
        className="palette-chip"
        style={{ background: item.value, color: readableOn(item.value) }}
        aria-hidden="true"
      />
      <span className="palette-meta">
        <span className="palette-label">{pick(item, 'label', locale)}</span>
        <span className="palette-value num-latin" dir="ltr">
          {item.value}
        </span>
      </span>
    </div>
  );
}

export function Specimen({ item }: { item: DesignPaletteItem }) {
  const locale = useLocale();
  const family = fontFamilyFor(item.value);
  return (
    <div className="palette-specimen" data-testid="palette-specimen" data-role={item.role}>
      <div className="palette-meta">
        <span className="palette-label">{pick(item, 'label', locale)}</span>
        <span className="palette-value num-latin" dir="ltr">
          {item.value}
        </span>
      </div>
      {item.imageUrl ? <img className="palette-image" src={item.imageUrl} alt="" /> : null}
      {specimenLines().map((line) => (
        <p key={line.lang} className="palette-specimen-line" lang={line.lang} dir={line.dir} style={{ fontFamily: family }}>
          {line.text}
        </p>
      ))}
    </div>
  );
}

export function LogoNote({ item }: { item: DesignPaletteItem }) {
  const locale = useLocale();
  return (
    <div className="palette-logo" data-testid="palette-logo" data-role={item.role}>
      {item.imageUrl ? <img className="palette-image" src={item.imageUrl} alt="" /> : null}
      <span className="palette-label">{pick(item, 'label', locale)}</span>
      <span className="palette-note">{item.value}</span>
    </div>
  );
}

export function PaletteItemView({ item }: { item: DesignPaletteItem }) {
  if (item.kind === 'COLOR') return <Swatch item={item} />;
  if (item.kind === 'FONT') return <Specimen item={item} />;
  return <LogoNote item={item} />;
}

/** The section heading for a kind (customer and designer copy is the same). */
export function PaletteKindTitle({ kind }: { kind: DesignPaletteItem['kind'] }) {
  const { t } = useTranslation();
  const key = kind === 'COLOR' ? 'palette.colors' : kind === 'FONT' ? 'palette.fonts' : 'palette.logo';
  return <h4 className="t-eyebrow palette-kind">{t(`design.${key}`)}</h4>;
}
