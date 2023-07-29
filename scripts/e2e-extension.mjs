import { createServer } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";

const token = "e2e-token";
const ingestPort = 19865;
const pagePort = 19866;
const storeRoot = await mkdtemp(join(tmpdir(), "knowledge-e2e-store-"));
const browserProfile = await mkdtemp(join(tmpdir(), "knowledge-e2e-profile-"));
const extensionPath = resolve("apps/knowledge-web-clipper/dist");
const chromePath = process.env.CHROME_PATH;

const html = (title, paragraph) => `<!doctype html>
<html lang="en">
  <head>
    <title>${title}</title>
    <link rel="canonical" href="http://127.0.0.1:${pagePort}/article">
    <meta name="author" content="Extension Bot">
  </head>
  <body>
    <article>
      <h1>${title}</h1>
      <p>${paragraph}</p>
      <ul><li>Content script collection</li><li>Local ingest server preview</li></ul>
    </article>
  </body>
</html>`;

const pageServer = createServer((request, response) => {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  if (request.url?.startsWith("/second")) {
    response.end(html(
      "Second E2E Article",
      "Knowledge extension auto refresh page with enough content to verify tab switching."
    ));
    return;
  }
  response.end(html(
    "E2E Article",
    "Knowledge extension E2E page with enough content to verify the side panel preview pipeline."
  ));
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

let context;
try {
  await waitForHealth();

  context = await chromium.launchPersistentContext(browserProfile, {
    headless: false,
    ...(chromePath ? { executablePath: chromePath } : {}),
    ignoreDefaultArgs: [
      "--disable-extensions",
      "--disable-component-extensions-with-background-pages"
    ],
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      "--no-first-run",
      "--no-default-browser-check"
    ]
  });

  const extensionId = await resolveExtensionId(context, browserProfile);
  const article = await context.newPage();
  await article.goto(`http://127.0.0.1:${pagePort}/article?utm_source=e2e#top`, {
    waitUntil: "domcontentloaded"
  });

  const sidePanel = await context.newPage();
  await sidePanel.goto(`chrome-extension://${extensionId}/side-panel.html`, {
    waitUntil: "domcontentloaded"
  });

  const articleTabId = await findArticleTabId(sidePanel);
  await sidePanel.evaluate(async ({ articleTabId: tabId, ingestPort: port, token: authToken }) => {
    const serverUrl = document.querySelector("#server-url");
    const serverToken = document.querySelector("#server-token");
    if (!serverUrl || !serverToken) {
      throw new Error("Missing settings inputs");
    }

    serverUrl.value = `http://127.0.0.1:${port}`;
    serverToken.value = authToken;
    serverUrl.dispatchEvent(new Event("change"));
    serverToken.dispatchEvent(new Event("change"));
    document.querySelector("#mode-browser")?.click();
    await chrome.tabs.update(tabId, { active: true });
  }, { articleTabId, ingestPort, token });

  await sidePanel.evaluate(() => document.querySelector("#refresh-button")?.click());
  await expectOutput(sidePanel, "Knowledge extension E2E page");
  await expectOutput(sidePanel, "Content script collection");

  await sidePanel.evaluate(() => document.querySelector("#save-button")?.click());
  await sidePanel.locator("#status-pill").filter({ hasText: "Saved" }).waitFor({ timeout: 10000 });

  const status = await get(`/api/clip/status?url=${encodeURIComponent(`http://127.0.0.1:${pagePort}/article?utm_source=e2e#top`)}`);
  if (status.saved !== true) {
    throw new Error(`Expected saved=true from backend status, got ${JSON.stringify(status)}`);
  }

  await sidePanel.evaluate(() => document.querySelector("#tab-saved")?.click());
  await sidePanel.locator("#saved-list").filter({ hasText: "E2E Article" }).waitFor({ timeout: 10000 });
  await sidePanel.locator("#saved-list").filter({ hasText: ".md" }).waitFor({ timeout: 10000 });

  await sidePanel.evaluate(() => document.querySelector("#tab-preview")?.click());
  const secondArticle = await context.newPage();
  await secondArticle.goto(`http://127.0.0.1:${pagePort}/second`, {
    waitUntil: "domcontentloaded"
  });
  const secondTabId = await findArticleTabId(sidePanel, `http://127.0.0.1:${pagePort}/second`);
  await sidePanel.evaluate((tabId) => chrome.tabs.update(tabId, { active: true }), secondTabId);
  await expectOutput(sidePanel, "Knowledge extension auto refresh page");

  await sidePanel.evaluate(() => document.querySelector("#copy-button")?.click());
  await sidePanel.locator("#status-pill").filter({ hasText: "Copied" }).waitFor({ timeout: 10000 });

  await sidePanel.evaluate(async (tabId) => {
    await chrome.tabs.update(tabId, { active: true });
    document.querySelector("#delete-button")?.click();
  }, articleTabId);
  await sidePanel.locator("#status-pill").filter({ hasText: "Deleted" }).waitFor({ timeout: 10000 });
  const deletedStatus = await get(`/api/clip/status?url=${encodeURIComponent(`http://127.0.0.1:${pagePort}/article?utm_source=e2e#top`)}`);
  if (deletedStatus.saved !== false) {
    throw new Error(`Expected saved=false after delete, got ${JSON.stringify(deletedStatus)}`);
  }

  console.log("knowledge extension e2e passed");
} finally {
  await context?.close();
  ingest.kill("SIGTERM");
  pageServer.close();
  await rm(storeRoot, { recursive: true, force: true });
  await rm(browserProfile, { recursive: true, force: true });
}

async function resolveExtensionId(context, profileDir) {
  const preferencesPath = join(profileDir, "Default", "Preferences");
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    try {
      const preferences = JSON.parse(await readFile(preferencesPath, "utf8"));
      const settings = preferences.extensions?.settings ?? {};
      const match = Object.entries(settings).find(([, value]) => {
        return value?.path && resolve(value.path) === extensionPath;
      });
      if (match) {
        return match[0];
      }
    } catch {
      await delay(200);
    }
  }

  let [serviceWorker] = context.serviceWorkers();
  if (!serviceWorker) {
    serviceWorker = await context.waitForEvent("serviceworker", { timeout: 3000 });
  }
  const match = serviceWorker.url().match(/^chrome-extension:\/\/([^/]+)\//);
  if (!match) {
    throw new Error(`Unable to resolve extension id from ${serviceWorker.url()}`);
  }
  return match[1];
}

async function findArticleTabId(page, urlPrefix = `http://127.0.0.1:${pagePort}/article`) {
  const tabs = await page.evaluate((urlPrefix) => {
    return chrome.tabs.query({ url: `${urlPrefix}*` });
  }, urlPrefix);
  const [tab] = tabs;
  if (!tab?.id) {
    throw new Error(`Unable to find article tab: ${JSON.stringify(tabs)}`);
  }
  return tab.id;
}

async function expectOutput(page, text) {
  try {
    await page.locator("#preview-output").filter({ hasText: text }).waitFor({ timeout: 15000 });
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      status: document.querySelector("#status-pill")?.textContent,
      pageUrl: document.querySelector("#page-url")?.textContent,
      output: document.querySelector("#preview-output")?.textContent || document.querySelector("#code-output")?.textContent
    }));
    throw new Error(`Expected side panel output to include "${text}". Diagnostics: ${JSON.stringify(diagnostics)}`, {
      cause: error
    });
  }
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
  const response = await fetch(`http://127.0.0.1:${ingestPort}${path}`, {
    headers: authorize ? { authorization: `Bearer ${token}` } : undefined
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}: ${await response.text()}`);
  }
  return response.json();
}

function listen(server, port) {
  return new Promise((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolveListen);
  });
}

function delay(ms) {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
