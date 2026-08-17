# Offline Spell Check for Web Pages

A Chrome / Edge extension (Manifest V3) that finds misspelled words on any web page
using a **bundled dictionary**. No network requests, no account, no ads, no tracking.
Two permissions: `activeTab` and `scripting`.

---

## What it does

- Highlights misspelled words in the page's visible text with a red wavy underline
- Also checks the text users never see: `<title>`, `alt`, `placeholder`, `aria-label`
- Suggests corrections on demand (click a highlight, or a row in the popup)
- Skips code blocks, camelCase identifiers, acronyms, URLs, paths and non-English elements
- **Never modifies the page.** Highlights live in a closed shadow root; the page's DOM
  is read, never written

## What it does not do

It finds **misspelled words**. It does not check grammar, and it cannot catch a
mistake that is itself a real word:

```
"the from below"    instead of  "the form below"
"there own files"   instead of  "their own files"
"loose the file"    instead of  "lose the file"
```

Judging those needs to understand the sentence, not the word. Any dictionary-based
checker — including Chrome's own — misses them. Measured: 0/6.

It also does not rewrite text, suggest phrasing, or generate anything.

---

## Architecture

```
manifest.json          MV3. permissions: activeTab + scripting. No content_scripts.
background.js          Service worker — the ONLY holder of the dictionary
shared/pipeline.js     ⭐ Single source of truth for all filtering rules
content/scan.js        DOM walk + word collection + highlight overlay (no dictionary)
popup/                 Trigger, result list, suggestions, timing readout
src/nspell/            nspell 2.1.5 ported CJS → ESM by hand (MIT)
src/dict/              index.aff + index.dic + licence (SCOWL en_US)
test/testpage.html     Self-checking fixture — every section states what should happen
build.py               Whitelist packaging + 4 hard gates
make_icons.py          Icons from geometry only, no font dependency
```

### Three constraints the design is built around

**1. Exactly one dictionary instance, and it lives in the service worker.**

A dictionary instance costs **20.7 MB of heap** (49,568 entries expand to **123,702**
word forms via affix rules). Built in a content script that would be *per tab* —
20 tabs = 400 MB. So the dictionary is built once in the service worker; the content
script holds none and sends candidate words over in **one batched message**.

A single `correct()` call is under 0.001 ms (1,000 calls measured at <1 ms), so the
cost is entirely in message serialisation — which is exactly why it must be batched
rather than one message per word.

MV3 recycles service workers (~30 s idle), so the dictionary is rebuilt on demand.
Rebuild costs ~100 ms cold, which is fast enough to sit directly in the click path —
no "scanning…" state needed.

**2. No `tabs` permission, no host permissions.**

The extension it competes with requests `tabs`, and chrome-stats flags it
**Critical**: *"Grants access to browser tabs, which can be used to track user
browsing habits."*

- `chrome.tabs.query()` works **without** the `tabs` permission — you just don't get
  `url`/`title`. We only need `id`.
- Scripts are injected on demand with `chrome.scripting.executeScript`, **not**
  declared as `content_scripts`. Declared content scripts need `matches`, which means
  host permissions, which means the install prompt says *"Read your data on all
  websites."* On-demand injection + `activeTab` means **that sentence never appears.**

`build.py` hard-fails if `tabs`, `content_scripts`, `web_accessible_resources` or
`host_permissions` ever appear.

**3. The dictionary ships as static data, not as an npm module.**

`dictionary-en`'s `index.js` reads files with `node:fs`, which does not exist in a
browser. So `index.aff` / `index.dic` are packaged as plain assets and read with
`fetch(chrome.runtime.getURL(...))`. (An extension reading its own packaged files
needs no permission and **no** `web_accessible_resources` — that field is for letting
*web pages* read extension resources, which we never do.)

### Why highlights are drawn the way they are

Some spell checkers make the whole document `contenteditable` to borrow Chrome's
built-in checker — that silently kills every link on the page. This one:

- draws into a **closed shadow root**, so page CSS and page scripts cannot touch it
- positions marks in **document coordinates**, so page scrolling moves them for free
  (there is no `scroll` listener for page scrolling at all)
- repaints only when it has to: window resize, font load, and scrolling inside an
  internally-scrolling container (caught via a capture-phase `scroll` listener on
  `document`, rAF-throttled)
- **clips every mark to its clipping ancestors.** The overlay hangs off
  `documentElement`, so nothing else would stop a mark from following its word
  straight out of an `overflow: auto` box and landing on unrelated content. Each
  mark rect is intersected with every ancestor whose `overflow` is not `visible`,
  and anything that falls outside is not drawn
- corrects for any containing block the page may have created, by reading the host
  element's own rect and treating that as the origin

### Known limits

| Limit | Why | Workaround |
|---|---|---|
| Marks drift over `position:fixed` elements after page scroll | Fixing it would mean recomputing every rect on every scroll frame, which throws away the main benefit of document-coordinate positioning. Fixed elements are usually navigation and page headers — and `nav` is skipped anyway | Click **Re-scan** |
| Only the main frame is scanned, not iframes | Cross-origin iframes are mostly ads and embeds | — |
| Typos inside `<input>`/`<textarea>` **values** are not checked | Only `placeholder` is. See TODO.md for the reasoning | — |
| A DOM that changes between the two passes (SPA re-render) can drop a highlight | Two-pass walk keeps memory proportional to real errors, not to page size | Click **Re-scan** |

---

## Development

```bash
# package for the store (runs 4 hard gates first)
python build.py          # -> dist/offline-spell-check-for-web-pages-v1.0.0.zip

# regenerate icons
python make_icons.py

# load unpacked: chrome://extensions -> Developer mode -> Load unpacked -> this folder

# serve the self-checking test page
cd test && python -m http.server 8765   # -> http://localhost:8765/testpage.html
```

### Changing the filtering rules

**All filtering logic lives in `shared/pipeline.js` and nowhere else.** It is written
as a dual-consumable IIFE on purpose:

- the content script loads it as a **classic script** (MV3's `executeScript` cannot
  inject ES modules)
- the Node measurement probes `import` it for its side effect via a shim at
  `../spell-probe/pipeline.mjs`

So the bytes the product runs and the bytes the probes measure are **the same bytes**.
After changing it, re-run all four checks:

```bash
cd ../spell-probe
node tokens_check.mjs    # tokenising + offsets + gate expectations   (fast, offline)
node recall_probe.mjs    # 18/18 non-word recall                     (fast, offline)
node fp_probe.mjs        # 0.05% false-positive rate                 (needs network)
node port_check.mjs      # only if you touched src/nspell/           (differential)
```

Measured baseline (see `../spell-probe/RESULTS.md` for the full report):

| Gate | Result |
|---|---|
| False positives | **0.05%** on 64,357 words of real English technical documentation |
| Non-word recall | **18/18 = 100%** |
| Real-word confusions | **0/6** — hard boundary, stated openly in the store copy |
| Code blocks | 0/2 flagged (skipping is intentional) |
| Attributes / `<title>` | 4/4 |
| Dictionary build | ~100 ms cold, 20.7 MB heap, 123,702 word forms |

---

## Credits and licences

This extension bundles two third-party components. Both licences are shipped inside
the package, as required.

**nspell 2.1.5** — MIT, © Titus Wormer. <https://github.com/wooorm/nspell>
A JavaScript reimplementation of a Hunspell-compatible checker; it contains no
Hunspell code, so no GPL/LGPL/MPL obligations apply. Ported from CommonJS to ES
modules by hand for this extension; every file states which upstream file it came
from, and the port is verified against upstream by differential test
(`spell-probe/port_check.mjs`). Full licence: `src/nspell/NSPELL-LICENSE.txt`.

**dictionary-en 4.0.0** — `(MIT AND BSD)`, © Titus Wormer.
<https://github.com/wooorm/dictionaries>

The English word list is derived from **SCOWL** (Spell Checker Oriented Word Lists),
Copyright 2000–2018 **Kevin Atkinson** and contributors, en_US Hunspell Dictionary
version 2020.12.07 — <http://wordlist.sourceforge.net>. It incorporates material
from Ispell (© 1993 Geoff Kuenning), WordNet 1.6 (© Princeton University), the
ENABLE word list, and UKACD (© J Ross Beresford). Used under their permissive terms;
commercial and closed-source use is permitted, with the condition that the copyright
notices be reproduced. The complete, unmodified licence text is shipped at
`src/dict/DICTIONARY-LICENSE.txt`.

The extension's own code is MIT — see `LICENSE`.

---

## Privacy

No network requests. No analytics. No accounts. Nothing is collected, because
nothing is sent. The dictionary is a local file. See `PRIVACY.md`.
