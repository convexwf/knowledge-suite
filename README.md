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

## MVP Scope

- `browser_html`: the extension sends rendered page HTML to the local server.
- `server_fetch`: the local server fetches the URL when no HTML is provided.
- `file://` pages are only supported through `browser_html`.
- The server stores RawDoc metadata, Document JSON, Markdown, raw HTML, and URL status in a local `knowledge-store`.
