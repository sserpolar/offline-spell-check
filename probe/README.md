# probe — the measurement harness

The numbers in [BENCHMARK.md](../BENCHMARK.md) come from these scripts. This
directory exists so that those numbers can be re-run rather than taken on
trust.

## The point of this directory

The filtering logic is **not duplicated here.** Every probe imports
[`../shared/pipeline.js`](../shared/pipeline.js) — the same file the shipped
extension loads into the page. `pipeline.mjs` in this directory is an eight-line
shim that imports that file for its side effect and re-exports
`globalThis.SpellPipeline` as named exports.

That matters because it removes a whole class of lie. A harness that reimplements
the extension's rules can measure a 0.05% false-positive rate while the shipped
product behaves differently. Here, the bytes being measured and the bytes being
shipped are the same bytes.

## Running them

```sh
cd probe
npm install        # dictionary-en + nspell
npm run recall     # offline
npm run port       # offline
npm run fp         # fetches four real documentation pages over the network
```

| Script | What it measures | Network |
|---|---|---|
| `npm run fp` | False-positive rate on real technical documentation | **yes** |
| `npm run recall` | Recall against injected misspellings, split into non-word and real-word classes | no |
| `npm run suggest` | Suggestion quality — whether the intended word is in the top 5 | no |
| `npm run port` | Word-by-word diff of the hand-ported ESM nspell against upstream CJS | no |
| `npm run load` | Dictionary build time and heap cost | no |
| `npm run tokens` | Tokenizer and offset correctness — that highlights land on the right characters | no |
| `npm run dictgap` | Which technical terms the dictionary does not know | no |

`fp_probe` is the only one that needs the network: it fetches the pages listed
in the file rather than shipping a frozen copy of them, so the measurement
follows the real web as it changes. The trade-off is that its exact number will
drift as those pages are edited.

## What a passing run looks like

`npm run recall` should reproduce the recall figures published in BENCHMARK.md:

```
--- non-word errors (the class a dictionary can catch)  18/18 ---
--- real-word errors (impossible for a dictionary)       0/6  ---
--- misspellings inside <code>: 0/2 caught (0 expected)       ---
--- attribute / title text: 4/4                              ---
--- false positives in prose: 0                              ---
```

The `0/6` is not a failure. Those six injected errors are real words
(`form` -> `from`, `there` -> `their`), and no dictionary-based checker can flag
them. Seeing `0/6` means the test is honest about the approach's hard limit; a
number above zero there would mean something was wrong with the test.

`npm run port` diffs about 130,000 words through both the upstream CommonJS
nspell and the hand-ported ESM copy in [`../src/nspell/`](../src/nspell/) and
requires 100% agreement on `correct()`, `suggest()` ordering, and `spell()`
flags. It exists because that port was done by hand, and a hand port fails
quietly: the symptom is not a crash but a false-positive rate that has silently
moved.

## Notes

- Some inline comments are in Chinese. They are working notes kept next to the
  code they describe rather than translated and drifting out of date.
- `dict_gap.mjs` reads the packaged dictionary at [`../src/dict/`](../src/dict/)
  and reports which technical terms are missing from it. Its output feeds the
  `TECH` list in `../shared/pipeline.js`. Anything added there must be
  re-measured with `npm run fp` **and** `npm run recall` — widening the
  vocabulary lowers false positives and can lower recall at the same time.
- One optimisation was measured and rejected: stripping suffixes to look up a
  root word. It moved false positives from 0.09% to 0.08% while dropping recall
  from 18/18 to 16/18. The reasoning is in BENCHMARK.md and in the header of
  `../shared/pipeline.js`. Please read it before trying that again.
