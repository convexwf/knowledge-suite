---
title: "Generic Article"
page_title: "Generic Article"
url: "https://example.com/generic-parser-fixture"
ingested_at: "2026-05-21T00:00:00.000Z"
language: "en"
---

# Generic Article

A generic article should remain readable without a site adapter. This case protects the ordinary Defuddle and DOM fallback path for pages that are not covered by a configured profile.

The parser should keep meaningful paragraphs, preserve important inline links, and avoid copying cookie banners or navigation text into the resulting Markdown.

| Step | Purpose |
| --- | --- |
| Capture | Store the raw HTML snapshot. |
| Parse | Build Document sections from readable content. |

> Fixtures make parser changes visible before they reach real notes.
