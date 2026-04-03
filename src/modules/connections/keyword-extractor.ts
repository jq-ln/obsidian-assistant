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
