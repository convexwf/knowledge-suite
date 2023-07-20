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

## Run The Server With Docker

```bash
docker compose up -d --build knowledge-ingest-server
docker compose logs -f knowledge-ingest-server
```

The compose service listens on `127.0.0.1:18765` and persists server data in `./knowledge-store`.

Set a non-default token before starting the service:

```bash
KNOWLEDGE_TOKEN="replace-me" docker compose up -d --build knowledge-ingest-server
```

## MVP Scope

- `browser_html`: the extension sends rendered page HTML to the local server.
- `server_fetch`: the local server fetches the URL when no HTML is provided.
- `file://` pages are only supported through `browser_html`.
- The server stores RawDoc metadata, Document JSON, Markdown, raw HTML, and URL status in a local `knowledge-store`.
