# Embedding-Based Similarity for Connection Detection — Design Spec

## Overview

Replace TF-IDF keyword overlap with embedding-based cosine similarity for connection detection. Notes are embedded via Ollama's nomic-embed-text model, stored locally as JSON, and scored by vector similarity. This captures semantic relationships that lexical overlap misses — synonyms, related concepts, thematic similarity — which matters for personal knowledge bases where exact vocabulary repetition is rare.

## Goals

- Semantic connection detection via embedding cosine similarity
- Incremental indexing: only embed notes when their content changes
- Dynamic threshold: top-k with configurable minimum floor (default 0.5) replaces fixed 0.15 composite score
- Eliminate the O(n^2) vault-wide cache rebuild on every connection scan
- Clean removal of TF-IDF scoring; retain keyword extraction for prompt building

## Architecture

Three new units, one renamed module, one modified flow:

| Unit | Responsibility |
|------|----------------|
| `src/embeddings/provider.ts` | `EmbeddingProvider` interface + `OllamaEmbeddingProvider` hitting `/api/embed` |
| `src/embeddings/store.ts` | `EmbeddingStore` — in-memory index, persistence to JSON, background indexing loop, word frequency cache |
| `src/embeddings/similarity.ts` | `SimilarityScorer` — cosine similarity between note pairs, top-k filtering |
| `src/modules/connections/scoring.ts` | Renamed to `KeywordExtractor`. Only `extractKeywords` retained; all scoring logic removed. |
| `src/main.ts` | `enqueueConnectionScan` rewritten to use embedding-based flow |

Dependency direction: `SimilarityScorer` depends on `EmbeddingStore`, `EmbeddingStore` depends on `EmbeddingProvider`. Nothing depends on `SimilarityScorer` except the connection scan flow in `main.ts`.

## Unit 1: EmbeddingProvider (`src/embeddings/provider.ts`)

### Interface

```typescript
interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  isAvailable(): Promise<boolean>;
}
```

### OllamaEmbeddingProvider

- Endpoint: `POST {ollamaEndpoint}/api/embed` with `{ model: "nomic-embed-text", input: text }`
- Returns the embedding vector from the response
- Shares `ollamaEndpoint` from plugin settings (same base URL as generation provider)
- Model is hardcoded to `nomic-embed-text` — the 768-dimensional vector size is baked into the store format and similarity math. Changing the model invalidates the entire index. This is not a configurable setting.
- Availability cache: same 30s TTL pattern as `OllamaProvider`. Separate cache instance (embedding model availability is independent of generation model).
- Timeouts via AbortController: 5s for availability checks, 10s for embed requests (embedding is much faster than generation).
- `updateConfig(config: { endpoint: string })` method for hot-reloading settings, matching the `OllamaProvider` pattern.

## Unit 2: EmbeddingStore (`src/embeddings/store.ts`)

### State

- `embeddings: Map<string, { contentHash: string, vector: Float32Array }>` — the index
- `wordFreqs: Map<string, number>` — cached vault-wide word frequencies for keyword extraction
- `fileHashes: Map<string, string>` — content hashes of all indexed files
- `dirty: boolean` — whether the JSON file needs a write
- `indexingInProgress: Set<string>` — paths currently being embedded (prevents concurrent embed of same note)
- `pendingEmbeds: Map<string, Promise<Float32Array>>` — promises for in-flight embeds so concurrent callers can await the same operation
- `isInitialIndexComplete: boolean` — flips to true once the catch-up pass finishes
- `consecutiveFailures: number` — tracks background indexing failures; resets to 0 on any successful embed
- `pausedUntil: number` — timestamp; background loop skips work until this time expires
- `intervalId: number | null` — stored so the interval can be cleared when initial indexing completes

### Content Hashing

FNV-1a hash over the note content string. Fast, no dependencies, collision-resistant enough for change detection. Returns a hex string.

### Public Methods

- `getVector(path: string): Float32Array | null` — read path for the similarity scorer. Returns the cached vector or null if the note hasn't been indexed.
- `ensureEmbedding(path: string, content: string): Promise<Float32Array>` — on-demand embed for the active note during connection scans.
  1. Compute content hash. If hash matches stored entry, return existing vector.
  2. If path is in `indexingInProgress`, await the existing promise from `pendingEmbeds` and return its result.
  3. Otherwise: add to `indexingInProgress`, create a promise that calls `provider.embed(content)`, store in `pendingEmbeds`. On resolution: validate vector dimensions (`vector.length !== 768` → discard and throw), store the vector + hash, update word frequencies incrementally, remove from `indexingInProgress` and `pendingEmbeds`, mark dirty. The promise resolves with the `Float32Array`.
- `getWordFrequencies(): Map<string, number>` — returns the cached word frequency map for `extractKeywords`.
- `remove(path: string): void` — called on note delete. Removes the embedding entry, marks dirty. Does not subtract word frequencies (see Known Limitations — word frequency drift).
- `serialize(): string` — JSON string for persistence.
- `static deserialize(json: string, provider: EmbeddingProvider): EmbeddingStore` — restores from JSON. Converts plain number arrays to `Float32Array`.
- `startBackgroundIndex(files: Array<{ path: string }>): void` — called after layout ready. Kicks off the background loop. Content is read lazily on each tick when the note is actually processed, not upfront — reading all content during `onLayoutReady` would defeat the O(n^2) improvement.
- `stopBackgroundIndex(): void` — clears the interval. Called on plugin unload.
- `flush(): Promise<void>` — forces an immediate persist. Called on plugin unload.

### Background Indexing Loop

Registered via `registerInterval` at 2-second intervals during initial catch-up.

On each tick:
1. If `Date.now() < pausedUntil`, skip.
2. If no un-indexed or stale files remain, set `isInitialIndexComplete = true`, clear the interval via `window.clearInterval(intervalId)`, return.
3. Pick the next file needing indexing (not in `indexingInProgress`).
4. Call `ensureEmbedding(path, content)`.
5. On success: reset `consecutiveFailures` to 0.
6. On failure: increment `consecutiveFailures`. If >= 3, set `pausedUntil = Date.now() + 60_000`, reset `consecutiveFailures` to 0.
7. If dirty, debounced persist (5s after last dirty mark).

### Persistence Format

```json
{
  "schemaVersion": 1,
  "wordFreqs": { "transformer": 42, "attention": 31 },
  "entries": {
    "path/to/note.md": {
      "contentHash": "a1b2c3d4",
      "vector": [0.123, -0.456, 0.789],
      "indexedAt": 1712345678000
    }
  }
}
```

On load, `vector` arrays are converted to `Float32Array` for the in-memory map. On save, converted back to plain number arrays for JSON serialization.

### Word Frequency Cache

Built as a side effect during indexing. When a note is embedded (or re-embedded):
1. If the note was previously indexed, subtract its old term counts from `wordFreqs`.
2. Tokenize the new content, count terms.
3. Add new term counts to `wordFreqs`.

Persisted alongside embeddings in the JSON file. Available immediately on restart without waiting for the catch-up pass.

### Startup Behavior

1. Load `embeddings.json` — restores embeddings, fileHashes, and wordFreqs.
2. Compare stored `fileHashes` against current vault files' content hashes.
3. Files with mismatched hashes or missing entries are queued for the background pass.
4. Files in the store but not in the vault are removed (note was deleted while plugin was unloaded).

## Unit 3: SimilarityScorer (`src/embeddings/similarity.ts`)

### Interface

```typescript
interface ScoredCandidate {
  path: string;
  score: number;
}

class SimilarityScorer {
  constructor(private store: EmbeddingStore) {}

  rankCandidates(
    sourcePath: string,
    candidatePaths: string[],
    options: { topK: number; minScore: number },
  ): ScoredCandidate[];
}
```

Note: `rankCandidates` is synchronous. All vectors are already in memory. No async needed.

### Flow

1. `store.getVector(sourcePath)` — must exist (caller ensures via `ensureEmbedding` before calling).
2. For each candidate path, `store.getVector(path)` — skip if null (not yet indexed).
3. Cosine similarity: `dot(a, b) / (magnitude(a) * magnitude(b))`.
4. Collect scored pairs, sort descending by score.
5. Take top `topK`, drop any below `minScore`.
6. Return the ranked list.

### Cosine Similarity

Pure function, three loops over `Float32Array`:
- Dot product: `sum(a[i] * b[i])`
- Magnitude A: `sqrt(sum(a[i]^2))`
- Magnitude B: `sqrt(sum(b[i]^2))`
- Result: `dot / (magA * magB)`

For 768 dimensions across 5k candidates, this is sub-millisecond.

## Connection Scan Flow (modified `enqueueConnectionScan` in `main.ts`)

The current implementation builds a vault-wide content cache and word frequency map on every invocation, then uses TF-IDF composite scoring. This is replaced entirely:

1. Read source note content and parse existing `[[links]]` from it.
2. `await embeddingStore.ensureEmbedding(notePath, content)` — on-demand embed for the active note.
3. Collect candidate paths: all markdown files except the source note and already-linked notes.
4. `similarityScorer.rankCandidates(notePath, candidatePaths, { topK: 10, minScore: settings.connectionMinScore })`
5. If no candidates pass the filter, return early.
6. For each ranked candidate, build a summary for the LLM prompt:
   - `wordFreqs = embeddingStore.getWordFrequencies()`
   - `content = await vaultService.readNote(candidate.path)`
   - `keywords = extractKeywords(content, wordFreqs)`
   - First ~400 chars of content as summary
7. Build LLM prompt via `connections.buildPrompt` (unchanged).
8. Enqueue the task.

This eliminates the O(n^2) vault cache loop. Content is only read for the ~10 candidates that pass the similarity filter.

## Changes to scoring.ts

Rename `CandidateScorer` to `KeywordExtractor`. Remove:
- `scoreCandidate`
- `rankCandidates`
- `setOverlap` (private)
- `NoteProfile` interface
- `ScoredCandidate` interface (replaced by the one in `similarity.ts`)
- `RankingConfig` interface
- `WEIGHTS` constant

Retain:
- `extractKeywords(noteContent: string, vaultWordFreqs: Map<string, number>, maxKeywords?: number): string[]`
- `STOP_WORDS`

`extractKeywords` can become a standalone exported function rather than a class method, since there's no state. The class wrapper adds nothing.

## Settings

Add to `PluginSettings` interface and settings UI:

| Setting | Type | Default | Location in UI |
|---------|------|---------|----------------|
| `connectionMinScore` | slider (0.3–0.9, step 0.05) | 0.5 | Automation section, below connection scan interval |

Description: "Minimum similarity score for connection suggestions. Higher values mean fewer but more relevant suggestions."

## Plugin Lifecycle Integration

### onload

- Construct `OllamaEmbeddingProvider` (shares `ollamaEndpoint` from settings)
- Load `EmbeddingStore` from `AI-Assistant/embeddings.json` (same try/catch/start-fresh pattern as other stores)
- Construct `SimilarityScorer` with the store
- Wire `saveSettings` to call `embeddingProvider.updateConfig()` for hot-reload

### onLayoutReady

- Compute content hashes for all vault markdown files
- Compare against stored hashes to identify stale/missing entries
- Call `embeddingStore.startBackgroundIndex(filesToIndex)`

### onunload

- `embeddingStore.stopBackgroundIndex()`
- `await embeddingStore.flush()`

### Note save event

- `ensureEmbedding` is called as part of the existing save debounce handler (the `modify` event listener that triggers `debounceTagNote`), not via a second listener. The embedding and tagging share the same debounce timer keyed by path (~5s). When the debounce fires, it calls `ensureEmbedding` before enqueuing the tag task — this means the embedding is fresh when the next connection scan runs.

### Note delete event

- `embeddingStore.remove(path)` (alongside existing suggestion cleanup)

## Error Handling

| Scenario | Behavior |
|----------|----------|
| **Ollama unavailable during background indexing** | Skip the note, increment `consecutiveFailures`. After 3 consecutive failures, pause loop for 60s. Counter resets to 0 on any successful embed. |
| **Ollama unavailable during on-demand embed** | `ensureEmbedding` throws. Connection scanner catches it, skips the scan. User sees "Connection scan skipped — Ollama unavailable." |
| **Embed returns wrong dimensions** | `vector.length !== 768` — discard the vector, do not store, log warning. Treat as a failure for retry purposes. |
| **embeddings.json corrupt or wrong schema** | Start fresh — empty index, full re-index on next background pass. Same pattern as queue.json. |
| **Note deleted while background index is processing it** | `readNote` returns null, skip, remove any existing entry from the store. |
| **Debounced write fails (vault locked)** | Retry on next debounce cycle. Data is safe in memory. |

## Testing

### EmbeddingProvider tests (`tests/embeddings/provider.test.ts`)

| Test | Verifies |
|------|----------|
| Correct request format | Sends `{ model: "nomic-embed-text", input: text }` to `/api/embed` |
| Response parsing | Extracts vector from response JSON |
| Timeout handling | AbortController fires at 10s, throws clean error |
| Availability caching | 30s TTL, invalidated on error |

### EmbeddingStore tests (`tests/embeddings/store.test.ts`)

| Test | Verifies |
|------|----------|
| Content hash invalidation | Changed content triggers re-embed |
| Skip unchanged notes | Same hash returns cached vector without calling provider |
| Concurrent embed prevention | Two `ensureEmbedding` calls for same path — provider called once, both resolve with same vector |
| Word frequency incremental update | Save note → frequencies increase; delete note → frequencies decrease |
| Serialization round-trip | Write to JSON, deserialize, vectors and wordFreqs match |
| Cleanup on note delete | Entry removed from all maps |
| Background indexing pause after 3 failures | Three consecutive failures trigger 60s pause; success resets counter |
| getVector returns null for unindexed notes | Clean null return, no error |

### SimilarityScorer tests (`tests/embeddings/similarity.test.ts`)

| Test | Verifies |
|------|----------|
| Cosine similarity math | Known vectors produce expected scores |
| topK filtering | Only top N candidates returned |
| minScore filtering | Candidates below threshold excluded |
| Skips unindexed candidates | Missing vectors excluded without error |
| Correct sort order | Highest similarity first |

### KeywordExtractor tests (`tests/modules/keyword-extractor.test.ts`)

Existing `extractKeywords` tests migrated from `scoring.test.ts`. Function signature unchanged, behavior unchanged.

### Integration tests

| Test | Verifies |
|------|----------|
| Connection scan filters by cosine similarity | Mock embedding provider, verify candidates ranked by similarity score and low-scoring candidates excluded |
| Connection scan builds prompt with keyword summaries | Mock embedding provider, verify prompt contains keyword summaries from `extractKeywords` using `getWordFrequencies()` |
| Connection scan early return when no candidates pass filter | All candidates below minScore, verify no LLM task enqueued |

All tests mock the HTTP boundary (embedding provider's fetch calls). All internal logic — store, scorer, keyword extraction — runs against real implementations. Consistent with the project's existing testing philosophy.

## Known Limitations

- **Word frequency drift on re-embed:** When a note is re-embedded after editing, old term counts are not subtracted — only new counts are added. Over time, heavily edited notes accumulate stale frequency entries. Frequencies are rebuilt correctly on a full re-index (startup with a cleared cache). A proper fix would store per-note term counts to enable subtraction, but is not worth the complexity now.
- **Eager content reads on startup hash comparison:** The `onLayoutReady` pass reads every file's content to compute hashes for comparison against stored hashes. For large vaults, comparing against file `mtime` as a first pass (skipping reads for files whose mtime hasn't changed) would be faster. The embeddings JSON would need to store `mtime` alongside `contentHash` to enable this. Not a blocker for personal vaults but worth revisiting if startup time becomes an issue.

## What Is Not In Scope

- Multiple embedding model support — hardcoded to nomic-embed-text
- Approximate nearest neighbor search (HNSW, IVF) — brute-force cosine over <10k vectors is fast enough
- Embedding-based tagging or other features — scoped to connection detection only
- SQLite or external vector DB — JSON file is sufficient for personal vault scale
- Streaming or batched embedding requests — one note at a time is fast enough locally
