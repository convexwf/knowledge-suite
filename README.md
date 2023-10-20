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
make setup    # install deps + build all packages
make dev      # start the ingest server
```

In Chrome, open `chrome://extensions`, enable **Developer mode**, then
**Load unpacked** → select `apps/knowledge-web-clipper/dist`.

```bash
make build-extension   # rebuild extension after code changes
```

For a full list of targets:

```bash
make help
```

### With AI Summary (experimental)

```bash
make setup-ai   # setup + pull ollama model
make dev-ai     # start server with AI enabled
```

Or run via Docker:

```bash
make docker-up-ai
```
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
Object files use UUID names:

```text
knowledge-store/
├── index.sqlite3
├── rawdocs/
│   ├── {rawdoc_id}.html
│   └── {rawdoc_id}.json
├── documents/
│   └── {doc_id}.json
├── markdown/
│   └── {doc_id}.md
└── assets/
```

SQLite stores URL/title/parser mappings, not object paths. Paths are derived from `doc_id` and `rawdoc_id`.
If the server detects the early MVP path-based schema, it deletes the old local store data and rebuilds the new schema instead of migrating old documents.
The compose file builds the `runtime` Dockerfile target explicitly. After changing server or schema code, restart with `--build` so the running container does not keep an older compiled parser:

```bash
docker compose up -d --build knowledge-ingest-server
```

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
- Saved files are UUID-named. `clips` maps each normalized URL to the current `doc_id` / `rawdoc_id`; re-saving the same URL creates new objects and moves the URL mapping to the newest result.
- The side panel includes a `Saved` view backed by `/api/clips` for recently saved pages.
- The side panel renders Markdown as sanitized DOM, supports copying Markdown, deleting the current clip, and optional auto-refresh on tab changes.
- Markdown output preserves inline links, inline images, figure images/captions, and basic HTML tables.

## Roadmap And TODO

Priority labels:

- `P0`: Blocks MVP reliability, safety, or daily usability.
- `P1`: Important MVP polish or validation that should happen soon.
- `P2`: Near-term quality, parser, or workflow improvement.
- `P3`: Larger knowledge-base capability after the clipper loop is stable.
- `P4`: Later automation, export, or ecosystem expansion.

### Obsidian Clipper Parser Gaps

This project intentionally started with a smaller parser surface than Obsidian Clipper. The table below tracks known gaps to close when improving extraction quality and Obsidian-style workflows.

| Priority | Gap | Obsidian Clipper capability | Knowledge Suite status |
| --- | --- | --- | --- |
| P1 | Async Defuddle parsing | Uses `Defuddle.parseAsync()` with a timeout fallback to sync `parse()` for richer async variables. | Implemented in the ingest parser with diagnostics for async/sync mode and usefulness. |
| P1 | Mature HTML-to-Markdown conversion | Uses `defuddle/full` `createMarkdownContent()` for a battle-tested Markdown conversion path. | Converts Defuddle output into `KnowledgeDocument.sections`, then renders Markdown with a local renderer. |
| P1 | Shadow DOM flattening | Runs a main-world script that stamps shadow root HTML into attributes readable by the content script. | Implemented for open shadow roots in the extension snapshot; diagnostics record shadow root count. |
| P1 | Relative URL normalization | Rewrites `src`, `href`, and `srcset` values to absolute URLs before downstream use. | Not implemented comprehensively. |
| P1 | Extraction quality metadata | Exposes parse time, word count, site, favicon, image, schema.org data, meta tags, and Defuddle variables. | RawDoc metadata now includes parser diagnostics, candidate metrics, cleanup summaries, and Defuddle async/sync details. |
| P2 | Selector extraction | Supports `selector:` and `selectorHtml:` variables for targeted extraction. | Not implemented. |
| P2 | Template and filter pipeline | Compiles note names, properties, frontmatter, note body templates, and many filters. | Not implemented; output format is fixed. |
| P2 | Selection capture | Captures selected HTML and can use it in templates. | Implemented as a high-priority parser candidate; template integration is still out of scope. |
| P2 | Highlighter integration | Stores and reuses page highlights, highlighter overlays, and highlight metadata. | Not implemented. |
| P2 | Full HTML cleanup for templates | Removes scripts/styles, strips inline styles, and prepares a cleaned full HTML variant for template variables. | Parser now has first-pass noise cleanup, but no cleaned full-HTML template variable. |
| P3 | Rich variable API | Builds reusable variables like `content`, `contentHtml`, `description`, `published`, `site`, `wordCount`, `schemaOrgData`, and selector-derived values. | No public variable API yet. |
| P3 | Obsidian frontmatter generation | Generates frontmatter from typed template properties. | Only fixed frontmatter in generated Markdown. |

### Completed P0

| Priority | Done | Notes |
| --- | --- | --- |
| P0 | Render Markdown preview as sanitized HTML | The extension builds preview DOM nodes directly instead of injecting page-derived HTML. |
| P0 | Add copy Markdown action | Copies the latest preview Markdown from the side panel. |
| P0 | Add delete current clip flow | Side panel supports `Remove` for parsed results and `Purge` for raw capture plus parsed result. |
| P0 | Add backend delete API | `DELETE /api/clip?url=...&mode=remove|purge` updates URL state and removes derived/raw objects according to mode. |
| P0 | Add path guard module and tests | Write/delete paths are resolved inside `knowledge-store`. |
| P0 | Tighten CORS | CORS allows Chrome extension origins and localhost-style development origins. |
| P0 | Add configurable auto-refresh | The side panel can auto-preview when the active tab changes or finishes loading. |
| P0 | Switch store to UUID object paths | Raw HTML, RawDoc JSON, Document JSON, and Markdown paths are derived from `rawdoc_id` / `doc_id`; SQLite no longer stores object paths. |
| P0 | Add current-result reparse semantics | Re-saving a URL upserts `clips.url_hash` to the newest `doc_id` / `rawdoc_id` and removes the previous object files. |
| P0 | Reset legacy MVP store schema | Old path-based local stores are deleted and recreated instead of migrated. |
| P0 | Add settings page | Server URL, token, default input mode, auto-refresh, diagnostics visibility, timeout, saved-list limit, and store maintenance live in the extension options page. |
| P1 | Add `RawDoc` tab | The side panel now exposes the RawDoc returned by preview/save for parser and storage debugging. |
| P1 | Add parser logs tab | The side panel now summarizes parser method, parser version, source details, section count, Defuddle metadata, and extraction warnings. |
| P1 | Preserve raw DOM for Defuddle and adapters | Defuddle and site adapters now run before aggressive fallback cleanup, preventing layout class names such as `fixed-sidebar` from deleting real content. |
| P1 | Add parser candidate previews | Preview responses include viable parser candidates; the side panel can switch active candidate from the Preview dropdown and save by `candidateId`. |
| P1 | Add SQLite chunks and FTS search | Saved documents are chunked into SQLite FTS and exposed through `/api/search`. |
| P1 | Add context packer | `/api/context` returns citation-ready full chunk content with trace support. |
| P1 | Add parser fixture corpus smoke suite | `fixtures:parser` replays 5 offline P0 cases for Fern docs, Freedium, arXiv HTML, generic article, and selection clipping with Document/Markdown/candidate snapshots. |
| P2 | Add TypeScript site adapter registry | Config adapters are loaded through a typed registry with URL matching, canonical/fetch transforms, and duplicate-id validation. |
| P2 | Port high-value config adapters | Current adapters include Fern docs, Freedium, Medium, arXiv HTML, Reddit, Meituan Tech, Engineering FB, Blog Google, Smashing Magazine, All Things Distributed, Brendan Gregg, and Juejin. |
| P2 | Add Reddit site adapter | Reddit/Shreddit posts now have a dedicated adapter with comment-tree extraction and regression coverage for browser HTML clipping. |

### MVP Completion

| Priority | TODO | Notes |
| --- | --- | --- |
| P1 | Improve local server offline UX | Show startup command, configured port, and token/config guidance when server is unavailable. |
| P1 | Complete badge states | Add transient `...` for conversion and `ERR` for failed conversion/status checks. |
| P1 | Add badge E2E assertion | Verify reload/re-enter saved URL shows `OK`. |
| P1 | Add `server_fetch` side-panel E2E path | Current extension E2E focuses on `browser_html`. |
| P1 | Add `file://` local HTML E2E path | Local files must force `browser_html`. |
| P1 | Add restricted-page E2E path | Example: `chrome://extensions` should show a clear access error. |
| P2 | Add first-run token/config flow | Generate or discover local token instead of relying only on manual env/config. |
| P2 | Add extension-side status cache | Reduce localhost status requests during tab switching. |
| P2 | Add JSON Schema validation against `knowledge-core/schemas` | Current implementation has TS types and input zod validation, but not full output schema validation. |
| P2 | Add SQLite delete/repair/orphan handling | Needed once delete and crash recovery matter. |
| P2 | Add optional Raw HTML persistence flag | Allow privacy-conscious mode that keeps metadata/JSON/Markdown but skips raw HTML. |

### Parser And Content Quality

| Priority | TODO | Notes |
| --- | --- | --- |
| P1 | Improve extraction quality scoring | Current scoring covers text length, section count, density, links, images, tables, code, and adapter bonus; still needs title similarity and noise-ratio metrics. |
| P1 | Expand real parser fixture corpus | The P0 smoke corpus exists; keep adding captured representative pages from `knowledge-core/raw_ingest/examples` and known failures. |
| P1 | Compare fixture corpus against `knowledge-core/raw_ingest` outputs | Field-level checks for title, source URL, section type sequence, metadata, and Markdown body. |
| P2 | Add code adapter runtime hooks | `codeAdapters` is currently empty; complex sites need prepare/root/metadata/content hooks beyond config selectors. |
| P2 | Improve table/code/figure Markdown snapshots | Current renderer coverage is still basic. |
| P2 | Improve selection clipping UX | `selectionHtml` is captured and parsed as a high-priority candidate, but the side panel does not yet expose an explicit selection-only mode. |
| P3 | Add asset pipeline | Download images, rewrite Markdown image paths, and store asset metadata. |
| P3 | Add SQLite assets table | Track original source, local path, owning document, and captions. |

### Knowledge Base Capabilities

| Priority | TODO | Notes |
| --- | --- | --- |
| P2 | Improve Saved list into a searchable library view | Add search, sorting, filters, and current-page affordances. |
| P2 | Add retrieval rebuild endpoint | Chunks are rebuilt during save/remove/purge, but there is no `POST /api/retrieval/rebuild` for repairing existing stores. |
| P2 | Add retrieval eval runner | Smoke retrieval exists; there is no persisted eval case table or `npm run eval:retrieval` yet. |
| P3 | Add embedding pipeline | Should build on Document JSON, not Markdown-only parsing. |
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
