// tests/modules/tagger.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { TaggerModule } from "@/modules/tagger/tagger";

describe("TaggerModule", () => {
  let tagger: TaggerModule;

  beforeEach(() => {
    tagger = new TaggerModule();
  });

  describe("buildPrompt", () => {
    it("includes note content, existing tags, and style guide", () => {
      const prompt = tagger.buildPrompt({
        noteContent: "# Neural Networks\nDeep learning is a subset of ML.",
        existingTags: ["ai", "machine-learning", "physics", "math"],
        rejectedTags: [],
        styleGuide: "Use kebab-case. Max depth 3.",
      });

      expect(prompt.system).toContain("tagging assistant");
      expect(prompt.prompt).toContain("Neural Networks");
      expect(prompt.prompt).toContain("machine-learning");
      expect(prompt.prompt).toContain("kebab-case");
    });

    it("includes rejected tags in prompt", () => {
      const prompt = tagger.buildPrompt({
        noteContent: "# Test",
        existingTags: ["ai"],
        rejectedTags: ["generic-tag"],
        styleGuide: "",
      });

      expect(prompt.prompt).toContain("generic-tag");
      expect(prompt.prompt).toContain("rejected");
    });

    it("requests JSON response format", () => {
      const prompt = tagger.buildPrompt({
        noteContent: "# Test",
        existingTags: [],
        rejectedTags: [],
        styleGuide: "",
      });

      expect(prompt.prompt).toContain("JSON");
    });
  });

  describe("buildBatchPrompt", () => {
    it("includes multiple notes in one prompt", () => {
      const prompt = tagger.buildBatchPrompt({
        notes: [
          { path: "a.md", content: "# Note A" },
          { path: "b.md", content: "# Note B" },
        ],
        existingTags: ["ai"],
        rejectedTagsByNote: { "a.md": ["bad-tag"], "b.md": [] },
        styleGuide: "kebab-case",
      });

      expect(prompt.prompt).toContain("a.md");
      expect(prompt.prompt).toContain("b.md");
      expect(prompt.prompt).toContain("Note A");
      expect(prompt.prompt).toContain("Note B");
    });
  });

  describe("parseResponse", () => {
    it("parses valid JSON response with tags array", () => {
      const result = tagger.parseResponse('{"tags": ["ai", "deep-learning"]}');
      expect(result).toEqual({ tags: ["ai", "deep-learning"] });
    });

    it("parses response with tags embedded in markdown code block", () => {
      const result = tagger.parseResponse(
        '```json\n{"tags": ["ai"]}\n```',
      );
      expect(result).toEqual({ tags: ["ai"] });
    });

    it("returns null for invalid JSON", () => {
      const result = tagger.parseResponse("not json at all");
      expect(result).toBeNull();
    });

    it("returns null for JSON without tags array", () => {
      const result = tagger.parseResponse('{"something": "else"}');
      expect(result).toBeNull();
    });
  });

  describe("parseBatchResponse", () => {
    it("parses response with per-note tags", () => {
      const result = tagger.parseBatchResponse(
        JSON.stringify({
          results: [
            { path: "a.md", tags: ["ai"] },
            { path: "b.md", tags: ["physics"] },
          ],
        }),
      );

      expect(result).toEqual({
        "a.md": ["ai"],
        "b.md": ["physics"],
      });
    });

    it("returns null for invalid response", () => {
      const result = tagger.parseBatchResponse("garbage");
      expect(result).toBeNull();
    });
  });
});
