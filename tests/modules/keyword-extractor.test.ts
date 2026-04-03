// tests/modules/keyword-extractor.test.ts
import { describe, it, expect } from "vitest";
import { extractKeywords } from "@/modules/connections/keyword-extractor";

describe("extractKeywords", () => {
  it("extracts high-frequency words from a note", () => {
    const noteContent =
      "Machine learning is a subset of artificial intelligence. " +
      "Machine learning algorithms learn from data. " +
      "Data is essential for machine learning.";
    const vaultWordFreqs = new Map<string, number>([
      ["machine", 5],
      ["learning", 5],
      ["subset", 50],
      ["artificial", 50],
      ["intelligence", 50],
      ["algorithms", 50],
      ["data", 50],
      ["essential", 100],
    ]);

    const keywords = extractKeywords(noteContent, vaultWordFreqs);
    expect(keywords).toContain("machine");
    expect(keywords).toContain("learning");
  });

  it("filters out stop words", () => {
    const keywords = extractKeywords(
      "the is a an and or but not for with this that from",
      new Map(),
    );
    expect(keywords).toHaveLength(0);
  });
});
