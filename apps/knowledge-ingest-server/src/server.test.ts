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
    expect(preview.json().status.saved).toBe(false);

    const save = await app.inject({
      method: "POST",
      url: "/api/clip/save",
      headers: { authorization: "Bearer test-token" },
      payload: body
    });
    expect(save.statusCode).toBe(200);
    expect(save.json().saved).toBe(true);
    expect(save.json().paths.markdownPath).toMatch(/\.md$/);
    await expect(access(join(storeRoot, "index.sqlite3"))).resolves.toBeUndefined();

    const status = await app.inject({
      method: "GET",
      url: "/api/clip/status?url=https%3A%2F%2Fexample.com%2Fa%3Futm_source%3Dx%23top",
      headers: { authorization: "Bearer test-token" }
    });
    expect(status.statusCode).toBe(200);
    expect(status.json().saved).toBe(true);

    const list = await app.inject({
      method: "GET",
      url: "/api/clips",
      headers: { authorization: "Bearer test-token" }
    });
    expect(list.statusCode).toBe(200);
    expect(list.json().clips).toHaveLength(1);
    expect(list.json().clips[0]).toMatchObject({
      normalizedUrl: "https://example.com/a",
      savedAt: expect.any(String),
      title: "Example Article"
    });

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
      saved: false
    });
    expect(deleted.json().deletedPaths).toContain(markdownPath);
    await expect(access(join(storeRoot, markdownPath))).rejects.toThrow();

    const deletedStatus = await app.inject({
      method: "GET",
      url: "/api/clip/status?url=https%3A%2F%2Fexample.com%2Fa",
      headers: { authorization: "Bearer test-token" }
    });
    expect(deletedStatus.statusCode).toBe(200);
    expect(deletedStatus.json().saved).toBe(false);

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
