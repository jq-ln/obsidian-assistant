import { describe, it, expect, beforeEach } from "vitest";
import { VaultService } from "@/vault/vault-service";
import { App, Vault } from "obsidian";

describe("VaultService", () => {
  let app: App;
  let vault: Vault;
  let service: VaultService;

  beforeEach(() => {
    app = new App();
    vault = app.vault;
    service = new VaultService(app);
  });

  describe("readNote", () => {
    it("reads note content", async () => {
      vault._seed("notes/test.md", "# Hello\nSome content");
      const content = await service.readNote("notes/test.md");
      expect(content).toBe("# Hello\nSome content");
    });

    it("returns null for non-existent note", async () => {
      const content = await service.readNote("missing.md");
      expect(content).toBeNull();
    });
  });

  describe("writeNote", () => {
    it("creates a new note", async () => {
      await service.writeNote("new.md", "# New note");
      const content = await service.readNote("new.md");
      expect(content).toBe("# New note");
    });

    it("overwrites an existing note", async () => {
      vault._seed("existing.md", "old content");
      await service.writeNote("existing.md", "new content");
      const content = await service.readNote("existing.md");
      expect(content).toBe("new content");
    });
  });

  describe("noteExists", () => {
    it("returns true for existing notes", () => {
      vault._seed("exists.md", "content");
      expect(service.noteExists("exists.md")).toBe(true);
    });

    it("returns false for missing notes", () => {
      expect(service.noteExists("missing.md")).toBe(false);
    });
  });

  describe("getAllTags", () => {
    it("extracts tags from note frontmatter", async () => {
      vault._seed(
        "tagged.md",
        "---\ntags:\n  - ai\n  - ml\n---\n# Note",
      );
      vault._seed(
        "tagged2.md",
        "---\ntags:\n  - ai\n  - physics\n---\n# Note 2",
      );
      const tags = await service.getAllTags();
      expect(tags).toContain("ai");
      expect(tags).toContain("ml");
      expect(tags).toContain("physics");
    });

    it("deduplicates tags", async () => {
      vault._seed("a.md", "---\ntags:\n  - ai\n---\n");
      vault._seed("b.md", "---\ntags:\n  - ai\n---\n");
      const tags = await service.getAllTags();
      const aiCount = tags.filter((t) => t === "ai").length;
      expect(aiCount).toBe(1);
    });
  });

  describe("getUntaggedNotes", () => {
    it("returns notes without tags in frontmatter", async () => {
      vault._seed("tagged.md", "---\ntags:\n  - ai\n---\n# Tagged");
      vault._seed("untagged.md", "# No tags here");
      vault._seed("empty-tags.md", "---\ntags: []\n---\n# Empty tags");
      const untagged = await service.getUntaggedNotes();
      const paths = untagged.map((n) => n.path);
      expect(paths).toContain("untagged.md");
      expect(paths).toContain("empty-tags.md");
      expect(paths).not.toContain("tagged.md");
    });
  });

  describe("parseFrontmatter / updateFrontmatter", () => {
    it("parses YAML frontmatter", async () => {
      vault._seed("fm.md", "---\ntags:\n  - ai\ncustom: value\n---\n# Content");
      const fm = await service.parseFrontmatter("fm.md");
      expect(fm).toEqual({ tags: ["ai"], custom: "value" });
    });

    it("strips surrounding quotes from string values", async () => {
      vault._seed(
        "quoted.md",
        '---\ntitle: "My Note: Part 2"\nauthor: \'Jane Doe\'\n---\n# Content',
      );
      const fm = await service.parseFrontmatter("quoted.md");
      expect(fm.title).toBe("My Note: Part 2");
      expect(fm.author).toBe("Jane Doe");
    });

    it("handles values with colons in them", async () => {
      vault._seed("url.md", "---\nurl: http://example.com\n---\n# Content");
      const fm = await service.parseFrontmatter("url.md");
      expect(fm.url).toBe("http://example.com");
    });

    it("returns empty object for notes without frontmatter", async () => {
      vault._seed("nofm.md", "# Just content");
      const fm = await service.parseFrontmatter("nofm.md");
      expect(fm).toEqual({});
    });

    it("updates frontmatter fields", async () => {
      vault._seed("fm.md", "---\ntags:\n  - ai\n---\n# Content");
      await service.updateFrontmatter("fm.md", { "suggested-tags": ["ml", "physics"] });
      const content = await service.readNote("fm.md");
      expect(content).toContain("suggested-tags");
      const fm = await service.parseFrontmatter("fm.md");
      expect(fm["suggested-tags"]).toEqual(["ml", "physics"]);
    });

    it("merges with existing frontmatter", async () => {
      vault._seed("fm.md", "---\ntags:\n  - ai\n---\n# Content");
      await service.updateFrontmatter("fm.md", { "ai-tagged": true });
      const fm = await service.parseFrontmatter("fm.md");
      expect(fm.tags).toEqual(["ai"]);
      expect(fm["ai-tagged"]).toBe(true);
    });

    it("removes a field when set to undefined", async () => {
      vault._seed("fm.md", "---\ntags:\n  - ai\nremoveme: true\n---\n# Content");
      await service.updateFrontmatter("fm.md", { removeme: undefined });
      const fm = await service.parseFrontmatter("fm.md");
      expect(fm.removeme).toBeUndefined();
    });
  });

  describe("getMarkdownFiles", () => {
    it("returns all markdown files", () => {
      vault._seed("a.md", "");
      vault._seed("folder/b.md", "");
      vault._seed("data.json", "{}");
      const files = service.getMarkdownFiles();
      const paths = files.map((f) => f.path);
      expect(paths).toContain("a.md");
      expect(paths).toContain("folder/b.md");
      expect(paths).not.toContain("data.json");
    });
  });
});
