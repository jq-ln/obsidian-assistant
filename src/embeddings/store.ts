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
    this.updateWordFreqsForContent(path, content);

    this.embeddings.set(path, { contentHash: hash, vector, indexedAt: Date.now() });
    this.dirty = true;
    this.schedulePersist();

    return vector;
  }

  private updateWordFreqsForContent(_path: string, newContent: string): void {
    const newWords = newContent
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2);

    const newCounts = new Map<string, number>();
    for (const w of newWords) {
      newCounts.set(w, (newCounts.get(w) ?? 0) + 1);
    }

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
