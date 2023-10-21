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

### Saved Clips

Switch to the **Saved** tab to browse all previously saved clips. Each clip
shows title, URL, state (Parsed / Raw only), and timestamps. Use the
**More** menu to copy Markdown, delete, or purge a clip.

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
| `KNOWLEDGE_AI_ENABLED` | `false` | Enable AI summary endpoints |
| `KNOWLEDGE_AI_OLLAMA_MODEL` | `qwen2.5:7b` | Ollama model name |
| `KNOWLEDGE_FETCH_TIMEOUT_MS` | `15000` | Server fetch timeout |
| `KNOWLEDGE_MAX_HTML_BYTES` | `10485760` | Max HTML payload size |

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

The server persists data in `./knowledge-store/`. To reset:

```bash
make clean-store
```

## Project Links

- [API Reference](https://github.com/convexwf/uknowledge/blob/master/doc-rules/doc/uknowledge/knowledge-ingest-server-api-reference.md)
- [Roadmap](ROADMAP.md)
- [Technical Design Docs](https://github.com/convexwf/uknowledge/tree/master/doc-rules/doc/uknowledge)
