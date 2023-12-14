import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { buildServer } from "./server.js";

describe("Markdown import API", () => {
  let storeRoot: string | undefined;

  afterEach(async () => {
    await rm(storeRoot ?? "", { recursive: true, force: true }).catch(() => undefined);
    storeRoot = undefined;
  });

  it("imports local assets and reparses them from stored relative paths", async () => {
    storeRoot = await mkdtemp(join(tmpdir(), "knowledge-markdown-api-"));
    const app = await buildServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      storeRoot,
      fetchTimeoutMs: 1000,
      maxHtmlBytes: 1024 * 1024,
      maxImportBytes: 1024 * 1024
    });

    const markdown = "---\ntitle: Asset lesson\n---\n\n# Lesson\n\n![Diagram](../images/diagram.png)\n";
    const body = multipart([
      { name: "file", filename: "lesson.md", contentType: "text/markdown", body: Buffer.from(markdown) },
      { name: "sourceUri", body: "lesson.md" },
      { name: "relativePath", body: "course/lesson.md" },
      { name: "assetPath", body: "images/diagram.png" },
      { name: "asset", filename: "images/diagram.png", contentType: "image/png", body: Buffer.from("image-bytes") }
    ]);
    const imported = await app.inject({
      method: "POST",
      url: "/api/import/markdown",
      headers: {
        authorization: "Bearer test-token",
        "content-type": body.contentType
      },
      payload: body.bytes
    });

    expect(imported.statusCode).toBe(200);
    const result = imported.json();
    expect(result.knowledgeItem.sourceType).toBe("markdown");
    expect(result.document.sections.at(-1).assets[0].asset_id).toMatch(/^[a-f0-9]{16}\.png$/);
    expect(result.warnings).toBeUndefined();

    const itemId = result.knowledgeItem.itemId;
    const reparsed = await app.inject({
      method: "POST",
      url: `/api/items/${encodeURIComponent(itemId)}/reparse`,
      headers: { authorization: "Bearer test-token" }
    });
    expect(reparsed.statusCode).toBe(200);
    expect(reparsed.json().warnings).toBeUndefined();
    expect(reparsed.json().document.sections.at(-1).assets[0].asset_id).toBe(
      result.document.sections.at(-1).assets[0].asset_id
    );

    await app.close();
  });
});

function multipart(parts: Array<{
  name: string;
  filename?: string;
  contentType?: string;
  body: string | Buffer;
}>): { bytes: Buffer; contentType: string } {
  const boundary = "----knowledge-markdown-test";
  const chunks: Buffer[] = [];
  for (const part of parts) {
    const disposition = `Content-Disposition: form-data; name="${part.name}"${part.filename ? `; filename="${part.filename}"` : ""}`;
    const headers = [disposition, part.contentType ? `Content-Type: ${part.contentType}` : undefined]
      .filter((value): value is string => Boolean(value))
      .join("\r\n");
    chunks.push(Buffer.from(`--${boundary}\r\n${headers}\r\n\r\n`));
    chunks.push(Buffer.isBuffer(part.body) ? part.body : Buffer.from(part.body));
    chunks.push(Buffer.from("\r\n"));
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`));
  return {
    bytes: Buffer.concat(chunks),
    contentType: `multipart/form-data; boundary=${boundary}`
  };
}
