(() => {
  const knowledgeWindow = window as typeof window & {
    __knowledgeWebClipperContentLoaded?: boolean;
  };

  if (!knowledgeWindow.__knowledgeWebClipperContentLoaded) {
    knowledgeWindow.__knowledgeWebClipperContentLoaded = true;

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type !== "knowledge.collectSnapshot") {
        return false;
      }

      sendResponse(collectSnapshot());
      return true;
    });
  }

  function collectSnapshot() {
    const snapshotHtml = serializeSnapshotHtml();
    const bodyText = document.body?.innerText;
    return {
      pageUrl: location.href,
      canonicalUrl: document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href,
      title: document.title,
      html: snapshotHtml.html,
      text: bodyText,
      diagnostics: {
        htmlLength: snapshotHtml.html.length,
        textLength: bodyText?.trim().length ?? 0,
        shadowRootCount: snapshotHtml.shadowRootCount
      },
      capturedAt: new Date().toISOString(),
      meta: collectMeta(),
      selectionHtml: collectSelectionHtml()
    };
  }

  function serializeSnapshotHtml(): { html: string; shadowRootCount: number } {
    const clone = document.documentElement.cloneNode(true) as HTMLElement;
    const shadowRootCount = flattenOpenShadowRoots(document.documentElement, clone);
    return {
      html: clone.outerHTML,
      shadowRootCount
    };
  }

  function flattenOpenShadowRoots(source: Element, target: Element): number {
    let shadowRootCount = 0;
    const sourceChildren = Array.from(source.children);
    const targetChildren = Array.from(target.children).slice(0, sourceChildren.length);

    for (let index = 0; index < sourceChildren.length; index += 1) {
      if (targetChildren[index]) {
        shadowRootCount += flattenOpenShadowRoots(sourceChildren[index], targetChildren[index]);
      }
    }

    const sourceWithShadow = source as Element & { shadowRoot?: ShadowRoot | null };
    if (sourceWithShadow.shadowRoot?.childNodes.length) {
      const shadowContainer = document.createElement("div");
      shadowContainer.setAttribute("data-knowledge-shadow-root", "open");
      for (const child of Array.from(sourceWithShadow.shadowRoot.childNodes)) {
        shadowContainer.append(child.cloneNode(true));
      }
      target.append(shadowContainer);
      shadowRootCount += 1;
    }

    return shadowRootCount;
  }

  function collectMeta(): Record<string, string> {
    const meta: Record<string, string> = {};
    for (const item of Array.from(document.querySelectorAll<HTMLMetaElement>("meta"))) {
      const key = item.name || item.getAttribute("property") || item.getAttribute("http-equiv");
      const content = item.content;
      if (key && content) {
        meta[key] = content;
      }
    }
    return meta;
  }

  function collectSelectionHtml(): string | undefined {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      return undefined;
    }

    const container = document.createElement("div");
    for (let index = 0; index < selection.rangeCount; index += 1) {
      container.append(selection.getRangeAt(index).cloneContents());
    }
    return container.innerHTML || undefined;
  }
})();
