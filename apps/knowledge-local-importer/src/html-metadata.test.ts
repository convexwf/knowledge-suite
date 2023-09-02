import { describe, expect, it } from "vitest";
import { extractHtmlMetadata, isHttpUrl } from "./html-metadata.js";

describe("HTML metadata extraction", () => {
  it("extracts title, canonical URL, og:url, and author", () => {
    const metadata = extractHtmlMetadata(`<!doctype html>
      <html>
        <head>
          <title>Example &amp; Test</title>
          <link rel="canonical" href="https://example.com/a?utm_source=x" />
          <meta property="og:url" content="https://example.com/a" />
          <meta name="author" content="Ada" />
        </head>
      </html>`);

    expect(metadata).toEqual({
      title: "Example & Test",
      canonicalUrl: "https://example.com/a?utm_source=x",
      originalUrl: "https://example.com/a",
      author: "Ada"
    });
  });

  it("recognizes only HTTP URLs as web-backed sources", () => {
    expect(isHttpUrl("https://example.com")).toBe(true);
    expect(isHttpUrl("http://example.com")).toBe(true);
    expect(isHttpUrl("file:///tmp/a.html")).toBe(false);
    expect(isHttpUrl("not a url")).toBe(false);
  });
});
