# Four things I was wrong about, building a spell checker with no host permissions

I wanted a spell checker that could proofread a whole web page — not the text I
type into a box, but the text already rendered on screen, including the parts
nobody looks at: `<title>`, `alt`, `placeholder`, `aria-label`.

Every one I tried did one of two things. It sent the page text to a server, or
it asked for **"read your data on all websites"** at install time. Usually both.

So the design constraint came first, before any code: the extension gets
`activeTab` and `scripting`, and nothing else. No host permissions, no network
code at all. Not "we promise not to send anything" — there is no code in it that
*can* send anything, and the dictionary is bundled so there is nothing to fetch.

That constraint turned out to be the easy part. What follows is the part I got
wrong, four times, each time in the same direction: I was optimizing the thing I
could see instead of the thing that was costing me.

Every number below comes from a script in `probe/`, and those scripts import
`shared/pipeline.js` — the same file the shipped extension loads into the page.
The filtering logic is not reimplemented for measurement, so the bytes being
measured are the bytes being shipped.

---

## 1. The false positives were not a dictionary problem

For a page-wide checker, the false-positive rate is the only number that
decides whether the thing is usable. A checker that underlines 5% of a technical
document is not a checker; it is a red wall you learn to ignore.

The first honest measurement, on ~65,000 words of real documentation (MDN's
`fetch` page, the VS Code extension API reference, knip's docs, Chrome's
extension docs), was **4.50%**. My assumption was obvious and wrong: the
dictionary is too small, technical writing is full of jargon, I need more words.

The single largest contributor was **one page whose content was German, being
checked against an English dictionary.** That page alone scored **75.48%**.

The fix was a language gate — honour the `lang` attribute on the element and
skip what is not English. Not a bigger dictionary. Had I gone with my instinct
I would have spent days padding a word list against a problem that had nothing
to do with word lists.

What remained after that fell into one clean category: real technical terms.
`Uri`, `Thenable`, `readonly`, `webview`, `args`, `falsy`, `cwd`, `eol`,
`viewport`. Those *are* a word-list problem, and they came down in stages:

| Stage | What was added | Rate |
|---|---|---|
| 1 | Basic skips (short words, digits, acronyms, camelCase) | **4.50%** |
| 2 | Language gate, URL/path stripping, technical term list | **0.55%** |
| 3 | Possessive `'s` stripping, skip nav / language switchers | **0.30%** |
| 4 | Two further gates | **0.07%** |
| 5 | Technical term list extended by 133 entries | **0.05%** |

Choosing real documentation as the corpus was deliberate. Prose written for a
spelling test does not contain `Thenable` or a language switcher in the footer,
and those are exactly what generates false positives. If I had benchmarked
against clean prose I would have shipped something that fell apart on the first
API reference page it saw.

---

## 2. The dictionary was not the bottleneck

A scan costs **95 ms** total. Here is where it goes:

| Phase | Cost |
|---|---|
| DOM walk | 3 ms |
| Second pass | 1 ms |
| Dictionary lookup (batched) | 0.3 ms |
| Message passing to the service worker | 4 ms |
| **`executeScript` injection** | **81 ms** |

Injection is **85% of the scan.** Meanwhile I had been optimizing the
dictionary — it is 20.7 MB in heap, so I moved it into the service worker,
built it once instead of per tab, and batched lookups to avoid per-word round
trips.

All of that was worth doing for memory reasons. None of it touched the number
that mattered. The batched lookup I was so pleased with costs **0.3 ms** out
of 95.

Skipping `executeScript` when the script is already injected would take a
re-scan from 95 ms to roughly 14 ms. It is deliberately not in v1.0: 95 ms is
already under the perceptual threshold, and I would rather ship the honest
measurement than the complexity.

---

## 3. My lab harness was silent about the largest cost

This is the one that generalizes past spell checkers.

I had a Node harness. It was fast, it ran offline, it was where I did all my
iteration. When I finally instrumented the real extension in Chrome:

| Measurement | Node harness | Chrome | |
|---|---|---|---|
| Read `index.aff` + `index.dic` | 1 ms | **62 ms** | 62× |
| Dictionary parse | 61 ms median | 64 ms | agrees |
| Batched lookup | < 1 ms / 1,000 | 0.3 ms | agrees |
| Service worker wake + serialization | not measurable | 4 ms | — |
| `executeScript` injection | **no equivalent** | **81 ms** | invisible |

Reading two files cost **62× more** in the browser than on disk in Node. And
the single largest cost in the whole system — injection — had **no counterpart
in the harness at all**, so the harness could not be wrong about it. It simply
never mentioned it.

That is the failure mode worth naming: the harness was accurate about
everything it could model, and silent about the thing that dominated. A lab
measurement that agrees with production on every axis it shares can still be
useless, because the axes it does not share are not flagged as missing. They
are just absent.

---

## 4. An optimization that measured well and was still wrong

Suffix stripping with root-word fallback: if a word is unknown, strip the
suffix and look up the root. `deserializing` → `deserialize`. Standard
technique, and the numbers came back positive:

| | Before | After |
|---|---|---|
| False positives | 0.09% | **0.08%** |
| Non-word recall | **18/18** | **16/18** ← |

I rolled it back. The two regressions were `occured` and `begining`, and the
mechanism is structural rather than a tuning problem: both are **omitted double
letters at the seam between root and suffix**, so stripping the suffix removes
the evidence of the error. There is no threshold at which this technique becomes
safe.

Measurement also showed it did not solve the problem I added it for.
`deserialize`, `deallocate` and `deduplicate` fail because *the root itself* is
absent from the dictionary, so a root fallback never fires. It was fixing a
different problem than the one I had, slightly, while breaking real catches.

Trading 2 of 18 real catches for 6 false-positive suppressions is the wrong
direction. The safe fix for domain derivatives was extending the technical term
list, which is what stages 4 and 5 above did.

---

## The limit I can't fix, stated up front

Non-word errors: **18/18**. Real-word errors: **0/6**.

`form` → `from`. `their` → `there`. `lose` → `loose`. The result is a correctly
spelled English word, so no dictionary-based checker can flag it — including
the one built into your browser. Judging these requires understanding the
sentence, not the word.

If you need that, you need a grammar model, and it will send your text to a
server to do it. This one will not, which is the entire point, so the limit is
not a defect to be fixed later. It is the price of the constraint.

---

## Reproducing it

```sh
git clone https://github.com/sserpolar/offline-spell-check
cd offline-spell-check/probe
npm install
npm run recall   # recall table, offline
npm run port     # diffs the hand-ported ESM nspell against upstream, offline
npm run fp       # false-positive rate; fetches the four pages listed above
```

`npm run recall` should print 18/18 non-word, 0/6 real-word, 0/2 inside code
blocks, 4/4 on attributes.

Two caveats worth stating rather than discovering. `fp_probe` fetches the four
documentation pages **live** instead of shipping a frozen copy, so its exact
figure drifts as those pages are edited — 0.05% is a measurement taken on a
specific day, not a constant. And the browser-side timings cannot be reproduced
by the harness at all; they come from instrumentation inside the extension.
That gap is the subject of section 3, and it is why the harness is not trusted
on its own.

Full numbers and method: [BENCHMARK.md](BENCHMARK.md). Engine is `nspell`
(MIT), hand-ported from CJS to ESM and diffed against upstream over 129,000
words — `probe/port_check.mjs`, 100% identical. Dictionary is SCOWL-derived,
622 KB in the package, attribution-only.
