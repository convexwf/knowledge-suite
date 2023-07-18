import {
  ClipInput,
  isFileUrl,
  normalizeUrlForKnowledge,
  nowIso,
  PageSnapshot
} from "@uknowledge/knowledge-schema";

export interface ResolvedInput {
  inputMode: ClipInput["inputMode"];
  url: string;
  normalizedUrl: string;
  html: string;
  title?: string;
  meta: Record<string, string>;
  capturedAt: string;
}

export async function resolveClipInput(input: ClipInput): Promise<ResolvedInput> {
  if (input.inputMode === "browser_html") {
    return fromSnapshot(input.snapshot);
  }

  if (isFileUrl(input.url)) {
    throw new Error("server_fetch does not support file:// URLs; use browser_html instead.");
  }

  const response = await fetch(input.url, {
    headers: {
      "user-agent": "knowledge-ingest-server/0.1"
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to fetch ${input.url}: ${response.status} ${response.statusText}`);
  }

  const html = await response.text();
  return {
    inputMode: "server_fetch",
    url: input.url,
    normalizedUrl: normalizeUrlForKnowledge(input.url),
    html,
    meta: {},
    capturedAt: nowIso()
  };
}

function fromSnapshot(snapshot: PageSnapshot): ResolvedInput {
  const url = snapshot.canonicalUrl || snapshot.pageUrl;
  return {
    inputMode: "browser_html",
    url,
    normalizedUrl: normalizeUrlForKnowledge(url),
    html: snapshot.html,
    title: snapshot.title,
    meta: snapshot.meta,
    capturedAt: snapshot.capturedAt
  };
}
