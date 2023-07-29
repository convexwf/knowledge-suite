# Knowledge Suite

`knowledge-suite` is the TypeScript runtime implementation for the Knowledge Web Clipper MVP.

## Packages

```text
knowledge-suite/
├── apps/
│   ├── knowledge-ingest-server/
│   └── knowledge-web-clipper/
└── packages/
    └── knowledge-schema/
```

## Quick Start

```bash
npm install
npm run build
npm run dev:server
```

Load `apps/knowledge-web-clipper/dist` as an unpacked Chrome extension after building the extension.
After rebuilding the extension, click reload in `chrome://extensions` and reload the target page once.
If the side panel reports that the receiving end does not exist, the extension will try to inject the content script and retry.

## Integration Smoke

```bash
npm run build
npm run smoke:ingest
```

The smoke script starts a temporary local article server plus `knowledge-ingest-server`, then verifies:

- `browser_html` preview
- `server_fetch` preview
- save + normalized status lookup
- saved clip listing
- non-HTML `server_fetch` rejection

## Extension E2E

```bash
npx playwright install chromium
npm run build
npm run e2e:extension
```

The E2E script loads the built Chrome extension in Playwright Chromium, previews the current page through `browser_html`, saves it, verifies backend status, and checks the side panel `Saved` view.

## Run The Server With Docker

```bash
docker compose up -d --build knowledge-ingest-server
docker compose logs -f knowledge-ingest-server
```

The compose service listens on `127.0.0.1:18765` and persists server data in `./knowledge-store`.
The store contains raw HTML, RawDoc metadata, Document JSON, Markdown, and a SQLite URL index at `knowledge-store/index.sqlite3`.

Set a non-default token before starting the service:

```bash
KNOWLEDGE_TOKEN="replace-me" docker compose up -d --build knowledge-ingest-server
```

Optional server fetch limits:

```bash
KNOWLEDGE_FETCH_TIMEOUT_MS=15000 KNOWLEDGE_MAX_HTML_BYTES=10485760 docker compose up -d
```

## MVP Scope

- `browser_html`: the extension sends rendered page HTML to the local server.
- `server_fetch`: the local server fetches the URL when no HTML is provided.
- `file://` pages are only supported through `browser_html`.
- The server stores RawDoc metadata, Document JSON, Markdown, raw HTML, and URL status in a local `knowledge-store`.
- The side panel includes a `Saved` view backed by `/api/clips` for recently saved pages.
- The side panel renders Markdown as sanitized DOM, supports copying Markdown, deleting the current clip, and optional auto-refresh on tab changes.

## Roadmap And TODO

Priority labels:

- `P0`: Blocks MVP reliability, safety, or daily usability.
- `P1`: Important MVP polish or validation that should happen soon.
- `P2`: Near-term quality, parser, or workflow improvement.
- `P3`: Larger knowledge-base capability after the clipper loop is stable.
- `P4`: Later automation, export, or ecosystem expansion.

### Completed P0

| Priority | Done | Notes |
| --- | --- | --- |
| P0 | Render Markdown preview as sanitized HTML | The extension builds preview DOM nodes directly instead of injecting page-derived HTML. |
| P0 | Add copy Markdown action | Copies the latest preview Markdown from the side panel. |
| P0 | Add delete current clip flow | Deletes the current URL from the index and removes known generated files. |
| P0 | Add backend delete API | `DELETE /api/clip?url=...` deletes the saved record; pass `deleteFiles=false` to keep files. |
| P0 | Add path guard module and tests | Write/delete paths are resolved inside `knowledge-store`. |
| P0 | Tighten CORS | CORS allows Chrome extension origins and localhost-style development origins. |
| P0 | Add configurable auto-refresh | The side panel can auto-preview when the active tab changes or finishes loading. |

### MVP Completion

| Priority | TODO | Notes |
| --- | --- | --- |
| P1 | Add `RawDoc Meta` tab | RawDoc is saved but not visible in the extension UI. |
| P1 | Add parser logs tab | Show warnings, parser version, elapsed time, and extraction mode. |
| P1 | Improve local server offline UX | Show startup command, configured port, and token/config guidance when server is unavailable. |
| P1 | Complete badge states | Add transient `...` for conversion and `ERR` for failed conversion/status checks. |
| P1 | Add badge E2E assertion | Verify reload/re-enter saved URL shows `OK`. |
| P1 | Add `server_fetch` side-panel E2E path | Current extension E2E focuses on `browser_html`. |
| P1 | Add `file://` local HTML E2E path | Local files must force `browser_html`. |
| P1 | Add restricted-page E2E path | Example: `chrome://extensions` should show a clear access error. |
| P2 | Add settings page | Move server URL/token/default UI behavior out of the main clipping panel. |
| P2 | Add first-run token/config flow | Generate or discover local token instead of relying only on manual env/config. |
| P2 | Persist UI preferences | Default tab, auto-preview behavior, and preferred input mode. |
| P2 | Add extension-side status cache | Reduce localhost status requests during tab switching. |
| P2 | Add JSON Schema validation against `knowledge-core/schemas` | Current implementation has TS types and input zod validation, but not full output schema validation. |
| P2 | Add SQLite delete/repair/orphan handling | Needed once delete and crash recovery matter. |
| P2 | Add optional Raw HTML persistence flag | Allow privacy-conscious mode that keeps metadata/JSON/Markdown but skips raw HTML. |

### Parser And Content Quality

| Priority | TODO | Notes |
| --- | --- | --- |
| P1 | Add extraction quality scoring | Score title match, content length, section count, and content density before accepting a parser result. |
| P1 | Add static HTML fixture snapshot tests | Use representative pages from `knowledge-core/raw_ingest/examples`. |
| P1 | Compare against `knowledge-core/raw_ingest` outputs | Field-level checks for title, source URL, section type sequence, and Markdown body. |
| P2 | Add hostname-based TypeScript site adapter interface | Foundation for migrating high-value site rules. |
| P2 | Port mature `knowledge-core/raw_ingest/sites` rules to TypeScript | Start with the most valuable or frequently clipped sites. |
| P2 | Improve table/code/figure Markdown snapshots | Current renderer coverage is still basic. |
| P2 | Implement selection-only clipping | `selectionHtml` exists in schema but is not wired through UI or parser. |
| P3 | Add asset pipeline | Download images, rewrite Markdown image paths, and store asset metadata. |
| P3 | Add SQLite assets table | Track original source, local path, owning document, and captions. |

### Knowledge Base Capabilities

| Priority | TODO | Notes |
| --- | --- | --- |
| P2 | Improve Saved list into a searchable library view | Add search, sorting, filters, and current-page affordances. |
| P3 | Add chunk generation | Stable chunks become input for retrieval and review workflows. |
| P3 | Add embedding pipeline | Should build on Document JSON, not Markdown-only parsing. |
| P3 | Add full-text search | SQLite FTS or a dedicated local index. |
| P3 | Add tags | Manual and eventually rule/model-assisted tagging. |
| P3 | Add duplicate/similar document detection | Use normalized URL, title, canonical URL, and later embeddings. |
| P3 | Add backlinks/references | Connect saved pages and future notes. |

### Obsidian And Export

| Priority | TODO | Notes |
| --- | --- | --- |
| P2 | Add configurable frontmatter | Good first step toward Obsidian use. |
| P3 | Add custom Markdown templates | Similar spirit to Obsidian Clipper, but backed by Document JSON. |
| P3 | Add file naming rules | Configure slug, date, host, title, and collision behavior. |
| P3 | Add directory structure rules | Route notes by host, tag, date, or content type. |
| P3 | Add Obsidian vault export | Copy or sync generated Markdown/assets into a vault. |
| P4 | Add batch JSONL export | Useful for downstream indexing, training, or migration. |

### Batch And Automation

| Priority | TODO | Notes |
| --- | --- | --- |
| P4 | Add RSS import | Batch ingest feed entries through `server_fetch`. |
| P4 | Add reading-list import | Browser or exported reading-list source. |
| P4 | Add URL file import | Simple newline-delimited URLs are enough for a first version. |
| P4 | Add bookmark import | Browser bookmarks or exported HTML. |
| P4 | Add background batch queue | Needed before recurring or large-volume ingestion. |
