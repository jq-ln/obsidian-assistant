// tests/modules/scoring.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { CandidateScorer, NoteProfile } from "@/modules/connections/scoring";

describe("CandidateScorer", () => {
  let scorer: CandidateScorer;

  beforeEach(() => {
    scorer = new CandidateScorer();
  });

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

      const keywords = scorer.extractKeywords(noteContent, vaultWordFreqs);
      // "machine" and "learning" appear often in this note but not across the vault → high TF-IDF
      expect(keywords).toContain("machine");
      expect(keywords).toContain("learning");
    });

    it("filters out stop words", () => {
      const keywords = scorer.extractKeywords(
        "the is a an and or but not for with this that from",
        new Map(),
      );
      expect(keywords).toHaveLength(0);
    });
  });

  describe("scoreCandidate", () => {
    const source: NoteProfile = {
      path: "source.md",
      tags: ["ai", "machine-learning"],
      titleWords: ["neural", "networks"],
      keywords: ["transformer", "attention", "model"],
      folder: "research",
      linkedPaths: new Set(),
    };

    it("scores high for a note with overlapping tags and keywords", () => {
      const candidate: NoteProfile = {
        path: "related.md",
        tags: ["ai", "deep-learning"],
        titleWords: ["deep", "learning"],
        keywords: ["transformer", "bert", "attention"],
        folder: "research",
        linkedPaths: new Set(),
      };

      const score = scorer.scoreCandidate(source, candidate);
      expect(score).toBeGreaterThan(0.3);
    });

    it("scores low for unrelated notes", () => {
      const candidate: NoteProfile = {
        path: "cooking.md",
        tags: ["recipes", "italian"],
        titleWords: ["pasta", "recipe"],
        keywords: ["tomato", "garlic", "olive"],
        folder: "cooking",
        linkedPaths: new Set(),
      };

      const score = scorer.scoreCandidate(source, candidate);
      expect(score).toBeLessThan(0.15);
    });

    it("excludes already-linked notes", () => {
      const sourceWithLink: NoteProfile = {
        ...source,
        linkedPaths: new Set(["already-linked.md"]),
      };

      const candidate: NoteProfile = {
        path: "already-linked.md",
        tags: ["ai"],
        titleWords: ["ai"],
        keywords: ["transformer"],
        folder: "research",
        linkedPaths: new Set(),
      };

      const score = scorer.scoreCandidate(sourceWithLink, candidate);
      expect(score).toBe(0);
    });

    it("gives folder proximity bonus", () => {
      const sameFolder: NoteProfile = {
        path: "other.md",
        tags: [],
        titleWords: [],
        keywords: ["transformer"],
        folder: "research",
        linkedPaths: new Set(),
      };

      const differentFolder: NoteProfile = {
        path: "other2.md",
        tags: [],
        titleWords: [],
        keywords: ["transformer"],
        folder: "notes",
        linkedPaths: new Set(),
      };

      const scoreSame = scorer.scoreCandidate(source, sameFolder);
      const scoreDiff = scorer.scoreCandidate(source, differentFolder);
      expect(scoreSame).toBeGreaterThan(scoreDiff);
    });
  });

  describe("rankCandidates", () => {
    it("returns top N candidates above threshold", () => {
      const source: NoteProfile = {
        path: "source.md",
        tags: ["ai"],
        titleWords: ["ai"],
        keywords: ["transformer"],
        folder: "research",
        linkedPaths: new Set(),
      };

      const candidates: NoteProfile[] = [
        {
          path: "good.md",
          tags: ["ai", "ml"],
          titleWords: ["machine"],
          keywords: ["transformer", "model"],
          folder: "research",
          linkedPaths: new Set(),
        },
        {
          path: "ok.md",
          tags: ["ai"],
          titleWords: ["data"],
          keywords: ["dataset"],
          folder: "other",
          linkedPaths: new Set(),
        },
        {
          path: "bad.md",
          tags: ["cooking"],
          titleWords: ["pasta"],
          keywords: ["tomato"],
          folder: "cooking",
          linkedPaths: new Set(),
        },
      ];

      const ranked = scorer.rankCandidates(source, candidates, {
        maxCandidates: 10,
        minScore: 0.15,
      });

      // "good.md" should rank highest, "bad.md" should be filtered out
      expect(ranked.length).toBeGreaterThanOrEqual(1);
      expect(ranked[0].profile.path).toBe("good.md");
      expect(ranked.every((r) => r.score >= 0.15)).toBe(true);
    });

    it("respects maxCandidates limit", () => {
      const source: NoteProfile = {
        path: "s.md",
        tags: ["ai"],
        titleWords: [],
        keywords: [],
        folder: "",
        linkedPaths: new Set(),
      };

      const candidates = Array.from({ length: 20 }, (_, i) => ({
        path: `note-${i}.md`,
        tags: ["ai"],
        titleWords: [],
        keywords: [],
        folder: "",
        linkedPaths: new Set<string>(),
      }));

      const ranked = scorer.rankCandidates(source, candidates, {
        maxCandidates: 5,
        minScore: 0,
      });

      expect(ranked).toHaveLength(5);
    });
  });
});
