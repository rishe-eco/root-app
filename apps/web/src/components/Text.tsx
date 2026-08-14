import type { ElementType, ReactNode } from 'react';
import { dirFor } from '@/lib/format';

/**
 * Corpus text embedded in interface chrome carries the language it is
 * written in, not the viewer's (R2.md §1.1) — a title or citation rendered
 * without its own lang/dir is set in the surrounding page's font and
 * direction, wrong exactly when it matters: a Persian title inside an
 * English list, or the reverse, which Vazirmatn's Latin glyphs make look
 * nearly right (persian-pass.md §1.6.1).
 */
export default function Text({
  lang,
  as: As = 'span',
  className,
  children,
}: {
  lang: string;
  as?: ElementType;
  className?: string;
  children: ReactNode;
}) {
  return (
    <As lang={lang} dir={dirFor(lang)} className={className}>
      {children}
    </As>
  );
}
