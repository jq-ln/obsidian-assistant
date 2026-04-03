import { describe, it, expect, vi, beforeEach } from "vitest";
import { EmbeddingStore, fnv1aHash } from "@/embeddings/store";
import { EmbeddingProvider } from "@/embeddings/provider";

function makeMockProvider(): EmbeddingProvider & { embed: ReturnType<typeof vi.fn> } {
  const vector = Array.from({ length: 768 }, (_, i) => Math.sin(i));
  return {
    embed: vi.fn().mockResolvedValue(vector),
    isAvailable: vi.fn().mockResolvedValue(true),
  };
}

describe("fnv1aHash", () => {
  it("returns a hex string", () => {
    const hash = fnv1aHash("hello");
    expect(hash).toMatch(/^[0-9a-f]+$/);
  });

  it("returns same hash for same input", () => {
    expect(fnv1aHash("test")).toBe(fnv1aHash("test"));
  });

  it("returns different hash for different input", () => {
    expect(fnv1aHash("hello")).not.toBe(fnv1aHash("world"));
  });
});

describe("EmbeddingStore", () => {
  let provider: ReturnType<typeof makeMockProvider>;
  let store: EmbeddingStore;

  beforeEach(() => {
    provider = makeMockProvider();
    store = new EmbeddingStore(provider);
  });

  describe("getVector", () => {
    it("returns null for unindexed notes", () => {
      expect(store.getVector("nonexistent.md")).toBeNull();
    });
  });

  describe("ensureEmbedding", () => {
    it("embeds new content and stores the vector", async () => {
      const vector = await store.ensureEmbedding("note.md", "some content");
      expect(vector).toBeInstanceOf(Float32Array);
      expect(vector.length).toBe(768);
      expect(provider.embed).toHaveBeenCalledWith("some content");
    });

    it("returns cached vector when content hash unchanged", async () => {
      await store.ensureEmbedding("note.md", "same content");
      const vector2 = await store.ensureEmbedding("note.md", "same content");
      expect(provider.embed).toHaveBeenCalledTimes(1);
      expect(vector2).toBeInstanceOf(Float32Array);
    });

    it("re-embeds when content changes", async () => {
      await store.ensureEmbedding("note.md", "version 1");
      await store.ensureEmbedding("note.md", "version 2");
      expect(provider.embed).toHaveBeenCalledTimes(2);
    });

    it("prevents concurrent embeds for the same path", async () => {
      const [v1, v2] = await Promise.all([
        store.ensureEmbedding("note.md", "content"),
        store.ensureEmbedding("note.md", "content"),
      ]);

      expect(provider.embed).toHaveBeenCalledTimes(1);
      expect(v1).toBe(v2); // same Float32Array reference
    });

    it("rejects vectors with wrong dimensions", async () => {
      provider.embed.mockResolvedValueOnce([1, 2, 3]); // wrong length
      await expect(store.ensureEmbedding("note.md", "content")).rejects.toThrow("768");
    });
  });

  describe("remove", () => {
    it("removes the entry from the store", async () => {
      await store.ensureEmbedding("note.md", "content");
      expect(store.getVector("note.md")).not.toBeNull();

      store.remove("note.md");
      expect(store.getVector("note.md")).toBeNull();
    });
  });

  describe("serialization", () => {
    it("round-trips through serialize/deserialize", async () => {
      await store.ensureEmbedding("a.md", "content a");
      await store.ensureEmbedding("b.md", "content b");

      const json = store.serialize();
      const restored = EmbeddingStore.deserialize(json, provider);

      expect(restored.getVector("a.md")).not.toBeNull();
      expect(restored.getVector("b.md")).not.toBeNull();
      expect(restored.getVector("a.md")!.length).toBe(768);
    });

    it("includes schema version", () => {
      const json = store.serialize();
      const data = JSON.parse(json);
      expect(data.schemaVersion).toBe(1);
    });
  });
});
