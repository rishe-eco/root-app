# The Persian pass

**Branch:** `stage-persian-pass`
**Needs:** everything. It is last because it audits the whole surface.
**Blocks:** nothing — but it is the stage that decides whether the product's own claim about itself is true.
**Spec:** none. The build plan lists it as the final item and never says what it is. **This file defines it**, which means the definition is a proposal — argue with it before starting.

**Acceptance:** the mechanical defects are gone and held by tests; the judgement defects are listed, triaged, and either fixed or recorded as accepted. Root reads the Persian product and recognises it as written rather than translated.

---

## 0 · What this is, and what it is not

Brand §2: *"Persian is the native tongue of the work… the brand speaks to the world from that ground, not despite it."* Core Philosophy is Persian-first by design. Every stage has been built with `fa.json` beside `en.json` and every screen driven in both languages.

**So this is not a translation pass. Nothing is missing.** It is the pass that asks the harder question: *is the Persian actually native, or is it correct-but-translated?* Those look identical in a diff and completely different to a reader.

**Two halves, and they need different people.**

| | | Who |
|---|---|---|
| **§1 Mechanical** | Things that are objectively wrong and a test can hold forever | the engineer |
| **§2 Judgement** | Whether the Persian reads as Persian | **the founder** — nobody else can call this |

Do §1 first. It is finite, it is satisfying, and it clears the noise so §2 can be about language rather than about bugs.

---

## 1 · The mechanical half

### 1.1 · Locale key parity — build the test that does not exist

There is **one** key-parity test in the codebase (`changeAction.test.ts`, for the `log.*` namespace) and one for the mail templates. Everything else is unguarded: a key added to `en.json` and forgotten in `fa.json` shows English text to a Persian reader and nothing fails.

**Write the general test.** Every key in `en.json` exists in `fa.json` and vice versa, across every namespace. It is ten lines and it retires a whole class of defect permanently.

Then add the two that catch the subtler version:
- **No Persian value is byte-identical to its English counterpart** — with an allowlist for the ones that legitimately are (`Root Cast`, `DOI`, brand names). An identical value is usually an untranslated placeholder.
- **No Persian value contains Latin letters** outside the same allowlist. Catches half-translated strings.

### 1.2 · Numerals — pick the rule, then enforce it

The codebase currently disagrees with itself. R1's entry list rendered a count with `num-latin` (Latin digits) beside a pagination footer using `formatCount` (Persian digits); the R1 review fixed that one instance, but the *rule* was never written down, so the next screen will re-litigate it.

**Proposed rule, to confirm or overrule:**

| | Digits | Why |
|---|---|---|
| Counts, totals, pagination, tallies | **Persian** «۱۲» | prose numbers in a Persian sentence |
| Dates and times | **Persian**, Jalali | already the case |
| Money | **Persian** | already the case |
| Years of publication, DOIs, refs, version numbers, hashes, concept keys | **Latin**, `num-latin` | identifiers that are Latin wherever they are printed, including in citations |

Write it into the house rules in [`README.md`](README.md), then audit every numeric render against it.

#### 1.2.1 · The row this table is missing: **ordinals** *(open — 2026-08-14)*

The rule landed as house rule 14 and the audit found five real bugs with it. Reviewing that audit turned up the case the table above never named, and so the audit had no verdict to apply: **a number that labels a thing in sequence.** It is neither a tally nor an identifier.

Three places, all still Latin, all sitting inside Persian:

- `ContractDetail.tsx` — the portal's step badges, hardcoded `1` / `2` / `3` in `sec-badge num-latin`.
- `ContractPrint.tsx:158` — **the printed contract's article numbers**, `<span className="num-latin">{a.number}.</span>` before a Persian article title.
- `ContractTab.tsx:139` — the same article number in the desk editor.

**The pass arguably made this worse, which is why it needs settling rather than ignoring.** Before, the portal was mixed enough that Latin ordinals did not stand out. Now every count, total, fee and date around them is Persian and they are the only Latin figures left on the screen.

**Not decided here on purpose.** Article numbering in the printed contract is how a legal document presents itself, not a formatting preference — «۱. عنوان» versus «1. عنوان» is the founder's call and belongs with §2. Whichever way it goes, **the answer must be the same in all three places**, and it should become a fourth row in the table above rather than three separate judgements.

### 1.3 · Logical properties — sweep and hold

House rule 7 says logical properties only. Verify rather than assume:

```
grep -rnE '\b(margin|padding|border)-(left|right)\b|\b(left|right)\s*:' apps/web/src/styles
```

Legitimate exceptions exist (`transform: translate(-50%)` centring is direction-agnostic). Judge each; fix the rest. Then consider a test that greps the stylesheets — it is crude, and it is the only thing that stops the next `margin-left` from shipping and looking fine in English.

### 1.4 · The `:lang()` token pair

R2 established that `:lang(fa)` and `:lang(en)` must both set the same custom properties *and* perform their own `font-family` / `line-height` substitution, because `.root-ui` resolves `var()` once at the top and nothing re-reads it lower down. Both blocks carry cross-reference comments.

**Audit that the pair is still complete**, and check computed style rather than appearance — Vazirmatn has Latin glyphs, so a Latin block wrongly set in it looks *nearly* right. That is precisely why it survived until R2.

### 1.5 · ZWNJ in the copy itself

Persian compounds and verb prefixes take a zero-width non-joiner (نیم‌فاصله, U+200C): «می‌شود» not «میشود», «نمی‌کند» not «نمیکند», «کتاب‌ها» not «کتابها».

R1 built `foldPersian` so *search* is ZWNJ-insensitive — but that is about matching, not about the copy being right. **Read every Persian string for ZWNJ correctness.** A missing one is a spelling error to a Persian reader and invisible to everyone else.

### 1.6 · Direction and mixed content

Check every place Persian text contains a Latin fragment — a URL, a DOI, an email, a product name, a file name:

- Does the Latin run render in the right place, or does the bidi algorithm move punctuation to the wrong end? A trailing `.` or `:` after a Latin run inside an RTL paragraph is the classic failure.
- Do `<input>` and `<textarea>` carry the right `dir`? An email field inside an RTL form usually wants `dir="ltr"` — the sign-in form already does this for `originalLang` in R1's editor; check the rest.
- Placeholders, validation messages, and the password field's show/hide toggle.

#### 1.6.1 · Corpus text inside interface chrome — a known, confirmed gap

**This one is not hypothetical; it is already wrong in three places**, found while reviewing R2, C2 and R4. The rule the codebase agrees on is R2's: entry content is *data*, and carries the language it is written in, not the viewer's. `LibraryReader` obeys it — `dirFor(entry.originalLang)` on the original column, `translationLangFor` on the other (that second half was the R2 review's own finding). Everywhere an entry title appears **outside** the reader, it does not:

| | What renders | Carries `lang`/`dir` |
|---|---|---|
| `LibraryList.tsx:111` | `titleTranslated ?? titleOriginal` in a card | **no** |
| `AskLab.tsx` citation list | `entryTitle` (always `titleOriginal`) | **no** |
| `ReviewAdmin.tsx:129`, thread cards | reviewer names | **no** — and see below |

A Persian title inside the English list is set in the Latin face and laid out LTR; the reverse is subtler and worse, because Vazirmatn *has* Latin glyphs, so an English title in a Persian list looks nearly right. That near-rightness is exactly why R2's own bug survived to review.

**Names are the harder half, and worth deciding rather than fixing by reflex.** `User.name` carries no language field to key off — nothing in the schema says whether «نهال» or "Nahal" was typed. `User.locale` is the language they *read*, which is a decent guess and not the same thing. The options are a stored field, a heuristic like `blockLocale`'s, or leaving names in the surrounding direction and accepting it. Emails already get `dir="ltr"` explicitly, which shows the file knows the problem exists. **Pick one and write it down** — this is a decision, not a defect.

**For titles, fix it once, as a component**, not three times inline — something like `<Text lang={…}>` that sets both attributes from one source. The server already has the language for the Library cases (`originalLang` is on the row); R4's `/ask` citation payload does **not** send it yet, and would need to. R4.md T5 asked for this and the build met only the half inside the answer panel — recorded here rather than left as a passing remark in a merge commit.

### 1.7 · Print

F1b verified the printed contract in Persian — Jalali dates, Persian digits, correct shaping, `tfoot` verification strip. **Re-verify**, because print is the surface nobody looks at between releases and V2/V3 changed what a contract contains.

---

## 2 · The judgement half — the founder's

Mechanically-correct Persian can still be translated Persian. The tells:

- **English sentence rhythm** — subordinate clauses in English order, an em-dash used the way English uses it.
- **Calques** — literal renderings that are grammatical and not idiomatic.
- **Register drift.** Brand §5 sets the voice: «بیا از همین‌جا شروع کنیم» · «این تصمیم مالِ توست؛ ما فقط کنارتیم» — warm, plain, second-person-singular. A screen that slips into formal administrative Persian («لطفاً جهت ادامه اقدام فرمایید») has broken the brand even though every word is right.
- **Consistency of terminology.** One concept, one Persian word, everywhere. Candidates to check: *revision*, *draft*, *publish*, *approve*, *scope*, *amendment*, *entry*, *concept*, *round*. Build the glossary as you go and put it in canon — this is the pass's most durable artefact, and the thing that stops the next stage inventing a fifth word for *publish*.

**Method:** read the Persian product end to end **without** the English beside it. Reading them side by side makes you check for accuracy; reading Persian alone makes you notice when it does not sound like a person.

**Surfaces, in the order a person meets them:** landing → About → Library reader and list → sign-in and invite → portal contracts and detail → the print view → the desk (all sections) → the Review Room → every email template.

---

## 3 · Two decisions this pass should settle

**3.1 · The desk is staff-facing. Does it get the same standard?**
The portal is the product; `/desk` is Root's own workshop. Argument for equal standard: Root reads Persian all day and the desk is where the most time is spent. Argument against: it is not customer-facing and the pass is expensive. *Lean: yes, equal — «اتاقِ کار» was chosen with care and it would be strange for the room to be the only well-written thing in it.*

**3.2 · Is there a Persian style guide, and where does it live?**
The glossary from §2 plus the numeral rule from §1.2 plus the ZWNJ and register notes amount to one. **It belongs in `root-sot` canon**, not here — it is *what*, not *how*, and it will outlive every line number in this directory. Brand §5 is where it hangs.

---

## 4 · Done when

- [ ] A general locale-key-parity test exists and passes, plus the identical-value and Latin-letters checks with their allowlists.
- [ ] The numeral rule is written into the house rules and every numeric render matches it.
- [ ] The logical-property sweep is clean, with any exceptions justified in place.
- [ ] The `:lang()` pair is complete, verified by computed style.
- [ ] Every Persian string has been read for ZWNJ correctness.
- [ ] Mixed-direction content, form inputs and the print view all check out.
- [ ] The founder has read the Persian product end to end, alone, and every finding is fixed or recorded as accepted.
- [ ] The glossary and style guide are in `root-sot` canon, hanging off Brand §5.
- [ ] **The build plan's final item is struck through**, and what the pass found is written up — including anything it decided that the next product should inherit.
