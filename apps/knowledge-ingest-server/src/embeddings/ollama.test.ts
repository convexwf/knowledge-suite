import { describe, expect, it } from "vitest";
import { cosineSimilarity, normalizeVector } from "./ollama.js";

describe("embedding math", () => {
  it("normalizes vectors to unit length", () => {
    const vector = normalizeVector([3, 4]);
    expect(vector[0]).toBeCloseTo(0.6);
    expect(vector[1]).toBeCloseTo(0.8);
    expect(cosineSimilarity(vector, vector)).toBeCloseTo(1);
  });

  it("scores orthogonal vectors as zero", () => {
    expect(cosineSimilarity(normalizeVector([1, 0]), normalizeVector([0, 1]))).toBeCloseTo(0);
  });
});
