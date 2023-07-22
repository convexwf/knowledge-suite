import { describe, expect, it } from "vitest";
import {
  isFileUrl,
  normalizeUrlForKnowledge,
  urlHash
} from "./index.js";

describe("normalizeUrlForKnowledge", () => {
  it("removes fragments and common tracking params", () => {
    expect(
      normalizeUrlForKnowledge("https://example.com/a?utm_source=x&b=2&a=1#section")
    ).toBe("https://example.com/a?a=1&b=2");
  });

  it("keeps file URLs untouched", () => {
    const url = "file:///Users/me/page.html#frag";
    expect(normalizeUrlForKnowledge(url)).toBe(url);
    expect(isFileUrl(url)).toBe(true);
  });
});

describe("urlHash", () => {
  it("hashes normalized URLs consistently", () => {
    expect(urlHash("https://example.com/a?utm_source=x#top")).toBe(urlHash("https://example.com/a"));
  });
});
