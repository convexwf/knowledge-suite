export interface HtmlMetadata {
  title?: string;
  canonicalUrl?: string;
  originalUrl?: string;
  author?: string;
}

export function extractHtmlMetadata(html: string): HtmlMetadata {
  return {
    title: firstNonEmpty([
      tagContent(html, "title"),
      metaContent(html, "property", "og:title"),
      metaContent(html, "name", "twitter:title")
    ]),
    canonicalUrl: firstNonEmpty([
      linkHref(html, "canonical"),
      metaContent(html, "property", "og:url")
    ]),
    originalUrl: firstNonEmpty([
      metaContent(html, "property", "og:url"),
      linkHref(html, "canonical")
    ]),
    author: firstNonEmpty([
      metaContent(html, "name", "author"),
      metaContent(html, "property", "article:author")
    ])
  };
}

export function isHttpUrl(value: string | undefined): value is string {
  if (!value) {
    return false;
  }
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function tagContent(html: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i").exec(html);
  return match ? decodeHtml(stripTags(match[1] ?? "")).trim() || undefined : undefined;
}

function metaContent(html: string, attrName: string, attrValue: string): string | undefined {
  for (const match of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = match[0];
    if (attributeValue(tag, attrName)?.toLowerCase() === attrValue.toLowerCase()) {
      return decodeHtml(attributeValue(tag, "content") ?? "").trim() || undefined;
    }
  }
  return undefined;
}

function linkHref(html: string, rel: string): string | undefined {
  for (const match of html.matchAll(/<link\b[^>]*>/gi)) {
    const tag = match[0];
    const rels = attributeValue(tag, "rel")?.toLowerCase().split(/\s+/) ?? [];
    if (rels.includes(rel.toLowerCase())) {
      return decodeHtml(attributeValue(tag, "href") ?? "").trim() || undefined;
    }
  }
  return undefined;
}

function attributeValue(tag: string, name: string): string | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = new RegExp(`${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function stripTags(value: string): string {
  return value.replace(/<[^>]+>/g, " ");
}

function decodeHtml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_match, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&amp;/g, "&");
}

function firstNonEmpty(values: Array<string | undefined>): string | undefined {
  return values.find((value) => value?.trim())?.trim();
}
