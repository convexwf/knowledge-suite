import { describe, expect, it } from "vitest";
import { readZipArchive } from "./unzip.js";
import { buildZipArchive } from "./zip.js";

describe("readZipArchive", () => {
  it("round-trips stored and deflated entries", () => {
    const archive = buildZipArchive([
      { path: "document.json", bytes: Buffer.from('{"doc_id":"doc-1"}') },
      { path: "assets/large.txt", bytes: Buffer.from("repeat ".repeat(200)) },
      { path: "empty.txt", bytes: Buffer.alloc(0) }
    ]);

    const entries = readZipArchive(archive);
    expect(entries.map((entry) => entry.path)).toEqual([
      "document.json",
      "assets/large.txt",
      "empty.txt"
    ]);
    expect(entries[0].bytes.toString("utf8")).toBe('{"doc_id":"doc-1"}');
    expect(entries[1].bytes.toString("utf8")).toBe("repeat ".repeat(200));
    expect(entries[2].bytes).toHaveLength(0);
  });

  it("rejects truncated archives", () => {
    const archive = buildZipArchive([
      { path: "document.json", bytes: Buffer.from("content") }
    ]);
    expect(() => readZipArchive(archive.subarray(0, 24))).toThrow(/empty or unsupported|truncated/);
  });
});
