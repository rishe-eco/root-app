/**
 * Root demo reporter — build plan D2 / L2.2.
 *
 * Ships in a customer's *staging* theme, as a build-time include, never in
 * their production bundle (see README.md in this directory for the three
 * guards this depends on and the two this file cannot enforce on its own).
 *
 * What it does, and nothing else: reports the current path to the parent
 * frame on load, and again on every SPA-shaped navigation (`pushState` /
 * `popstate`). The portal (apps/web) matches that path against the demo's
 * declared page list (apps/api/src/lib/demoPages.ts) — this file has no
 * opinion about matching; it only ever reports.
 */
(function () {
  'use strict';

  var script = document.currentScript;

  // Guard 1 (L2.2): an explicit runtime flag, separate from the build-time
  // guard the README asks for. A `<script>` tag left in a production build by
  // mistake still does nothing unless this attribute is also "true" — two
  // independent ways the leak has to happen at once, not one.
  if (!script || script.getAttribute('data-enabled') !== 'true') return;

  // Guard 2 (L2.2): refuse to run when not framed at all. A reporter posting
  // a customer's browsing path out of their own, un-embedded live store is
  // the exact leak this stage exists to prevent — top-level navigation is
  // never a demo review.
  if (window.parent === window) return;

  // Guard 3 (L2.2, the portal-facing half of the origin check): the target
  // origin for postMessage, never '*'. Passing a concrete origin here is what
  // makes the browser itself refuse delivery if this page is ever framed by
  // anything other than Root's own portal — the snippet does not (cannot)
  // read window.parent.location cross-origin to check this by hand; the
  // browser enforces it as part of postMessage's own contract.
  var rootOrigin = script.getAttribute('data-root-origin');
  if (!rootOrigin) return;

  function currentPath() {
    return location.pathname + location.search + location.hash;
  }

  function report() {
    window.parent.postMessage({ source: 'root-demo-reporter', path: currentPath() }, rootOrigin);
  }

  var originalPushState = history.pushState;
  history.pushState = function () {
    var result = originalPushState.apply(this, arguments);
    report();
    return result;
  };
  window.addEventListener('popstate', report);

  report();
})();
