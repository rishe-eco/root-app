# The tagline, the hero, and the descriptor — **done 2026-08-10**

**Canon:** `root-sot/ecosystem/canon/01-philosophy/01-brand-definition.md` **1.2** · `00-core-philosophy.md` **0.2** · decision log, 2026-08-10.
**Status:** complete and browser-verified in both languages. Nothing outstanding.

This took three passes over four days, and two of them were partly undone by the third. The end state is short; the reasoning is in canon, and the *reversals* are the part worth reading before touching any of these strings again.

---

## 1 · Where it landed

**Thesis** — names no object:

> The person authors their own life. Root never authors it for them.
> انسان، نویسنده‌ی زندگیِ خودش است. ریشه هرگز جای او نمی‌نویسد.

**Tagline** — adjectival, one licensed face at a time, currently *new*:

> In search of something **new**...
> در جست‌وجوی چیزی **نو**...

**Descriptor** — always beside the tagline, never absent (two-tier rule):

> An ecosystem for knowing and growing yourself.
> زیست‌بومی برای شناختن و ساختنِ خود.

Licensed faces: **new·نو · true·راستین · lasting·ماندگار · clear·روشن · pure·ناب**. See Brand §7 for what each derives from, and why *beautiful*, *wise* and *creative* are excluded.

---

## 2 · How to change the live face

1. Edit **`tagline.face`** in `en.json` **and** `fa.json`. That is the whole code change.
2. Add a changelog line to Brand §7.

The hero and the footer both render `components/Tagline.tsx`, which reads that one key — so they **cannot** disagree. That is deliberate: the family is one bad week away from becoming five taglines, and the last four days were spent repairing exactly that kind of drift. Do not inline the prefix/face/suffix anywhere new; render the component.

**Any new face must be one word in both languages.** The gold is a single `<span>` between a prefix and a suffix; a two-word adjective unbalances the line in one language and not the other. And the Persian is the gate, not the English — *wise* and *creative* are fine English and poor Persian, and that settled them.

---

## 3 · The strings, and where they live

| Key | Used by |
|---|---|
| `tagline.prefix` / `.face` / `.suffix` | `Tagline.tsx` → the hero `<h1>` **and** the footer |
| `tagline.descriptor` | the hero lead **and** the footer — one string, two placements |
| `footer.lead` | `"Root — "` / «ریشه — » |
| `about.thesis` | one string; no highlight, no split |

**Retired:** `landing.heroPrefix/heroHighlight/heroSuffix/heroDescriptor`, `about.thesisA/thesisBeauty/thesisB`, `footer.descriptor`.

**`landing.rootCast` is kept though nothing renders it** — Root Cast is a real forthcoming strand and R2 needs the label for `/library/cast`. Same precedent as `landing.cta`.

---

## 4 · The reversals — read this before editing any of it

**Pass 1 (08-08).** "In search of beauty" → "in search of a life worth living", merging the tagline with the landing headline, which had been drifting independently. Beauty retained as the private telos.

**Pass 2 (08-09).** The hero rebuilt to one centred line plus descriptor — the tagline, a headline, a lead and a blurred Root Cast panel had been four things competing in one eyeful. Descriptor *platform* → *ecosystem*.

**Pass 3 (08-10) — reversed the phrasing from pass 1.** *"A life worth living"* places a value on a life: it implies some are not, and hands the person a standard they did not choose. So the thesis's first half was breaking its second — **to say what someone is searching for is to author it for them.** The object came out entirely, and the direction moved into an adjectival tagline that gestures without naming.

**The record of pass 1 was wrong, and the correction is the useful artefact.** Brand §3 claims the frame is *"the only one that holds all five without instrumentalizing any of them"*. Pass 1 recorded that claim as surviving. It did not: *therapy toward a worthwhile life* makes therapy a means to a verdict Root set — exactly what §3 forbids. **The fault was never the wording; it was naming an object at all.** §3 is now marked as the sentence that decides the thesis: if a future phrasing can't pass it, the phrasing goes.

**One thing was right all along and nobody had noticed.** Core Philosophy §7 says beauty is *"the direction of authorship, **not a promised result** … one search wearing many faces."* The faces are now literal — and "not a promised result" had disqualified "a life worth living" a month before it was adopted. **When a phrasing question comes up again, read §7 first.**

---

## 5 · What deliberately did not change

- **`--color-beauty` and the `.beauty` class keep their names.** Gold-is-beauty is a claim about the visual language, not the tagline, and it is still true. The class now marks *new* / «نو», which is what a colour-role class should survive.
- **Brand §8's internal decision test still says "beauty"** — and is now the only place in that file that does. That asymmetry is correct and canon explains it: a public tagline must not name the object; an internal test must, or there is nothing to hold a feature against.

---

## 6 · Verified

Typecheck clean · 120 unit tests · full locale key parity across every namespace · `/en/`, `/fa/`, `/en/about`, `/fa/about` all driven in the browser: hero and footer render the identical face, gold resolves in both placements, `dir` flips, Persian keeps `letter-spacing: normal` and drops a type rung (48px desktop → 32px at 375px), no horizontal overflow at either width, no console errors. No occurrence of *beauty*, *worth living* or *platform* survives anywhere in the app.

`01-visitor.spec.ts` asserts the hero by heading role, which also holds the landing page to having an `<h1>` at all.
