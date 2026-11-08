(() => {
  const MARK = "__knowledgeCaptureRelayContentLoaded";
  if (window[MARK]) return;
  window[MARK] = true;

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message && message.type === "knowledge.capture.snapshot") {
      sendResponse(collectSnapshot());
      return true;
    }
    return false;
  });

  function collectSnapshot() {
    const html = document.documentElement ? document.documentElement.outerHTML : "";
    const text = document.body ? document.body.innerText : "";
    const canonical = document.querySelector('link[rel="canonical"]');
    const canonicalUrl = canonical && canonical.href ? canonical.href : undefined;
    return {
      pageUrl: location.href,
      ...(canonicalUrl ? { canonicalUrl } : {}),
      pageTitle: document.title,
      title: document.title,
      html,
      text,
      capturedAt: new Date().toISOString(),
      meta: { capture: "extension-relay" },
      diagnostics: {
        htmlLength: html.length,
        textLength: text.trim().length,
        shadowRootCount: 0
      }
    };
  }
})();
