import type { GitHubMarkdownRequest } from "./types.js";

const OWNER_OR_REPO = /^[A-Za-z0-9_.-]{1,100}$/;

export function parseGitHubMarkdownUrl(value: string): GitHubMarkdownRequest | undefined {
  const input = value.trim();
  if (!input) return undefined;

  const linkTarget = unwrapMarkdownLink(input);
  let url: URL;
  try {
    url = new URL(linkTarget);
  } catch {
    throw new Error("Paste a valid GitHub Markdown URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("GitHub Markdown URL must use http or https.");
  }

  const segments = decodePathSegments(url.pathname);
  const hostname = url.hostname.toLowerCase();
  if (hostname === "github.com" || hostname === "www.github.com") {
    if (segments.length < 5 || !OWNER_OR_REPO.test(segments[0]) || !OWNER_OR_REPO.test(segments[1])) {
      throw new Error("Use a GitHub file or directory URL such as github.com/owner/repo/blob/main/docs/intro.md.");
    }
    if (segments[2] !== "blob" && segments[2] !== "tree") {
      throw new Error("GitHub URL must point to a file (blob) or directory (tree).");
    }
    const source = refAndPath(segments, 3);
    return {
      owner: segments[0],
      repo: segments[1],
      ref: source.ref,
      path: source.path
    };
  }

  if (hostname === "raw.githubusercontent.com") {
    if (segments.length < 4 || !OWNER_OR_REPO.test(segments[0]) || !OWNER_OR_REPO.test(segments[1])) {
      throw new Error("Use a GitHub raw URL containing owner, repository, ref, and path.");
    }
    const source = refAndPath(segments, 2);
    return {
      owner: segments[0],
      repo: segments[1],
      ref: source.ref,
      path: source.path
    };
  }

  throw new Error("Paste a GitHub.com Markdown URL.");
}

function refAndPath(segments: string[], refIndex: number): { ref: string; path: string } {
  let pathIndex = refIndex + 1;
  let ref = segments[refIndex];
  if (segments[refIndex] === "refs" && (segments[refIndex + 1] === "heads" || segments[refIndex + 1] === "tags")) {
    ref = segments[refIndex + 2] ?? "";
    pathIndex = refIndex + 3;
  }
  const path = segments.slice(pathIndex).join("/");
  if (!ref || !path) {
    throw new Error("The GitHub URL must include both a ref and a repository path.");
  }
  return { ref, path };
}

function decodePathSegments(pathname: string): string[] {
  try {
    return pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
  } catch {
    throw new Error("The GitHub URL contains an invalid encoded path.");
  }
}

function unwrapMarkdownLink(value: string): string {
  const markdownLink = /^\[[^\]]*\]\(<?([^\s)>]+)>?\)$/.exec(value);
  if (markdownLink?.[1]) return markdownLink[1];
  return value.replace(/^<|>$/g, "");
}
