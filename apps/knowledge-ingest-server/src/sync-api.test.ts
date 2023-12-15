import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import type { FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { buildServer } from "./server.js";

const TOKEN = "test-token";

const html = `<!doctype html>
<html lang="en">
  <head>
    <title>Sync Fixture Article - Example Site</title>
    <meta name="author" content="Ada">
  </head>
  <body>
    <article>
      <h1>Sync Fixture Article</h1>
      <p>Offline packages must be reproducible and verifiable by the reader client without trusting the zip container bytes.</p>
      <p>The catalog snapshot must expose the same content hash so clients can decide whether a package needs to be downloaded again.</p>
      <ul><li>First point</li><li>Second point</li></ul>
    </article>
  </body>
</html>`;

interface ZipEntry {
  path: string;
  bytes: Buffer;
}

/** Minimal ZIP reader used to assert the archive layout produced by the server. */
function readZipEntries(archive: Buffer): ZipEntry[] {
  const entries: ZipEntry[] = [];
  let offset = 0;
  while (offset + 30 <= archive.byteLength && archive.readUInt32LE(offset) === 0x04034b50) {
    const method = archive.readUInt16LE(offset + 8);
    const compressedSize = archive.readUInt32LE(offset + 18);
    const uncompressedSize = archive.readUInt32LE(offset + 22);
    const nameLength = archive.readUInt16LE(offset + 26);
    const extraLength = archive.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLength + extraLength;
    const path = archive.subarray(nameStart, nameStart + nameLength).toString("utf8");
    const data = archive.subarray(dataStart, dataStart + compressedSize);
    const bytes = method === 8 ? inflateRawSync(data) : Buffer.from(data);
    expect(bytes.byteLength).toBe(uncompressedSize);
    entries.push({ path, bytes });
    offset = dataStart + compressedSize;
  }
  return entries;
}

/** Independent implementation of the contract defined in the reader design doc. */
function expectedContentHash(entries: ZipEntry[]): string {
  const manifest = [...entries]
    .filter((entry) => entry.path !== "manifest.json")
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0)
    .map((entry) => `${entry.path}\u0000${createHash("sha256").update(entry.bytes).digest("hex")}\n`)
    .join("");
  return createHash("sha256").update(manifest, "utf8").digest("hex");
}

describe("sync api", () => {
  let storeRoot: string;
  let app: FastifyInstance;

  beforeEach(async () => {
    storeRoot = await mkdtemp(join(tmpdir(), "knowledge-sync-test-"));
    app = await buildServer({
      host: "127.0.0.1",
      port: 0,
      token: TOKEN,
      storeRoot,
      fetchTimeoutMs: 1000,
      maxHtmlBytes: 1024 * 1024
    });
  });

  afterEach(async () => {
    await app.close();
    await rm(storeRoot, { recursive: true, force: true });
  });

  async function saveItem(): Promise<{ itemId: string; docId: string }> {
    const response = await app.inject({
      method: "POST",
      url: "/api/ingest/save",
      headers: { authorization: `Bearer ${TOKEN}` },
      payload: {
        inputMode: "browser_html",
        snapshot: {
          pageUrl: "https://example.com/sync-fixture",
          canonicalUrl: "https://example.com/sync-fixture",
          pageTitle: "Sync Fixture Article - Example Site",
          title: "Sync Fixture Article - Example Site",
          html,
          capturedAt: "2026-09-13T02:00:00.000Z",
          meta: { author: "Ada" }
        }
      }
    });
    expect(response.statusCode).toBe(200);
    const body = response.json();
    return { itemId: body.status.itemId as string, docId: body.document.doc_id as string };
  }

  it("serves a full catalog snapshot with a reusable etag", async () => {
    const { itemId, docId } = await saveItem();

    const first = await app.inject({
      method: "GET",
      url: "/api/sync/catalog",
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    expect(first.statusCode).toBe(200);
    const snapshot = first.json();
    expect(snapshot.schemaVersion).toBe(1);
    expect(typeof snapshot.serverTime).toBe("string");
    expect(snapshot.items).toHaveLength(1);
    expect(snapshot.items[0]).toMatchObject({
      itemId,
      docId,
      sourceType: "url",
      state: "parsed",
      sourceUrl: "https://example.com/sync-fixture"
    });
    expect(snapshot.items[0].contentHash).toMatch(/^[0-9a-f]{64}$/);
    expect(snapshot.items[0].packageBytes).toBeGreaterThan(0);
    expect(snapshot.items[0].sectionCount).toBeGreaterThan(0);

    const etag = first.headers.etag as string;
    expect(etag).toMatch(/^"[0-9a-f]{64}"$/);

    const second = await app.inject({
      method: "GET",
      url: "/api/sync/catalog",
      headers: { authorization: `Bearer ${TOKEN}`, "if-none-match": etag }
    });
    expect(second.statusCode).toBe(304);
    expect(second.body).toBe("");
  });

  it("serves an offline package whose hash matches the catalog entry", async () => {
    const { itemId } = await saveItem();
    const catalog = await app.inject({
      method: "GET",
      url: "/api/sync/catalog",
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    const catalogItem = catalog.json().items[0];

    const response = await app.inject({
      method: "GET",
      url: `/api/items/${encodeURIComponent(itemId)}/package`,
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("application/zip");
    expect(response.headers.etag).toBe(`"${catalogItem.contentHash}"`);

    const entries = readZipEntries(response.rawPayload);
    const paths = entries.map((entry) => entry.path).sort();
    expect(paths).toEqual(["document.json", "manifest.json", "markdown.md"]);

    const manifest = JSON.parse(entries.find((entry) => entry.path === "manifest.json")!.bytes.toString("utf8"));
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.itemId).toBe(itemId);
    expect(manifest.contentHash).toBe(catalogItem.contentHash);
    expect(manifest.files.map((file: { path: string }) => file.path).sort())
      .toEqual(["document.json", "markdown.md"]);
    expect(manifest.documentBytes).toBeGreaterThan(0);

    const document = entries.find((entry) => entry.path === "document.json")!.bytes.toString("utf8");
    expect(JSON.parse(document).sections.length).toBe(catalogItem.sectionCount);

    expect(expectedContentHash(entries)).toBe(catalogItem.contentHash);

    const notModified = await app.inject({
      method: "GET",
      url: `/api/items/${encodeURIComponent(itemId)}/package`,
      headers: { authorization: `Bearer ${TOKEN}`, "if-none-match": response.headers.etag as string }
    });
    expect(notModified.statusCode).toBe(304);
  });

  it("reports a missing package for unknown items", async () => {
    const response = await app.inject({
      method: "GET",
      url: "/api/items/url%3Asha256%3Amissing/package",
      headers: { authorization: `Bearer ${TOKEN}` }
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error).toBe("package_not_available");
  });

  it("requires a token for sync endpoints", async () => {
    const catalog = await app.inject({ method: "GET", url: "/api/sync/catalog" });
    expect(catalog.statusCode).toBe(401);
    const missing = await app.inject({ method: "GET", url: "/api/items/url%3Asha256%3Amissing/package" });
    expect(missing.statusCode).toBe(401);
  });
});
