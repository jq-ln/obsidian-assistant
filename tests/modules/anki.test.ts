import { describe, it, expect, beforeEach } from "vitest";
import { AnkiModule, CardFormat } from "@/modules/anki/anki";

describe("AnkiModule", () => {
  let anki: AnkiModule;

  beforeEach(() => {
    anki = new AnkiModule();
  });

  describe("buildPrompt", () => {
    it("includes note content and format preference", () => {
      const prompt = anki.buildPrompt({
        noteContent: "# Neural Networks\nTransformers use attention mechanisms.",
        existingCards: [],
        cardFormat: "both",
      });

      expect(prompt.system).toContain("spaced repetition");
      expect(prompt.prompt).toContain("Neural Networks");
      expect(prompt.prompt).toContain("attention mechanisms");
      expect(prompt.prompt).toContain("basic");
      expect(prompt.prompt).toContain("cloze");
    });

    it("includes existing cards to avoid duplicates", () => {
      const prompt = anki.buildPrompt({
        noteContent: "# Test",
        existingCards: ["What is X?::X is Y"],
        cardFormat: "both",
      });

      expect(prompt.prompt).toContain("What is X?::X is Y");
      expect(prompt.prompt).toContain("duplicate");
    });

    it("restricts to basic-only when configured", () => {
      const prompt = anki.buildPrompt({
        noteContent: "# Test",
        existingCards: [],
        cardFormat: "basic-only",
      });

      expect(prompt.prompt).toContain("basic");
      expect(prompt.prompt).toContain("Front::Back");
      expect(prompt.prompt).not.toContain("cloze");
    });

    it("restricts to cloze-only when configured", () => {
      const prompt = anki.buildPrompt({
        noteContent: "# Test",
        existingCards: [],
        cardFormat: "cloze-only",
      });

      expect(prompt.prompt).toContain("cloze");
      expect(prompt.prompt).not.toContain("Front::Back");
    });

    it("requests JSON response", () => {
      const prompt = anki.buildPrompt({
        noteContent: "# Test",
        existingCards: [],
        cardFormat: "both",
      });

      expect(prompt.prompt).toContain("JSON");
    });
  });

  describe("parseResponse", () => {
    it("parses basic cards", () => {
      const result = anki.parseResponse(
        JSON.stringify({
          cards: [
            { type: "basic", front: "What is X?", back: "X is Y" },
          ],
        }),
      );

      expect(result).toHaveLength(1);
      expect(result![0].type).toBe("basic");
      expect(result![0].front).toBe("What is X?");
      expect(result![0].back).toBe("X is Y");
    });

    it("parses cloze cards", () => {
      const result = anki.parseResponse(
        JSON.stringify({
          cards: [
            { type: "cloze", text: "The capital of France is {{c1::Paris}}." },
          ],
        }),
      );

      expect(result).toHaveLength(1);
      expect(result![0].type).toBe("cloze");
      expect(result![0].text).toBe("The capital of France is {{c1::Paris}}.");
    });

    it("parses mixed cards", () => {
      const result = anki.parseResponse(
        JSON.stringify({
          cards: [
            { type: "basic", front: "Q1", back: "A1" },
            { type: "cloze", text: "{{c1::Test}}" },
            { type: "basic", front: "Q2", back: "A2" },
          ],
        }),
      );

      expect(result).toHaveLength(3);
    });

    it("handles markdown code blocks", () => {
      const result = anki.parseResponse(
        '```json\n{"cards": [{"type": "basic", "front": "Q", "back": "A"}]}\n```',
      );
      expect(result).toHaveLength(1);
    });

    it("returns null for malformed JSON", () => {
      expect(anki.parseResponse("not json")).toBeNull();
    });

    it("returns null for missing cards array", () => {
      expect(anki.parseResponse('{"something": "else"}')).toBeNull();
    });

    it("filters out invalid card objects", () => {
      const result = anki.parseResponse(
        JSON.stringify({
          cards: [
            { type: "basic", front: "Q", back: "A" },
            { type: "unknown", data: "bad" },
            { type: "basic" }, // missing front/back
          ],
        }),
      );
      expect(result).toHaveLength(1);
    });
  });

  describe("formatCardMarkdown", () => {
    it("formats a basic card", () => {
      const md = anki.formatCardMarkdown({ type: "basic", front: "Q", back: "A" });
      expect(md).toBe("Q::A");
    });

    it("formats a cloze card", () => {
      const md = anki.formatCardMarkdown({
        type: "cloze",
        text: "The answer is {{c1::42}}.",
      });
      expect(md).toBe("The answer is {{c1::42}}.");
    });
  });

  describe("buildFlashcardsSection", () => {
    it("builds a complete flashcards section", () => {
      const section = anki.buildFlashcardsSection([
        "Q1::A1",
        "The answer is {{c1::42}}.",
      ]);

      expect(section).toBe("\n\n## Flashcards\n\nQ1::A1\n\nThe answer is {{c1::42}}.\n");
    });
  });

  describe("extractExistingCards", () => {
    it("extracts cards from a flashcards section", () => {
      const content = `# My Note

Some content here.

## Flashcards

Q1::A1

The answer is {{c1::42}}.
`;
      const cards = anki.extractExistingCards(content);
      expect(cards).toEqual(["Q1::A1", "The answer is {{c1::42}}."]);
    });

    it("returns empty array when no flashcards section", () => {
      const cards = anki.extractExistingCards("# Just a note\nNo cards here.");
      expect(cards).toEqual([]);
    });
  });

  describe("appendCardsToContent", () => {
    it("appends to existing flashcards section", () => {
      const content = "# Note\n\n## Flashcards\n\nQ1::A1\n";
      const result = anki.appendCardsToContent(content, ["Q2::A2"]);
      expect(result).toContain("Q1::A1");
      expect(result).toContain("Q2::A2");
    });

    it("creates flashcards section when none exists", () => {
      const content = "# Note\n\nSome content.";
      const result = anki.appendCardsToContent(content, ["Q1::A1"]);
      expect(result).toContain("## Flashcards");
      expect(result).toContain("Q1::A1");
    });
  });
});
