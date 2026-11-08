const DEFAULT_SERVER = "http://127.0.0.1:18765";
const DEFAULT_TOKEN = "dev-token";
const ALLOWED_HOSTS = new Set(["www.xiaoheihe.cn", "xiaoheihe.cn"]);
const BLOCKED_PATTERN = /(\u9a8c\u8bc1\u7801|\u5b89\u5168\u9a8c\u8bc1|\u8bbf\u95ee\u8fc7\u4e8e\u9891\u7e41|\u8bf7\u5b8c\u6210\u9a8c\u8bc1|\u6ed1\u5757\u9a8c\u8bc1)/;
const PING_INTERVAL_MS = 20000;
const RECONNECT_DELAY_MS = 3000;
const HANDSHAKE_TIMEOUT_MS = 6000;

let socket = null;
let reconnectTimer = null;
let pingTimer = null;
let connectionEpoch = 0;
let handshakeTimer = null;

async function readSettings() {
  try {
    const stored = await chrome.storage.local.get(["server", "token"]);
    return {
      server: String(stored.server || DEFAULT_SERVER).replace(/\/+$/, ""),
      token: String(stored.token || DEFAULT_TOKEN)
    };
  } catch {
    return { server: DEFAULT_SERVER, token: DEFAULT_TOKEN };
  }
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    void connect();
  }, RECONNECT_DELAY_MS);
}

async function connect() {
  if (socket && socket.readyState === WebSocket.OPEN) return;
  if (socket) {
    const stale = socket;
    socket = null;
    stopHandshakeTimer();
    try { stale.close(); } catch { /* ignore */ }
  }
  const settings = await readSettings();
  const wsUrl = settings.server.replace(/^http/i, "ws") + "/agent?token=" + encodeURIComponent(settings.token);
  const epoch = ++connectionEpoch;
  let next;
  try {
    next = new WebSocket(wsUrl);
  } catch {
    scheduleReconnect();
    return;
  }
  socket = next;
  startHandshakeTimer(next);
  next.addEventListener("open", () => {
    if (epoch !== connectionEpoch) return;
    stopHandshakeTimer();
    send({ type: "hello", version: chrome.runtime.getManifest().version });
    startPing();
  });
  next.addEventListener("message", (event) => {
    if (epoch !== connectionEpoch) return;
    void onMessage(event.data);
  });
  next.addEventListener("close", () => {
    if (socket === next) socket = null;
    stopHandshakeTimer();
    stopPing();
    scheduleReconnect();
  });
  next.addEventListener("error", () => {
    try { next.close(); } catch { /* ignore */ }
  });
}

function startHandshakeTimer(candidate) {
  stopHandshakeTimer();
  handshakeTimer = setTimeout(() => {
    handshakeTimer = null;
    if (candidate.readyState === WebSocket.OPEN) return;
    if (socket === candidate) socket = null;
    try { candidate.close(); } catch { /* ignore */ }
    scheduleReconnect();
  }, HANDSHAKE_TIMEOUT_MS);
}

function stopHandshakeTimer() {
  if (!handshakeTimer) return;
  clearTimeout(handshakeTimer);
  handshakeTimer = null;
}

function startPing() {
  stopPing();
  pingTimer = setInterval(() => send({ type: "ping", at: Date.now() }), PING_INTERVAL_MS);
}

function stopPing() {
  if (pingTimer) {
    clearInterval(pingTimer);
    pingTimer = null;
  }
}

function send(payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  try {
    socket.send(JSON.stringify(payload));
    return true;
  } catch {
    return false;
  }
}

async function onMessage(raw) {
  let message;
  try {
    message = JSON.parse(String(raw));
  } catch {
    return;
  }
  if (!message || message.type !== "capture" || typeof message.taskId !== "string") return;
  const taskId = message.taskId;
  try {
    const result = await runCapture(message);
    send({ type: "result", taskId, ok: true, ...result });
  } catch (error) {
    const text = error instanceof Error ? error.message : String(error);
    send({ type: "result", taskId, ok: false, error: text });
  }
}

async function runCapture(task) {
  const target = new URL(String(task.url));
  if (target.protocol !== "https:") throw new Error("only https URLs are allowed");
  if (!ALLOWED_HOSTS.has(target.hostname)) throw new Error("host not allowed: " + target.hostname);

  const tab = await chrome.tabs.create({ url: target.href, active: false });
  const tabId = tab.id;
  if (typeof tabId !== "number") throw new Error("failed to open a capture tab");

  try {
    await waitForLoad(tabId, Number(task.loadTimeoutMs) || 45000);
    await waitForStable(tabId, Number(task.waitMs) || 8000);
    if (task.mode === "links") {
      const links = await requestLinks(tabId, 10);
      return { blocked: false, links };
    }
    const snapshot = await requestSnapshot(tabId, 10);
    const text = String(snapshot.text || "");
    const compact = text.replace(/\s+/g, "");
    if (compact.length < 60) {
      return { blocked: true, blockReasons: ["empty-page"], textSample: text.slice(0, 300) };
    }
    if (BLOCKED_PATTERN.test(text) && compact.length < 500) {
      return { blocked: true, blockReasons: ["blocked-text"], textSample: text.slice(0, 300) };
    }
    return { blocked: false, snapshot };
  } finally {
    if (!task.keepOpen) await chrome.tabs.remove(tabId).catch(() => {});
  }
}

function waitForLoad(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => finish(new Error("tab load timed out")), timeoutMs);
    const listener = (updatedId, info) => {
      if (updatedId === tabId && info.status === "complete") finish(null);
    };
    function finish(error) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(listener);
      if (error) reject(error);
      else resolve();
    }
    chrome.tabs.onUpdated.addListener(listener);
    chrome.tabs.get(tabId).then((tab) => {
      if (tab.status === "complete") finish(null);
    }).catch((error) => finish(error));
  });
}

async function waitForStable(tabId, maxWaitMs) {
  const deadline = Date.now() + maxWaitMs;
  let previous = -1;
  let stable = 0;
  while (Date.now() < deadline) {
    const length = await measureBodyLength(tabId);
    if (length > 0 && length === previous) {
      stable += 1;
      if (stable >= 3) return length;
    } else {
      stable = 0;
    }
    previous = length;
    await sleep(500);
  }
  return previous;
}

async function measureBodyLength(tabId) {
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => (document.body ? document.body.innerText.length : 0)
    });
    return results && results[0] ? Number(results[0].result) || 0 : 0;
  } catch {
    return 0;
  }
}

async function requestSnapshot(tabId, attempts) {
  let lastError = new Error("snapshot request failed");
  for (let index = 0; index < attempts; index += 1) {
    try {
      const snapshot = await chrome.tabs.sendMessage(tabId, { type: "knowledge.capture.snapshot" });
      if (snapshot && typeof snapshot.html === "string" && snapshot.html.length > 0) return snapshot;
      lastError = new Error("content script returned an empty snapshot");
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    await sleep(400);
  }
  throw lastError;
}

async function requestLinks(tabId, attempts) {
  let lastError = new Error("link discovery failed");
  for (let index = 0; index < attempts; index += 1) {
    try {
      const results = await chrome.scripting.executeScript({
        target: { tabId },
        func: collectLinksInPage
      });
      const value = results && results[0] ? results[0].result : null;
      if (value && Array.isArray(value.candidates) && value.candidates.length > 0) return value;
      lastError = new Error("no links found on the page");
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
    }
    await sleep(400);
  }
  throw lastError;
}

async function collectLinksInPage() {
  const bbsLinkPattern = /\/app\/bbs\/link\/\d+/;
  const homePage = /^\/app\/bbs\/home\/?$/.test(location.pathname);
  const favouritePage = /^\/app\/user\/favour\//.test(location.pathname);
  const seen = new Map();

  collect();
  if (homePage) {
    await sleepInPage(800);
    collect();
    for (let index = 0; index < 4 && countBbsLinks() < 32; index += 1) {
      const buttons = [...document.querySelectorAll("button.bbs-home__topic-item")];
      if (index >= buttons.length) break;
      buttons[index].click();
      if (!(await waitForPath(/^\/app\/topic\/link\//, 8000))) break;
      await waitForLinkCount(8, 6000);
      await sleepInPage(400);
      collect();
      history.back();
      if (!(await waitForPath(/^\/app\/bbs\/home\/?$/, 8000))) break;
      await sleepInPage(1000);
      collect();
    }
  } else if (favouritePage) {
    const originalY = window.scrollY;
    let stagnant = 0;
    for (let round = 0; round < 12 && countBbsLinks() < 35; round += 1) {
      const before = seen.size;
      window.scrollTo(0, window.scrollY + Math.max(600, Math.round(window.innerHeight * 0.9)));
      await sleepInPage(1100);
      collect();
      if (seen.size <= before) stagnant += 1;
      else stagnant = 0;
      if (stagnant >= 2) break;
    }
    window.scrollTo(0, originalY);
  }
  return { pageUrl: location.href, title: document.title, candidates: [...seen.values()] };

  function collect() {
    for (const anchor of document.querySelectorAll("a[href]")) {
      const url = anchor.href;
      if (!url || seen.has(url)) continue;
      const text = pickLinkText(anchor);
      if (!text) continue;
      seen.set(url, { url, text });
      if (seen.size >= 500) break;
    }
  }

  function countBbsLinks() {
    let count = 0;
    for (const url of seen.keys()) {
      if (bbsLinkPattern.test(url)) count += 1;
    }
    return count;
  }

  function sleepInPage(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  async function waitForPath(pattern, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (pattern.test(location.pathname)) return true;
      await sleepInPage(300);
    }
    return pattern.test(location.pathname);
  }

  async function waitForLinkCount(min, timeoutMs) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (document.querySelectorAll('a[href*="/app/bbs/link/"]').length >= min) return true;
      await sleepInPage(300);
    }
    return false;
  }

  function pickLinkText(anchor) {
    const explicit = (anchor.getAttribute("title") || anchor.getAttribute("aria-label") || "").replace(/\s+/g, " ").trim();
    if (explicit) return explicit.slice(0, 200);
    const node = anchor.querySelector('[class*="title" i], [class*="headline" i], h1, h2, h3, h4');
    if (node) {
      const value = (node.textContent || "").replace(/\s+/g, " ").trim();
      if (value) return value.slice(0, 200);
    }
    return (anchor.innerText || anchor.textContent || "").replace(/\s+/g, " ").trim().slice(0, 200);
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

chrome.runtime.onStartup.addListener(() => { void connect(); });
chrome.runtime.onInstalled.addListener(() => { void connect(); });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "relay-keepalive") void connect();
});
void chrome.alarms.create("relay-keepalive", { periodInMinutes: 0.5 });
void connect();
