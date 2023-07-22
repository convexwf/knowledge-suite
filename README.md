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

## Integration Smoke

```bash
npm run build
npm run smoke:ingest
```

The smoke script starts a temporary local article server plus `knowledge-ingest-server`, then verifies:

- `browser_html` preview
- `server_fetch` preview
- save + normalized status lookup
- non-HTML `server_fetch` rejection

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
