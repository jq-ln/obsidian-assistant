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
