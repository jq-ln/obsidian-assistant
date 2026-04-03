import { describe, it, expect } from "vitest";
import { cosineSimilarity, SimilarityScorer, ScoredCandidate } from "@/embeddings/similarity";

describe("cosineSimilarity", () => {
  it("returns 1 for identical vectors", () => {
    const v = new Float32Array([1, 2, 3]);
    expect(cosineSimilarity(v, v)).toBeCloseTo(1.0);
  });

  it("returns 0 for orthogonal vectors", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([0, 1, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(0.0);
  });

  it("returns -1 for opposite vectors", () => {
    const a = new Float32Array([1, 0, 0]);
    const b = new Float32Array([-1, 0, 0]);
    expect(cosineSimilarity(a, b)).toBeCloseTo(-1.0);
  });

  it("computes correct similarity for known vectors", () => {
    const a = new Float32Array([1, 2, 3]);
    const b = new Float32Array([4, 5, 6]);
    // dot = 32, magA = sqrt(14), magB = sqrt(77)
    const expected = 32 / (Math.sqrt(14) * Math.sqrt(77));
    expect(cosineSimilarity(a, b)).toBeCloseTo(expected);
  });
});

describe("SimilarityScorer", () => {
  function makeStore(vectors: Record<string, number[]>) {
    const map = new Map<string, Float32Array>();
    for (const [path, v] of Object.entries(vectors)) {
      map.set(path, new Float32Array(v));
    }
    return {
      getVector(path: string): Float32Array | null {
        return map.get(path) ?? null;
      },
    };
  }

  it("ranks candidates by cosine similarity descending", () => {
    const store = makeStore({
      "source.md": [1, 0, 0],
      "close.md": [0.9, 0.1, 0],
      "far.md": [0, 0, 1],
      "medium.md": [0.5, 0.5, 0],
    });

    const scorer = new SimilarityScorer(store as any);
    const result = scorer.rankCandidates(
      "source.md",
      ["close.md", "far.md", "medium.md"],
      { topK: 10, minScore: 0 },
    );

    expect(result[0].path).toBe("close.md");
    expect(result[1].path).toBe("medium.md");
    expect(result[2].path).toBe("far.md");
  });

  it("respects topK limit", () => {
    const store = makeStore({
      "source.md": [1, 0, 0],
      "a.md": [0.9, 0.1, 0],
      "b.md": [0.8, 0.2, 0],
      "c.md": [0.7, 0.3, 0],
    });

    const scorer = new SimilarityScorer(store as any);
    const result = scorer.rankCandidates(
      "source.md",
      ["a.md", "b.md", "c.md"],
      { topK: 2, minScore: 0 },
    );

    expect(result).toHaveLength(2);
  });

  it("filters candidates below minScore", () => {
    const store = makeStore({
      "source.md": [1, 0, 0],
      "close.md": [0.9, 0.1, 0],
      "far.md": [0, 0, 1],
    });

    const scorer = new SimilarityScorer(store as any);
    const result = scorer.rankCandidates(
      "source.md",
      ["close.md", "far.md"],
      { topK: 10, minScore: 0.5 },
    );

    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("close.md");
  });

  it("skips candidates without vectors", () => {
    const store = makeStore({
      "source.md": [1, 0, 0],
      "indexed.md": [0.9, 0.1, 0],
    });

    const scorer = new SimilarityScorer(store as any);
    const result = scorer.rankCandidates(
      "source.md",
      ["indexed.md", "missing.md"],
      { topK: 10, minScore: 0 },
    );

    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("indexed.md");
  });
});
