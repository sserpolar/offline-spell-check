# Benchmark

Measured numbers for this extension: how often it flags a word that is not
actually misspelled, how many real misspellings it catches, and what it costs
to run. Every figure below came from a run, not from an estimate.

Two things worth reading before the tables:

- The **false-positive rate is the number that matters** for a page-wide spell
  checker. A checker that underlines 5% of a technical document is not a
  checker, it is a red wall you learn to ignore.
- There is a **hard limit** on what a dictionary can catch, stated in
  [Recall](#recall) rather than buried. It is not a bug and it will not be
  fixed in a later version.

---

## Corpus

Four real English technical documentation pages, **~65,000 words submitted**:

| Page |
|---|
| MDN — `fetch` API |
| VS Code — Extension API reference |
| knip — documentation |
| Chrome — extension documentation |

Real documentation was used on purpose. Prose written for a spelling test does
not contain `Thenable`, `readonly`, `cwd`, `falsy`, or a language switcher in
the footer — and those are exactly what produces false positives.

---

## False positives

**Final: 0.05%** — 28 unique words across ~65,000 submitted.

Every step was earned by a rule, not by padding a dictionary with real
misspellings:

| Stage | What was added | Rate | Worst single page (64k words) |
|---|---|---|---|
| 1 | Basic skips only (short words, digits, acronyms, camelCase) | **4.50%** | 3.46% |
| 2 | Language gate, URL/path stripping, technical term list | **0.55%** | 0.47% |
| 3 | Possessive `'s` stripping, skip nav / language switchers | **0.30%** | 0.27% |
| 4 | Two further gates | **0.07%** | — |
| 5 | Technical term list extended by 133 entries | **0.05%** | — |

### Where the first 4.50% actually came from

Worth stating because it was not a dictionary problem. The single largest
contributor was **one page whose content was German, checked against an English
dictionary** — that page alone scored **75.48%**. The fix was a language gate
(honour `lang` on the element), not a bigger dictionary.

The remaining flags fell into clean categories, all of them false positives,
none of them real misspellings:

| Category | Examples |
|---|---|
| Technical terms / API names | `Uri` `Thenable` `readonly` `webview` `args` `tooltip` `json` `falsy` `cwd` `viewport` `eol` |

The measured rate is also a slight **over**-estimate of what you will see in
practice: the harness submits some text that the shipped extension skips
outright, such as `<li lang="de">Deutsch</li>`.

---

## Recall

| Error class | Result | Note |
|---|---|---|
| **Non-word errors** (result is not a real word) | **18/18 = 100%** | Everything a dictionary can catch, it caught |
| **Real-word errors** (result is a valid word) | **0/6** | **Hard limit — see below** |
| Attribute and `<title>` text | **4/4 = 100%** | |
| Code blocks | Correctly skipped | |

### The hard limit, stated plainly

`form` → `from`, `their` → `there`, `lose` → `loose`: the result is a correctly
spelled English word, so no dictionary-based checker can flag it — including
the one built into your browser. Judging these requires understanding the
sentence, not the word.

If you need that, you need a grammar tool, and it will send your text to a
server to do it. This extension will not.

---

## An optimization that was tested and rejected

Included because a benchmark that only lists wins is not a benchmark.

**Suffix stripping with root-word fallback** — if a word is unknown, strip its
suffix and look up the root. It looked worthwhile:

| | Before | After |
|---|---|---|
| False positives | 0.09% | **0.08%** (6 hits) |
| Non-word recall | **18/18** | **16/18** ← |

It was rolled back. The two regressions were `occured` (→ `occur`) and
`begining` (→ `begin`). The mechanism is structural, not a tuning problem:
both are **omitted double letters at the seam between root and suffix**, so
stripping the suffix removes the evidence of the error. The technique cannot
be made safe.

Measurement also showed it did not solve the problem it was added for:
`deserialize`, `deallocate` and `deduplicate` fail because **the root itself is
absent from the dictionary**, so a root fallback never fires.

Trading 2 of 18 real catches for 6 false-positive suppressions is the wrong
direction. The only safe fix for domain derivatives is extending the technical
term list, which is what stages 4 and 5 above did.

---

## Performance, measured in the browser

Numbers below are from Chrome on a real page, not from Node.

**Total for a scan: 95 ms.**

| Phase | Cost |
|---|---|
| DOM walk | 3 ms |
| Second pass | 1 ms |
| Dictionary lookup (batched) | 0.3 ms |
| Message passing to the service worker | 4 ms |
| **`executeScript` injection** | **81 ms** |
| Dictionary build, cold, once | 126 ms (fetch 62 + parse 64) |

Two results that contradicted the expectation going in:

**1. Injection dominates, not the dictionary.** `inject` is 81 of 95 ms —
**85% of the scan**. Optimization attention had been going to the dictionary
(20.7 MB, build time, batching lookups to avoid per-word round trips) while
the largest single cost was loading the content script. Skipping
`executeScript` when already injected would take a re-scan from 95 ms to about
14 ms. It is not in v1.0: 95 ms is already below the perceptual threshold, so
the complexity is not yet worth it.

**2. `fetch` of the dictionary files costs 62 ms, not 1 ms.** Reading the same
two files from disk in Node took 1 ms. In the browser it is **62× slower** —
the single largest gap between the lab harness and reality.

Other figures:

| | |
|---|---|
| Cold start (dictionary build runs in parallel with injection) | **~165 ms** |
| 1,000 dictionary lookups | **< 1 ms** |
| Heap per dictionary instance | **~20.7 MB** |

The 20.7 MB is why the dictionary lives in the service worker and is queried in
batches, rather than being built per tab.

### Lab harness vs. real browser

Kept as its own table because the discrepancies are the useful part:

| Measurement | Node harness | Chrome | |
|---|---|---|---|
| Read `index.aff` + `index.dic` | 1 ms | **62 ms** | 62× — the one real surprise |
| Dictionary parse | 61 ms median / 89–101 ms cold | **64 ms** | agrees |
| Batched lookup | < 1 ms / 1,000 | **0.3 ms** | agrees |
| Service worker wake + serialization | not measurable | **4 ms** | batching confirmed |
| `executeScript` injection | **no equivalent** | **81 ms** | invisible to the harness |

The lesson generalizes: the harness was accurate about everything it could
model and silent about the largest cost, because that cost had no counterpart
outside a browser.

---

## Dictionary and licensing

| | |
|---|---|
| Dictionary | SCOWL-derived (`dictionary-en`), `MIT AND BSD` |
| Spell-check engine | `nspell`, MIT |
| Size in the package | 622 KB |
| Copyleft obligations | none — attribution only |

The full licence text ships inside the extension.

---

## Reproducing this

Every number above comes from a script in [`probe/`](probe/), and those scripts
import [`shared/pipeline.js`](shared/pipeline.js) — **the same file the shipped
extension loads into the page.** The filtering logic is not reimplemented for
measurement, so the bytes measured and the bytes shipped are the same bytes.

```sh
cd probe
npm install
npm run recall   # reproduces the recall table above, offline
npm run port     # diffs the hand-ported ESM nspell against upstream, offline
npm run fp       # the false-positive rate; fetches the four pages listed above
```

`npm run recall` should print `18/18` non-word, `0/6` real-word, `0/2` inside
code blocks and `4/4` on attributes — the recall section of this document.

Two honest caveats:

- **`fp_probe` fetches the four documentation pages live** rather than shipping
  a frozen copy, so its exact figure drifts as those pages are edited. The
  0.05% above is a measurement taken on a specific day, not a constant.
- **The browser-side timings cannot be reproduced by the harness at all.** They
  come from instrumentation inside the extension, visible in the popup during
  development. That gap is the subject of the lab-versus-browser table above,
  and it is the reason the harness was not trusted on its own.

See [`probe/README.md`](probe/README.md) for what each script does.

---

## What these numbers do not cover

- **Languages other than English.** Non-English elements are skipped, not
  checked.
- **Grammar, phrasing, or real-word confusions.** See the hard limit above.
- **Text you type into form fields.** Only their `placeholder` attributes are
  checked.
- **Very large pages.** The DOM walk cost was measured on documentation-sized
  pages; the scaling behaviour on unusually large documents is not yet
  characterized.
- **Suggestion ranking.** Candidates at the same edit distance are not yet
  ordered by frequency, so the best suggestion is not always first
  (`wiht` → `whit`, `with`).
