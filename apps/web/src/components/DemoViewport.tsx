import { useEffect, useMemo, useRef, useState } from 'react';
import { useMutation } from '@apollo/client';
import { useTranslation } from 'react-i18next';
import { REPORT_DEMO_PATH, type Demo, type DemoPage } from '@/lib/queries';

/**
 * The viewport-preset frame (build plan L2; spec §4 stage 6, §12 Q1) — an
 * `<iframe>` onto a demo's live staging site, scaled to a preset width so a
 * reviewer can "walk the staging site at three widths" without leaving the
 * portal or the desk. Both surfaces render the same component; neither owns
 * a second copy of this logic (house rule 3).
 *
 * **Never a capture, never a proxy** (D2) — this is a plain same-tab
 * `<iframe>` at `demo.stagingUrl`, unmodified. The one piece of logic beyond
 * "render an iframe" is the postMessage handshake with the reporter snippet
 * (`snippets/demo-reporter`) — see the origin check below, which is the
 * portal-facing half of L2.2's "postMessage needs an origin check on both
 * ends."
 */

const PRESETS = {
  mobile: { width: 375, height: 812 },
  tablet: { width: 768, height: 1024 },
  desktop: { width: 1440, height: 900 },
} as const;

type Preset = keyof typeof PRESETS;

/** Below this, simulating a desktop width inside a frame is a control that
 *  cannot work (L2.2) — a real phone screen has no way to show 1440px of
 *  layout at a legible scale. */
const PHONE_MAX_WIDTH = 480;

function usePhoneViewport(): boolean {
  const [isPhone, setIsPhone] = useState(
    () => typeof window !== 'undefined' && window.innerWidth <= PHONE_MAX_WIDTH,
  );
  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${PHONE_MAX_WIDTH}px)`);
    const onChange = () => setIsPhone(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, []);
  return isPhone;
}

/** Null when `stagingUrl` somehow fails to parse — refuses to listen for
 *  messages from an origin it cannot name, rather than falling back to '*'. */
function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

export default function DemoViewport({ demo }: { demo: Demo }) {
  const { t } = useTranslation();
  const isPhone = usePhoneViewport();
  const [preset, setPreset] = useState<Preset>('desktop');
  const [matched, setMatched] = useState<DemoPage | null>(null);
  const [showDesign, setShowDesign] = useState(false);
  const [reportPath] = useMutation(REPORT_DEMO_PATH);

  const stagingOrigin = useMemo(() => originOf(demo.stagingUrl), [demo.stagingUrl]);

  useEffect(() => {
    if (!stagingOrigin) return;
    function onMessage(event: MessageEvent) {
      // L2.2: validate the *sender's* origin against the demo's own declared
      // staging host before trusting anything in the payload — the portal's
      // half of the postMessage contract the reporter snippet's README
      // documents for the other end. Without this, any page that frames this
      // component could inject page-change events of its own.
      if (event.origin !== stagingOrigin) return;
      const data = event.data as { source?: unknown; path?: unknown } | null;
      if (!data || data.source !== 'root-demo-reporter' || typeof data.path !== 'string') return;
      reportPath({ variables: { demoId: demo.id, path: data.path } })
        .then((res) => setMatched(res.data?.reportDemoPath?.page ?? null))
        .catch(() => {
          // A failed report (e.g. the session lapsed) should not break the
          // frame itself — the reviewer keeps browsing; the next navigation
          // tries again.
        });
    }
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [stagingOrigin, demo.id, reportPath]);

  const designImage = matched?.pageDesign?.imageUrl ?? null;
  const box = isPhone ? null : PRESETS[preset];

  return (
    <div className="demo-viewport">
      <div className="demo-viewport-bar">
        {isPhone ? (
          <p className="t-caption demo-phone-note">{t('demo.viewport.phoneNote')}</p>
        ) : (
          <div className="demo-preset-btns" role="group" aria-label={t('demo.viewport.presetGroup')}>
            {(Object.keys(PRESETS) as Preset[]).map((p) => (
              <button
                key={p}
                type="button"
                className={`btn btn-sm ${preset === p ? 'btn-primary' : 'btn-ghost'}`}
                aria-pressed={preset === p}
                onClick={() => setPreset(p)}
              >
                {t(`demo.viewport.preset.${p}`)}
              </button>
            ))}
          </div>
        )}

        {designImage ? (
          <button
            type="button"
            className={`btn btn-sm ${showDesign ? 'btn-primary' : 'btn-ghost'}`}
            aria-pressed={showDesign}
            onClick={() => setShowDesign((v) => !v)}
          >
            {showDesign ? t('demo.viewport.showSite') : t('demo.viewport.showDesign')}
          </button>
        ) : null}
      </div>

      {showDesign && designImage ? (
        <div className="demo-frame-outer">
          <img className="demo-frame-design" src={designImage} alt="" />
        </div>
      ) : box ? (
        <ScaledFrame src={demo.stagingUrl} width={box.width} height={box.height} title={t('demo.viewport.frameTitle')} />
      ) : (
        <div className="demo-frame-outer demo-frame-outer-native">
          <iframe className="demo-frame-native" src={demo.stagingUrl} title={t('demo.viewport.frameTitle')} />
        </div>
      )}

      <p className="t-caption demo-current-page">
        {matched ? t('demo.viewport.currentPage', { label: matched.labelFa }) : t('demo.viewport.noPageYet')}
      </p>
    </div>
  );
}

/**
 * Renders `src` at its true `width`×`height`, then scales the whole thing
 * down (`transform: scale()`) to fit the available width — "an `<iframe>`
 * whose width and height come from a preset table, transform: scale() to fit
 * the pane" (build plan L2.1), and nothing more novel than that. The outer
 * wrapper's own height tracks the *scaled* height via a ref, not a fixed id
 * — this component is rendered once per demo, and the desk phase board shows
 * several demos at once.
 */
function ScaledFrame({ src, width, height, title }: { src: string; width: number; height: number; title: string }) {
  const outerRef = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const outer = outerRef.current;
    if (!outer) return;
    const measure = () => setScale(Math.min(1, outer.clientWidth / width));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(outer);
    return () => observer.disconnect();
  }, [width]);

  return (
    <div ref={outerRef} className="demo-frame-outer" style={{ blockSize: height * scale }}>
      <iframe
        className="demo-frame-scaled"
        src={src}
        title={title}
        style={{ width, height, transform: `scale(${scale})` }}
      />
    </div>
  );
}
