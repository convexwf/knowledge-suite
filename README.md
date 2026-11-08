# Knowledge Suite

Clip web pages into clean Markdown, with full-text search, reader mode, and
optional AI summaries — all running locally on your machine.

## Quick Start

```bash
make setup    # install dependencies + build
make dev      # start the server (Docker, http://127.0.0.1:18765)
make down     # stop the server
```

In Chrome, open `chrome://extensions`, enable **Developer mode**,
then **Load unpacked** → select `apps/knowledge-web-clipper/dist`.

That's it. Open any web page, click the extension icon to open the side panel,
and start clipping.

To rebuild after code changes:

```bash
make rebuild      # rebuild extension + Docker image + restart server
```

Or just rebuild the extension:

```bash
make build-extension
```

Then click **Reload** on the extension card in `chrome://extensions`.

Run `make help` to see all available targets.

## Features

### Web Clipping

The side panel supports two input modes:

- **Current HTML** — sends the browser-rendered page HTML to the local server.
  Works for any page, including `file://` and authenticated sites.
- **Server Fetch** — the server fetches the URL directly. Faster and cleaner
  for public pages.

You can preview the parsed Markdown before saving. If the parser produces
multiple candidates, switch between them in the preview dropdown and save the
best one.

### Extension Capture (no per-run prompt)

Chrome asks for confirmation on every new DevTools client, so the CDP path needs
one click per run. The `knowledge-capture-relay` extension removes that prompt:
it keeps a single WebSocket to the local server and captures allow-listed pages
on request.

```bash
# One-time setup:
#   chrome://extensions -> enable Developer mode ->
#   Load unpacked -> apps/knowledge-capture-relay
# Allow-list is currently https://www.xiaoheihe.cn/*

npm run capture -- https://www.xiaoheihe.cn/app/bbs/link/196383163 --save
npm run capture -- <url> --quiet
```

The extension opens a background tab, waits for the DOM to settle, and returns
the rendered snapshot. The server then parses it with the same adapters used by
the web clipper, so nothing leaves the machine. Add `--quiet` to reduce the
output to a single line.

Full walkthrough, token cost, latency and security notes:
[docs/capture-pipeline.zh-CN.md](docs/capture-pipeline.zh-CN.md).

### Saved Clips

Switch to the **Saved** tab to browse all previously saved clips. Each clip
shows title, URL, state (Parsed / Raw only), and timestamps. Use the
**More** menu to copy Markdown, delete, or purge a clip.

### Search Mode

`KNOWLEDGE_SEARCH` controls the derived retrieval index:

- `fts` (default): build chunks and a SQLite FTS5 index. Chinese queries of
  three or more characters use the trigram index; one- and two-character
  queries fall back to a `LIKE` scan.
- `off`: storage-only deployments (for example a cloud mirror). No chunks or
  FTS rows are written and `/api/search`, `/api/context` return
  `retriever: "disabled"` with empty results.
- `hybrid`: FTS plus vector recall, fused with reciprocal rank fusion
  (`k=60`). Requires `KNOWLEDGE_EMBEDDINGS=ollama`. If Ollama is offline the
  query degrades to FTS instead of failing; vector-only rows must reach
  cosine similarity `0.2`.

Embedding settings (used by `hybrid` and by the reindex commands):

- `KNOWLEDGE_EMBEDDINGS` — `none` (default) or `ollama`. The bundled
  `docker-compose.yml` defaults to `ollama` for local use.
- `KNOWLEDGE_EMBEDDING_MODEL` — `bge-m3` (1024 dimensions, L2-normalized).
- Chunk text is embedded as `title + heading path + text`.
- Vectors are stored per model in `chunk_embeddings`; switching models keeps
  old vectors instead of deleting them.
- The server calls Ollama directly at `POST /api/embed`. Ingest never blocks
  on Ollama: a failed embedding leaves the chunk pending for the next
  reindex.

If you switch from `off` to `fts` or `hybrid`, rebuild the derived index:

```bash
npm run search:reindex
```

The same maintenance is available over HTTP:

```bash
curl -X POST -H "Authorization: Bearer dev-token" http://127.0.0.1:18765/api/search/reindex
curl -X POST -H "Authorization: Bearer dev-token" "http://127.0.0.1:18765/api/embeddings/reindex?force=true"
```

Items carry an `owner` (`master` or `xiaojing`). `/api/items` accepts `owner`
and `tag` filters, and `/api/tags` lists available tags for the filter UI.

### Reader

Open any saved document in the reader (`reader.html`) for a focused reading
experience:

- **Document outline** — navigate by heading structure in the left sidebar.
- **Copy Markdown** — one-click copy of the full document.
- **Reparse** — re-process the raw document with updated parser code.

### AI Summary (experimental)

Generate section-level summaries using a local LLM. Requires
[Ollama](https://ollama.com) with the `qwen2.5:7b` model.

```bash
make setup-ai   # install + pull the model
make dev-ai     # start server with AI enabled
```

In the reader, click **AI Summary**, select headings to summarize, and
monitor progress. Summaries appear inline below each heading.

### Search

Full-text search across all saved documents via `/api/search`.
Context retrieval (`/api/context`) returns relevant chunks for RAG-style
queries.

### Annotations

Highlight, tag, and annotate sections within saved documents. View all
annotations per document in the annotations panel.

### Cloud Mirror Sync

The server can pull a one-way mirror from another Knowledge Suite instance
once a day. The remote instance is the read-only source; the local store
rebuilds its own chunks, FTS rows, and embeddings. See
[docs/knowledge-sync.zh-CN.md](docs/knowledge-sync.zh-CN.md).

### Batch Import

Import existing content in bulk:

```bash
make import-calibre ROOT=/path/to/calibre/library   # EPUB library
make import-html ROOT=/path/to/html/files            # HTML directory
make import-urls FILE=urls.txt                        # URL list
```

### Settings

Open the extension options page (`chrome://extensions` → **Details** →
**Extension options**) to configure:

- Server URL and token
- Default input mode and auto-refresh behavior
- Saved list limit and panel defaults
- Store maintenance (scan, clear, purge)

## Configuration

| Variable | Default | Description |
| --- | --- | --- |
| `KNOWLEDGE_HOST` | `127.0.0.1` | Server bind address |
| `KNOWLEDGE_PORT` | `18765` | Server port |
| `KNOWLEDGE_TOKEN` | `dev-token` | Bearer token for API auth |
| `KNOWLEDGE_SEARCH` | `fts` | Retrieval mode: `off`, `fts`, or `hybrid` |
| `KNOWLEDGE_EMBEDDINGS` | `none` | Embedding provider: `none` or `ollama` (hybrid requires `ollama`) |
| `KNOWLEDGE_EMBEDDING_BASE_URL` | `http://127.0.0.1:11434` | Ollama base URL |
| `KNOWLEDGE_EMBEDDING_MODEL` | `bge-m3` | Embedding model name |
| `KNOWLEDGE_EMBEDDING_DIM` | `1024` | Expected vector dimension |
| `KNOWLEDGE_EMBEDDING_BATCH_SIZE` | `16` | Texts per Ollama embed request |
| `KNOWLEDGE_EMBEDDING_TIMEOUT_MS` | `60000` | Ollama embed timeout |
| `KNOWLEDGE_SYNC_SOURCE_URL` | unset | Remote Knowledge Suite base URL; enables one-way pull when set with a token |
| `KNOWLEDGE_SYNC_SOURCE_TOKEN` | unset | Bearer token for the remote source; leave unset on the cloud source |
| `KNOWLEDGE_SYNC_AT` | `19:00` | Daily local time for the scheduled pull |
| `TZ` | `Asia/Shanghai` | Container timezone used to interpret `KNOWLEDGE_SYNC_AT` |
| `KNOWLEDGE_AI_ENABLED` | `false` | Enable AI summary endpoints |
| `KNOWLEDGE_AI_OLLAMA_MODEL` | `qwen2.5:7b` | Ollama model name |
| `KNOWLEDGE_FETCH_TIMEOUT_MS` | `15000` | Server fetch timeout |
| `KNOWLEDGE_MAX_HTML_BYTES` | `10485760` | Max HTML payload size |
| `KNOWLEDGE_GITHUB_TOKEN` | unset | Optional runtime-injected GitHub token for private repository Markdown |
| `GITHUB_TOKEN` | unset | Legacy alias for `KNOWLEDGE_GITHUB_TOKEN` |
| `GITHUB_API_URL` | `https://api.github.com` | GitHub API base URL |
| `KNOWLEDGE_MAX_GITHUB_FILES` | `100` | Max Markdown files in one GitHub import |
| `KNOWLEDGE_MAX_GITHUB_MARKDOWN_BYTES` | `5242880` | Max Markdown bytes in one GitHub import |
| `KNOWLEDGE_MAX_GITHUB_ASSET_REFERENCES` | `500` | Max referenced images in one GitHub import |
| `KNOWLEDGE_MAX_GITHUB_ASSET_BYTES` | `20971520` | Max private image proxy response size |

## Server Management

The server always runs in Docker:

```bash
make dev             # start (no AI)
make dev-ai          # start (with AI, requires Ollama)
make down            # stop
make logs            # tail logs
make rebuild         # rebuild extension + image + restart
make rebuild-ai      # same, with AI
```

With a custom token:

```bash
SERVER_TOKEN="your-token" make dev
```

GitHub Markdown imports use `owner`, `repo`, `ref`, and a repository-relative `path`. The path may be a Markdown file or any nested directory; directory imports recurse through `.md` and `.markdown` files. For private repositories, inject a read-only GitHub token only at server runtime:

```bash
KNOWLEDGE_GITHUB_TOKEN="github_pat_..." make dev
```

GitHub Markdown images are not copied into the Knowledge Store. Public repository images use a commit-pinned `raw.githubusercontent.com` URL. Private repository images are fetched on demand through the authenticated Knowledge Server proxy, so the GitHub token never reaches the browser or the Store.

The server persists data in `./knowledge-store/`. To reset:

```bash
make clean-store
```

To inspect legacy Markdown files and compare them with their Document JSON
derivatives, run the dry-run maintenance command:

```bash
npm run markdown:rewrite -- --store ./knowledge-store
```

Add `--write` only after reviewing the report to rewrite the derived Markdown
files. The command never changes Document JSON, annotations, chunks, or item
state.

## Project Links

- [API Reference](https://github.com/convexwf/uknowledge/blob/master/doc-rules/doc/uknowledge/knowledge-ingest-server-api-reference.md)
- [Roadmap](ROADMAP.md)
- [Technical Design Docs](https://github.com/convexwf/uknowledge/tree/master/doc-rules/doc/uknowledge)
