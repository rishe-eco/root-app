import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocale } from '@/lib/locale';
import { splitByScript } from '@/lib/titleScript';

/**
 * DX4 (desk UX review 26): **one title field wherever a title is typed.**
 *
 * One input. Whatever is typed goes into the column of its own script (any
 * Persian or Arabic letter: the Persian column; otherwise the English one; no
 * letters at all: the panel's language), and the other column is `''`. The
 * parent keeps the pair as two strings and sends both to its mutation as it
 * always did, so nothing downstream changes shape (decision log row 21).
 *
 * "Add the other language" opens a second input; from then on the two inputs
 * are the two columns, labelled by language, with no detection between them. A
 * row that already has both languages opens with both. Changing what the one
 * input holds from one script to the other moves the text to the other column
 * and loses nothing else: a second input, once open, is never emptied by this
 * component.
 *
 * Saving is the parent's: its form's blur (see `useAutosave`) or its button.
 * The component holds only the text being typed, so a half-typed digit string
 * does not flip columns under the cursor.
 */
export default function TitleField({
  fa,
  en,
  onChange,
  idBase,
  label,
  disabled = false,
  testId,
}: {
  fa: string;
  en: string;
  onChange: (next: { fa: string; en: string }) => void;
  idBase: string;
  /** The single input's label; defaults to "Title". Two inputs are labelled by their language. */
  label?: string;
  disabled?: boolean;
  testId?: string;
}) {
  const { t } = useTranslation();
  const locale = useLocale();
  const both = fa.trim() !== '' && en.trim() !== '';
  const [opened, setOpened] = useState(both);
  const [text, setText] = useState(fa || en);
  const two = opened || both;

  // An outside change (a refetch, a reset) wins over what was typed; typing never trips this,
  // because the pair the parent holds is always the split of the text.
  useEffect(() => {
    const split = splitByScript(text, locale);
    if (split.fa !== fa || split.en !== en) setText(fa || en);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fa, en]);

  if (two) {
    return (
      <div className="editor-grid-2 title-field" data-testid={testId} data-mode="two">
        <div className="field">
          <label className="label" htmlFor={`${idBase}-fa`}>
            {t('workspace.titleFa')}
          </label>
          <input
            id={`${idBase}-fa`}
            className="input"
            dir="rtl"
            value={fa}
            readOnly={disabled}
            onChange={(e) => onChange({ fa: e.target.value, en })}
            data-testid={testId ? `${testId}-fa` : undefined}
          />
        </div>
        <div className="field">
          <label className="label" htmlFor={`${idBase}-en`}>
            {t('workspace.titleEn')}
          </label>
          <input
            id={`${idBase}-en`}
            className="input"
            dir="ltr"
            value={en}
            readOnly={disabled}
            onChange={(e) => onChange({ fa, en: e.target.value })}
            data-testid={testId ? `${testId}-en` : undefined}
          />
        </div>
      </div>
    );
  }

  return (
    <div className="field title-field" data-testid={testId} data-mode="one">
      <label className="label" htmlFor={`${idBase}-title`}>
        {label ?? t('workspace.title')}
      </label>
      <input
        id={`${idBase}-title`}
        className="input"
        dir="auto"
        value={text}
        readOnly={disabled}
        onChange={(e) => {
          setText(e.target.value);
          onChange(splitByScript(e.target.value, locale));
        }}
        data-testid={testId ? `${testId}-one` : undefined}
      />
      {disabled ? null : (
        <button
          type="button"
          className="btn btn-ghost btn-sm title-field-add"
          onClick={() => setOpened(true)}
          data-testid={testId ? `${testId}-add-other` : undefined}
        >
          {t('workspace.addOtherLanguage')}
        </button>
      )}
    </div>
  );
}
