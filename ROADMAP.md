# Knowledge Suite — Roadmap

Priority labels:

- `P0`: Blocks MVP reliability, safety, or daily usability.
- `P1`: Important MVP polish or validation that should happen soon.
- `P2`: Near-term quality, parser, or workflow improvement.
- `P3`: Larger knowledge-base capability after the clipper loop is stable.
- `P4`: Later automation, export, or ecosystem expansion.

## Completed

### P0

| Done | Notes |
| --- | --- |
| Render Markdown preview as sanitized HTML | Uses markdown-it + DOMPurify. |
| Add copy Markdown action | Copies the latest preview Markdown from the side panel. |
| Add delete current clip flow | Side panel supports `Remove` and `Purge`. |
| Add backend delete API | `DELETE /api/clip?url=...&mode=remove\|purge`. |
| Add path guard module and tests | Write/delete paths are resolved inside `knowledge-store`. |
| Tighten CORS | CORS allows Chrome extension origins and localhost. |
| Add configurable auto-refresh | Side panel can auto-preview on tab change/load. |
| Switch store to UUID object paths | Object files named by `rawdoc_id` / `doc_id`. |
| Add current-result reparse semantics | Re-saving a URL upserts to the newest result. |
| Reset legacy MVP store schema | Old stores are deleted and recreated. |
| Add settings page | Server URL, token, input mode, auto-refresh, timeout, store maintenance. |

### P1

| Done | Notes |
| --- | --- |
| Add `RawDoc` tab | Side panel exposes RawDoc for debugging. |
| Add parser logs tab | Summarizes parser method, section count, Defuddle metadata. |
| Preserve raw DOM for Defuddle and adapters | Prevent layout class names from deleting content. |
| Add parser candidate previews | Multiple candidates in preview, save by `candidateId`. |
| Add SQLite chunks and FTS search | Saved docs chunked into FTS, exposed via `/api/search`. |
| Add context packer | `/api/context` returns citation-ready chunks. |
| Add parser fixture corpus smoke suite | `fixtures:parser` replays offline P0 cases. |

### P2

| Done | Notes |
| --- | --- |
| Add TypeScript site adapter registry | Config adapters with URL matching and transforms. |
| Port high-value config adapters | Fern docs, Freedium, Medium, arXiv, Reddit, Meituan, etc. |
| Add Reddit site adapter | Comment-tree extraction with regression coverage. |

## TODO

### MVP Completion

| Priority | TODO | Notes |
| --- | --- | --- |
| P1 | Improve local server offline UX | Show startup command and token guidance when unavailable. |
| P1 | Complete badge states | Add transient `...` and `ERR` states. |
| P1 | Add badge E2E assertion | Verify reload/re-enter saved URL shows `OK`. |
| P1 | Add `server_fetch` side-panel E2E path | Current E2E focuses on `browser_html`. |
| P1 | Add `file://` local HTML E2E path | Local files must force `browser_html`. |
| P1 | Add restricted-page E2E path | `chrome://extensions` should show access error. |
| P2 | Add first-run token/config flow | Generate or discover local token. |
| P2 | Add extension-side status cache | Reduce localhost status requests during tab switching. |
| P2 | Add JSON Schema validation | TS types exist, but not full output schema validation. |
| P2 | Add SQLite delete/repair/orphan handling | Needed for crash recovery. |
| P2 | Add optional Raw HTML persistence flag | Privacy-conscious mode. |

### Parser & Content Quality

| Priority | TODO | Notes |
| --- | --- | --- |
| P1 | Improve extraction quality scoring | Needs title similarity and noise-ratio metrics. |
| P1 | Expand real parser fixture corpus | Add representative pages and known failures. |
| P1 | Compare fixture against `knowledge-core/raw_ingest` | Field-level checks for title, URL, sections, Markdown. |
| P2 | Add code adapter runtime hooks | `codeAdapters` for complex sites. |
| P2 | Improve table/code/figure Markdown snapshots | Current coverage is basic. |
| P2 | Improve selection clipping UX | No explicit selection-only mode yet. |
| P3 | Add asset pipeline | Download images, rewrite paths, store metadata. |
| P3 | Add SQLite assets table | Track source, local path, document, captions. |

### Knowledge Base

| Priority | TODO | Notes |
| --- | --- | --- |
| P2 | Improve Saved list into a searchable library | Search, sort, filter, current-page affordances. |
| P2 | Add retrieval rebuild endpoint | `POST /api/retrieval/rebuild` for repairing stores. |
| P2 | Add retrieval eval runner | Persisted eval case table. |
| P3 | Add embedding pipeline | Build on Document JSON, not Markdown-only. |
| P3 | Add tags | Manual and rule/model-assisted tagging. |
| P3 | Add duplicate/similar document detection | URL, title, canonical, embeddings. |
| P3 | Add backlinks/references | Connect saved pages and future notes. |

### Obsidian & Export

| Priority | TODO | Notes |
| --- | --- | --- |
| P2 | Add configurable frontmatter | First step toward Obsidian compatibility. |
| P3 | Add custom Markdown templates | Backed by Document JSON. |
| P3 | Add file naming rules | Slug, date, host, title, collision behavior. |
| P3 | Add directory structure rules | Route notes by host, tag, date, content type. |
| P3 | Add Obsidian vault export | Copy/sync Markdown + assets into a vault. |
| P4 | Add batch JSONL export | For downstream indexing, training, migration. |

### Batch & Automation

| Priority | TODO | Notes |
| --- | --- | --- |
| P4 | Add RSS import | Batch ingest feed entries. |
| P4 | Add reading-list import | Browser or exported reading-list source. |
| P4 | Add URL file import | Newline-delimited URLs. |
| P4 | Add bookmark import | Browser bookmarks or exported HTML. |
| P4 | Add background batch queue | For recurring or large-volume ingestion. |
