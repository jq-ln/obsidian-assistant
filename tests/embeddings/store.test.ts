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

  describe("word frequencies", () => {
    it("tracks word frequencies after embedding", async () => {
      await store.ensureEmbedding("note.md", "machine learning is great machine learning");
      const freqs = store.getWordFrequencies();
      expect(freqs.get("machine")).toBe(2);
      expect(freqs.get("learning")).toBe(2);
      expect(freqs.get("great")).toBe(1);
    });

    it("does not count stop words or short words", async () => {
      await store.ensureEmbedding("note.md", "the is a an and or but not for");
      const freqs = store.getWordFrequencies();
      expect(freqs.size).toBe(0);
    });

    it("persists word frequencies through serialization", async () => {
      await store.ensureEmbedding("note.md", "transformer attention model");
      const json = store.serialize();
      const restored = EmbeddingStore.deserialize(json, provider);
      const freqs = restored.getWordFrequencies();
      expect(freqs.get("transformer")).toBe(1);
      expect(freqs.get("attention")).toBe(1);
    });

    it("tracks frequencies before removal (freqs not decremented — known limitation)", async () => {
      await store.ensureEmbedding("note.md", "unique-word unique-word");
      expect(store.getWordFrequencies().get("unique-word")).toBe(2);

      store.remove("note.md");
      // Known limitation: word freqs are not decremented on remove.
      // They are rebuilt correctly on next startup from a cleared cache.
      // Verify the vector is gone even though freqs persist.
      expect(store.getVector("note.md")).toBeNull();
      expect(store.getWordFrequencies().get("unique-word")).toBe(2);
    });
  });

  describe("background indexing", () => {
    it("pauses after 3 consecutive failures", async () => {
      provider.embed
        .mockRejectedValueOnce(new Error("fail 1"))
        .mockRejectedValueOnce(new Error("fail 2"))
        .mockRejectedValueOnce(new Error("fail 3"));

      const readContent = vi.fn().mockResolvedValue("content");

      store.startBackgroundIndex(
        [{ path: "a.md" }, { path: "b.md" }, { path: "c.md" }, { path: "d.md" }],
        readContent,
        vi.fn(),
      );

      // Manually trigger 3 ticks
      await (store as any).backgroundTick();
      await (store as any).backgroundTick();
      await (store as any).backgroundTick();

      // 4th tick should be skipped (paused)
      provider.embed.mockResolvedValue(Array.from({ length: 768 }, () => 0));
      await (store as any).backgroundTick();
      // embed should have been called 3 times (the 3 failures), not 4
      expect(provider.embed).toHaveBeenCalledTimes(3);

      store.stopBackgroundIndex();
    });

    it("resets failure counter on success", async () => {
      provider.embed
        .mockRejectedValueOnce(new Error("fail 1"))
        .mockRejectedValueOnce(new Error("fail 2"))
        .mockResolvedValueOnce(Array.from({ length: 768 }, () => 0))
        .mockRejectedValueOnce(new Error("fail 3"))
        .mockRejectedValueOnce(new Error("fail 4"));

      const readContent = vi.fn().mockResolvedValue("content");

      store.startBackgroundIndex(
        [{ path: "a.md" }, { path: "b.md" }, { path: "c.md" }, { path: "d.md" }, { path: "e.md" }],
        readContent,
        vi.fn(),
      );

      await (store as any).backgroundTick(); // fail 1
      await (store as any).backgroundTick(); // fail 2
      await (store as any).backgroundTick(); // success → reset
      await (store as any).backgroundTick(); // fail 3
      await (store as any).backgroundTick(); // fail 4

      // All 5 were processed (no pause triggered because success reset the counter)
      expect(provider.embed).toHaveBeenCalledTimes(5);

      store.stopBackgroundIndex();
    });

    it("skips deleted notes during background indexing", async () => {
      const readContent = vi.fn().mockResolvedValue(null); // note deleted

      store.startBackgroundIndex(
        [{ path: "deleted.md" }],
        readContent,
        vi.fn(),
      );

      await (store as any).backgroundTick();
      expect(store.getVector("deleted.md")).toBeNull();
      expect(provider.embed).not.toHaveBeenCalled();

      store.stopBackgroundIndex();
    });
  });
});
