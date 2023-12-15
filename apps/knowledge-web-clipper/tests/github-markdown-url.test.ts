import { describe, expect, it } from "vitest";
import { parseGitHubMarkdownUrl } from "../src/github-markdown-url.js";

describe("GitHub Markdown URL parser", () => {
  it("parses a GitHub blob URL into the server request", () => {
    expect(parseGitHubMarkdownUrl(
      "https://github.com/convexwf/easy-rl/blob/master/docs/easy-rl-complete.md"
    )).toEqual({
      owner: "convexwf",
      repo: "easy-rl",
      ref: "master",
      path: "docs/easy-rl-complete.md"
    });
  });

  it("accepts directory, raw, and pasted Markdown-link forms", () => {
    expect(parseGitHubMarkdownUrl("https://github.com/convexwf/easy-rl/tree/main/docs"))
      .toMatchObject({ owner: "convexwf", repo: "easy-rl", ref: "main", path: "docs" });
    expect(parseGitHubMarkdownUrl(
      "[easy-rl](https://github.com/convexwf/easy-rl/blob/refs/heads/master/docs/intro.md#top)"
    )).toMatchObject({ owner: "convexwf", repo: "easy-rl", ref: "master", path: "docs/intro.md" });
    expect(parseGitHubMarkdownUrl(
      "https://raw.githubusercontent.com/convexwf/easy-rl/refs/heads/master/docs/intro.md"
    )).toMatchObject({ owner: "convexwf", repo: "easy-rl", ref: "master", path: "docs/intro.md" });
  });

  it("rejects non-GitHub URLs and incomplete repository links", () => {
    expect(() => parseGitHubMarkdownUrl("https://example.com/docs/intro.md"))
      .toThrow("Paste a GitHub.com Markdown URL.");
    expect(() => parseGitHubMarkdownUrl("https://github.com/convexwf/easy-rl"))
      .toThrow("file or directory URL");
  });
});
