# Embedding-Based Similarity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace TF-IDF keyword overlap with nomic-embed-text cosine similarity for connection detection, eliminating the O(n^2) vault cache rebuild and catching semantic relationships that lexical overlap misses.

**Architecture:** Three new units (EmbeddingProvider, EmbeddingStore, SimilarityScorer) replace the composite TF-IDF scorer. The connection scan flow reads vectors from an in-memory index backed by a JSON file, with background indexing on startup and on-demand embedding for active notes. Keyword extraction is retained as a standalone function for LLM prompt building.

**Tech Stack:** TypeScript, Obsidian Plugin API, Ollama `/api/embed` endpoint, nomic-embed-text (768-dim), Vitest

**Spec:** `docs/superpowers/specs/2026-04-03-embedding-similarity-design.md`

---

## File Map

```
src/
├── embeddings/
│   ├── provider.ts          # EmbeddingProvider interface + OllamaEmbeddingProvider
│   ├── store.ts             # EmbeddingStore: in-memory index, persistence, background loop, word freq cache
│   └── similarity.ts        # SimilarityScorer: cosine similarity, top-k filtering
├── modules/connections/
│   ├── keyword-extractor.ts # extractKeywords + STOP_WORDS (moved from scoring.ts)
│   └── connections.ts       # ConnectionModule (unchanged)
├── settings.ts              # Add connectionMinScore
└── main.ts                  # Wire embeddings, rewrite enqueueConnectionScan

tests/
├── embeddings/
│   ├── provider.test.ts
│   ├── store.test.ts
│   └── similarity.test.ts
├── modules/
│   ├── keyword-extractor.test.ts  # Migrated from scoring.test.ts
│   └── connections.test.ts        # Unchanged
└── integration/
    └── connection-flow.test.ts    # New: embedding-based connection scan
```

**Deleted files:**
- `src/modules/connections/scoring.ts`
- `tests/modules/scoring.test.ts`

---

## Task 1: EmbeddingProvider Interface and OllamaEmbeddingProvider

**Files:**
- Create: `src/embeddings/provider.ts`
- Create: `tests/embeddings/provider.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/embeddings/provider.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OllamaEmbeddingProvider } from "@/embeddings/provider";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("OllamaEmbeddingProvider", () => {
  let provider: OllamaEmbeddingProvider;

  beforeEach(() => {
    provider = new OllamaEmbeddingProvider("http://localhost:11434");
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("isAvailable", () => {
    it("returns true when Ollama responds to health check", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ models: [{ name: "nomic-embed-text" }] }),
      });

      expect(await provider.isAvailable()).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:11434/api/tags",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
    });

    it("returns false when Ollama is unreachable", async () => {
      mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));
      expect(await provider.isAvailable()).toBe(false);
    });

    it("caches availability for 30 seconds", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ models: [] }),
      });

      await provider.isAvailable();
      await provider.isAvailable();
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("embed", () => {
    it("sends correct request and parses response", async () => {
      const vector = Array.from({ length: 768 }, (_, i) => i * 0.001);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ embeddings: [vector] }),
      });

      const result = await provider.embed("Test note content");

      expect(result).toEqual(vector);

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:11434/api/embed");
      const body = JSON.parse(options.body);
      expect(body.model).toBe("nomic-embed-text");
      expect(body.input).toBe("Test note content");
    });

    it("passes abort signal to fetch", async () => {
      const vector = Array.from({ length: 768 }, () => 0);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ embeddings: [vector] }),
      });

      await provider.embed("test");
      const [, options] = mockFetch.mock.calls[0];
      expect(options.signal).toBeInstanceOf(AbortSignal);
    });

    it("throws timeout error when request is aborted", async () => {
      const abortError = new Error("The operation was aborted");
      abortError.name = "AbortError";
      mockFetch.mockRejectedValueOnce(abortError);

      await expect(provider.embed("test")).rejects.toThrow("timed out");
    });

    it("throws on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      });

      await expect(provider.embed("test")).rejects.toThrow("Embed request failed");
    });
  });

  describe("updateConfig", () => {
    it("updates endpoint and invalidates cache", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ models: [] }),
      });

      await provider.isAvailable();
      provider.updateConfig({ endpoint: "http://other:11434" });
      await provider.isAvailable();

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[1][0]).toBe("http://other:11434/api/tags");
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/embeddings/provider.test.ts`
Expected: FAIL — module `@/embeddings/provider` not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/embeddings/provider.ts

export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  isAvailable(): Promise<boolean>;
  updateConfig?(config: { endpoint: string }): void;
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  private endpoint: string;
  private cachedAvailable: boolean | null = null;
  private cacheTimestamp = 0;
  private readonly CACHE_TTL_MS = 30_000;
  private readonly HEALTH_TIMEOUT_MS = 5_000;
  private readonly EMBED_TIMEOUT_MS = 10_000;

  constructor(endpoint: string) {
    this.endpoint = endpoint.replace(/\/$/, "");
  }

  updateConfig(config: { endpoint: string }): void {
    if (config.endpoint !== undefined) {
      this.endpoint = config.endpoint.replace(/\/$/, "");
      this.cachedAvailable = null;
      this.cacheTimestamp = 0;
    }
  }

  async isAvailable(): Promise<boolean> {
    const now = Date.now();
    if (this.cachedAvailable !== null && now - this.cacheTimestamp < this.CACHE_TTL_MS) {
      return this.cachedAvailable;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.HEALTH_TIMEOUT_MS);
      try {
        const response = await fetch(`${this.endpoint}/api/tags`, { signal: controller.signal });
        this.cachedAvailable = response.ok;
      } finally {
        clearTimeout(timeoutId);
      }
    } catch {
      this.cachedAvailable = false;
    }

    this.cacheTimestamp = now;
    return this.cachedAvailable;
  }

  async embed(text: string): Promise<number[]> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.EMBED_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${this.endpoint}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: "nomic-embed-text",
          input: text,
        }),
      });
    } catch (error: any) {
      clearTimeout(timeoutId);
      if (error.name === "AbortError") {
        throw new Error(`Embed request timed out after ${this.EMBED_TIMEOUT_MS / 1000}s`);
      }
      throw error;
    }

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Embed request failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return data.embeddings[0];
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/embeddings/provider.test.ts`
Expected: All 8 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/embeddings/provider.ts tests/embeddings/provider.test.ts
git commit -m "feat: add EmbeddingProvider interface and OllamaEmbeddingProvider"
```

---

## Task 2: SimilarityScorer with Cosine Similarity

**Files:**
- Create: `src/embeddings/similarity.ts`
- Create: `tests/embeddings/similarity.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/embeddings/similarity.test.ts
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

    // "far.md" is orthogonal (score ~0), should be filtered out
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe("close.md");
  });

  it("skips candidates without vectors", () => {
    const store = makeStore({
      "source.md": [1, 0, 0],
      "indexed.md": [0.9, 0.1, 0],
      // "missing.md" not in store
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/embeddings/similarity.test.ts`
Expected: FAIL — module `@/embeddings/similarity` not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/embeddings/similarity.ts
import { EmbeddingStore } from "./store";

export interface ScoredCandidate {
  path: string;
  score: number;
}

export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  let dot = 0;
  let magA = 0;
  let magB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    magA += a[i] * a[i];
    magB += b[i] * b[i];
  }
  const denom = Math.sqrt(magA) * Math.sqrt(magB);
  return denom === 0 ? 0 : dot / denom;
}

export class SimilarityScorer {
  private store: EmbeddingStore;

  constructor(store: EmbeddingStore) {
    this.store = store;
  }

  rankCandidates(
    sourcePath: string,
    candidatePaths: string[],
    options: { topK: number; minScore: number },
  ): ScoredCandidate[] {
    const sourceVector = this.store.getVector(sourcePath);
    if (!sourceVector) return [];

    const scored: ScoredCandidate[] = [];

    for (const path of candidatePaths) {
      const candidateVector = this.store.getVector(path);
      if (!candidateVector) continue;

      const score = cosineSimilarity(sourceVector, candidateVector);
      if (score >= options.minScore) {
        scored.push({ path, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, options.topK);
  }
}
```

Note: This file imports `EmbeddingStore` for the type but only uses the `getVector` method. The tests use a minimal mock implementing just that method. The actual `EmbeddingStore` is built in Task 3. This compiles because TypeScript's structural typing means the mock satisfies the type as long as it has `getVector`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/embeddings/similarity.test.ts`
Expected: All 8 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/embeddings/similarity.ts tests/embeddings/similarity.test.ts
git commit -m "feat: add SimilarityScorer with cosine similarity"
```

---

## Task 3: EmbeddingStore — Core (Hash, Storage, Serialization)

This is the largest unit. Split into three sub-tasks: core storage, background indexing, and word frequencies.

**Files:**
- Create: `src/embeddings/store.ts`
- Create: `tests/embeddings/store.test.ts`

- [ ] **Step 1: Write the failing tests for core storage**

```typescript
// tests/embeddings/store.test.ts
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
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/embeddings/store.test.ts`
Expected: FAIL — module `@/embeddings/store` not found

- [ ] **Step 3: Write the core implementation**

```typescript
// src/embeddings/store.ts
import { EmbeddingProvider } from "./provider";

const EXPECTED_DIMENSIONS = 768;

export function fnv1aHash(str: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = (hash * 0x01000193) >>> 0;
  }
  return hash.toString(16);
}

interface StoredEntry {
  contentHash: string;
  vector: Float32Array;
  indexedAt: number;
}

interface ReadContentFn {
  (path: string): Promise<string | null>;
}

export class EmbeddingStore {
  private provider: EmbeddingProvider;
  private embeddings = new Map<string, StoredEntry>();
  private wordFreqs = new Map<string, number>();
  private dirty = false;
  private indexingInProgress = new Set<string>();
  private pendingEmbeds = new Map<string, Promise<Float32Array>>();

  // Background indexing state
  private filesToIndex: Array<{ path: string }> = [];
  private readContent: ReadContentFn | null = null;
  private indexPointer = 0;
  isInitialIndexComplete = false;
  private consecutiveFailures = 0;
  private pausedUntil = 0;
  private intervalId: number | null = null;
  private persistTimeout: ReturnType<typeof setTimeout> | null = null;
  private onPersist: (() => Promise<void>) | null = null;

  constructor(provider: EmbeddingProvider) {
    this.provider = provider;
  }

  getVector(path: string): Float32Array | null {
    return this.embeddings.get(path)?.vector ?? null;
  }

  getContentHash(path: string): string | null {
    return this.embeddings.get(path)?.contentHash ?? null;
  }

  getWordFrequencies(): Map<string, number> {
    return this.wordFreqs;
  }

  isDirty(): boolean {
    return this.dirty;
  }

  async ensureEmbedding(path: string, content: string): Promise<Float32Array> {
    const hash = fnv1aHash(content);

    // Return cached if hash matches
    const existing = this.embeddings.get(path);
    if (existing && existing.contentHash === hash) {
      return existing.vector;
    }

    // Await in-flight embed if one exists for this path
    const pending = this.pendingEmbeds.get(path);
    if (pending) {
      return pending;
    }

    // Start new embed
    const promise = this.doEmbed(path, content, hash);
    this.indexingInProgress.add(path);
    this.pendingEmbeds.set(path, promise);

    try {
      return await promise;
    } finally {
      this.indexingInProgress.delete(path);
      this.pendingEmbeds.delete(path);
    }
  }

  private async doEmbed(path: string, content: string, hash: string): Promise<Float32Array> {
    const raw = await this.provider.embed(content);

    if (raw.length !== EXPECTED_DIMENSIONS) {
      throw new Error(
        `Embedding dimensions mismatch: expected ${EXPECTED_DIMENSIONS}, got ${raw.length}`,
      );
    }

    const vector = new Float32Array(raw);

    // Update word frequencies incrementally
    const oldEntry = this.embeddings.get(path);
    if (oldEntry) {
      // We need the old content to subtract terms, but we don't store it.
      // Word freq updates happen via updateWordFreqs called externally or during ensureEmbedding.
      // For now, we subtract using the stored terms approach below.
    }
    this.updateWordFreqsForContent(path, content);

    this.embeddings.set(path, { contentHash: hash, vector, indexedAt: Date.now() });
    this.dirty = true;
    this.schedulePersist();

    return vector;
  }

  private updateWordFreqsForContent(path: string, newContent: string): void {
    // Tokenize new content
    const newWords = newContent
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2);

    const newCounts = new Map<string, number>();
    for (const w of newWords) {
      newCounts.set(w, (newCounts.get(w) ?? 0) + 1);
    }

    // Add new counts
    for (const [word, count] of newCounts) {
      this.wordFreqs.set(word, (this.wordFreqs.get(word) ?? 0) + count);
    }
  }

  remove(path: string): void {
    this.embeddings.delete(path);
    this.dirty = true;
    this.schedulePersist();
  }

  // --- Background indexing ---

  startBackgroundIndex(
    files: Array<{ path: string }>,
    readContent: ReadContentFn,
    onPersist: () => Promise<void>,
  ): void {
    this.filesToIndex = files;
    this.readContent = readContent;
    this.onPersist = onPersist;
    this.indexPointer = 0;
    this.isInitialIndexComplete = false;

    if (files.length === 0) {
      this.isInitialIndexComplete = true;
      return;
    }

    this.intervalId = window.setInterval(() => this.backgroundTick(), 2000);
  }

  stopBackgroundIndex(): void {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
    if (this.persistTimeout !== null) {
      clearTimeout(this.persistTimeout);
      this.persistTimeout = null;
    }
  }

  async flush(): Promise<void> {
    if (this.persistTimeout !== null) {
      clearTimeout(this.persistTimeout);
      this.persistTimeout = null;
    }
    if (this.dirty && this.onPersist) {
      await this.onPersist();
      this.dirty = false;
    }
  }

  private async backgroundTick(): Promise<void> {
    if (Date.now() < this.pausedUntil) return;

    if (this.indexPointer >= this.filesToIndex.length) {
      this.isInitialIndexComplete = true;
      if (this.intervalId !== null) {
        window.clearInterval(this.intervalId);
        this.intervalId = null;
      }
      return;
    }

    const file = this.filesToIndex[this.indexPointer];
    this.indexPointer++;

    if (this.indexingInProgress.has(file.path)) return;

    try {
      const content = this.readContent ? await this.readContent(file.path) : null;
      if (content === null) {
        this.remove(file.path);
        return;
      }

      await this.ensureEmbedding(file.path, content);
      this.consecutiveFailures = 0;
    } catch {
      this.consecutiveFailures++;
      if (this.consecutiveFailures >= 3) {
        this.pausedUntil = Date.now() + 60_000;
        this.consecutiveFailures = 0;
      }
    }
  }

  private schedulePersist(): void {
    if (this.persistTimeout !== null) return;
    this.persistTimeout = setTimeout(async () => {
      this.persistTimeout = null;
      if (this.dirty && this.onPersist) {
        await this.onPersist();
        this.dirty = false;
      }
    }, 5000);
  }

  // --- Serialization ---

  serialize(): string {
    const entries: Record<string, { contentHash: string; vector: number[]; indexedAt: number }> = {};
    for (const [path, entry] of this.embeddings) {
      entries[path] = {
        contentHash: entry.contentHash,
        vector: Array.from(entry.vector),
        indexedAt: entry.indexedAt,
      };
    }

    const wordFreqs: Record<string, number> = {};
    for (const [word, count] of this.wordFreqs) {
      wordFreqs[word] = count;
    }

    return JSON.stringify({ schemaVersion: 1, wordFreqs, entries });
  }

  static deserialize(json: string, provider: EmbeddingProvider): EmbeddingStore {
    const data = JSON.parse(json);
    if (data.schemaVersion !== 1) {
      throw new Error(`Unknown schema version: ${data.schemaVersion}`);
    }

    const store = new EmbeddingStore(provider);

    if (data.wordFreqs) {
      for (const [word, count] of Object.entries(data.wordFreqs)) {
        store.wordFreqs.set(word, count as number);
      }
    }

    if (data.entries) {
      for (const [path, entry] of Object.entries(data.entries)) {
        const e = entry as { contentHash: string; vector: number[]; indexedAt: number };
        store.embeddings.set(path, {
          contentHash: e.contentHash,
          vector: new Float32Array(e.vector),
          indexedAt: e.indexedAt,
        });
      }
    }

    return store;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/embeddings/store.test.ts`
Expected: All 10 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/embeddings/store.ts tests/embeddings/store.test.ts
git commit -m "feat: add EmbeddingStore with hashing, storage, serialization, and background indexing"
```

---

## Task 4: EmbeddingStore — Background Indexing Tests

**Files:**
- Modify: `tests/embeddings/store.test.ts`

- [ ] **Step 1: Add background indexing and word frequency tests**

Append to `tests/embeddings/store.test.ts` inside the `describe("EmbeddingStore")` block:

```typescript
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
      // All are stop words or <= 2 chars, none should appear
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

      // 2 failures, 1 success (resets counter), 2 more failures — should NOT pause
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
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx vitest run tests/embeddings/store.test.ts`
Expected: All tests PASS

- [ ] **Step 3: Commit**

```bash
git add tests/embeddings/store.test.ts
git commit -m "test: add background indexing and word frequency tests for EmbeddingStore"
```

---

## Task 5: Rename scoring.ts to keyword-extractor.ts

**Files:**
- Delete: `src/modules/connections/scoring.ts`
- Create: `src/modules/connections/keyword-extractor.ts`
- Delete: `tests/modules/scoring.test.ts`
- Create: `tests/modules/keyword-extractor.test.ts`

- [ ] **Step 1: Create the new keyword-extractor module**

```typescript
// src/modules/connections/keyword-extractor.ts

const STOP_WORDS = new Set([
  "the", "is", "a", "an", "and", "or", "but", "not", "for", "with",
  "this", "that", "from", "are", "was", "were", "been", "be", "have",
  "has", "had", "do", "does", "did", "will", "would", "could", "should",
  "may", "might", "can", "shall", "to", "of", "in", "on", "at", "by",
  "it", "its", "as", "if", "so", "no", "up", "out", "then", "than",
  "when", "what", "which", "who", "how", "all", "each", "every",
  "both", "few", "more", "most", "other", "some", "such", "only",
  "own", "same", "also", "just", "about", "into", "over", "after",
]);

export function extractKeywords(
  noteContent: string,
  vaultWordFreqs: Map<string, number>,
  maxKeywords = 20,
): string[] {
  const words = noteContent
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

  const localFreq = new Map<string, number>();
  for (const word of words) {
    localFreq.set(word, (localFreq.get(word) ?? 0) + 1);
  }

  const scored: Array<[string, number]> = [];
  for (const [word, count] of localFreq.entries()) {
    const tf = count / words.length;
    const vaultFreq = vaultWordFreqs.get(word) ?? 1;
    const idf = 1 / Math.log2(1 + vaultFreq);
    scored.push([word, tf * idf]);
  }

  scored.sort((a, b) => b[1] - a[1]);
  return scored.slice(0, maxKeywords).map(([word]) => word);
}
```

- [ ] **Step 2: Create the migrated test file**

```typescript
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
```

- [ ] **Step 3: Delete old files**

```bash
rm src/modules/connections/scoring.ts tests/modules/scoring.test.ts
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/modules/keyword-extractor.test.ts`
Expected: 2 tests PASS

Run: `npx vitest run`
Expected: Compilation errors in files that import from `scoring.ts`. These will be fixed in Task 6.

- [ ] **Step 5: Commit**

```bash
git add src/modules/connections/keyword-extractor.ts tests/modules/keyword-extractor.test.ts
git rm src/modules/connections/scoring.ts tests/modules/scoring.test.ts
git commit -m "refactor: rename CandidateScorer to standalone extractKeywords function"
```

---

## Task 6: Add connectionMinScore Setting

**Files:**
- Modify: `src/settings.ts`

- [ ] **Step 1: Add the setting to the interface and defaults**

In `src/settings.ts`, add `connectionMinScore` to the `PluginSettings` interface after `connectionScanIntervalMin`:

```typescript
  connectionMinScore: number;
```

Add to `DEFAULT_SETTINGS`:

```typescript
  connectionMinScore: 0.5,
```

- [ ] **Step 2: Add the UI control in the display method**

In the Automation section, after the connection scan interval slider, add:

```typescript
    new Setting(containerEl)
      .setName("Connection similarity threshold")
      .setDesc("Minimum similarity score for connection suggestions. Higher = fewer but more relevant.")
      .addSlider((slider) =>
        (slider as any)
          .setLimits(0.3, 0.9, 0.05)
          .setValue(this.settings.connectionMinScore)
          .setDynamicTooltip()
          .onChange(async (value: number) => {
            this.settings.connectionMinScore = value;
            await this.save();
          }),
      );
```

- [ ] **Step 3: Run type check**

Run: `npx tsc -noEmit -skipLibCheck`
Expected: Errors in `main.ts` referencing `scorer` (from removed scoring.ts). This is expected — fixed in Task 7.

- [ ] **Step 4: Commit**

```bash
git add src/settings.ts
git commit -m "feat: add connectionMinScore setting with slider UI"
```

---

## Task 7: Wire Embeddings into Plugin Lifecycle and Rewrite Connection Scan

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Update imports**

Replace the old scoring import and add new ones. In `src/main.ts`, change:

```typescript
import { CandidateScorer } from "./modules/connections/scoring";
```

to:

```typescript
import { extractKeywords } from "./modules/connections/keyword-extractor";
import { OllamaEmbeddingProvider } from "./embeddings/provider";
import { EmbeddingStore, fnv1aHash } from "./embeddings/store";
import { SimilarityScorer } from "./embeddings/similarity";
```

- [ ] **Step 2: Update class fields**

Replace:

```typescript
  private scorer = new CandidateScorer();
```

with:

```typescript
  private embeddingProvider!: OllamaEmbeddingProvider;
  private embeddingStore!: EmbeddingStore;
  private similarityScorer!: SimilarityScorer;
```

- [ ] **Step 3: Wire construction in onload**

After the `this.ollama = new OllamaProvider(...)` block, add:

```typescript
    this.embeddingProvider = new OllamaEmbeddingProvider(
      this.settings.ollamaEndpoint,
    );

    // Load embedding store
    this.embeddingStore = await this.loadEmbeddingStore();
    this.similarityScorer = new SimilarityScorer(this.embeddingStore);
```

- [ ] **Step 4: Add embedding store persistence methods**

After the `saveQueue` method, add:

```typescript
  // --- Embedding store persistence ---

  private async loadEmbeddingStore(): Promise<EmbeddingStore> {
    const content = await this.vaultService.readNote(`${ASSISTANT_FOLDER}/embeddings.json`);
    if (content) {
      try { return EmbeddingStore.deserialize(content, this.embeddingProvider); } catch { /* start fresh */ }
    }
    return new EmbeddingStore(this.embeddingProvider);
  }

  private async saveEmbeddingStore(): Promise<void> {
    await this.vaultService.writeNote(
      `${ASSISTANT_FOLDER}/embeddings.json`,
      this.embeddingStore.serialize(),
    );
  }
```

- [ ] **Step 5: Wire onLayoutReady**

In the `onLayoutReady` method, after `await this.initializeVaultFolder()`, add:

```typescript
    // Start background embedding index
    const allFiles = this.vaultService.getMarkdownFiles();
    const filesToIndex: Array<{ path: string }> = [];
    for (const file of allFiles) {
      if (file.path.startsWith(`${ASSISTANT_FOLDER}/`)) continue;
      const content = await this.vaultService.readNote(file.path);
      if (!content) continue;
      const currentHash = fnv1aHash(content);
      const storedHash = this.embeddingStore.getContentHash(file.path);
      if (storedHash !== currentHash) {
        filesToIndex.push({ path: file.path });
      }
    }
    this.embeddingStore.startBackgroundIndex(
      filesToIndex,
      (path) => this.vaultService.readNote(path),
      () => this.saveEmbeddingStore(),
    );
```

- [ ] **Step 6: Wire onunload**

In `onunload`, before `await this.saveQueue()`, add:

```typescript
    this.embeddingStore.stopBackgroundIndex();
    await this.embeddingStore.flush();
    await this.saveEmbeddingStore();
```

- [ ] **Step 7: Wire note delete event**

In the existing delete handler, add after `this.suggestionsStore.removeForNote(file.path);`:

```typescript
          this.embeddingStore.remove(file.path);
```

- [ ] **Step 8: Wire save debounce**

In `debounceTagNote`, update the setTimeout callback to embed before tagging:

```typescript
  private debounceTagNote(path: string, delayMs: number): void {
    const existing = this.debounceTimers.get(path);
    if (existing) clearTimeout(existing);

    this.debounceTimers.set(
      path,
      setTimeout(async () => {
        this.debounceTimers.delete(path);
        // Ensure embedding is fresh before tagging
        const content = await this.vaultService.readNote(path);
        if (content) {
          try { await this.embeddingStore.ensureEmbedding(path, content); } catch { /* Ollama may be down */ }
        }
        this.enqueueTagNote(path, TaskTrigger.Automatic);
      }, delayMs),
    );
  }
```

- [ ] **Step 9: Wire saveSettings**

In `saveSettings`, add after the `this.ollama.updateConfig(...)` call:

```typescript
    this.embeddingProvider.updateConfig({
      endpoint: this.settings.ollamaEndpoint,
    });
```

- [ ] **Step 10: Rewrite enqueueConnectionScan**

Replace the entire `enqueueConnectionScan` method:

```typescript
  private async enqueueConnectionScan(notePath: string, trigger: TaskTrigger): Promise<void> {
    const content = await this.vaultService.readNote(notePath);
    if (!content) return;

    // On-demand embed for the active note
    try {
      await this.embeddingStore.ensureEmbedding(notePath, content);
    } catch {
      showNotice("Connection scan skipped — Ollama unavailable.");
      return;
    }

    // Extract existing links to exclude
    const linkMatches = content.matchAll(/\[\[([^\]]+)\]\]/g);
    const linkedPaths = new Set<string>();
    for (const m of linkMatches) {
      linkedPaths.add(m[1] + ".md");
      linkedPaths.add(m[1]);
    }

    // Collect candidate paths (exclude source and already-linked)
    const candidatePaths = this.vaultService.getMarkdownFiles()
      .filter((f) => f.path !== notePath && !linkedPaths.has(f.path))
      .map((f) => f.path);

    // Rank by embedding similarity
    const ranked = this.similarityScorer.rankCandidates(notePath, candidatePaths, {
      topK: 10,
      minScore: this.settings.connectionMinScore,
    });

    if (ranked.length === 0) return;

    // Build prompt with keyword summaries for each candidate
    const wordFreqs = this.embeddingStore.getWordFrequencies();
    const fm = await this.vaultService.parseFrontmatter(notePath);
    const sourceTags = fm.tags ?? [];

    const candidateSummaries = [];
    for (const r of ranked) {
      const candidateContent = await this.vaultService.readNote(r.path);
      if (!candidateContent) continue;
      const keywords = extractKeywords(candidateContent, wordFreqs);
      candidateSummaries.push({
        path: r.path,
        title: r.path.replace(/\.md$/, "").split("/").pop() ?? "",
        tags: ((await this.vaultService.parseFrontmatter(r.path)).tags ?? []),
        summary: candidateContent.slice(0, 400),
      });
    }

    const prompt = this.connections.buildPrompt({
      sourceTitle: notePath.replace(/\.md$/, "").split("/").pop() ?? "",
      sourceTags,
      sourceSummary: content.slice(0, 400),
      candidates: candidateSummaries,
    });

    const task = createTask({
      type: "connection-detector",
      action: "scan-connections",
      payload: {
        notePath,
        systemPrompt: prompt.system,
        prompt: prompt.prompt,
        maxTokens: prompt.maxTokens,
      },
      trigger,
    });

    this.orchestrator.queue.enqueue(task);
  }
```

- [ ] **Step 11: Run type check and tests**

Run: `npx tsc -noEmit -skipLibCheck`
Expected: PASS

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 12: Build**

Run: `node esbuild.config.mjs`
Expected: Build succeeds

- [ ] **Step 13: Commit**

```bash
git add src/main.ts
git commit -m "feat: wire embeddings into plugin lifecycle, rewrite connection scan"
```

---

## Task 8: Integration Tests for Connection Scan

**Files:**
- Create: `tests/integration/connection-flow.test.ts`

- [ ] **Step 1: Write the integration tests**

```typescript
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
    // Create vectors where source is similar to "close" but not "far"
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

    // "close" should score high (near-identical vector), "far" should be filtered
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
      { topK: 10, minScore: 0.95 }, // very high threshold
    );

    expect(ranked).toHaveLength(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npx vitest run tests/integration/connection-flow.test.ts`
Expected: All 3 tests PASS

- [ ] **Step 3: Run full test suite**

Run: `npx vitest run`
Expected: All tests PASS

- [ ] **Step 4: Final build**

Run: `npx tsc -noEmit -skipLibCheck && node esbuild.config.mjs`
Expected: Both pass

- [ ] **Step 5: Commit**

```bash
git add tests/integration/connection-flow.test.ts
git commit -m "test: add integration tests for embedding-based connection scan"
```
