// tests/integration/connection-flow.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { EmbeddingStore } from "@/embeddings/store";
import { SimilarityScorer } from "@/embeddings/similarity";
import { extractKeywords } from "@/modules/connections/keyword-extractor";
import { EmbeddingProvider } from "@/embeddings/provider";

function makeMockProvider(vectors: Record<string, number[]>): EmbeddingProvider {
  const entries = Object.entries(vectors);
  let callIndex = 0;
  return {
    embed: vi.fn().mockImplementation(async () => {
      const vector = entries[callIndex]?.[1] ?? Array.from({ length: 768 }, () => 0);
      callIndex++;
      return vector;
    }),
    isAvailable: vi.fn().mockResolvedValue(true),
  };
}

describe("Connection scan with embeddings", () => {
  it("filters candidates by cosine similarity", async () => {
    const dim = 768;
    const sourceVec = Array.from({ length: dim }, (_, i) => Math.sin(i));
    const closeVec = Array.from({ length: dim }, (_, i) => Math.sin(i) + 0.01 * Math.cos(i));
    const farVec = Array.from({ length: dim }, (_, i) => Math.cos(i * 7));

    const provider = makeMockProvider({
      "source.md": sourceVec,
      "close.md": closeVec,
      "far.md": farVec,
    });

    const store = new EmbeddingStore(provider);
    await store.ensureEmbedding("source.md", "source content");
    await store.ensureEmbedding("close.md", "close content");
    await store.ensureEmbedding("far.md", "far content");

    const scorer = new SimilarityScorer(store);
    const ranked = scorer.rankCandidates(
      "source.md",
      ["close.md", "far.md"],
      { topK: 10, minScore: 0.5 },
    );

    expect(ranked.length).toBeGreaterThanOrEqual(1);
    expect(ranked[0].path).toBe("close.md");
    expect(ranked[0].score).toBeGreaterThan(0.9);
  });

  it("builds prompt with keyword summaries using word frequencies", async () => {
    const dim = 768;
    const vec = Array.from({ length: dim }, (_, i) => Math.sin(i));
    const provider = makeMockProvider({
      "source.md": vec,
      "candidate.md": vec,
    });

    const store = new EmbeddingStore(provider);
    await store.ensureEmbedding("source.md", "machine learning transformer");
    await store.ensureEmbedding("candidate.md", "transformer attention mechanism");

    const wordFreqs = store.getWordFrequencies();
    expect(wordFreqs.size).toBeGreaterThan(0);

    const keywords = extractKeywords("transformer attention mechanism", wordFreqs);
    expect(keywords.length).toBeGreaterThan(0);
    expect(keywords).toContain("transformer");
  });

  it("returns early when no candidates pass the filter", async () => {
    const dim = 768;
    const sourceVec = Array.from({ length: dim }, (_, i) => Math.sin(i));
    const farVec = Array.from({ length: dim }, (_, i) => Math.cos(i * 7));

    const provider = makeMockProvider({
      "source.md": sourceVec,
      "far.md": farVec,
    });

    const store = new EmbeddingStore(provider);
    await store.ensureEmbedding("source.md", "source content");
    await store.ensureEmbedding("far.md", "far content");

    const scorer = new SimilarityScorer(store);
    const ranked = scorer.rankCandidates(
      "source.md",
      ["far.md"],
      { topK: 10, minScore: 0.95 },
    );

    expect(ranked).toHaveLength(0);
  });
});
