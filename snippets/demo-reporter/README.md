# The demo reporter snippet

Build plan D2 / L2 / L2.2. This is the ~20-line asset that lets the portal's
live-demo frame (`apps/web`) know which page a reviewer is looking at, on a
site Root itself built and deployed to staging. It is **not** part of
root-app's own build — it ships inside a *customer's* staging theme, the same
way a footer include or an analytics tag would.

## What it does

On load, and again on every `pushState`/`popstate` navigation (covers
client-routed SPA-shaped sites as well as plain multi-page ones), it posts the
current path to the parent frame:

```js
window.parent.postMessage({ source: 'root-demo-reporter', path: '/products' }, rootOrigin);
```

The portal receives this, matches the path against the demo's declared page
list (`apps/api/src/lib/demoPages.ts`'s `matchDemoPath`), and shows the
matching page's notes and design image — or records it as a page nobody
expected (`DemoUnmatchedPath`) if nothing matches. This file has no opinion
about any of that; it only ever reports.

## How to include it

1. Copy `root-demo-reporter.js` into the customer's staging theme (a static
   asset, served from wherever the theme already serves its own scripts).
2. Include it **only in the staging build**, never in the production one —
   this is the build-time half of the leak guard (L2.2's first guard, "an
   environment flag"). Concretely, whatever build step distinguishes staging
   from production for this project (an environment variable, a separate
   theme variant, a deploy target) must be the thing deciding whether this
   `<script>` tag exists in the rendered HTML at all — not a runtime check
   alone.
3. Set both data attributes on the tag:

   ```html
   <script
     src="/assets/root-demo-reporter.js"
     data-enabled="true"
     data-root-origin="https://studio.root.example"
   ></script>
   ```

   - `data-enabled="true"` is the second, independent leak guard (L2.2): even
     if step 2 fails and the tag ships in production by accident, the script
     does nothing unless this attribute is also present and exactly `"true"`.
     Do not template this from the same flag that gates step 2 — the whole
     point is two unrelated failures having to happen at once.
   - `data-root-origin` must be the portal's own origin, exactly as the
     browser will see it (scheme + host + port). This is passed as
     `postMessage`'s `targetOrigin`, never `'*'` — the browser itself refuses
     delivery if the frame's parent is not that origin, which is the
     snippet's whole answer to "validate the parent's origin" (L2.2). The
     snippet cannot read `window.parent.location` to check this by hand
     (that would be exactly the cross-origin read browsers block), so getting
     this value right at include time is the only place the check happens.

## The third guard: `frame-ancestors`

The snippet refuses to run when it is not framed at all (`window.parent ===
window`), but nothing in *this file* stops some other, unrelated origin from
framing the staging site and receiving the same postMessage broadcast the
portal expects. That is a response header on the staging host, not something
a client-side script can enforce:

```
Content-Security-Policy: frame-ancestors https://studio.root.example;
```

Set this on the staging deployment itself (Nginx, the theme's own headers,
wherever the site's other security headers already live). Naming only Root's
own origin means a page framing the staging site from anywhere else fails to
load at all, rather than loading and silently listening in.

## What this snippet is not

- Not a capture mechanism — it reports a path, never a screenshot or the
  page's content (build plan L2.1: no automatic capture-at-publish).
- Not a proxy — it runs inside the customer's own site, unmodified otherwise
  (D2 rejects a rewriting reverse proxy outright).
- Not the portal's half of the origin check. The portal validates the
  *sender's* origin against the demo's declared staging host
  (`Demo.stagingUrl`) before trusting any incoming `postMessage` — see
  `apps/web/src/components/DemoViewport.tsx`. Both ends check; neither one
  checking is enough on its own.
