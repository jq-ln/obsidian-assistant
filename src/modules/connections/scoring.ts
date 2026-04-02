// src/modules/connections/scoring.ts

export interface NoteProfile {
  path: string;
  tags: string[];
  titleWords: string[];
  keywords: string[];
  folder: string;
  linkedPaths: Set<string>;
}

export interface ScoredCandidate {
  profile: NoteProfile;
  score: number;
}

export interface RankingConfig {
  maxCandidates: number;
  minScore: number;
}

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

const WEIGHTS = {
  tagOverlap: 0.4,
  titleSimilarity: 0.2,
  keywordOverlap: 0.3,
  folderProximity: 0.1,
};

export class CandidateScorer {
  extractKeywords(
    noteContent: string,
    vaultWordFreqs: Map<string, number>,
    maxKeywords = 20,
  ): string[] {
    const words = noteContent
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

    // Count word frequency in this note
    const localFreq = new Map<string, number>();
    for (const word of words) {
      localFreq.set(word, (localFreq.get(word) ?? 0) + 1);
    }

    // TF-IDF-like scoring: high local frequency, low vault frequency
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

  scoreCandidate(source: NoteProfile, candidate: NoteProfile): number {
    // Exclude already-linked notes
    if (source.linkedPaths.has(candidate.path)) return 0;
    if (source.path === candidate.path) return 0;

    const tagScore = this.setOverlap(source.tags, candidate.tags);
    const titleScore = this.setOverlap(source.titleWords, candidate.titleWords);
    const keywordScore = this.setOverlap(source.keywords, candidate.keywords);
    const folderScore = source.folder === candidate.folder && source.folder !== "" ? 1 : 0;

    return (
      WEIGHTS.tagOverlap * tagScore +
      WEIGHTS.titleSimilarity * titleScore +
      WEIGHTS.keywordOverlap * keywordScore +
      WEIGHTS.folderProximity * folderScore
    );
  }

  rankCandidates(
    source: NoteProfile,
    candidates: NoteProfile[],
    config: RankingConfig,
  ): ScoredCandidate[] {
    const scored: ScoredCandidate[] = [];

    for (const candidate of candidates) {
      const score = this.scoreCandidate(source, candidate);
      if (score >= config.minScore) {
        scored.push({ profile: candidate, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, config.maxCandidates);
  }

  /** Jaccard-like overlap: |intersection| / |union|, returns 0 if both empty. */
  private setOverlap(a: string[], b: string[]): number {
    if (a.length === 0 && b.length === 0) return 0;
    const setA = new Set(a.map((s) => s.toLowerCase()));
    const setB = new Set(b.map((s) => s.toLowerCase()));
    let intersection = 0;
    for (const item of setA) {
      if (setB.has(item)) intersection++;
    }
    const union = new Set([...setA, ...setB]).size;
    return union === 0 ? 0 : intersection / union;
  }
}
