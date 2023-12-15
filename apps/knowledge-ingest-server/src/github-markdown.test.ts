import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "./server.js";

let commitSha = "commit-one";
let markdownSha = "markdown-one";
let imageSha = "image-one";
const requests: Array<{ url: string; authorization?: string }> = [];

describe("GitHub Markdown import", () => {
  let storeRoot: string;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(async () => {
    storeRoot = await mkdtemp(join(tmpdir(), "knowledge-github-markdown-"));
    originalFetch = globalThis.fetch;
    commitSha = "commit-one";
    markdownSha = "markdown-one";
    imageSha = "image-one";
    requests.length = 0;
    vi.stubGlobal("fetch", mockGitHubFetch);
  });

  afterEach(async () => {
    vi.stubGlobal("fetch", originalFetch);
    await rm(storeRoot, { recursive: true, force: true });
  });

  it("imports nested private Markdown and serves referenced images without storing image bytes", async () => {
    const app = await buildServer({
      host: "127.0.0.1",
      port: 0,
      token: "server-token",
      githubToken: "github-secret",
      storeRoot,
      fetchTimeoutMs: 1000,
      maxHtmlBytes: 1024 * 1024,
      maxImportBytes: 1024 * 1024
    });

    const body = {
      owner: "convexwf",
      repo: "easy-rl",
      ref: "master",
      path: "docs"
    };
    const scan = await app.inject({
      method: "POST",
      url: "/api/import/github/markdown/scan",
      headers: { authorization: "Bearer server-token" },
      payload: body
    });
    expect(scan.statusCode).toBe(200);
    expect(scan.json()).toMatchObject({
      private: true,
      commitSha: "commit-one",
      files: [{ path: "docs/ch1/intro.md", assets: [{ path: "docs/img/ch1/1.1.png", delivery: "proxy" }] }]
    });
    expect(scan.body).not.toContain("github-secret");
    const requestCountAfterScan = requests.length;

    const imported = await app.inject({
      method: "POST",
      url: "/api/import/github/markdown",
      headers: { authorization: "Bearer server-token" },
      payload: body
    });
    expect(imported.statusCode).toBe(200);
    expect(requests.length).toBe(requestCountAfterScan);
    const result = imported.json();
    expect(result.results).toHaveLength(1);
    expect(result.results[0].saved).toBe(true);
    const itemId = result.results[0].knowledgeItem.itemId as string;
    expect(itemId).toMatch(/^github:sha256:/);

    const detail = await app.inject({
      method: "GET",
      url: `/api/items/${encodeURIComponent(itemId)}`,
      headers: { authorization: "Bearer server-token" }
    });
    expect(detail.statusCode).toBe(200);
    const detailJson = detail.json();
    const asset = detailJson.document.sections.at(-1).assets[0];
    expect(asset.source_url).toMatch(/^\/api\/items\/.+\/github-asset\//);
    expect(detailJson.rawdoc.metadata.assets[0]).toMatchObject({
      path: "docs/img/ch1/1.1.png",
      blobSha: "image-one",
      delivery: "proxy"
    });
    expect(JSON.stringify(detailJson)).not.toContain("image-bytes");

    const assetsDirectory = await readdir(join(storeRoot, "assets"));
    expect(assetsDirectory).toEqual([]);

    const assetRef = detailJson.rawdoc.metadata.assets[0].assetRef as string;
    const image = await app.inject({
      method: "GET",
      url: `/api/items/${encodeURIComponent(itemId)}/github-asset/${encodeURIComponent(assetRef)}`,
      headers: { authorization: "Bearer server-token" }
    });
    expect(image.statusCode).toBe(200);
    expect(image.headers["content-type"]).toContain("image/png");
    expect(Buffer.from(image.rawPayload).toString("utf8")).toBe("image-bytes");
    const githubImageRequest = requests.find((request) => request.url.includes("/git/blobs/image-one"));
    expect(githubImageRequest?.authorization).toBe("Bearer github-secret");

    await app.close();
  });

  it("compares only Markdown on refresh and ignores referenced image changes", async () => {
    const app = await buildServer({
      host: "127.0.0.1",
      port: 0,
      token: "server-token",
      githubToken: "github-secret",
      storeRoot,
      fetchTimeoutMs: 1000,
      maxHtmlBytes: 1024 * 1024,
      maxImportBytes: 1024 * 1024
    });
    const body = { owner: "convexwf", repo: "easy-rl", ref: "master", path: "docs/ch1/intro.md" };
    const imported = await app.inject({
      method: "POST",
      url: "/api/import/github/markdown",
      headers: { authorization: "Bearer server-token" },
      payload: body
    });
    const itemId = imported.json().results[0].knowledgeItem.itemId as string;
    const importedDetail = await app.inject({
      method: "GET",
      url: `/api/items/${encodeURIComponent(itemId)}`,
      headers: { authorization: "Bearer server-token" }
    });
    const rawdocId = importedDetail.json().rawdoc.rawdoc_id as string;
    expect(requests).toHaveLength(3);

    requests.length = 0;
    const exactAssetRef = importedDetail.json().rawdoc.metadata.assets[0].assetRef as string;
    const exactImage = await app.inject({
      method: "GET",
      url: `/api/items/${encodeURIComponent(itemId)}/github-asset/${encodeURIComponent(exactAssetRef)}`,
      headers: { authorization: "Bearer server-token" }
    });
    expect(exactImage.statusCode).toBe(200);
    expect(Buffer.from(exactImage.rawPayload).toString("utf8")).toBe("image-bytes");
    expect(requests.some((request) => request.url.includes("/contents/docs/img/ch1/1.1.png?"))).toBe(true);

    requests.length = 0;
    const current = await app.inject({
      method: "POST",
      url: `/api/items/${encodeURIComponent(itemId)}/refresh`,
      headers: { authorization: "Bearer server-token" }
    });
    expect(current.statusCode).toBe(200);
    expect(current.json()).toMatchObject({ updated: false, status: "up_to_date", commitSha: "commit-one" });
    expect(requests.some((request) => request.url.includes("/git/blobs/markdown-one"))).toBe(false);

    commitSha = "commit-two";
    imageSha = "image-two";
    const imageOnlyRefresh = await app.inject({
      method: "POST",
      url: `/api/items/${encodeURIComponent(itemId)}/refresh`,
      headers: { authorization: "Bearer server-token" }
    });
    expect(imageOnlyRefresh.statusCode).toBe(200);
    expect(imageOnlyRefresh.json()).toMatchObject({ updated: false, status: "up_to_date", commitSha: "commit-two" });
    expect(imageOnlyRefresh.json().document).toBeUndefined();

    const unchangedRawdoc = JSON.parse(await readFile(
      join(storeRoot, "rawdocs", `${rawdocId}.json`),
      "utf8"
    ));
    expect(unchangedRawdoc.metadata.commitSha).toBe("commit-two");
    expect(unchangedRawdoc.metadata.assets[0].blobSha).toBeUndefined();
    expect(requests.some((request) => request.url.includes("/git/blobs/image-two"))).toBe(false);

    markdownSha = "markdown-two";
    commitSha = "commit-three";
    imageSha = "image-three";
    const markdownRefresh = await app.inject({
      method: "POST",
      url: `/api/items/${encodeURIComponent(itemId)}/refresh`,
      headers: { authorization: "Bearer server-token" }
    });
    expect(markdownRefresh.statusCode).toBe(200);
    expect(markdownRefresh.json()).toMatchObject({
      updated: true,
      status: "updated",
      oldCommitSha: "commit-two",
      commitSha: "commit-three"
    });
    expect(markdownRefresh.json().document.sections.at(-1).assets[0].source_url).not.toBe(
      detailSourceUrl(itemId, "commit-one")
    );

    const rawdoc = JSON.parse(await readFile(join(
      storeRoot,
      "rawdocs",
      `${markdownRefresh.json().rawdoc.rawdoc_id}.json`
    ), "utf8"));
    expect(rawdoc.metadata.commitSha).toBe("commit-three");
    expect(rawdoc.metadata.assets[0].blobSha).toBeUndefined();
    await app.close();
  });
});

async function mockGitHubFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  const url = String(input);
  requests.push({ url, authorization: new Headers(init?.headers).get("authorization") ?? undefined });
  if (url.endsWith("/repos/convexwf/easy-rl")) {
    return jsonResponse({ private: true, default_branch: "master" });
  }
  if (url.includes("/commits/")) {
    return jsonResponse({ sha: commitSha });
  }
  if (url.includes("/contents/docs/ch1/intro.md?")) {
    return jsonResponse({
      path: "docs/ch1/intro.md",
      type: "file",
      sha: markdownSha,
      size: Buffer.byteLength(markdown()),
      encoding: "base64",
      content: Buffer.from(markdown()).toString("base64")
    });
  }
  if (url.includes("/contents/docs/img/ch1/1.1.png?")) {
    return jsonResponse({
      path: "docs/img/ch1/1.1.png",
      type: "file",
      sha: imageSha,
      size: 11,
      encoding: "base64",
      content: Buffer.from("image-bytes").toString("base64")
    });
  }
  if (url.includes("/git/trees/")) {
    return jsonResponse({
      truncated: false,
      tree: [
        { path: "docs", type: "tree", sha: "tree-docs" },
        { path: "docs/ch1/intro.md", type: "blob", sha: "markdown-one", size: markdown().length },
        { path: "docs/img/ch1/1.1.png", type: "blob", sha: imageSha, size: 11 }
      ]
    });
  }
  if (url.includes("/git/blobs/markdown-one") || url.includes("/git/blobs/markdown-two")) {
    return jsonResponse(blobPayload(markdownSha, markdown()));
  }
  if (url.includes("/git/blobs/image-one") || url.includes("/git/blobs/image-two")) {
    return jsonResponse(blobPayload(imageSha, "image-bytes"));
  }
  return new Response("not found", { status: 404 });
}

function markdown(): string {
  const heading = markdownSha === "markdown-two" ? "Updated lesson" : "Lesson";
  return `---\ntitle: Remote lesson\n---\n\n# ${heading}\n\n![Diagram](../img/ch1/1.1.png)\n`;
}

function blobPayload(sha: string, value: string): { sha: string; size: number; encoding: string; content: string } {
  return {
    sha,
    size: Buffer.byteLength(value),
    encoding: "base64",
    content: Buffer.from(value).toString("base64")
  };
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

function detailSourceUrl(itemId: string, commit: string): string {
  return `/api/items/${encodeURIComponent(itemId)}/github-asset/${encodeURIComponent(
    Buffer.from(`${commit}:docs/img/ch1/1.1.png`).toString("base64url")
  )}`;
}
