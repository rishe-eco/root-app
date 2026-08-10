import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * A password input with a show/hide toggle. The eye is built from plain
 * spans and CSS, not an icon font or SVG — same convention as Lock.tsx.
 */
export default function PasswordField({
  id,
  label,
  value,
  onChange,
  autoComplete,
  help,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (value: string) => void;
  autoComplete: string;
  help?: ReactNode;
}) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);

  return (
    <div className="field">
      <label className="label" htmlFor={id}>
        {label}
      </label>
      <div className="password-wrap">
        <input
          id={id}
          className="input"
          type={visible ? 'text' : 'password'}
          autoComplete={autoComplete}
          dir="ltr"
          required
          value={value}
          onChange={(e) => onChange(e.target.value)}
        />
        <button
          type="button"
          className="password-toggle"
          aria-label={t(visible ? 'auth.hidePassword' : 'auth.showPassword')}
          aria-pressed={visible}
          onClick={() => setVisible((v) => !v)}
        >
          <span className="eye" aria-hidden="true">
            <span className="eye-lens" />
            <span className="eye-pupil" />
            {visible ? <span className="eye-slash" /> : null}
          </span>
        </button>
      </div>
      {help}
    </div>
  );
}
