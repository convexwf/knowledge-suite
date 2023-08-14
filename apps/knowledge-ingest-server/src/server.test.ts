import { access, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveInsideRoot } from "./path-guard.js";
import { buildServer } from "./server.js";

const html = `<!doctype html>
<html lang="en">
  <head>
    <title>Example Article</title>
    <meta name="author" content="Ada">
  </head>
  <body>
    <article>
      <h1>Example Article</h1>
      <p>Hello knowledge suite. This paragraph is intentionally long enough to exercise the parser path with useful article content.</p>
      <ul><li>First point</li><li>Second point</li></ul>
    </article>
  </body>
</html>`;

describe("knowledge ingest server", () => {
  let storeRoot: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    storeRoot = await mkdtemp(join(tmpdir(), "knowledge-ingest-test-"));
    originalFetch = globalThis.fetch;
  });

  afterEach(async () => {
    globalThis.fetch = originalFetch;
    await rm(storeRoot, { recursive: true, force: true });
  });

  it("reports runtime health details", async () => {
    const app = await buildServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      storeRoot,
      fetchTimeoutMs: 1000,
      maxHtmlBytes: 2048
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/health"
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      ok: true,
      service: "knowledge-ingest-server",
      store: {
        type: "sqlite",
        indexPath: "index.sqlite3"
      },
      limits: {
        fetchTimeoutMs: 1000,
        maxHtmlBytes: 2048
      }
    });

    await app.close();
  });

  it("previews and saves browser_html clips", async () => {
    const app = await buildServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      storeRoot,
      fetchTimeoutMs: 1000,
      maxHtmlBytes: 1024 * 1024
    });

    const body = {
      inputMode: "browser_html",
      snapshot: {
        pageUrl: "https://example.com/a?utm_source=x#top",
        canonicalUrl: "https://example.com/a",
        title: "Example Article",
        html,
        capturedAt: "2026-05-11T02:00:00.000Z",
        meta: { author: "Ada" }
      }
    };

    const preview = await app.inject({
      method: "POST",
      url: "/api/clip/preview",
      headers: { authorization: "Bearer test-token" },
      payload: body
    });
    expect(preview.statusCode).toBe(200);
    expect(preview.json().markdown).toContain("Hello knowledge suite.");
    expect(preview.json().rawdoc.metadata.defuddle.wordCount).toBeGreaterThan(0);
    expect(preview.json().rawdoc.metadata.originalUrl).toBe("https://example.com/a?utm_source=x#top");
    expect(preview.json().rawdoc.metadata.canonicalUrl).toBe("https://example.com/a");
    expect(preview.json().status).toMatchObject({
      state: "empty",
      hasRawdoc: false,
      hasDocument: false
    });

    const save = await app.inject({
      method: "POST",
      url: "/api/clip/save",
      headers: { authorization: "Bearer test-token" },
      payload: body
    });
    expect(save.statusCode).toBe(200);
    expect(save.json().saved).toBe(true);
    expect(save.json().status).toMatchObject({
      state: "parsed",
      hasRawdoc: true,
      hasDocument: true
    });
    expect(save.json().paths.markdownPath).toMatch(/\.md$/);
    await expect(access(join(storeRoot, "index.sqlite3"))).resolves.toBeUndefined();

    const status = await app.inject({
      method: "GET",
      url: "/api/clip/status?url=https%3A%2F%2Fexample.com%2Fa%3Futm_source%3Dx%23top",
      headers: { authorization: "Bearer test-token" }
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      normalizedUrl: "https://example.com/a",
      state: "parsed",
      hasRawdoc: true,
      hasDocument: true,
      originalUrl: "https://example.com/a?utm_source=x#top",
      canonicalUrl: "https://example.com/a"
    });

    const list = await app.inject({
      method: "GET",
      url: "/api/clips",
      headers: { authorization: "Bearer test-token" }
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().clips).toHaveLength(1);
    expect(list.json().clips[0]).toMatchObject({
      normalizedUrl: "https://example.com/a",
      state: "parsed",
      hasRawdoc: true,
      hasDocument: true,
      originalUrl: "https://example.com/a?utm_source=x#top",
      canonicalUrl: "https://example.com/a",
      captureSavedAt: expect.any(String),
      captureUpdatedAt: expect.any(String),
      title: "Example Article"
    });

    const search = await app.inject({
      method: "GET",
      url: "/api/search?q=Second%20point&limit=5",
      headers: { authorization: "Bearer test-token" }
    });
    expect(search.statusCode).toBe(200);
    expect(search.json()).toMatchObject({
      query: "Second point",
      retriever: "sqlite_fts"
    });
    expect(search.json().results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          docId: save.json().document.doc_id,
          title: "Example Article",
          sourceUrl: "https://example.com/a",
          normalizedUrl: "https://example.com/a",
          parserMethod: "defuddle"
        })
      ])
    );
    expect(search.json().results[0].sectionIds.length).toBeGreaterThan(0);
    expect(String(search.json().results[0].snippet)).toContain("Second");

    const markdownPath = save.json().paths.markdownPath;
    await expect(access(join(storeRoot, markdownPath))).resolves.toBeUndefined();

    const deleted = await app.inject({
      method: "DELETE",
      url: "/api/clip?url=https%3A%2F%2Fexample.com%2Fa%3Futm_source%3Dx%23top",
      headers: { authorization: "Bearer test-token" }
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({
      deleted: true,
      mode: "remove",
      previousState: "parsed",
      currentState: "captured",
      state: "captured",
      hasRawdoc: true,
      hasDocument: false
    });
    expect(deleted.json().deletedFiles).toContain(markdownPath);
    await expect(access(join(storeRoot, markdownPath))).rejects.toThrow();

    const deletedStatus = await app.inject({
      method: "GET",
      url: "/api/clip/status?url=https%3A%2F%2Fexample.com%2Fa",
      headers: { authorization: "Bearer test-token" }
    });
    expect(deletedStatus.statusCode).toBe(200);
    expect(deletedStatus.json()).toMatchObject({
      normalizedUrl: "https://example.com/a",
      state: "captured",
      hasRawdoc: true,
      hasDocument: false
    });

    const reparsed = await app.inject({
      method: "POST",
      url: "/api/clip/reparse",
      headers: { authorization: "Bearer test-token" },
      payload: { url: "https://example.com/a" }
    });
    expect(reparsed.statusCode).toBe(200);
    expect(reparsed.json()).toMatchObject({
      saved: true,
      status: {
        normalizedUrl: "https://example.com/a",
        state: "parsed",
        hasRawdoc: true,
        hasDocument: true
      }
    });
    expect(reparsed.json().rawdoc.rawdoc_id).toBe(save.json().rawdoc.rawdoc_id);

    const purged = await app.inject({
      method: "DELETE",
      url: "/api/clip?url=https%3A%2F%2Fexample.com%2Fa&mode=purge",
      headers: { authorization: "Bearer test-token" }
    });
    expect(purged.statusCode).toBe(200);
    expect(purged.json()).toMatchObject({
      deleted: true,
      mode: "purge",
      currentState: "empty",
      state: "empty",
      hasRawdoc: false,
      hasDocument: false
    });

    await app.close();
  });

  it("rejects oversized browser_html uploads with a server_fetch hint", async () => {
    const app = await buildServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      storeRoot,
      fetchTimeoutMs: 1000,
      maxHtmlBytes: 512
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/clip/preview",
      headers: { authorization: "Bearer test-token" },
      payload: {
        inputMode: "browser_html",
        snapshot: {
          pageUrl: "https://example.com/large",
          title: "Large",
          html: `<html><body>${"x".repeat(1024)}</body></html>`,
          capturedAt: "2026-05-11T02:00:00.000Z",
          meta: {}
        }
      }
    });

    expect(response.statusCode).toBe(413);
    expect(response.json()).toMatchObject({
      error: "payload_too_large"
    });
    expect(response.json().message).toContain("Switch the extension to Server Fetch mode");

    await app.close();
  });

  it("extracts Defuddle metadata for body-only article pages without semantic article wrappers", async () => {
    const app = await buildServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      storeRoot,
      fetchTimeoutMs: 1000,
      maxHtmlBytes: 1024 * 1024
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/clip/preview",
      headers: { authorization: "Bearer test-token" },
      payload: {
        inputMode: "browser_html",
        snapshot: {
          pageUrl: "https://example.com/body-only",
          title: "Body Only Article",
          html: `<!doctype html>
            <html>
              <head><title>Body Only Article</title></head>
              <body>
                <div class="container">
                  <h1>Body Only Article</h1>
                  <div class="main-content">
                    <p>First paragraph with enough prose to look like a real article sentence for extraction.</p>
                    <p>Second paragraph with enough prose to confirm Defuddle is reading the full document body.</p>
                    <p>Third paragraph with enough prose to keep the extracted content above the usefulness threshold.</p>
                  </div>
                </div>
              </body>
            </html>`,
          capturedAt: "2026-05-11T02:00:00.000Z",
          meta: {}
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().rawdoc.metadata.defuddle.wordCount).toBeGreaterThan(20);
    expect(response.json().markdown).toContain("Second paragraph");

    await app.close();
  });

  it("renders links, images, and tables into Markdown", async () => {
    const app = await buildServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      storeRoot,
      fetchTimeoutMs: 1000,
      maxHtmlBytes: 1024 * 1024
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/clip/preview",
      headers: { authorization: "Bearer test-token" },
      payload: {
        inputMode: "browser_html",
        snapshot: {
          pageUrl: "https://example.com/rich-markdown",
          title: "Rich Markdown Article",
          html: `<!doctype html>
            <html>
              <head><title>Rich Markdown Article</title></head>
              <body>
                <article>
                  <h1>Rich Markdown Article</h1>
                  <p>Read the <a href="https://example.com/source">source article</a> and inspect the inline <img src="https://example.com/chart.png" alt="progress chart">.</p>
                  <figure>
                    <img src="https://example.com/photo.jpg" alt="Body composition photo">
                    <figcaption>Body composition trend.</figcaption>
                  </figure>
                  <table>
                    <tr><th>Metric</th><th>Value</th></tr>
                    <tr><td>Body fat</td><td>8%</td></tr>
                    <tr><td>Period</td><td>4 months</td></tr>
                  </table>
                </article>
              </body>
            </html>`,
          capturedAt: "2026-05-11T02:00:00.000Z",
          meta: {}
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().markdown).toContain("[source article](https://example.com/source)");
    expect(response.json().markdown).toContain("![progress chart](https://example.com/chart.png)");
    expect(response.json().markdown).toContain("![Body composition photo](https://example.com/photo.jpg)");
    expect(response.json().markdown).toContain("| Metric | Value |");
    expect(response.json().markdown).toContain("| Body fat | 8% |");

    await app.close();
  });

  it("uses a matched site adapter as a scored parser candidate", async () => {
    const app = await buildServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      storeRoot,
      fetchTimeoutMs: 1000,
      maxHtmlBytes: 1024 * 1024
    });

    const freediumHtml = `<!doctype html>
      <html>
        <head>
          <title>How I Lowered My Body Fat Percentage</title>
          <meta property="og:title" content="How I Lowered My Body Fat Percentage">
        </head>
        <body>
          <div class="storage-notification-container">Local storage warning should be removed.</div>
          <div class="container">
            <h1>How I Lowered My Body Fat Percentage</h1>
            <div class="main-content">
              <div>
                <p>This Freedium article paragraph contains enough concrete prose to be considered useful by the parser scoring model.</p>
                <p>The second paragraph confirms the adapter-selected content root keeps the article body without the storage notification chrome.</p>
                <figure>
                  <img data-src="/images/progress.jpg" alt="Progress chart">
                  <figcaption>Progress chart.</figcaption>
                </figure>
              </div>
            </div>
          </div>
        </body>
      </html>`;
    const freediumPayload = {
      inputMode: "browser_html" as const,
      snapshot: {
        pageUrl: "https://freedium-mirror.cfd/https://medium.com/in-fitness-and-in-health/example-a875f21bed2d",
        title: "How I Lowered My Body Fat Percentage",
        html: freediumHtml,
        capturedAt: "2026-05-11T02:00:00.000Z",
        meta: {}
      }
    };

    const response = await app.inject({
      method: "POST",
      url: "/api/clip/preview",
      headers: { authorization: "Bearer test-token" },
      payload: freediumPayload
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().rawdoc.metadata.parserMethod).toBe("site_adapter");
    expect(response.json().rawdoc.metadata.parserProfile).toBe("freedium");
    expect(response.json().rawdoc.metadata.originalUrl).toBe(
      "https://freedium-mirror.cfd/https://medium.com/in-fitness-and-in-health/example-a875f21bed2d"
    );
    expect(response.json().rawdoc.metadata.canonicalUrl).toBe(
      "https://medium.com/in-fitness-and-in-health/example-a875f21bed2d"
    );
    expect(response.json().rawdoc.metadata.normalizedUrl).toBe(
      "https://medium.com/in-fitness-and-in-health/example-a875f21bed2d"
    );
    expect(response.json().rawdoc.metadata.matchedAdapters[0]).toMatchObject({
      id: "freedium"
    });
    expect(response.json().rawdoc.metadata.parserCandidates).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: "site_adapter",
          adapterId: "freedium",
          selected: true
        }),
        expect.objectContaining({
          method: "dom_fallback"
        })
      ])
    );
    expect(response.json().markdown).toContain("The second paragraph confirms");
    expect(response.json().markdown).toContain("![Progress chart](https://freedium-mirror.cfd/images/progress.jpg)");
    expect(response.json().markdown).not.toContain("Local storage warning");

    const save = await app.inject({
      method: "POST",
      url: "/api/clip/save",
      headers: { authorization: "Bearer test-token" },
      payload: freediumPayload
    });
    expect(save.statusCode).toBe(200);
    expect(save.json()).toMatchObject({
      saved: true,
      status: {
        normalizedUrl: "https://medium.com/in-fitness-and-in-health/example-a875f21bed2d",
        state: "parsed",
        hasRawdoc: true,
        hasDocument: true,
        originalUrl: "https://freedium-mirror.cfd/https://medium.com/in-fitness-and-in-health/example-a875f21bed2d",
        canonicalUrl: "https://medium.com/in-fitness-and-in-health/example-a875f21bed2d"
      }
    });

    const mirrorStatus = await app.inject({
      method: "GET",
      url: "/api/clip/status?url=https%3A%2F%2Ffreedium-mirror.cfd%2Fhttps%3A%2F%2Fmedium.com%2Fin-fitness-and-in-health%2Fexample-a875f21bed2d",
      headers: { authorization: "Bearer test-token" }
    });
    expect(mirrorStatus.statusCode).toBe(200);
    expect(mirrorStatus.json()).toMatchObject({
      normalizedUrl: "https://medium.com/in-fitness-and-in-health/example-a875f21bed2d",
      state: "parsed",
      hasRawdoc: true,
      hasDocument: true,
      originalUrl: "https://freedium-mirror.cfd/https://medium.com/in-fitness-and-in-health/example-a875f21bed2d",
      canonicalUrl: "https://medium.com/in-fitness-and-in-health/example-a875f21bed2d"
    });

    await app.close();
  });

  it("prefers a user selection candidate when selection HTML is present", async () => {
    const app = await buildServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      storeRoot,
      fetchTimeoutMs: 1000,
      maxHtmlBytes: 1024 * 1024
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/clip/preview",
      headers: { authorization: "Bearer test-token" },
      payload: {
        inputMode: "browser_html",
        snapshot: {
          pageUrl: "https://example.com/selection",
          title: "Selection Article",
          html: `<!doctype html><html><body><article><h1>Selection Article</h1><p>Full page content that should lose to the selected passage when the user has highlighted a useful excerpt.</p></article></body></html>`,
          selectionHtml: `<section><h2>Selected Passage</h2><p>The selected passage is intentionally long enough to become a first-class parser candidate.</p><blockquote>Selection keeps quoted material.</blockquote></section>`,
          capturedAt: "2026-05-11T02:00:00.000Z",
          meta: {}
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().rawdoc.metadata.parserMethod).toBe("selection");
    expect(response.json().markdown).toContain("## Selected Passage");
    expect(response.json().markdown).toContain("> Selection keeps quoted material.");
    expect(response.json().markdown).not.toContain("Full page content");

    await app.close();
  });

  it("uses schema.org JSON-LD as a parser candidate", async () => {
    const app = await buildServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      storeRoot,
      fetchTimeoutMs: 1000,
      maxHtmlBytes: 1024 * 1024
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/clip/preview",
      headers: { authorization: "Bearer test-token" },
      payload: {
        inputMode: "browser_html",
        snapshot: {
          pageUrl: "https://example.com/jsonld",
          title: "Shell Page",
          html: `<!doctype html>
            <html>
              <head>
                <script type="application/ld+json">
                  {
                    "@context": "https://schema.org",
                    "@type": "ScholarlyArticle",
                    "headline": "Structured Article",
                    "author": [{"name": "Grace Hopper"}],
                    "datePublished": "2026-01-02",
                    "keywords": ["parser", "jsonld"],
                    "abstract": "A structured abstract extracted from schema.org metadata.",
                    "articleBody": "A structured article body extracted from schema.org metadata.\\n\\nThe body has enough text to be useful when the visible DOM is sparse."
                  }
                </script>
              </head>
              <body><main><p>Short shell.</p></main></body>
            </html>`,
          capturedAt: "2026-05-11T02:00:00.000Z",
          meta: {}
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().rawdoc.metadata.parserMethod).toBe("schema_org");
    expect(response.json().document.meta.title).toBe("Structured Article");
    expect(response.json().document.meta.authors).toEqual(["Grace Hopper"]);
    expect(response.json().document.meta.tags).toEqual(["parser", "jsonld"]);
    expect(response.json().markdown).toContain("A structured article body");

    await app.close();
  });

  it("parses arXiv LaTeXML HTML with paper tags and references", async () => {
    let fetchedUrl = "";
    globalThis.fetch = async (url) => {
      fetchedUrl = String(url);
      return new Response(`<!doctype html>
        <html>
          <head>
            <title>arXiv paper</title>
            <meta name="citation_author" content="Ignored Meta Author">
          </head>
          <body>
            <article class="ltx_document">
              <h1 class="ltx_title_document">A Useful Paper</h1>
              <div class="ltx_authors">
                <span class="ltx_personname">Ada Lovelace</span>
                <span class="ltx_personname">Alan Turing</span>
              </div>
              <section class="ltx_section">
                <h2 class="ltx_title">Introduction</h2>
                <div class="ltx_para">
                  <p class="ltx_p">This arXiv paragraph is long enough to exercise the paper parser candidate and preserve inline math <math alttext="x^2"></math>.</p>
                </div>
                <figure>
                  <img class="ltx_graphics" src="figures/example.png" alt="Example figure">
                  <figcaption class="ltx_caption">An example figure.</figcaption>
                </figure>
              </section>
              <section class="ltx_bibliography">
                <ul>
                  <li id="bib.bib1"><span class="ltx_tag">[1]</span> A referenced paper.</li>
                </ul>
              </section>
            </article>
          </body>
        </html>`, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8"
        }
      });
    };

    const app = await buildServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      storeRoot,
      fetchTimeoutMs: 1000,
      maxHtmlBytes: 1024 * 1024
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/clip/preview",
      headers: { authorization: "Bearer test-token" },
      payload: {
        inputMode: "server_fetch",
        url: "https://arxiv.org/abs/2401.00001v1"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(fetchedUrl).toBe("https://arxiv.org/html/2401.00001v1");
    expect(response.json().rawdoc.metadata.parserMethod).toBe("site_adapter");
    expect(response.json().rawdoc.metadata.parserProfile).toBe("arxiv_html");
    expect(response.json().document.meta.title).toBe("A Useful Paper");
    expect(response.json().document.meta.authors).toEqual(["Ada Lovelace", "Alan Turing"]);
    expect(response.json().document.meta.tags).toEqual([
      "paper:work_id:arxiv:2401.00001v1",
      "paper:variant:preprint"
    ]);
    expect(response.json().document.references[0]).toMatchObject({
      ref_id: "bib.bib1",
      label: "[1]",
      text: "[1] A referenced paper."
    });
    expect(response.json().markdown).toContain("inline math $x^2$");
    expect(response.json().markdown).toContain("![Example figure](https://arxiv.org/html/figures/example.png)");

    await app.close();
  });

  it("removes common page chrome before extraction", async () => {
    const app = await buildServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      storeRoot,
      fetchTimeoutMs: 1000,
      maxHtmlBytes: 1024 * 1024
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/clip/preview",
      headers: { authorization: "Bearer test-token" },
      payload: {
        inputMode: "browser_html",
        snapshot: {
          pageUrl: "https://example.com/noisy",
          title: "Noisy Article",
          html: `<!doctype html>
            <html>
              <head><title>Noisy Article</title></head>
              <body>
                <nav>Global navigation should be removed</nav>
                <div class="cookie banner">Accept cookies should be removed</div>
                <div class="modal overlay">Subscribe modal should be removed</div>
                <article>
                  <h1>Noisy Article</h1>
                  <h4>Useful fourth-level heading</h4>
                  <p>Useful article body that should remain after noisy page chrome is removed from the extraction tree.</p>
                </article>
              </body>
            </html>`,
          capturedAt: "2026-05-11T02:00:00.000Z",
          meta: {}
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().markdown).toContain("#### Useful fourth-level heading");
    expect(response.json().markdown).toContain("Useful article body");
    expect(response.json().markdown).not.toContain("Global navigation");
    expect(response.json().markdown).not.toContain("Accept cookies");
    expect(response.json().markdown).not.toContain("Subscribe modal");

    await app.close();
  });

  it("restricts CORS to extension and localhost origins", async () => {
    const app = await buildServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      storeRoot,
      fetchTimeoutMs: 1000,
      maxHtmlBytes: 1024 * 1024
    });

    const extensionOrigin = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: { origin: "chrome-extension://abc123" }
    });
    expect(extensionOrigin.headers["access-control-allow-origin"]).toBe("chrome-extension://abc123");

    const localhostOrigin = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: { origin: "http://127.0.0.1:3000" }
    });
    expect(localhostOrigin.headers["access-control-allow-origin"]).toBe("http://127.0.0.1:3000");

    const blockedOrigin = await app.inject({
      method: "GET",
      url: "/api/health",
      headers: { origin: "https://example.com" }
    });
    expect(blockedOrigin.headers["access-control-allow-origin"]).toBeUndefined();

    await app.close();
  });

  it("guards knowledge-store file paths", () => {
    expect(resolveInsideRoot(storeRoot, "docs/example.md")).toBe(join(storeRoot, "docs/example.md"));
    expect(() => resolveInsideRoot(storeRoot, "../escape.md")).toThrow("escapes");
    expect(() => resolveInsideRoot(storeRoot, "/tmp/escape.md")).toThrow("Unsafe");
  });

  it("rejects server_fetch for file URLs", async () => {
    const app = await buildServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      storeRoot,
      fetchTimeoutMs: 1000,
      maxHtmlBytes: 1024 * 1024
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/clip/preview",
      headers: { authorization: "Bearer test-token" },
      payload: {
        inputMode: "server_fetch",
        url: "file:///Users/me/page.html"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain("browser_html");
    await app.close();
  });

  it("previews server_fetch HTML responses", async () => {
    globalThis.fetch = async () => new Response(html, {
      status: 200,
      headers: {
        "content-type": "text/html; charset=utf-8"
      }
    });

    const app = await buildServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      storeRoot,
      fetchTimeoutMs: 1000,
      maxHtmlBytes: 1024 * 1024
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/clip/preview",
      headers: { authorization: "Bearer test-token" },
      payload: {
        inputMode: "server_fetch",
        url: "https://example.com/a"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().markdown).toContain("Hello knowledge suite.");
    await app.close();
  });

  it("rejects non-HTML server_fetch responses", async () => {
    globalThis.fetch = async () => new Response("{}", {
      status: 200,
      headers: {
        "content-type": "application/json"
      }
    });

    const app = await buildServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      storeRoot,
      fetchTimeoutMs: 1000,
      maxHtmlBytes: 1024 * 1024
    });

    const response = await app.inject({
      method: "POST",
      url: "/api/clip/preview",
      headers: { authorization: "Bearer test-token" },
      payload: {
        inputMode: "server_fetch",
        url: "https://example.com/api"
      }
    });

    expect(response.statusCode).toBe(400);
    expect(response.json().message).toContain("Expected HTML");
    await app.close();
  });
});
