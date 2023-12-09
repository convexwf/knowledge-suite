(() => {
  const knowledgeWindow = window as typeof window & {
    __knowledgeWebClipperContentLoaded?: boolean;
  };

  if (!knowledgeWindow.__knowledgeWebClipperContentLoaded) {
    knowledgeWindow.__knowledgeWebClipperContentLoaded = true;

    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === "knowledge.collectSnapshot") {
        sendResponse(collectSnapshot());
        return true;
      }

      if (message?.type === "knowledge.discoverLinks") {
        const mode = (message?.mode as string) === "list" ? "list" : "navigation";
        sendResponse(mode === "list" ? collectListPageLinks() : collectNavigationLinks());
        return true;
      }

      return false;
    });
  }

  function collectSnapshot() {
    const snapshotHtml = serializeSnapshotHtml();
    const bodyText = document.body?.innerText;
    return {
      pageUrl: location.href,
      canonicalUrl: document.querySelector<HTMLLinkElement>('link[rel="canonical"]')?.href,
      pageTitle: document.title,
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
    sanitizeSnapshotClone(clone);
    return {
      html: clone.outerHTML,
      shadowRootCount
    };
  }

  function sanitizeSnapshotClone(root: Element): void {
    for (const element of [root, ...Array.from(root.querySelectorAll("*"))]) {
      sanitizeSvgLengthAttributes(element);
    }
  }

  function sanitizeSvgLengthAttributes(element: Element): void {
    if (element.namespaceURI !== "http://www.w3.org/2000/svg") {
      return;
    }

    for (const attribute of Array.from(element.attributes)) {
      if (SVG_LENGTH_ATTRIBUTES.has(attribute.name.toLowerCase()) && isInvalidSvgLengthPlaceholder(attribute.value)) {
        element.removeAttribute(attribute.name);
      }
    }
  }

  function isInvalidSvgLengthPlaceholder(value: string): boolean {
    return /^(?:currentWidth|currentHeight|undefined|null|NaN)$/i.test(value.trim());
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

  function collectNavigationLinks() {
    const candidates: Array<{
      url: string;
      text?: string;
      source?: string;
      order: number;
      depth: number;
    }> = [];
    const seen = new Set<string>();
    const containers = findNavigationContainers();

    for (const container of containers) {
      const source = sourceForContainer(container);
      const links = Array.from(container.querySelectorAll<HTMLAnchorElement>("a[href]"));
      for (const link of links) {
        pushCandidate(link, source, depthForLink(link, container));
      }
    }

    for (const selector of [
      'link[rel="next"]',
      'a[rel="next"]',
      'a[aria-label*="next" i]',
      'a[title*="next" i]'
    ]) {
      const element = document.querySelector<HTMLAnchorElement | HTMLLinkElement>(selector);
      if (element) {
        pushCandidate(element, "next", 0);
      }
    }

    return {
      pageUrl: location.href,
      title: document.title,
      candidates
    };

    function pushCandidate(link: HTMLAnchorElement | HTMLLinkElement, source: string, depth: number): void {
      const rawHref = link.href;
      if (!rawHref) {
        return;
      }
      let url: URL;
      try {
        url = new URL(rawHref, location.href);
      } catch {
        return;
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        return;
      }
      // Keep hash for same-origin links (SPA routing), strip for cross-origin
      if (url.origin !== location.origin) {
        url.hash = "";
      }
      const normalized = url.toString();
      if (seen.has(normalized)) {
        return;
      }
      seen.add(normalized);
      const text = "textContent" in link ? link.textContent?.trim().replace(/\s+/g, " ") : undefined;
      candidates.push({
        url: normalized,
        text: text || link.getAttribute("aria-label") || link.getAttribute("title") || undefined,
        source,
        order: candidates.length,
        depth
      });
    }
  }

  function collectListPageLinks() {
    const candidates: Array<{
      url: string;
      text?: string;
      source?: string;
      order: number;
      depth: number;
    }> = [];
    const seen = new Set<string>();

    const nonArticlePathPatterns = [
      /\/about(\/|$)/i,
      /\/privacy(\/|$)/i,
      /\/terms(\/|$)/i,
      /\/tags(\/|$)/i,
      /\/categories(\/|$)/i,
      /\/category(\/|$)/i,
      /\/authors(\/|$)/i,
      /\/author(\/|$)/i,
      /\/login(\/|$)/i,
      /\/register(\/|$)/i,
      /\/subscribe(\/|$)/i,
      /\/contact(\/|$)/i,
      /\/careers(\/|$)/i,
      /\/jobs(\/|$)/i,
      /\/press(\/|$)/i
    ];

    function isNonArticlePath(href: string): boolean {
      try {
        const url = new URL(href, location.href);
        return nonArticlePathPatterns.some((pattern) => pattern.test(url.pathname));
      } catch {
        return true;
      }
    }

    function isFooterOrSocial(link: HTMLAnchorElement): boolean {
      const closest = link.closest("footer, [class*=footer i], [class*=social i], [class*=share i]");
      if (closest) return true;
      const rel = link.getAttribute("rel");
      if (rel && /nofollow/i.test(rel)) return true;
      return false;
    }

    function isSkipLink(url: URL): boolean {
      if (url.origin !== location.origin) return false;
      if (/^#/.test(url.hash) && url.pathname === location.pathname) return true;
      if (url.pathname === location.pathname) return true;
      return false;
    }

    function pushCandidate(link: HTMLAnchorElement, source: string): void {
      const rawHref = link.href;
      if (!rawHref) return;
      let url: URL;
      try {
        url = new URL(rawHref, location.href);
      } catch {
        return;
      }
      if (url.protocol !== "http:" && url.protocol !== "https:") return;
      if (url.origin !== location.origin) return;
      if (isSkipLink(url)) return;
      if (isNonArticlePath(rawHref)) return;
      if (isFooterOrSocial(link)) return;

      url.hash = "";
      const search = url.search;
      // Keep only meaningful query params; strip common tracking
      const strippedSearch = search.replace(/[?&](utm_|fbclid|gclid|ref|source=|mc_cid|mc_eid)[^&]*/gi, "");
      url.search = strippedSearch;

      const normalized = url.toString();
      if (seen.has(normalized)) return;
      seen.add(normalized);

      // Extract best title text from the link or nearby heading
      let text: string | undefined;
      const h = link.querySelector("h1, h2, h3, h4, h5, h6");
      if (h) {
        text = h.textContent?.trim().replace(/\s+/g, " ");
      }
      if (!text) {
        text = link.textContent?.trim().replace(/\s+/g, " ");
        // If text is very short (e.g. "Read more"), try to find heading nearby
        if (text && text.length < 15) {
          const parent = link.closest("article, li, [class*=post i], [class*=card i], [class*=item i]");
          if (parent) {
            const parentHeading = parent.querySelector("h1, h2, h3, h4, h5, h6");
            if (parentHeading) {
              text = parentHeading.textContent?.trim().replace(/\s+/g, " ") || text;
            }
          }
        }
      }
      if (!text) {
        text = link.getAttribute("aria-label") || link.getAttribute("title") || undefined;
      }

      candidates.push({
        url: normalized,
        text,
        source,
        order: candidates.length,
        depth: 0
      });
    }

    // Find main content area
    let container: Element | null = document.querySelector("main");
    if (!container) {
      // Look for the largest article-containing element
      const articleParents = Array.from(document.querySelectorAll("article"))
        .map((a) => a.parentElement)
        .filter((el): el is HTMLElement => el !== null);
      if (articleParents.length > 0) {
        container = articleParents[0];
      }
    }
    if (!container) {
      container = document.body;
    }

    // Try repeating <article> cards first
    const articles = Array.from(container.querySelectorAll("article"));
    if (articles.length >= 2) {
      for (const article of articles) {
        const link = article.querySelector<HTMLAnchorElement>("a[href]");
        if (link) {
          pushCandidate(link, "list");
        }
      }
    } else {
      // Fallback: scan for links inside repeating list items or card containers
      const listItems = Array.from(
        container.querySelectorAll(
          "li:has(a[href]), [class*=post i]:has(a[href]), [class*=card i]:has(a[href]), [class*=item i]:has(a[href])"
        )
      );
      if (listItems.length >= 2) {
        for (const item of listItems) {
          const link = item.querySelector<HTMLAnchorElement>("a[href]");
          if (link) {
            pushCandidate(link, "list");
          }
        }
      } else {
        // Last resort: direct links in main content that look like article links
        const links = Array.from(
          container.querySelectorAll<HTMLAnchorElement>("a[href]")
        );
        for (const link of links) {
          // Heuristic: link text is long enough to be an article title
          const text = link.textContent?.trim() || "";
          if (text.length >= 20) {
            pushCandidate(link, "list");
          }
        }
      }
    }

    return {
      pageUrl: location.href,
      title: document.title,
      candidates
    };
  }

  function findNavigationContainers(): Element[] {
    const selectors = [
      "nav",
      "aside",
      '[role="navigation"]',
      '[aria-label*="nav" i]',
      '[aria-label*="sidebar" i]',
      '[aria-label*="docs" i]',
      '[class*="sidebar" i]',
      '[class*="toc" i]',
      '[class*="docs" i]'
    ];
    const seen = new Set<Element>();
    const containers: Element[] = [];
    for (const selector of selectors) {
      for (const element of Array.from(document.querySelectorAll(selector))) {
        if (!seen.has(element) && element.querySelector("a[href]")) {
          seen.add(element);
          containers.push(element);
        }
      }
    }
    return containers.slice(0, 12);
  }

  function sourceForContainer(container: Element): string {
    const label = container.getAttribute("aria-label") ?? container.getAttribute("role") ?? container.className;
    const text = String(label).toLowerCase();
    if (text.includes("toc")) {
      return "toc";
    }
    if (text.includes("sidebar") || text.includes("docs")) {
      return "sidebar";
    }
    return container.tagName.toLowerCase() === "nav" ? "nav" : "sidebar";
  }

  function depthForLink(link: Element, container: Element): number {
    let depth = 0;
    let current: Element | null = link.parentElement;
    while (current && current !== container) {
      if (current.matches("ul, ol, [role='list']")) {
        depth += 1;
      }
      current = current.parentElement;
    }
    return Math.max(0, depth - 1);
  }

  const SVG_LENGTH_ATTRIBUTES = new Set([
    "cx",
    "cy",
    "dx",
    "dy",
    "font-size",
    "height",
    "markerheight",
    "markerwidth",
    "r",
    "refx",
    "refy",
    "rx",
    "ry",
    "stroke-dashoffset",
    "stroke-width",
    "width",
    "x",
    "x1",
    "x2",
    "y",
    "y1",
    "y2"
  ]);
})();
