/**
 * The customer portal's six rail icons (wp-design-review.md Phase C1;
 * wp-dashboards.md #10, which found every item wearing the same 7px outlined
 * square).
 *
 * Inline SVG, because the kit's other glyphs (the lock, the eye) are markup too
 * and an icon library would be the first dependency the design system had —
 * a path is markup. One stroke weight (1.75 at 24px, so ≈1.5px at 20px, the
 * weight of the 16px label beside it), round caps and joins, and `currentColor`
 * so the icon takes whatever the link takes: muted, hovered, active, or dark.
 *
 * Decorative: the label next to it is the accessible name, so the icon is
 * `aria-hidden` and not focusable. (On a phone the label is *shown* under the
 * icon — the bar never relies on the icon alone.)
 *
 * None of these mirror in RTL: a wrench, a page and a grid are not directional.
 * The speech bubble is the exception, because its tail marks who is speaking —
 * `.portal-icon-mirror` flips it (portal.css) so the tail stays on the inline
 * start side in both directions.
 */

export type PortalIconName = 'dashboard' | 'contracts' | 'invoices' | 'tools' | 'support' | 'desk';

const PATHS: Record<PortalIconName, JSX.Element> = {
  // Four squares — the dashboard as a set of tiles.
  dashboard: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="1.5" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="1.5" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="1.5" />
    </>
  ),
  // A page with a folded corner and two lines of text.
  contracts: (
    <>
      <path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z" />
      <path d="M14 3v5h5" />
      <path d="M9 13h6M9 17h6" />
    </>
  ),
  // A receipt whose foot is a zigzag.
  invoices: (
    <>
      <path d="M5 3h14v18l-2.33-1.5L14.33 21 12 19.5 9.67 21 7.33 19.5 5 21z" />
      <path d="M9 8h6M9 12h6" />
    </>
  ),
  // A spanner: a round head with an open jaw, and a handle at 45 degrees.
  tools: (
    <path d="M14.5 5.2a4.2 4.2 0 0 0-5.3 5.3L4.4 15.3a2.1 2.1 0 0 0 3 3l4.8-4.8a4.2 4.2 0 0 0 5.3-5.3l-2.6 2.6-2.5-.6-.6-2.5z" />
  ),
  // A speech bubble, tail at the bottom start (flipped in RTL by CSS).
  support: (
    <>
      <path d="M4 6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-7l-4.5 4v-4H6a2 2 0 0 1-2-2z" />
      <path d="M8 9h8M8 12h5" />
    </>
  ),
  // A briefcase: the staff desk.
  desk: (
    <>
      <rect x="3" y="7" width="18" height="13" rx="2" />
      <path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7" />
      <path d="M3 13h18" />
    </>
  ),
};

export default function PortalIcon({ name }: { name: PortalIconName }) {
  return (
    <svg
      className={name === 'support' ? 'portal-icon portal-icon-mirror' : 'portal-icon'}
      viewBox="0 0 24 24"
      width="20"
      height="20"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  );
}
