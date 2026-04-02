// tests/modules/tag-audit.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { TagAuditModule } from "@/modules/tagger/tag-audit";

describe("TagAuditModule", () => {
  let audit: TagAuditModule;

  beforeEach(() => {
    audit = new TagAuditModule();
  });

  describe("buildPrompt", () => {
    it("includes all vault tags", () => {
      const prompt = audit.buildAuditPrompt([
        "ai",
        "AI",
        "machine-learning",
        "ml",
        "project",
        "projects",
      ]);

      expect(prompt.prompt).toContain("ai");
      expect(prompt.prompt).toContain("machine-learning");
      expect(prompt.prompt).toContain("projects");
    });

    it("requests JSON response", () => {
      const prompt = audit.buildAuditPrompt(["ai", "ml"]);
      expect(prompt.prompt).toContain("JSON");
    });
  });

  describe("parseAuditResponse", () => {
    it("parses merge suggestions", () => {
      const result = audit.parseAuditResponse(
        JSON.stringify({
          suggestions: [
            {
              action: "merge",
              tags: ["ai", "AI"],
              into: "ai",
              reason: "Case variant",
            },
            {
              action: "merge",
              tags: ["ml", "machine-learning"],
              into: "machine-learning",
              reason: "Abbreviation",
            },
          ],
        }),
      );

      expect(result).toHaveLength(2);
      expect(result![0].action).toBe("merge");
      expect(result![0].tags).toEqual(["ai", "AI"]);
      expect(result![0].into).toBe("ai");
    });

    it("returns null for invalid response", () => {
      expect(audit.parseAuditResponse("not json")).toBeNull();
    });
  });

  describe("computeAffectedFiles", () => {
    it("finds files containing the old tag", () => {
      const tagIndex: Record<string, string[]> = {
        "AI": ["note1.md", "note2.md"],
        "ai": ["note3.md"],
        "ml": ["note1.md"],
      };

      const affected = audit.computeAffectedFiles(
        { action: "merge", tags: ["AI", "ai"], into: "ai", reason: "" },
        tagIndex,
      );

      // "AI" needs to be renamed in note1.md and note2.md
      // "ai" is already correct in note3.md
      expect(affected).toEqual(["note1.md", "note2.md"]);
    });
  });
});
