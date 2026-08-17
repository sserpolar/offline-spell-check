# Privacy Policy — Offline Spell Check for Web Pages

**Last updated: 2026-08-15**

## The short version

This extension does not collect, store, transmit, or sell any data. It cannot,
because it never makes a network request of any kind.

## Single purpose

Find misspelled English words in the text of the page the user is currently looking
at, using a dictionary bundled inside the extension, and highlight them.

## What data is handled, and where it goes

| Data | Where it goes |
|---|---|
| The visible text of the active tab | Read into memory in that tab, compared against a local dictionary, then discarded when the tab is closed or highlights are cleared. **Never leaves the browser.** |
| The `title`, `alt`, `placeholder` and `aria-label` attribute values of the active tab | Same as above. |
| The list of misspelled words found | Kept in memory only, to draw highlights and fill the popup list. Never stored, never sent. |

Nothing is written to disk. Nothing is written to `chrome.storage`. The extension
does not request the `storage` permission at all.

## Network activity

**There is none.** The extension makes zero outbound requests.

The only `fetch()` call in the code reads the extension's own bundled dictionary files
(`src/dict/index.aff` and `src/dict/index.dic`) via `chrome.runtime.getURL()`. That is
a read of a file inside the installed extension package, not a network request.

There is no backend, no API, no telemetry, no analytics, no crash reporting, no
remote configuration, and no remotely-hosted code.

## Permissions, and exactly why each is needed

| Permission | Why | What it does NOT allow |
|---|---|---|
| `activeTab` | To read the text of the tab the user is looking at, **only after the user clicks the extension's toolbar icon**. Access is granted by Chrome for that one tab, for that one interaction. | It gives no access to other tabs, to tabs the user has not activated us on, or to browsing history. |
| `scripting` | To inject the scanning and highlighting script into that tab when the user clicks the icon. | It grants no access on its own — it can only act where `activeTab` has already granted access. |

**Permissions deliberately NOT requested:**

- **`tabs`** — not requested. This permission would allow reading the URL and title
  of every tab, which can be used to reconstruct browsing habits. It is not needed
  for spell checking.
- **Host permissions** (e.g. `<all_urls>`, `*://*/*`) — not requested. This is why
  installing this extension does **not** show the warning *"Read your data on all
  websites."*
- **`storage`** — not requested. Nothing is persisted.
- Declared `content_scripts` — not used. Declaring them would require `matches`
  patterns, which are equivalent to host permissions. Scripts are injected on demand
  instead.

The packaging script (`build.py`) fails the build if any of these ever appear in the
manifest, so they cannot be added silently in a future version without the store
listing and this document being revisited.

## Does it modify pages?

No. The extension reads the page's text and draws its own highlight layer inside a
**closed shadow root** attached to a single element it adds. It does not wrap page
text in new elements, does not set `contenteditable`, and does not alter any page
content, attribute, style, or script.

## Chrome Web Store data-usage disclosures

For each category the Chrome Web Store asks about, this extension collects **none**:

| Category | Collected? |
|---|---|
| Personally identifiable information | No |
| Health information | No |
| Financial and payment information | No |
| Authentication information | No |
| Personal communications | No |
| Location | No |
| Web history | No |
| User activity | No |
| Website content | **No.** Page text is read into memory to perform the spell check and is never transmitted or stored. Nothing is *collected* in the sense the Store uses the word. |

We certify that:

- We do not sell or transfer user data to third parties, outside of approved use cases
- We do not use or transfer user data for purposes unrelated to our item's single purpose
- We do not use or transfer user data to determine creditworthiness or for lending purposes

## Children

The extension collects nothing from anyone, including children.

## Changes to this policy

Any change that affects what data is handled will be accompanied by a version bump
and an update to this file. The permission set is enforced by the build script, so a
change in data handling cannot ship without this document being revisited.

## Contact

Please open an issue on the project's repository.
