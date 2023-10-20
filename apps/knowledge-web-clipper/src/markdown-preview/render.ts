type MarkdownItInstance = {
  render(markdown: string): string;
  validateLink?: (url: string) => boolean;
};

type MarkdownItFactory = (options: {
  html: boolean;
  linkify: boolean;
  typographer: boolean;
  breaks: boolean;
}) => MarkdownItInstance;

type DomPurify = {
  sanitize(
    html: string,
    options: {
      ALLOWED_TAGS: string[];
      ALLOWED_ATTR: string[];
      RETURN_DOM_FRAGMENT: true;
    }
  ): DocumentFragment | string;
};

declare global {
  interface Window {
    DOMPurify?: DomPurify;
    markdownit?: MarkdownItFactory;
    katex?: {
      render: (
        source: string,
        element: HTMLElement,
        options: {
          displayMode?: boolean;
          output?: "html" | "mathml" | "htmlAndMathml";
          strict?: boolean | string;
          throwOnError?: boolean;
          trust?: boolean;
        }
      ) => void;
    };
  }
}

type MathToken = {
  display: boolean;
  source: string;
};

const MATH_PLACEHOLDER_PREFIX = "KNOWLEDGE_MATH_";

const ALLOWED_TAGS = [
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "blockquote",
  "pre",
  "code",
  "a",
  "img",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "strong",
  "em",
  "del",
  "span",
  "div",
  "br",
  "hr"
];

const ALLOWED_ATTR = [
  "alt",
  "class",
  "href",
  "loading",
  "rel",
  "src",
  "target",
  "title"
];

let markdownItInstance: MarkdownItInstance | undefined;

export function renderMarkdownPreview(markdown: string): DocumentFragment {
  const body = stripSectionAnchors(stripFrontmatter(markdown)).trim();
  const fragment = document.createDocumentFragment();
  if (!body) {
    const empty = document.createElement("p");
    empty.textContent = "No Markdown content was produced for this document.";
    fragment.append(empty);
    return fragment;
  }

  const protectedMarkdown = protectMath(body);
  const html = markdownRenderer().render(protectedMarkdown.markdown);
  const sanitized = sanitizeHtml(html);
  restoreMathTokens(sanitized, protectedMarkdown.tokens);
  hardenLinksAndImages(sanitized);
  return sanitized;
}

function markdownRenderer(): MarkdownItInstance {
  if (markdownItInstance) {
    return markdownItInstance;
  }
  if (!window.markdownit) {
    throw new Error("Markdown renderer is not loaded.");
  }

  const renderer = window.markdownit({
    html: false,
    linkify: false,
    typographer: false,
    breaks: false
  });
  renderer.validateLink = (url: string) => isSafeMarkdownUrl(url, "link") || isSafeMarkdownUrl(url, "image");
  markdownItInstance = renderer;
  return renderer;
}

function sanitizeHtml(html: string): DocumentFragment {
  if (window.DOMPurify) {
    const sanitized = window.DOMPurify.sanitize(html, {
      ALLOWED_TAGS,
      ALLOWED_ATTR,
      RETURN_DOM_FRAGMENT: true
    });
    if (typeof sanitized !== "string") {
      return sanitized;
    }
    return htmlToFragment(sanitized);
  }

  const fragment = htmlToFragment(html);
  removeUnsafeNodes(fragment);
  return fragment;
}

function htmlToFragment(html: string): DocumentFragment {
  const template = document.createElement("template");
  template.innerHTML = html;
  return template.content;
}

function removeUnsafeNodes(root: ParentNode): void {
  for (const element of collectElements(root)) {
    if (!ALLOWED_TAGS.includes(element.tagName.toLowerCase())) {
      element.replaceWith(...Array.from(element.childNodes));
      continue;
    }
    for (const attribute of Array.from(element.attributes)) {
      const name = attribute.name.toLowerCase();
      if (!ALLOWED_ATTR.includes(name) || name.startsWith("on")) {
        element.removeAttribute(attribute.name);
      }
    }
  }
}

function hardenLinksAndImages(root: ParentNode): void {
  for (const anchor of collectElements(root, "a")) {
    if (!anchor.hasAttribute("href")) {
      continue;
    }
    const link = anchor as HTMLAnchorElement;
    if (!isSafeMarkdownUrl(link.href, "link")) {
      link.removeAttribute("href");
      continue;
    }
    link.target = "_blank";
    link.rel = "noreferrer";
  }

  for (const image of collectElements(root, "img")) {
    if (!image.hasAttribute("src")) {
      continue;
    }
    const img = image as HTMLImageElement;
    if (!isSafeMarkdownUrl(img.src, "image")) {
      img.removeAttribute("src");
      continue;
    }
    img.setAttribute("loading", "lazy");
    img.setAttribute("referrerpolicy", "no-referrer");
  }
}

function collectElements(root: ParentNode, tagName?: string): Element[] {
  const wantedTag = tagName?.toUpperCase();
  const elements: Element[] = [];
  const visit = (node: ParentNode): void => {
    for (const child of Array.from(node.childNodes ?? [])) {
      if (child instanceof Element) {
        if (!wantedTag || child.tagName === wantedTag) {
          elements.push(child);
        }
        visit(child);
      }
    }
  };
  visit(root);
  return elements;
}

function stripSectionAnchors(markdown: string): string {
  return markdown.replace(/^<!--\s*section_id:\S+\s*-->\n/gm, "");
}

function stripFrontmatter(markdown: string): string {
  const lines = markdown.trimStart().split(/\r?\n/);
  if (lines[0]?.trim() !== "---") {
    return markdown;
  }

  const endIndex = lines.slice(1).findIndex((line) => line.trim() === "---");
  if (endIndex === -1) {
    return markdown;
  }
  return lines.slice(endIndex + 2).join("\n").trimStart();
}

function protectMath(markdown: string): { markdown: string; tokens: MathToken[] } {
  const tokens: MathToken[] = [];
  const lines = markdown.split(/\r?\n/);
  const output: string[] = [];
  let fencedCode = false;
  let blockMath: string[] | undefined;

  const addToken = (source: string, display: boolean): string => {
    const placeholder = `${MATH_PLACEHOLDER_PREFIX}${tokens.length}`;
    tokens.push({ display, source });
    return placeholder;
  };

  for (const line of lines) {
    const trimmed = line.trim();
    const fence = line.match(/^\s*(```|~~~)/);
    if (fence && !blockMath) {
      fencedCode = !fencedCode;
      output.push(line);
      continue;
    }

    if (fencedCode) {
      output.push(line);
      continue;
    }

    if (blockMath) {
      if (trimmed === "$$" || trimmed === "\\]") {
        output.push(addToken(blockMath.join("\n"), true));
        blockMath = undefined;
      } else {
        blockMath.push(line);
      }
      continue;
    }

    const oneLineDisplayMath = parseOneLineDisplayMath(trimmed);
    if (oneLineDisplayMath) {
      output.push(addToken(oneLineDisplayMath, true));
      continue;
    }

    if (trimmed === "$$" || trimmed === "\\[") {
      blockMath = [];
      continue;
    }

    output.push(protectInlineMath(line, addToken));
  }

  if (blockMath) {
    output.push(addToken(blockMath.join("\n"), true));
  }

  return {
    markdown: output.join("\n"),
    tokens
  };
}

function protectInlineMath(
  line: string,
  addToken: (source: string, display: boolean) => string
): string {
  return line
    .replace(/\\\((.+?)\\\)/g, (_match, source: string) => addToken(source, false))
    .replace(/(?<!\$)\$([^$\n]+?)\$(?!\$)/g, (_match, source: string) => addToken(source, false));
}

function parseOneLineDisplayMath(line: string): string | undefined {
  if (line.startsWith("$$") && line.endsWith("$$") && line.length > 4) {
    return line.slice(2, -2).trim();
  }
  if (line.startsWith("\\[") && line.endsWith("\\]") && line.length > 4) {
    return line.slice(2, -2).trim();
  }
  return undefined;
}

function restoreMathTokens(root: ParentNode, tokens: MathToken[]): void {
  if (tokens.length === 0) {
    return;
  }

  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const textNodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    textNodes.push(node as Text);
  }

  for (const textNode of textNodes) {
    const parent = textNode.parentElement;
    const exactToken = parsePlaceholder(textNode.nodeValue?.trim() ?? "");
    if (exactToken !== undefined && tokens[exactToken]?.display && parent?.tagName.toLowerCase() === "p") {
      parent.replaceWith(renderMath(tokens[exactToken].source, true));
      continue;
    }

    const replacement = replaceTextMathTokens(textNode.nodeValue ?? "", tokens);
    if (replacement) {
      textNode.replaceWith(replacement);
    }
  }
}

function replaceTextMathTokens(text: string, tokens: MathToken[]): DocumentFragment | undefined {
  const regex = new RegExp(`${MATH_PLACEHOLDER_PREFIX}(\\d+)`, "g");
  let match: RegExpExecArray | null;
  let index = 0;
  const fragment = document.createDocumentFragment();
  let changed = false;

  while ((match = regex.exec(text))) {
    if (match.index > index) {
      fragment.append(document.createTextNode(text.slice(index, match.index)));
    }
    const token = tokens[Number(match[1])];
    if (token) {
      fragment.append(renderMath(token.source, token.display));
      changed = true;
    } else {
      fragment.append(document.createTextNode(match[0]));
    }
    index = match.index + match[0].length;
  }

  if (!changed) {
    return undefined;
  }
  if (index < text.length) {
    fragment.append(document.createTextNode(text.slice(index)));
  }
  return fragment;
}

function parsePlaceholder(text: string): number | undefined {
  const match = text.match(new RegExp(`^${MATH_PLACEHOLDER_PREFIX}(\\d+)$`));
  return match ? Number(match[1]) : undefined;
}

function renderMath(source: string, display: boolean): HTMLElement {
  const element = document.createElement(display ? "div" : "span");
  element.className = display ? "math-display" : "math-inline";
  element.dataset.source = source;
  const normalized = source.trim();
  if (window.katex) {
    try {
      window.katex.render(normalized, element, {
        displayMode: display,
        output: "htmlAndMathml",
        strict: "ignore",
        throwOnError: false,
        trust: false
      });
      element.classList.add("math-rendered");
      return element;
    } catch {
      element.replaceChildren();
    }
  }
  appendMathTokens(element, normalized);
  return element;
}

function appendMathTokens(parent: HTMLElement, source: string): void {
  let index = 0;
  while (index < source.length) {
    if (source.startsWith("\\frac", index)) {
      const parsed = parseFraction(source, index + "\\frac".length);
      if (parsed) {
        const fraction = document.createElement("span");
        fraction.className = "math-frac";
        const numerator = document.createElement("span");
        numerator.className = "math-num";
        appendMathTokens(numerator, parsed.numerator);
        const denominator = document.createElement("span");
        denominator.className = "math-den";
        appendMathTokens(denominator, parsed.denominator);
        fraction.append(numerator, denominator);
        parent.append(fraction);
        index = parsed.nextIndex;
        continue;
      }
    }

    const char = source[index];
    if ((char === "^" || char === "_") && parent.lastChild) {
      const parsed = parseScriptArgument(source, index + 1);
      if (parsed) {
        const script = document.createElement(char === "^" ? "sup" : "sub");
        appendMathTokens(script, parsed.value);
        parent.append(script);
        index = parsed.nextIndex;
        continue;
      }
    }

    if (char === "\\") {
      const command = source.slice(index).match(/^\\[A-Za-z]+/);
      if (command) {
        parent.append(document.createTextNode(mathCommandText(command[0])));
        index += command[0].length;
        continue;
      }
    }

    parent.append(document.createTextNode(mathSymbolText(char)));
    index += 1;
  }
}

function parseFraction(source: string, startIndex: number): { numerator: string; denominator: string; nextIndex: number } | undefined {
  const numerator = parseBraceGroup(source, skipSpaces(source, startIndex));
  if (!numerator) {
    return undefined;
  }
  const denominator = parseBraceGroup(source, skipSpaces(source, numerator.nextIndex));
  if (!denominator) {
    return undefined;
  }
  return {
    numerator: numerator.value,
    denominator: denominator.value,
    nextIndex: denominator.nextIndex
  };
}

function parseScriptArgument(source: string, startIndex: number): { value: string; nextIndex: number } | undefined {
  const index = skipSpaces(source, startIndex);
  if (source[index] === "{") {
    return parseBraceGroup(source, index);
  }
  if (source[index] === "\\") {
    const command = source.slice(index).match(/^\\[A-Za-z]+/);
    if (command) {
      return {
        value: command[0],
        nextIndex: index + command[0].length
      };
    }
  }
  return source[index]
    ? { value: source[index], nextIndex: index + 1 }
    : undefined;
}

function parseBraceGroup(source: string, startIndex: number): { value: string; nextIndex: number } | undefined {
  if (source[startIndex] !== "{") {
    return undefined;
  }
  let depth = 0;
  for (let index = startIndex; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") {
      depth += 1;
    } else if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        return {
          value: source.slice(startIndex + 1, index),
          nextIndex: index + 1
        };
      }
    }
  }
  return undefined;
}

function skipSpaces(source: string, startIndex: number): number {
  let index = startIndex;
  while (source[index] === " ") {
    index += 1;
  }
  return index;
}

function mathCommandText(command: string): string {
  const commands: Record<string, string> = {
    "\\alpha": "alpha",
    "\\beta": "beta",
    "\\gamma": "gamma",
    "\\delta": "delta",
    "\\epsilon": "epsilon",
    "\\theta": "theta",
    "\\lambda": "lambda",
    "\\mu": "mu",
    "\\pi": "pi",
    "\\sigma": "sigma",
    "\\phi": "phi",
    "\\omega": "omega",
    "\\Gamma": "Gamma",
    "\\Delta": "Delta",
    "\\Theta": "Theta",
    "\\Lambda": "Lambda",
    "\\Pi": "Pi",
    "\\Sigma": "Sigma",
    "\\Phi": "Phi",
    "\\Omega": "Omega",
    "\\sum": "sum",
    "\\prod": "prod",
    "\\int": "int",
    "\\infty": "infinity",
    "\\partial": "partial",
    "\\nabla": "nabla",
    "\\times": "x",
    "\\cdot": ".",
    "\\pm": "+/-",
    "\\leq": "<=",
    "\\geq": ">=",
    "\\neq": "!=",
    "\\approx": "~",
    "\\to": "->",
    "\\rightarrow": "->",
    "\\leftarrow": "<-",
    "\\Rightarrow": "=>",
    "\\in": "in",
    "\\notin": "not in",
    "\\subset": "subset",
    "\\subseteq": "subseteq",
    "\\cup": "cup",
    "\\cap": "cap"
  };
  return commands[command] ?? command.replace(/^\\/, "");
}

function mathSymbolText(char: string): string {
  return char === "~" ? " " : char;
}

function isSafeMarkdownUrl(value: string, kind: "image" | "link"): boolean {
  try {
    const url = new URL(value, window.location?.href || "https://knowledge.local/");
    if (kind === "image") {
      return ["http:", "https:", "blob:", "data:"].includes(url.protocol);
    }
    return ["http:", "https:", "file:", "mailto:"].includes(url.protocol);
  } catch {
    return false;
  }
}
