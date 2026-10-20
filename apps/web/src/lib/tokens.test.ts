import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The design review (wp-design-review.md) found three classes of bug that no
 * existing test could see, because every one of them is a *value*, not a
 * behaviour:
 *
 *  1. A `var(--x)` that names a token nobody defined. The browser drops the
 *     whole declaration without a word — `--space-10` and `--space-5` were used
 *     for months with no definition, so the Library's lede ran into its cards and
 *     the contract page's pending banner had no padding at all.
 *  2. A text colour that is too faint on the ground it sits on. The palette's own
 *     comments claim contrast figures; nothing computed them.
 *  3. (After Phase G) the same two, in the dark appearance.
 *
 * This file reads the stylesheets as text, so it needs no browser and runs in
 * the ordinary `npm test`. Contrast is *computed* (WCAG 2.x relative luminance)
 * from the very declarations the browser will read, so a token edited without
 * its consequences fails here with the pair and the ratio.
 */

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..');
const STYLES = join(SRC, 'styles');

// ---------------------------------------------------------------------------
// A small CSS reader — just enough: comments stripped, rule blocks found by
// brace matching, `@media` bodies read recursively.

type Rule = { selector: string; body: string; media: string | null };

function stripComments(css: string): string {
  return css.replace(/\/\*[\s\S]*?\*\//g, '');
}

function readRules(css: string, media: string | null = null): Rule[] {
  const rules: Rule[] = [];
  let i = 0;
  while (i < css.length) {
    const open = css.indexOf('{', i);
    if (open === -1) break;
    const selector = css.slice(i, open).trim();
    let depth = 1;
    let j = open + 1;
    while (j < css.length && depth > 0) {
      if (css[j] === '{') depth++;
      else if (css[j] === '}') depth--;
      j++;
    }
    const body = css.slice(open + 1, j - 1);
    if (selector.startsWith('@media')) rules.push(...readRules(body, selector));
    else if (!selector.startsWith('@')) rules.push({ selector, body, media });
    i = j;
  }
  return rules;
}

function declarations(body: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of body.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) out.set(m[1]!, m[2]!.trim());
  return out;
}

function readCss(name: string): string {
  return stripComments(readFileSync(join(STYLES, name), 'utf8'));
}

// ---------------------------------------------------------------------------
// 1 · Every var(--x) a stylesheet (or a component) reads is defined.

function walk(dir: string, ext: RegExp, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, ext, out);
    else if (ext.test(name)) out.push(p);
  }
  return out;
}

test('every var(--x) used in a stylesheet is defined in tokens.css or in that same file', () => {
  const tokenNames = new Set<string>();
  for (const m of readCss('tokens.css').matchAll(/(--[\w-]+)\s*:/g)) tokenNames.add(m[1]!);

  const problems: string[] = [];
  for (const file of readdirSync(STYLES).filter((f) => f.endsWith('.css'))) {
    const css = readCss(file);
    const local = new Set<string>();
    for (const m of css.matchAll(/(--[\w-]+)\s*:/g)) local.add(m[1]!);
    for (const m of css.matchAll(/var\(\s*(--[\w-]+)/g)) {
      const name = m[1]!;
      if (!tokenNames.has(name) && !local.has(name)) problems.push(`${file}: var(${name}) is never defined`);
    }
  }
  assert.deepEqual([...new Set(problems)], [], 'a declaration using an undefined token is silently dropped by the browser');
});

test('every var(--x) written in a component (an inline style or a class string) is defined', () => {
  const tokenNames = new Set<string>();
  for (const m of readCss('tokens.css').matchAll(/(--[\w-]+)\s*:/g)) tokenNames.add(m[1]!);
  const problems: string[] = [];
  for (const file of walk(SRC, /\.tsx?$/)) {
    if (file.endsWith('.test.ts')) continue;
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/var\(\s*(--[\w-]+)/g)) {
      // A component may declare its own custom property in the same file (`'--x': …`).
      const declaredHere = new RegExp(`['"]${m[1]}['"]\\s*:`).test(text);
      if (!tokenNames.has(m[1]!) && !declaredHere) problems.push(`${file.slice(SRC.length + 1)}: var(${m[1]}) is never defined`);
    }
  }
  assert.deepEqual([...new Set(problems)], []);
});

// A dark appearance can only redefine the semantic names. A component that read
// a raw ramp (--indigo-200, --gold-600) or wrote a hex would be the one thing
// that did not switch — and would fail every contrast figure in section 2
// without the test ever seeing it. print.css is exempt: paper is always light.
test('component CSS reads semantic tokens only: no raw ramp, no hard-coded colour', () => {
  const problems: string[] = [];
  for (const file of readdirSync(STYLES).filter((f) => f.endsWith('.css') && f !== 'tokens.css' && f !== 'print.css')) {
    const css = readCss(file);
    for (const m of css.matchAll(/var\(\s*(--(?:neutral|indigo|clay|cyan|gold)-\d+)/g)) problems.push(`${file}: reads the raw ramp ${m[1]}`);
    for (const m of css.matchAll(/#[0-9a-fA-F]{3,8}\b/g)) problems.push(`${file}: hard-codes ${m[0]}`);
    for (const m of css.matchAll(/\brgba?\(/g)) problems.push(`${file}: hard-codes an ${m[0]}…) colour`);
  }
  assert.deepEqual(problems, []);
});

// ---------------------------------------------------------------------------
// 2 · Contrast, computed, in both appearances.

type Mode = 'light' | 'dark';

const tokenRules = readRules(readCss('tokens.css'));
const isDarkMedia = (r: Rule) => r.media !== null && /prefers-color-scheme:\s*dark/.test(r.media);
// The light set: every `:root` / `.force-light` block that is not inside a media query.
const lightDecls = new Map<string, string>();
const darkDecls = new Map<string, string>();
for (const r of tokenRules) {
  const sels = r.selector.split(',').map((s) => s.trim());
  if (r.media === null && sels.some((s) => s === ':root' || s === '.force-light')) {
    for (const [k, v] of declarations(r.body)) lightDecls.set(k, v);
  } else if (isDarkMedia(r) && sels.some((s) => s === ':root')) {
    for (const [k, v] of declarations(r.body)) darkDecls.set(k, v);
  }
}

function resolve(token: string, mode: Mode, seen = new Set<string>()): string {
  if (seen.has(token)) throw new Error(`token cycle at ${token}`);
  seen.add(token);
  const raw = (mode === 'dark' ? darkDecls.get(token) : undefined) ?? lightDecls.get(token);
  if (raw === undefined) throw new Error(`${token} is not defined in tokens.css (${mode})`);
  const ref = /^var\(\s*(--[\w-]+)\s*\)$/.exec(raw);
  if (ref) return resolve(ref[1]!, mode, seen);
  return raw;
}

function rgb(hex: string): [number, number, number] {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`not a #RRGGBB colour: ${hex}`);
  const n = parseInt(m[1]!, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function luminance(hex: string): number {
  const [r, g, b] = rgb(hex).map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function ratio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

/** [foreground token, background token, minimum ratio, what it is] */
type Pair = [fg: string, bg: string, min: number, label: string];

const GROUNDS = ['--color-bg', '--color-footer', '--color-panel', '--color-raised'] as const;
const onEveryGround = (fg: string, min: number, label: string): Pair[] => GROUNDS.map((g) => [fg, g, min, label]);

const PAIRS: Pair[] = [
  // Body copy tiers. Text under 18.66px regular (everything below --text-h3 unless
  // bold) needs 4.5:1 on every ground a page can put it on.
  ...onEveryGround('--color-text', 4.5, 'text'),
  ...onEveryGround('--color-text-muted', 4.5, 'muted text'),
  ...onEveryGround('--color-text-subtle', 4.5, 'subtle text (13px captions)'),
  // Links and crumbs.
  ...onEveryGround('--color-accent-text', 4.5, 'accent as text (.link-action, .req)'),
  ...onEveryGround('--color-secondary', 4.5, 'secondary as text (crumbs, .cview)'),
  ...onEveryGround('--color-error', 4.5, 'error text'),
  // Filled grounds.
  ['--color-on-accent', '--color-accent', 4.5, 'label on a clay button'],
  ['--color-on-accent', '--color-accent-hover', 4.5, 'label on a hovered clay button'],
  ['--color-text-inverse', '--color-inverse', 4.5, 'text on the indigo ground'],
  ['--color-text-on-inverse-muted', '--color-inverse', 4.5, 'secondary copy on the indigo ground'],
  ['--color-eyebrow-on-inverse', '--color-inverse', 4.5, 'eyebrow on the indigo ground'],
  ['--color-on-strong', '--color-error', 4.5, 'label on a solid error badge'],
  ['--color-on-strong', '--color-secondary', 4.5, 'label on a solid secondary fill (done pill, ticked box)'],
  // Badges: every fg/bg pair.
  ['--badge-gold-fg', '--badge-gold-bg', 4.5, 'gold badge'],
  ['--badge-cyan-fg', '--badge-cyan-bg', 4.5, 'cyan badge'],
  ['--badge-cyan-fg', '--color-secondary-soft', 4.5, 'cyan badge on the soft secondary ground'],
  ['--badge-clay-fg', '--badge-clay-bg', 4.5, 'clay badge'],
  ['--badge-indigo-fg', '--badge-indigo-bg', 4.5, 'indigo badge'],
  ['--badge-neutral-fg', '--badge-neutral-bg', 4.5, 'neutral badge'],
  ['--badge-strong-fg', '--badge-strong-bg', 4.5, 'strong (done) badge'],
  ['--color-text-muted', '--color-footer', 4.5, 'draft badge'],
  ['--color-text-subtle', '--color-panel', 4.5, 'discarded badge'],
  ['--avatar-you-fg', '--avatar-you-bg', 4.5, 'the customer’s own avatar'],
  ['--color-text', '--color-mark-bg', 4.5, 'a review highlight'],
  ['--color-text', '--color-secondary-soft', 4.5, 'text on a notice (auth-notice, a finished row)'],
  ['--color-error', '--color-accent-soft', 4.5, 'error text on its soft ground (auth-error, a removed change)'],
  ['--color-text', '--color-accent-soft', 4.5, 'text on the soft action ground'],
  ['--color-placeholder-ink', '--color-panel', 3, 'the big letter on a concept preview — LARGE text (32px bold)'],
  // Non-text: control boundaries, focus rings (WCAG 1.4.11, 3:1).
  ['--color-border-control', '--color-bg', 3, 'input / checkbox boundary on the page'],
  ['--color-border-control', '--color-raised', 3, 'input / checkbox boundary on a raised ground'],
  ['--color-focus', '--color-bg', 3, 'focus ring on the page'],
  ['--color-focus', '--color-raised', 3, 'focus ring on a raised ground'],
  ['--color-focus', '--color-panel', 3, 'focus ring on a panel'],
  ['--color-focus-on-inverse', '--color-inverse', 3, 'focus ring on the indigo ground'],
  // The tagline's gold word is large type (the hero's rung is 48/64px), so 3:1.
  ['--color-beauty', '--color-bg', 3, 'beauty — LARGE text only (hero tagline)'],
  ['--color-locked', '--color-bg', 3, 'the padlock — a meaningful icon, not text'],
];

for (const mode of ['light', 'dark'] as const) {
  test(`contrast, ${mode}: every named pair passes its threshold`, (t) => {
    if (mode === 'dark' && darkDecls.size === 0) {
      t.skip('no dark appearance defined yet');
      return;
    }
    const failures: string[] = [];
    for (const [fg, bg, min, label] of PAIRS) {
      const r = ratio(resolve(fg, mode), resolve(bg, mode));
      if (r + 1e-9 < min) {
        failures.push(`${label}: ${fg} ${resolve(fg, mode)} on ${bg} ${resolve(bg, mode)} is ${r.toFixed(2)}:1, needs ${min}:1`);
      }
    }
    assert.deepEqual(failures, [], `\n${failures.join('\n')}`);
  });
}

test('the contrast pair list is printable (run with CONTRAST_TABLE=1 to see every ratio)', () => {
  if (!process.env.CONTRAST_TABLE) return;
  for (const mode of ['light', 'dark'] as const) {
    console.log(`\n== ${mode} ==`);
    for (const [fg, bg, min, label] of PAIRS) {
      let line: string;
      try {
        line = `${ratio(resolve(fg, mode), resolve(bg, mode)).toFixed(2).padStart(6)}:1 (≥${min})  ${fg} ${resolve(fg, mode)} on ${bg} ${resolve(bg, mode)}  — ${label}`;
      } catch (e) {
        line = `   n/a  ${fg} on ${bg}: ${(e as Error).message}`;
      }
      console.log(line);
    }
  }
});

test('the palette comments’ own figures: gold-700 on gold-100 and the corrected slate', () => {
  // The two numbers tokens.css states in prose, held so the prose cannot drift.
  assert.ok(ratio(resolve('--gold-700', 'light'), resolve('--gold-100', 'light')) >= 5.5);
  assert.ok(ratio(resolve('--neutral-700', 'light'), resolve('--color-panel', 'light')) >= 5.0);
});
