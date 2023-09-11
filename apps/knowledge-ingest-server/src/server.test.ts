import { access, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { resolveInsideRoot } from "./path-guard.js";
import { buildServer } from "./server.js";

const html = `<!doctype html>
<html lang="en">
  <head>
    <title>Example Article - Example Site</title>
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

const redditHtml = `<!doctype html>
<html lang="en">
  <head>
    <title>AI Agent best practices from one year as AI Engineer : r/AI_Agents</title>
  </head>
  <body>
    <div class="grid-container theme-rpl grid flex-nav-expanded">
      <div id="subgrid-container" class="subgrid-container">
        <div class="main-container fixed-sidebar">
          <shreddit-post
            post-title="AI Agent best practices from one year as AI Engineer"
            author="LearnSkillsFast"
            created-timestamp="2025-07-02T01:23:43.595000+0000"
            subreddit-prefixed-name="r/AI_Agents">
            <h1 slot="title">AI Agent best practices from one year as AI Engineer</h1>
            <shreddit-post-text-body slot="text-body">
              <div slot="text-body">
                <div property="schema:articleBody">
                  <p>Hey everyone.</p>
                  <h1>I've worked as an AI Engineer for 1 year.</h1>
                  <p>You might <strong>not need an AI agent</strong> for every automation workflow.</p>
                  <p>Start with a deterministic chain, keep tool inputs small, and only add planning when the workflow genuinely branches.</p>
                  <ul>
                    <li><p>Create a chain in LangChain.</p></li>
                    <li><p>Log every model decision before adding memory.</p></li>
                  </ul>
                </div>
              </div>
            </shreddit-post-text-body>
          </shreddit-post>
          <shreddit-comment
            author="Worldly-Control403"
            thingid="t1_njxr5bd"
            depth="0"
            created="2025-10-17T08:00:51.354000+0000"
            permalink="/r/AI_Agents/comments/1lpj771/comment/njxr5bd/"
            score="16">
            <div class="md" id="t1_njxr5bd-comment-rtjson-content" slot="comment">
              <p>Most problems do not need AI agents. A bit of logic and clean process usually does the job.</p>
              <p>Keep it stupid simple and start with a normal workflow before adding an agent.</p>
            </div>
          </shreddit-comment>
          <shreddit-comment
            author="LearnSkillsFast"
            thingid="t1_n0v6fcy"
            depth="0"
            created="2025-07-02T01:24:26.086000+0000"
            permalink="/r/AI_Agents/comments/1lpj771/comment/n0v6fcy/"
            score="10">
            <div class="md" id="t1_n0v6fcy-comment-rtjson-content" slot="comment">
              <p>Agent use-cases: <a href="https://github.com/ashishpatel26/500-AI-Agents-Projects">500 AI Agents Projects</a></p>
              <p>Building effective agents: <a href="https://www.anthropic.com/engineering/building-effective-agents">Anthropic guide</a></p>
            </div>
          </shreddit-comment>
          <shreddit-comment
            author="ImpressiveFault42069"
            thingid="t1_n0vja75"
            depth="0"
            created="2025-07-02T02:39:27.026000+0000"
            permalink="/r/AI_Agents/comments/1lpj771/comment/n0vja75/"
            score="4">
            <div class="md" id="t1_n0vja75-comment-rtjson-content" slot="comment">
              <p>I would say for beginners, n8n is the best no or low code tool to build powerful linear agents.</p>
            </div>
          </shreddit-comment>
          <shreddit-comment
            author="LearnSkillsFast"
            thingid="t1_n0vjqdv"
            depth="1"
            created="2025-07-02T02:42:09.144000+0000"
            permalink="/r/AI_Agents/comments/1lpj771/comment/n0vjqdv/"
            score="1">
            <div class="md" id="t1_n0vjqdv-comment-rtjson-content" slot="comment">
              <p>Good to hear, what sort of solutions have you made with n8n?</p>
            </div>
          </shreddit-comment>
        </div>
      </div>
    </div>
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
        pageTitle: "Example Article - Example Site",
        title: "Example Article - Example Site",
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
    expect(preview.json().rawdoc.metadata.pageTitle).toBe("Example Article - Example Site");
    expect(preview.json().rawdoc.metadata.contentTitle).toBe("Example Article");
    expect(preview.json().document.meta.title).toBe("Example Article");
    expect(preview.json().document.meta.page_title).toBe("Example Article - Example Site");
    expect(preview.json().markdown).toContain("page_title: \"Example Article - Example Site\"");
    expect(preview.json().selectedCandidateId).toBe(preview.json().serverSelectedCandidateId);
    expect(preview.json().candidatePreviews.length).toBeGreaterThan(0);
    expect(preview.json().candidatePreviews[0].markdown).toContain("Hello knowledge suite.");
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
      canonicalUrl: "https://example.com/a",
      title: "Example Article - Example Site",
      pageTitle: "Example Article - Example Site",
      contentTitle: "Example Article",
      displayTitle: "Example Article - Example Site"
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
      title: "Example Article - Example Site",
      pageTitle: "Example Article - Example Site",
      contentTitle: "Example Article",
      displayTitle: "Example Article - Example Site"
    });

    const items = await app.inject({
      method: "GET",
      url: "/api/items?sourceType=url",
      headers: { authorization: "Bearer test-token" }
    });
    expect(items.statusCode).toBe(200);
    expect(items.json().items).toEqual([
      expect.objectContaining({
        itemId: expect.stringMatching(/^url:sha256:/),
        sourceType: "url",
        state: "parsed",
        title: "Example Article - Example Site",
        activeDocId: save.json().document.doc_id,
        activeRawdocId: save.json().rawdoc.rawdoc_id
      })
    ]);

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
          title: "Example Article - Example Site",
          pageTitle: "Example Article - Example Site",
          contentTitle: "Example Article",
          displayTitle: "Example Article - Example Site",
          sourceUrl: "https://example.com/a",
          normalizedUrl: "https://example.com/a",
          parserMethod: "defuddle"
        })
      ])
    );
    expect(search.json().results[0].sectionIds.length).toBeGreaterThan(0);
    expect(String(search.json().results[0].snippet)).toContain("Second");

    const context = await app.inject({
      method: "GET",
      url: "/api/context?q=Second%20point&limit=3&maxChars=2000&trace=true",
      headers: { authorization: "Bearer test-token" }
    });
    expect(context.statusCode).toBe(200);
    expect(context.json()).toMatchObject({
      query: "Second point",
      retriever: "sqlite_fts",
      packer: "section_chunk_v1",
      citations: [
        expect.objectContaining({
          citationId: "1",
          marker: "[1]",
          docId: save.json().document.doc_id,
          sourceUrl: "https://example.com/a",
          parserMethod: "defuddle",
          trace: expect.objectContaining({
            termCoverage: 1
          })
        })
      ]
    });
    expect(context.json().budget.usedChars).toBe(context.json().contextText.length);
    expect(context.json().contextText).toContain("[1] Example Article - Example Site");
    expect(context.json().contextText).toContain("Second point");

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

  it("imports, reads, searches, removes, and reparses EPUB items", async () => {
    let pandocRuns = 0;
    const app = await buildServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      storeRoot,
      fetchTimeoutMs: 1000,
      maxHtmlBytes: 1024 * 1024,
      maxImportBytes: 1024 * 1024,
      epubPandocRunner: async ({ outputPath }) => {
        pandocRuns += 1;
        await writeFile(outputPath, JSON.stringify({
          meta: {
            title: { t: "MetaInlines", c: [{ t: "Str", c: "EPUB" }, { t: "Space" }, { t: "Str", c: "Handbook" }] },
            author: { t: "MetaList", c: [{ t: "MetaInlines", c: [{ t: "Str", c: "Ada" }] }] },
            lang: { t: "MetaString", c: "en" }
          },
          blocks: [
            { t: "Header", c: [1, ["intro", [], []], [{ t: "Str", c: "Introduction" }]] },
            {
              t: "Para",
              c: [
                { t: "Str", c: "EPUB" },
                { t: "Space" },
                { t: "Str", c: "retrieval" },
                { t: "Space" },
                { t: "Str", c: "content" },
                { t: "Space" },
                { t: "Str", c: "is" },
                { t: "Space" },
                { t: "Str", c: "searchable." }
              ]
            },
            {
              t: "BulletList",
              c: [
                [{ t: "Plain", c: [{ t: "Str", c: "First" }, { t: "Space" }, { t: "Str", c: "chapter" }] }]
              ]
            },
            {
              t: "Table",
              c: [
                ["", [], []],
                [null, []],
                [["AlignDefault", 0], ["AlignDefault", 0]],
                [
                  ["", [], []],
                  [
                    [
                      ["", [], []],
                      [
                        [["", [], []], "AlignDefault", 1, 1, [{ t: "Plain", c: [{ t: "Str", c: "Name" }] }]],
                        [["", [], []], "AlignDefault", 1, 1, [{ t: "Plain", c: [{ t: "Str", c: "Value" }] }]]
                      ]
                    ]
                  ]
                ],
                [
                  [
                    ["", [], []],
                    0,
                    [["", [], []], []],
                    [
                      [
                        ["", [], []],
                        [
                          [["", [], []], "AlignDefault", 1, 1, [{ t: "Plain", c: [{ t: "Str", c: "Alpha" }] }]],
                          [["", [], []], "AlignDefault", 1, 1, [{ t: "Plain", c: [{ t: "Str", c: "One" }] }]]
                        ]
                      ],
                      [
                        ["", [], []],
                        [
                          [["", [], []], "AlignDefault", 1, 1, [{ t: "Plain", c: [{ t: "Str", c: "Beta" }] }]],
                          [["", [], []], "AlignDefault", 1, 1, [{ t: "Plain", c: [{ t: "Str", c: "Two" }] }]]
                        ]
                      ]
                    ]
                  ]
                ],
                [["", [], []], []]
              ]
            },
            {
              t: "Div",
              c: [
                ["chapter-detail", [], []],
                [
                  { t: "Header", c: [2, ["detail", [], []], [{ t: "Str", c: "Nested" }, { t: "Space" }, { t: "Str", c: "Section" }]] },
                  {
                    t: "Para",
                    c: [
                      { t: "Str", c: "Nested" },
                      { t: "Space" },
                      { t: "Str", c: "EPUB" },
                      { t: "Space" },
                      { t: "Str", c: "body" },
                      { t: "Space" },
                      { t: "Str", c: "text" },
                      { t: "Space" },
                      { t: "Str", c: "is" },
                      { t: "Space" },
                      { t: "Str", c: "preserved." }
                    ]
                  }
                ]
              ]
            }
          ]
        }), "utf8");
        return { version: "pandoc 3.test", warnings: [] };
      }
    });

    const epubBytes = Buffer.from("fake epub bytes");
    const metadataOpf = `<?xml version="1.0" encoding="UTF-8"?>
      <package xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf">
        <metadata>
          <dc:identifier opf:scheme="calibre" id="calibre_id">883</dc:identifier>
          <dc:identifier opf:scheme="uuid" id="uuid_id">book-uuid</dc:identifier>
          <dc:identifier opf:scheme="ISBN">9787567511491</dc:identifier>
          <dc:identifier opf:scheme="NEW_DOUBAN">25707589</dc:identifier>
          <dc:title>Calibre Handbook</dc:title>
          <dc:creator>Ada Lovelace</dc:creator>
          <dc:publisher>Example Press</dc:publisher>
          <dc:date>2024-01-02</dc:date>
          <dc:language>zho</dc:language>
          <dc:subject>Reference</dc:subject>
          <dc:description>&lt;p&gt;Imported from Calibre.&lt;/p&gt;</dc:description>
          <meta name="calibre:user_metadata:#pages" content="{&quot;#value#&quot;:55}" />
          <meta name="calibre:user_metadata:#words" content="{&quot;#value#&quot;:47562}" />
        </metadata>
      </package>`;
    const imported = await app.inject({
      method: "POST",
      url: "/api/import/epub",
      headers: { authorization: "Bearer test-token" },
      payload: {
        fileBase64: epubBytes.toString("base64"),
        metadataOpf,
        coverBase64: Buffer.from("fake cover bytes").toString("base64"),
        coverFilename: "cover.jpg",
        sourceUri: "file:///books/handbook.epub",
        tags: ["fixture"]
      }
    });

    expect(imported.statusCode).toBe(200);
    const saved = imported.json();
    expect(saved.saved).toBe(true);
    expect(saved.knowledgeItem).toMatchObject({
      sourceType: "epub",
      title: "Calibre Handbook",
      creators: ["Ada Lovelace"],
      language: "zh",
      tags: ["fixture", "Reference"],
      state: "parsed"
    });
    expect(saved.rawdoc).toMatchObject({
      source_type: "epub",
      source_uri: "file:///books/handbook.epub",
      content_type: "application/epub+zip"
    });
    expect(saved.rawdoc.metadata).toMatchObject({
      parserBackend: "pandoc",
      pandocVersion: "pandoc 3.test",
      importMode: "calibre_directory",
      calibre: {
        id: "883",
        isbn: "9787567511491",
        douban: "25707589",
        title: "Calibre Handbook",
        publisher: "Example Press",
        pages: 55,
        wordCount: 47562
      },
      identifiers: {
        calibre: "883",
        uuid: "book-uuid",
        isbn: "9787567511491",
        douban: "25707589"
      }
    });
    expect(saved.rawdoc.metadata.metadataOpfHash).toEqual(expect.any(String));
    expect(saved.rawdoc.metadata.externalCoverHash).toEqual(expect.any(String));
    expect(saved.document.meta.source.type).toBe("epub");
    expect(saved.document.meta.published_at).toBe("2024-01-02");
    expect(saved.document.meta.cover_asset_id).toMatch(/\.jpg$/);
    expect(saved.document.meta.statistics).toMatchObject({
      sectionCount: expect.any(Number),
      headingCount: 2,
      paragraphCount: 2,
      tableCount: 1,
      figureCount: 1,
      imageCount: 1,
      assetCount: 1
    });
    expect(saved.document.sections).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: "figure",
        assets: [expect.objectContaining({ asset_id: expect.stringMatching(/\.jpg$/), path: expect.stringMatching(/^assets\//) })]
      }),
      expect.objectContaining({ type: "heading", content: "Introduction" }),
      expect.objectContaining({ type: "paragraph", content: "EPUB retrieval content is searchable." }),
      expect.objectContaining({ type: "table", rows: [["Name", "Value"], ["Alpha", "One"], ["Beta", "Two"]] }),
      expect.objectContaining({ type: "heading", content: "Nested Section" }),
      expect.objectContaining({ type: "paragraph", content: "Nested EPUB body text is preserved." })
    ]));
    expect(saved.markdown).toContain("# Calibre Handbook");
    expect(saved.markdown).toContain("![Cover](assets/");
    expect(saved.markdown).toContain("EPUB retrieval content is searchable.");
    expect(saved.markdown).toContain("| Name | Value |");
    expect(saved.markdown).toContain("| Alpha | One |");
    expect(saved.markdown).toContain("Nested EPUB body text is preserved.");
    expect(saved.paths.rawContentPath).toMatch(/\.epub$/);
    expect(Object.values(saved.paths).some((path) => String(path).endsWith(".opf"))).toBe(false);
    await expect(access(join(storeRoot, saved.paths.rawContentPath))).resolves.toBeUndefined();

    const scan = await app.inject({
      method: "GET",
      url: "/api/store/scan",
      headers: { authorization: "Bearer test-token" }
    });
    expect(scan.statusCode).toBe(200);
    expect(scan.json().tables.epubMetadata).toBe(1);

    const list = await app.inject({
      method: "GET",
      url: "/api/items?sourceType=epub",
      headers: { authorization: "Bearer test-token" }
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().items).toHaveLength(1);
    expect(list.json().items[0].itemId).toBe(saved.knowledgeItem.itemId);

    const document = await app.inject({
      method: "GET",
      url: `/api/documents/${saved.document.doc_id}`,
      headers: { authorization: "Bearer test-token" }
    });
    expect(document.statusCode).toBe(200);
    expect(document.json().meta.title).toBe("Calibre Handbook");

    const markdown = await app.inject({
      method: "GET",
      url: `/api/documents/${saved.document.doc_id}/markdown`,
      headers: { authorization: "Bearer test-token" }
    });
    expect(markdown.statusCode).toBe(200);
    expect(markdown.body).toContain("EPUB retrieval content");

    const search = await app.inject({
      method: "GET",
      url: "/api/search?q=EPUB%20retrieval",
      headers: { authorization: "Bearer test-token" }
    });
    expect(search.statusCode).toBe(200);
    expect(search.json().results[0]).toMatchObject({
      docId: saved.document.doc_id,
      rawdocId: saved.rawdoc.rawdoc_id,
      title: "Calibre Handbook",
      sourceUrl: "file:///books/handbook.epub",
      normalizedUrl: saved.knowledgeItem.itemId,
      parserMethod: "pandoc_epub"
    });

    const removed = await app.inject({
      method: "DELETE",
      url: `/api/items/${encodeURIComponent(saved.knowledgeItem.itemId)}`,
      headers: { authorization: "Bearer test-token" }
    });
    expect(removed.statusCode).toBe(200);
    expect(removed.json()).toMatchObject({
      deleted: true,
      mode: "remove",
      previousState: "parsed",
      currentState: "captured",
      removedDocId: saved.document.doc_id
    });
    await expect(access(join(storeRoot, saved.paths.rawContentPath))).resolves.toBeUndefined();

    const reparsed = await app.inject({
      method: "POST",
      url: `/api/items/${encodeURIComponent(saved.knowledgeItem.itemId)}/reparse`,
      headers: { authorization: "Bearer test-token" }
    });
    expect(reparsed.statusCode).toBe(200);
    expect(reparsed.json().knowledgeItem).toMatchObject({
      itemId: saved.knowledgeItem.itemId,
      title: "Calibre Handbook",
      creators: ["Ada Lovelace"],
      language: "zh",
      state: "parsed"
    });
    expect(reparsed.json().rawdoc.metadata.importMode).toBe("calibre_directory");
    expect(reparsed.json().rawdoc.metadata.metadataOpfHash).toBeUndefined();
    expect(reparsed.json().rawdoc.rawdoc_id).toBe(saved.rawdoc.rawdoc_id);
    expect(reparsed.json().document.doc_id).not.toBe(saved.document.doc_id);
    expect(pandocRuns).toBe(2);

    await app.close();
  });

  it("runs Defuddle and Reddit adapter before aggressive fallback cleanup", async () => {
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
          pageUrl: "https://www.reddit.com/r/AI_Agents/comments/1lpj771/ai_agent_best_practices_from_one_year_as_ai/",
          pageTitle: "AI Agent best practices from one year as AI Engineer : r/AI_Agents",
          title: "AI Agent best practices from one year as AI Engineer : r/AI_Agents",
          html: redditHtml,
          bodyText: "Hey everyone. You might not need an AI agent for every automation workflow.",
          capturedAt: "2026-05-20T02:00:00.000Z",
          meta: {}
        }
      }
    });

    expect(response.statusCode).toBe(200);
    const payload = response.json();
    const candidates = payload.rawdoc.metadata.parserCandidates;
    const defuddleCandidate = candidates.find((candidate: { method: string }) => candidate.method === "defuddle");
    const redditCandidate = candidates.find((candidate: { method: string; adapterId?: string }) =>
      candidate.method === "site_adapter" && candidate.adapterId === "reddit"
    );

    expect(payload.rawdoc.metadata.defuddle.wordCount).toBeGreaterThan(20);
    expect(defuddleCandidate?.metrics.textLength).toBeGreaterThan(180);
    expect(redditCandidate?.metrics.textLength).toBeGreaterThan(180);
    expect(payload.markdown).toContain("not need an AI agent");
    expect(payload.markdown).toContain("Create a chain in LangChain");
    expect(payload.markdown).toContain("## Comments");
    expect(payload.markdown).toContain("> **Worldly-Control403** · [2025-10-17](https://reddit.com/r/AI_Agents/comments/1lpj771/comment/njxr5bd/) · 16 points");
    expect(payload.markdown).toContain("> Agent use-cases: [500 AI Agents Projects](https://github.com/ashishpatel26/500-AI-Agents-Projects)");
    expect(payload.markdown).toContain("> > **LearnSkillsFast** · [2025-07-02](https://reddit.com/r/AI_Agents/comments/1lpj771/comment/n0vjqdv/) · 1 points");
    expect(payload.document.meta.title).toBe("AI Agent best practices from one year as AI Engineer");

    await app.close();
  });

  it("saves a user-selected parser candidate", async () => {
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
        pageUrl: "https://example.com/candidates",
        title: "Candidate Article",
        html,
        selectionHtml: `
          <section>
            <h2>Selected Candidate</h2>
            <p>The selected candidate is intentionally long enough to win the default parser score.</p>
          </section>
        `,
        capturedAt: "2026-05-11T02:30:00.000Z",
        meta: {}
      }
    };

    const preview = await app.inject({
      method: "POST",
      url: "/api/clip/preview",
      headers: { authorization: "Bearer test-token" },
      payload: body
    });
    expect(preview.statusCode).toBe(200);
    const previewJson = preview.json();
    expect(previewJson.selectedCandidateId).toBe("selection");
    const fallback = previewJson.candidatePreviews.find(
      (candidate: { method: string }) => candidate.method === "dom_fallback"
    );
    expect(fallback).toBeTruthy();
    expect(fallback.markdown).toContain("Hello knowledge suite.");

    const save = await app.inject({
      method: "POST",
      url: "/api/clip/save",
      headers: { authorization: "Bearer test-token" },
      payload: {
        ...body,
        candidateId: fallback.id
      }
    });
    expect(save.statusCode).toBe(200);
    const saved = save.json();
    expect(saved.activeCandidateId).toBe(fallback.id);
    expect(saved.serverSelectedCandidateId).toBe("selection");
    expect(saved.rawdoc.metadata.parserSelectedCandidateId).toBe("selection");
    expect(saved.rawdoc.metadata.userSelectedCandidateId).toBe(fallback.id);
    expect(saved.document.meta.parser_version).toBe("knowledge-ingest-server/0.2:dom_fallback");
    expect(saved.markdown).toContain("Hello knowledge suite.");

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

  it("scans and clears the local store through maintenance APIs", async () => {
    const app = await buildServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      storeRoot,
      fetchTimeoutMs: 1000,
      maxHtmlBytes: 1024 * 1024
    });

    const body = {
      inputMode: "browser_html" as const,
      snapshot: {
        pageUrl: "https://example.com/maintenance",
        pageTitle: "Maintenance Article - Example Site",
        title: "Maintenance Article - Example Site",
        html,
        capturedAt: "2026-05-11T02:00:00.000Z",
        meta: {}
      }
    };
    const save = await app.inject({
      method: "POST",
      url: "/api/clip/save",
      headers: { authorization: "Bearer test-token" },
      payload: body
    });
    expect(save.statusCode).toBe(200);

    const scan = await app.inject({
      method: "GET",
      url: "/api/store/scan",
      headers: { authorization: "Bearer test-token" }
    });
    expect(scan.statusCode).toBe(200);
    expect(scan.json()).toMatchObject({
      storeRoot,
      database: {
        exists: true,
        path: "index.sqlite3"
      },
      tables: {
        clips: 1,
        rawdocs: 1,
        documents: 1
      },
      files: {
        rawdocs: 2,
        documents: 1,
        markdown: 1,
        totalContentFiles: 4
      }
    });

    const rejected = await app.inject({
      method: "POST",
      url: "/api/store/clear",
      headers: { authorization: "Bearer test-token" },
      payload: { confirm: true }
    });
    expect(rejected.statusCode).toBe(400);

    const cleared = await app.inject({
      method: "POST",
      url: "/api/store/clear",
      headers: { authorization: "Bearer test-token" },
      payload: {
        confirm: true,
        confirmation: "CLEAR KNOWLEDGE STORE"
      }
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({
      cleared: true,
      before: {
        totals: {
          contentFiles: 4
        }
      },
      after: {
        totals: {
          rows: 0,
          contentFiles: 0
        }
      }
    });

    const status = await app.inject({
      method: "GET",
      url: "/api/clip/status?url=https%3A%2F%2Fexample.com%2Fmaintenance",
      headers: { authorization: "Bearer test-token" }
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      state: "empty",
      hasRawdoc: false,
      hasDocument: false
    });

    await app.close();
  });

  it("clears parsed results through maintenance API while keeping raw captures", async () => {
    const app = await buildServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      storeRoot,
      fetchTimeoutMs: 1000,
      maxHtmlBytes: 1024 * 1024
    });

    const body = {
      inputMode: "browser_html" as const,
      snapshot: {
        pageUrl: "https://example.com/maintenance-parsed",
        pageTitle: "Parsed Maintenance Article - Example Site",
        title: "Parsed Maintenance Article - Example Site",
        html,
        capturedAt: "2026-05-11T02:00:00.000Z",
        meta: {}
      }
    };
    const save = await app.inject({
      method: "POST",
      url: "/api/clip/save",
      headers: { authorization: "Bearer test-token" },
      payload: body
    });
    expect(save.statusCode).toBe(200);

    const rejected = await app.inject({
      method: "POST",
      url: "/api/store/clear-parsed",
      headers: { authorization: "Bearer test-token" },
      payload: { confirm: true }
    });
    expect(rejected.statusCode).toBe(400);

    const cleared = await app.inject({
      method: "POST",
      url: "/api/store/clear-parsed",
      headers: { authorization: "Bearer test-token" },
      payload: {
        confirm: true,
        confirmation: "CLEAR PARSED RESULTS"
      }
    });
    expect(cleared.statusCode).toBe(200);
    expect(cleared.json()).toMatchObject({
      cleared: true,
      mode: "parsed",
      before: {
        parsedResults: {
          parsedClips: 1,
          documentRows: 1
        }
      },
      after: {
        tables: {
          clips: 1,
          rawdocs: 1,
          documents: 0,
          chunks: 0
        },
        files: {
          rawdocs: 2,
          totalContentFiles: 2
        },
        parsedResults: {
          parsedClips: 0,
          documentRows: 0,
          chunkRows: 0,
          derivedFiles: 0
        }
      }
    });

    const status = await app.inject({
      method: "GET",
      url: "/api/clip/status?url=https%3A%2F%2Fexample.com%2Fmaintenance-parsed",
      headers: { authorization: "Bearer test-token" }
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({
      state: "captured",
      hasRawdoc: true,
      hasDocument: false
    });

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
                  <img data-src="https://example.com/standalone.jpg" alt="Standalone chart">
                  <figcaption>Standalone chart caption.</figcaption>
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
    expect(response.json().markdown).toContain("![Standalone chart](https://example.com/standalone.jpg)");
    expect(response.json().markdown).toContain("Standalone chart caption.");
    expect(response.json().markdown).toContain("| Metric | Value |");
    expect(response.json().markdown).toContain("| Body fat | 8% |");

    await app.close();
  });

  it("renders GitHub markdown image containers in Defuddle and DOM fallback candidates", async () => {
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
          pageUrl: "https://github.com/datawhalechina/hello-agents/blob/main/docs/chapter14/example.md",
          pageTitle: "Example GitHub Markdown",
          title: "Example GitHub Markdown",
          html: `<!doctype html>
            <html>
              <head><title>Example GitHub Markdown</title></head>
              <body>
                <article class="markdown-body entry-content container-lg">
                  <h1>第十四章 自动化深度研究智能体</h1>
                  <p>此次系统仍然采用经典的前后端分离架构，如图 14.1 所示。</p>
                  <div align="center" dir="auto">
                    <a target="_blank" href="https://raw.githubusercontent.com/datawhalechina/Hello-Agents/main/docs/images/14-figures/14-1.png">
                      <img src="https://raw.githubusercontent.com/datawhalechina/Hello-Agents/main/docs/images/14-figures/14-1.png" alt="" width="85%" style="max-width: 100%;">
                    </a>
                    <p dir="auto">图 14.1 深度研究助手技术架构</p>
                  </div>
                  <p>系统分为四层架构设计，包含前端、后端、智能体和外部服务。</p>
                </article>
              </body>
            </html>`,
          capturedAt: "2026-05-11T02:00:00.000Z",
          meta: {}
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().markdown).toContain(
      "![图 14.1 深度研究助手技术架构](https://raw.githubusercontent.com/datawhalechina/Hello-Agents/main/docs/images/14-figures/14-1.png)"
    );
    expect(response.json().markdown).toContain("图 14.1 深度研究助手技术架构");
    const domFallback = response.json().candidatePreviews.find(
      (candidate: { method: string }) => candidate.method === "dom_fallback"
    );
    expect(domFallback?.markdown).toContain(
      "![图 14.1 深度研究助手技术架构](https://raw.githubusercontent.com/datawhalechina/Hello-Agents/main/docs/images/14-figures/14-1.png)"
    );

    await app.close();
  });

  it("does not render ordinary div wrappers as duplicate paragraphs", async () => {
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
          pageUrl: "https://example.com/wrapped-layout",
          pageTitle: "Wrapped Layout",
          title: "Wrapped Layout",
          html: `<!doctype html>
            <html>
              <head><title>Wrapped Layout</title></head>
              <body>
                <article>
                  <h1>Wrapped Layout</h1>
                  <div class="content-wrapper">
                    <p>First stable paragraph.</p>
                    <p>Second stable paragraph.</p>
                  </div>
                  <section>
                    <div class="layout-shell">
                      <h2>Nested Heading</h2>
                      <p>Nested body paragraph.</p>
                    </div>
                  </section>
                </article>
              </body>
            </html>`,
          capturedAt: "2026-05-11T02:00:00.000Z",
          meta: {}
        }
      }
    });

    expect(response.statusCode).toBe(200);
    const markdown = response.json().markdown;
    expect(markdown.match(/First stable paragraph\./g)).toHaveLength(1);
    expect(markdown.match(/Second stable paragraph\./g)).toHaveLength(1);
    expect(markdown.match(/Nested body paragraph\./g)).toHaveLength(1);
    expect(markdown).not.toContain(
      "First stable paragraph. Second stable paragraph."
    );

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
                <a class="related-article-card" href="https://freedium-mirror.cfd/https://agentnativedev.medium.com/qwen-3-5-35b-a3b-why-your-800-gpu-just-became-a-frontier-class-ai-workstation-abc123">
                  <div>
                    <h2>Qwen 3.5 35B-A3B: Why Your $800 GPU Just Became a Frontier Class AI Workstation</h2>
                    <p>A rich Medium link card teaser should be stripped from the article body.</p>
                  </div>
                </a>
                <p>The second paragraph confirms the adapter-selected content root keeps the article body without the storage notification chrome.</p>
                <img data-src="/images/progress.jpg" alt="Progress chart">
                <figcaption>Progress chart.</figcaption>
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
    expect(response.json().markdown).toContain(
      "[Qwen 3.5 35B-A3B: Why Your $800 GPU Just Became a Frontier Class AI Workstation](https://freedium-mirror.cfd/https://agentnativedev.medium.com/qwen-3-5-35b-a3b-why-your-800-gpu-just-became-a-frontier-class-ai-workstation-abc123)"
    );
    expect(response.json().markdown).not.toContain("A rich Medium link card teaser");
    expect(response.json().markdown).toContain("![Progress chart](https://freedium-mirror.cfd/images/progress.jpg)");
    expect(response.json().markdown).toContain("Progress chart.");
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

  it("keeps Fern docs main content when layout classes mention header height", async () => {
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
          pageUrl: "https://docs.cohere.com/docs/rerank-overview",
          title: "An Overview of Cohere's Rerank Model",
          html: `<!doctype html>
            <html>
              <head><title>An Overview of Cohere's Rerank Model</title></head>
              <body id="fern-docs">
                <main class="fern-main relative z-0 flex transition-all duration-500 ease-out mt-(--header-height)">
                  <article class="w-content-width mx-auto max-w-full">
                    <h1>An Overview of Cohere's Rerank Model</h1>
                    <h2>How Rerank Works</h2>
                    <p>The Rerank API endpoint is a simple and very powerful tool for semantic search.</p>
                    <h2>Get Started</h2>
                    <p>In this example, documents are indexed from most to least relevant to the query.</p>
                  </article>
                </main>
              </body>
            </html>`,
          capturedAt: "2026-05-20T02:00:00.000Z",
          meta: {}
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().rawdoc.metadata.parserProfile).not.toBe("dom_fallback");
    expect(response.json().rawdoc.metadata.matchedAdapters[0].id).toBe("fern_docs");
    const fernCandidates = response.json().rawdoc.metadata.parserCandidates.filter(
      (candidate: { adapterId?: string }) => candidate.adapterId === "fern_docs"
    );
    expect(fernCandidates).toHaveLength(1);
    expect(fernCandidates[0].selector).toBe("main article");
    expect(response.json().rawdoc.metadata.parserDiagnostics.cleanup.cleanedReadableRoot.tag).toBe("article");
    expect(response.json().markdown).toContain("## How Rerank Works");
    expect(response.json().markdown).toContain("Rerank API endpoint");
    expect(response.json().markdown).toContain("## Get Started");

    await app.close();
  });

  it("uses rendered browser text when serialized HTML has no readable content", async () => {
    const app = await buildServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      storeRoot,
      fetchTimeoutMs: 1000,
      maxHtmlBytes: 1024 * 1024
    });

    const renderedText = [
      "Rendered Only Article",
      "Client-rendered applications can expose useful text through the live browser body even when serialized HTML only contains an empty application root.",
      "The parser keeps this as a low-confidence fallback so the clipper does not return an empty document."
    ].join("\n\n");

    const response = await app.inject({
      method: "POST",
      url: "/api/clip/preview",
      headers: { authorization: "Bearer test-token" },
      payload: {
        inputMode: "browser_html",
        snapshot: {
          pageUrl: "https://example.com/rendered-only",
          title: "Rendered Only Article",
          html: `<!doctype html><html><head><title>Rendered Only Article</title></head><body><div id="root"></div></body></html>`,
          text: renderedText,
          capturedAt: "2026-05-20T02:10:00.000Z",
          meta: {}
        }
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().rawdoc.metadata.parserProfile).toBe("rendered_text_fallback");
    expect(response.json().rawdoc.metadata.parserDiagnostics.input.browserTextLength).toBeGreaterThan(80);
    expect(response.json().markdown).toContain("Client-rendered applications");

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

  it("uses the final server_fetch response URL as the primary clip identity", async () => {
    globalThis.fetch = async () => {
      const response = new Response(html, {
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8"
        }
      });
      Object.defineProperty(response, "url", {
        value: "https://docs.example.com/docs/reranking?utm_source=feed#intro"
      });
      return response;
    };

    const app = await buildServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      storeRoot,
      fetchTimeoutMs: 1000,
      maxHtmlBytes: 1024 * 1024
    });

    const saveResponse = await app.inject({
      method: "POST",
      url: "/api/clip/save",
      headers: { authorization: "Bearer test-token" },
      payload: {
        inputMode: "server_fetch",
        url: "https://docs.example.com/docs/rerank-overview"
      }
    });

    expect(saveResponse.statusCode).toBe(200);
    const saved = saveResponse.json();
    expect(saved.status.normalizedUrl).toBe("https://docs.example.com/docs/reranking");
    expect(saved.status.originalUrl).toBe("https://docs.example.com/docs/rerank-overview");
    expect(saved.rawdoc.metadata.canonicalUrl).toBe(
      "https://docs.example.com/docs/reranking?utm_source=feed#intro"
    );
    expect(saved.rawdoc.metadata.fetchUrl).toBe(
      "https://docs.example.com/docs/reranking?utm_source=feed#intro"
    );

    const finalStatusResponse = await app.inject({
      method: "GET",
      url: `/api/clip/status?url=${encodeURIComponent("https://docs.example.com/docs/reranking")}`,
      headers: { authorization: "Bearer test-token" }
    });
    expect(finalStatusResponse.statusCode).toBe(200);
    expect(finalStatusResponse.json().state).toBe("parsed");
    expect(finalStatusResponse.json().normalizedUrl).toBe("https://docs.example.com/docs/reranking");

    const originalStatusResponse = await app.inject({
      method: "GET",
      url: `/api/clip/status?url=${encodeURIComponent("https://docs.example.com/docs/rerank-overview")}`,
      headers: { authorization: "Bearer test-token" }
    });
    expect(originalStatusResponse.statusCode).toBe(200);
    expect(originalStatusResponse.json().state).toBe("parsed");
    expect(originalStatusResponse.json().normalizedUrl).toBe("https://docs.example.com/docs/reranking");

    await app.close();
  });

  it("creates a collection and saves a batch of server_fetch pages", async () => {
    globalThis.fetch = async (input) => {
      const url = String(input);
      const title = url.includes("/guide") ? "Guide" : "Overview";
      return new Response(`<!doctype html>
        <html>
          <head><title>${title}</title></head>
          <body><article><h1>${title}</h1><p>${title} explains a useful docs page with enough text for parsing into a knowledge document.</p></article></body>
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

    const discover = await app.inject({
      method: "POST",
      url: "/api/batch/discover",
      headers: { authorization: "Bearer test-token" },
      payload: {
        pageUrl: "https://docs.example.com/oss/overview",
        candidates: [
          { url: "https://docs.example.com/oss/overview", text: "Overview", source: "sidebar", order: 0 },
          { url: "https://docs.example.com/oss/guide#top", text: "Guide", source: "sidebar", order: 1 },
          { url: "https://other.example.com/out", text: "Outside", source: "sidebar", order: 2 }
        ],
        scope: {
          sameOrigin: true,
          pathPrefix: "/oss/",
          maxItems: 10
        }
      }
    });

    expect(discover.statusCode).toBe(200);
    expect(discover.json().items).toHaveLength(2);
    expect(discover.json().stats).toMatchObject({
      inputCount: 3,
      dedupedCount: 2,
      selectedCount: 2
    });

    const createJob = await app.inject({
      method: "POST",
      url: "/api/batch/jobs",
      headers: { authorization: "Bearer test-token" },
      payload: {
        sourcePageUrl: "https://docs.example.com/oss/overview",
        collection: {
          title: "Example Docs",
          rootUrl: "https://docs.example.com/oss/overview",
          strategy: "create"
        },
        items: discover.json().items.map((item: { url: string; titleHint?: string; source?: string; order: number; depth: number }) => ({
          url: item.url,
          titleHint: item.titleHint,
          source: item.source,
          order: item.order,
          depth: item.depth
        })),
        options: {
          skipExisting: true,
          maxConcurrency: 2
        }
      }
    });

    expect(createJob.statusCode).toBe(200);
    expect(createJob.json().collectionId).toEqual(expect.any(String));
    expect(createJob.json().jobId).toEqual(expect.any(String));

    const job = await waitForBatchJob(app, createJob.json().jobId);
    expect(job.state).toBe("succeeded");
    expect(job.saved).toBe(2);
    expect(job.failed).toBe(0);
    expect(job.items.every((item: { docId?: string }) => item.docId)).toBe(true);

    const collection = await app.inject({
      method: "GET",
      url: `/api/collections/${createJob.json().collectionId}`,
      headers: { authorization: "Bearer test-token" }
    });

    expect(collection.statusCode).toBe(200);
    expect(collection.json().collection).toMatchObject({
      title: "Example Docs",
      state: "active",
      itemCount: 2
    });
    expect(collection.json().items.map((item: { title?: string }) => item.title)).toEqual(["Overview", "Guide"]);
    expect(collection.json().items.every((item: { docId?: string }) => item.docId)).toBe(true);

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

async function waitForBatchJob(app: FastifyInstance, jobId: string): Promise<{
  state: string;
  saved: number;
  failed: number;
  items: Array<{ docId?: string }>;
}> {
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const response = await app.inject({
      method: "GET",
      url: `/api/batch/jobs/${jobId}`,
      headers: { authorization: "Bearer test-token" }
    });
    const body = response.json();
    if (body.state !== "queued" && body.state !== "running") {
      return body;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error("Timed out waiting for batch job");
}
