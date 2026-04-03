// tests/modules/connections.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { ConnectionModule } from "@/modules/connections/connections";

describe("ConnectionModule", () => {
  let module: ConnectionModule;

  beforeEach(() => {
    module = new ConnectionModule();
  });

  describe("buildPrompt", () => {
    it("includes source note and candidate summaries", () => {
      const prompt = module.buildPrompt({
        sourceTitle: "Neural Networks",
        sourceTags: ["ai", "ml"],
        sourceSummary: "Deep learning architectures...",
        candidates: [
          { path: "backprop.md", title: "Backpropagation", tags: ["ai", "calculus"], keywords: ["gradient", "chain-rule"], summary: "Chain rule applied to neural nets..." },
          { path: "cooking.md", title: "Pasta Recipe", tags: ["cooking"], keywords: ["pasta", "tomato"], summary: "How to make pasta..." },
        ],
      });

      expect(prompt.prompt).toContain("Neural Networks");
      expect(prompt.prompt).toContain("backprop.md");
      expect(prompt.prompt).toContain("cooking.md");
      expect(prompt.prompt).toContain("JSON");
    });
  });

  describe("parseResponse", () => {
    it("parses connection suggestions", () => {
      const result = module.parseResponse(
        JSON.stringify({
          connections: [
            {
              path: "backprop.md",
              reason: "Backpropagation is a key training algorithm for neural networks",
            },
          ],
        }),
      );

      expect(result).toHaveLength(1);
      expect(result![0].path).toBe("backprop.md");
      expect(result![0].reason).toContain("Backpropagation");
    });

    it("returns empty array when no connections found", () => {
      const result = module.parseResponse(
        JSON.stringify({ connections: [] }),
      );
      expect(result).toEqual([]);
    });

    it("returns null for invalid response", () => {
      expect(module.parseResponse("not json")).toBeNull();
    });
  });

  describe("buildRelatedSection", () => {
    it("generates markdown for related links", () => {
      const section = module.buildRelatedSection([
        { path: "backprop.md", reason: "Training algorithm for neural nets" },
        { path: "activation.md", reason: "Activation functions used in layers" },
      ]);

      expect(section).toContain("## Related");
      expect(section).toContain("[[backprop]]");
      expect(section).toContain("[[activation]]");
    });
  });
});
