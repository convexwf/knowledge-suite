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
      <p>${paragraph} Read the <a href="http://127.0.0.1:${pagePort}/source">source article</a>.</p>
      <p>Inline math should render from Markdown $x_i^2 + \\alpha$.</p>
      <p>$$</p>
      <p>\\frac{a+b}{c}</p>
      <p>$$</p>
      <knowledge-shadow-card></knowledge-shadow-card>
      <p><img src="http://127.0.0.1:${pagePort}/chart.png" alt="progress chart"></p>
      <table>
        <tr><th>Metric</th><th>Value</th></tr>
        <tr><td>Body fat</td><td>8%</td></tr>
      </table>
      <ul><li>Content script collection</li><li>Local ingest server preview</li></ul>
    </article>
    <script>
      customElements.define("knowledge-shadow-card", class extends HTMLElement {
        connectedCallback() {
          if (!this.shadowRoot) {
            this.attachShadow({ mode: "open" }).innerHTML = "<p>Shadow DOM captured content</p>";
          }
        }
      });
    </script>
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
    await chrome.storage.local.set({
      serverUrl: `http://127.0.0.1:${port}`,
      token: authToken,
      defaultInputMode: "browser_html",
      allowServerFetch: true,
      autoRefresh: true
    });
    document.querySelector("#mode-browser")?.click();
    await chrome.tabs.update(tabId, { active: true });
  }, { articleTabId, ingestPort, token });

  await activateTab(sidePanel, articleTabId);
  await sidePanel.evaluate(() => document.querySelector("#refresh-button")?.click());
  await expectOutput(sidePanel, "Knowledge extension E2E page");
  await expectOutput(sidePanel, "Content script collection");
  await expectOutput(sidePanel, "Shadow DOM captured content");
  await expectDiagnosticsDisclosureCompact(sidePanel);
  await sidePanel.locator("#preview-output .math-inline .katex").waitFor({ timeout: 10000 });
  await sidePanel.locator("#preview-output .math-display .katex").waitFor({ timeout: 10000 });
  await sidePanel.locator('#preview-output a[href^="http://127.0.0.1:"]').filter({ hasText: "source article" }).waitFor({ timeout: 10000 });
  await sidePanel.locator('#preview-output img[alt="progress chart"]').first().waitFor({ timeout: 10000 });
  await sidePanel.locator("#preview-output table").filter({ hasText: "Body fat" }).waitFor({ timeout: 10000 });

  const previewTopBeforeSave = await sidePanel.locator("#preview-output").evaluate((node) => {
    return Math.round(node.getBoundingClientRect().top);
  });
  await sidePanel.evaluate(() => document.querySelector("#save-button")?.click());
  await sidePanel.locator("#status-pill").filter({ hasText: "Saved" }).waitFor({ timeout: 10000 });
  await sidePanel.locator("#status-toast").waitFor({ state: "visible", timeout: 10000 });
  const previewTopAfterSave = await sidePanel.locator("#preview-output").evaluate((node) => {
    return Math.round(node.getBoundingClientRect().top);
  });
  if (previewTopBeforeSave !== previewTopAfterSave) {
    throw new Error(`Expected toast save feedback not to shift preview layout, got top ${previewTopBeforeSave} -> ${previewTopAfterSave}`);
  }

  const status = await get(`/api/ingest/status?url=${encodeURIComponent(`http://127.0.0.1:${pagePort}/article?utm_source=e2e#top`)}`);
  if (status.state !== "parsed" || status.hasDocument !== true) {
    throw new Error(`Expected parsed saved document from backend status, got ${JSON.stringify(status)}`);
  }

  await sidePanel.evaluate(() => document.querySelector("#tab-saved")?.click());
  await sidePanel.locator("#saved-list").filter({ hasText: "E2E Article" }).waitFor({ timeout: 10000 });
  await sidePanel.locator("#saved-list").filter({ hasText: "Parsed" }).waitFor({ timeout: 10000 });
  await expectPreviewTypography(sidePanel);

  await sidePanel.evaluate(() => document.querySelector("#tab-preview")?.click());
  const secondArticle = await context.newPage();
  await secondArticle.goto(`http://127.0.0.1:${pagePort}/second`, {
    waitUntil: "domcontentloaded"
  });
  const secondTabId = await findArticleTabId(sidePanel, `http://127.0.0.1:${pagePort}/second`);
  await activateTab(sidePanel, secondTabId);
  await sidePanel.evaluate(() => document.querySelector("#refresh-button")?.click());
  await expectOutput(sidePanel, "Knowledge extension auto refresh page");

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

async function activateTab(page, tabId) {
  await page.evaluate(async (tabId) => {
    await chrome.tabs.update(tabId, { active: true });
    const deadline = Date.now() + 3000;
    while (Date.now() < deadline) {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      if (tab?.id === tabId) {
        return;
      }
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 50));
    }
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    throw new Error(`Expected active tab ${tabId}, got ${tab?.id ?? "none"} (${tab?.url ?? "unknown url"})`);
  }, tabId);
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

async function expectStatus(page, text) {
  try {
    await page.waitForFunction((expected) => {
      const pill = document.querySelector("#status-pill")?.textContent ?? "";
      const toast = document.querySelector("#status-toast");
      const toastText = toast?.textContent ?? "";
      const toastVisible = Boolean(toast && !toast.hasAttribute("hidden"));
      return pill.includes(expected) || (toastVisible && toastText.includes(expected));
    }, text, { timeout: 10000 });
  } catch (error) {
    const diagnostics = await page.evaluate(() => ({
      status: document.querySelector("#status-pill")?.textContent,
      toast: document.querySelector("#status-toast")?.textContent,
      toastHidden: document.querySelector("#status-toast")?.hasAttribute("hidden"),
      detail: document.querySelector("#status-detail")?.textContent,
      removeDisabled: document.querySelector("#remove-button")?.disabled,
      purgeDisabled: document.querySelector("#purge-button")?.disabled,
      output: document.querySelector("#preview-output")?.textContent || document.querySelector("#code-output")?.textContent
    }));
    throw new Error(`Timed out waiting for status ${text}: ${JSON.stringify(diagnostics)}`, { cause: error });
  }
}

async function expectPreviewTypography(page) {
  const metrics = await page.evaluate(() => {
    const previewParagraph = document.querySelector("#preview-output p");
    const savedTitle = document.querySelector("#saved-list .saved-title");
    const previewStyle = previewParagraph ? getComputedStyle(previewParagraph) : null;
    const savedStyle = savedTitle ? getComputedStyle(savedTitle) : null;
    return {
      previewFontSize: previewStyle?.fontSize ?? null,
      savedTitleFontSize: savedStyle?.fontSize ?? null
    };
  });

  if (metrics.previewFontSize !== "17px") {
    throw new Error(`Expected preview paragraph font-size to stay at 17px, got ${JSON.stringify(metrics)}`);
  }
  if (metrics.savedTitleFontSize !== "15px") {
    throw new Error(`Expected saved title font-size to stay at 15px, got ${JSON.stringify(metrics)}`);
  }
}

async function expectDiagnosticsDisclosureCompact(page) {
  const metrics = await page.evaluate(() => {
    const row = document.querySelector("#diagnostics-toggle-row");
    const button = document.querySelector("#diagnostics-toggle");
    return {
      rowHeight: row ? Math.round(row.getBoundingClientRect().height) : null,
      buttonHeight: button ? Math.round(button.getBoundingClientRect().height) : null
    };
  });

  if (metrics.rowHeight !== 0) {
    throw new Error(`Expected diagnostics toggle row to take zero layout height, got ${JSON.stringify(metrics)}`);
  }
  if (!metrics.buttonHeight || metrics.buttonHeight > 18) {
    throw new Error(`Expected compact diagnostics toggle height, got ${JSON.stringify(metrics)}`);
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
