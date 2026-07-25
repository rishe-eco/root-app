/**
 * The padlock. Two divs — shackle and body — because the whole system is
 * CSS/markup with no icon font. Gold, because "coming later" is a promise,
 * not a warning.
 */
export default function Lock() {
  return (
    <span className="lock" aria-hidden="true">
      <span className="lock-shackle" />
      <span className="lock-body" />
    </span>
  );
}
