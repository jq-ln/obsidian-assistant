import { describe, it, expect, beforeEach } from "vitest";
import { SuggestionsStore } from "@/suggestions/store";
import {
  createSuggestion,
  _resetSuggestionIdCounter,
  Suggestion,
} from "@/suggestions/suggestion";

function makeTagSuggestion(notePath = "test.md"): Suggestion {
  return createSuggestion({
    type: "tag",
    sourceNotePath: notePath,
    title: "ai",
    detail: "Suggested tag: ai",
  });
}

function makeAnkiSuggestion(notePath = "test.md"): Suggestion {
  return createSuggestion({
    type: "anki-card",
    sourceNotePath: notePath,
    title: "What is X?",
    detail: "Basic card",
    editable: "What is X?::X is Y",
  });
}

describe("SuggestionsStore", () => {
  let store: SuggestionsStore;

  beforeEach(() => {
    _resetSuggestionIdCounter();
    store = new SuggestionsStore();
  });

  describe("add and get", () => {
    it("adds a suggestion and retrieves it by id", () => {
      const sug = makeTagSuggestion();
      store.add(sug);
      expect(store.get(sug.id)).toEqual(sug);
    });

    it("returns undefined for unknown id", () => {
      expect(store.get("nonexistent")).toBeUndefined();
    });
  });

  describe("filtering", () => {
    it("returns pending suggestions for a note path", () => {
      store.add(makeTagSuggestion("a.md"));
      store.add(makeTagSuggestion("b.md"));
      store.add(makeAnkiSuggestion("a.md"));

      const forA = store.getForNote("a.md");
      expect(forA).toHaveLength(2);
      expect(forA.every((s) => s.sourceNotePath === "a.md")).toBe(true);
    });

    it("returns pending suggestions by type", () => {
      store.add(makeTagSuggestion());
      store.add(makeAnkiSuggestion());
      store.add(makeAnkiSuggestion());

      const cards = store.getByType("anki-card");
      expect(cards).toHaveLength(2);
    });

    it("excludes non-pending suggestions from filters", () => {
      const sug = makeTagSuggestion();
      store.add(sug);
      store.accept(sug.id);

      expect(store.getForNote("test.md")).toHaveLength(0);
      expect(store.getByType("tag")).toHaveLength(0);
    });

    it("returns all pending suggestions", () => {
      store.add(makeTagSuggestion());
      store.add(makeAnkiSuggestion());
      const dismissed = makeTagSuggestion();
      store.add(dismissed);
      store.dismiss(dismissed.id);

      expect(store.getAllPending()).toHaveLength(2);
    });
  });

  describe("status transitions", () => {
    it("accepts a suggestion", () => {
      const sug = makeTagSuggestion();
      store.add(sug);
      store.accept(sug.id);
      expect(store.get(sug.id)?.status).toBe("accepted");
    });

    it("dismisses a suggestion", () => {
      const sug = makeTagSuggestion();
      store.add(sug);
      store.dismiss(sug.id);
      expect(store.get(sug.id)?.status).toBe("dismissed");
    });

    it("updates the editable field", () => {
      const sug = makeAnkiSuggestion();
      store.add(sug);
      store.updateEditable(sug.id, "Edited::Content");
      expect(store.get(sug.id)?.editable).toBe("Edited::Content");
    });
  });

  describe("cleanup", () => {
    it("removes accepted suggestions older than maxAge", () => {
      const sug = makeTagSuggestion();
      store.add(sug);
      store.accept(sug.id);
      // Backdate
      const stored = store.get(sug.id)!;
      (stored as any)._resolvedAt = Date.now() - 25 * 60 * 60 * 1000;

      store.cleanup(24 * 60 * 60 * 1000);
      expect(store.get(sug.id)).toBeUndefined();
    });

    it("keeps pending suggestions regardless of age", () => {
      const sug = makeTagSuggestion();
      sug.created = Date.now() - 100 * 24 * 60 * 60 * 1000; // 100 days old
      store.add(sug);

      store.cleanup(24 * 60 * 60 * 1000);
      expect(store.get(sug.id)).toBeDefined();
    });
  });

  describe("removeForNote", () => {
    it("removes all suggestions for a deleted note", () => {
      store.add(makeTagSuggestion("deleted.md"));
      store.add(makeAnkiSuggestion("deleted.md"));
      store.add(makeTagSuggestion("keep.md"));

      store.removeForNote("deleted.md");
      expect(store.getForNote("deleted.md")).toHaveLength(0);
      expect(store.getForNote("keep.md")).toHaveLength(1);
    });
  });

  describe("pending counts", () => {
    it("returns counts grouped by type", () => {
      store.add(makeTagSuggestion());
      store.add(makeTagSuggestion());
      store.add(makeAnkiSuggestion());

      const counts = store.getPendingCounts();
      expect(counts.tag).toBe(2);
      expect(counts["anki-card"]).toBe(1);
      expect(counts.connection).toBe(0);
    });
  });

  describe("serialization", () => {
    it("round-trips through serialize/deserialize", () => {
      store.add(makeTagSuggestion());
      store.add(makeAnkiSuggestion());

      const json = store.serialize();
      const restored = SuggestionsStore.deserialize(json);
      expect(restored.getAllPending()).toHaveLength(2);
    });

    it("syncs suggestion ID counter on deserialize", () => {
      store.add(makeTagSuggestion()); // id: sug-1
      store.add(makeTagSuggestion()); // id: sug-2

      const json = store.serialize();
      const restored = SuggestionsStore.deserialize(json);

      // New suggestion should get sug-3, not sug-1
      const newSug = createSuggestion({
        type: "tag",
        sourceNotePath: "new.md",
        title: "test",
        detail: "test",
      });
      expect(newSug.id).toBe("sug-3");
    });
  });
});
