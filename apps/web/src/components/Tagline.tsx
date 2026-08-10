import { useTranslation } from 'react-i18next';

/**
 * The tagline, in exactly one place.
 *
 * Brand §7 licenses a **family** of faces — new · true · lasting · clear ·
 * pure, and their Persian counterparts — on the reasoning that naming the
 * object of the search would be authoring it, which is the one thing the
 * thesis refuses. Core Philosophy §7 is where the shape comes from: one
 * search wearing many faces.
 *
 * **But only one face is live at a time, across the whole site.** The family
 * is licensed vocabulary; the tagline is still singular. Rendering it from
 * one component reading one key is what makes that structural rather than a
 * rule someone has to remember — the hero and the footer cannot disagree,
 * because they are the same string.
 *
 * To change the live face: edit `tagline.face` in both locale files, and add
 * a changelog line to the brand definition. That is the whole operation, and
 * it is deliberately a two-line diff.
 *
 * The highlighted face is **one word in both languages**, which is a real
 * constraint on the family rather than a coincidence — a two-word adjective
 * unbalances the line in one language and not the other.
 */
export default function Tagline() {
  const { t } = useTranslation();

  return (
    <>
      {t('tagline.prefix')}
      <span className="beauty">{t('tagline.face')}</span>
      {t('tagline.suffix')}
    </>
  );
}
