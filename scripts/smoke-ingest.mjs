import { createServer } from "node:http";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const token = "smoke-token";
const ingestPort = 19765;
const pagePort = 19766;
const storeRoot = await mkdtemp(join(tmpdir(), "knowledge-smoke-store-"));

const html = `<!doctype html>
<html lang="en">
  <head>
    <title>Smoke Article</title>
    <meta name="author" content="Integration Bot">
  </head>
  <body>
    <article>
      <h1>Smoke Article</h1>
      <p>Knowledge smoke integration page with enough article text for the extraction pipeline.</p>
      <ul><li>Browser HTML mode</li><li>Server fetch mode</li></ul>
    </article>
  </body>
</html>`;

const pageServer = createServer((request, response) => {
  if (request.url === "/json") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{}");
    return;
  }

  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  response.end(html);
});

await listen(pageServer, pagePort);

const ingest = spawn(
  process.execPath,
  ["--enable-source-maps", "apps/knowledge-ingest-server/dist/index.js"],
  {
    env: {
      ...process.env,
      KNOWLEDGE_HOST: "127.0.0.1",
      KNOWLEDGE_PORT: String(ingestPort),
      KNOWLEDGE_TOKEN: token,
      KNOWLEDGE_STORE: storeRoot,
      KNOWLEDGE_FETCH_TIMEOUT_MS: "5000"
    },
    stdio: ["ignore", "pipe", "pipe"]
  }
);

let serverOutput = "";
ingest.stdout.on("data", (chunk) => {
  serverOutput += chunk.toString();
});
ingest.stderr.on("data", (chunk) => {
  serverOutput += chunk.toString();
});

try {
  await waitForHealth();

  const pageUrl = `http://127.0.0.1:${pagePort}/article?utm_source=smoke#top`;
  const canonicalUrl = `http://127.0.0.1:${pagePort}/article`;

  const browserPreview = await post("/api/clip/preview", {
    inputMode: "browser_html",
    snapshot: {
      pageUrl,
      canonicalUrl,
      title: "Smoke Article",
      html,
      capturedAt: new Date().toISOString(),
      meta: { author: "Integration Bot" }
    }
  });
  assertIncludes(browserPreview.markdown, "Knowledge smoke integration page", "browser_html markdown");

  const fetchPreview = await post("/api/clip/preview", {
    inputMode: "server_fetch",
    url: canonicalUrl
  });
  assertIncludes(fetchPreview.markdown, "Server fetch mode", "server_fetch markdown");

  const saved = await post("/api/clip/save", {
    inputMode: "browser_html",
    snapshot: {
      pageUrl,
      canonicalUrl,
      title: "Smoke Article",
      html,
      capturedAt: new Date().toISOString(),
      meta: { author: "Integration Bot" }
    }
  });
  if (saved.saved !== true) {
    throw new Error("Expected save response to include saved=true");
  }

  const status = await get(`/api/clip/status?url=${encodeURIComponent(pageUrl)}`);
  if (status.saved !== true) {
    throw new Error("Expected saved status for normalized smoke URL");
  }

  const nonHtml = await fetch(`${baseUrl()}/api/clip/preview`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify({
      inputMode: "server_fetch",
      url: `http://127.0.0.1:${pagePort}/json`
    })
  });
  if (nonHtml.status !== 400) {
    throw new Error(`Expected non-HTML server_fetch to return 400, got ${nonHtml.status}`);
  }

  console.log("knowledge ingest smoke passed");
} finally {
  ingest.kill("SIGTERM");
  pageServer.close();
  await rm(storeRoot, { recursive: true, force: true });
}

async function waitForHealth() {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const health = await get("/api/health", false);
      if (health.ok) {
        return;
      }
    } catch {
      await delay(200);
    }
  }
  throw new Error(`knowledge-ingest-server did not become healthy:\n${serverOutput}`);
}

async function get(path, authorize = true) {
  const response = await fetch(`${baseUrl()}${path}`, {
    headers: authorize ? headers() : undefined
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return response.json();
}

async function post(path, body) {
  const response = await fetch(`${baseUrl()}${path}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body)
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return response.json();
}

function headers() {
  return {
    "content-type": "application/json",
    authorization: `Bearer ${token}`
  };
}

function baseUrl() {
  return `http://127.0.0.1:${ingestPort}`;
}

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
}

function assertIncludes(value, needle, label) {
  if (!String(value).includes(needle)) {
    throw new Error(`Expected ${label} to include ${needle}`);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
