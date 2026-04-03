import { describe, it, expect, beforeEach } from "vitest";
import { CardMigration } from "@/modules/anki/card-migration";
import { VaultService } from "@/vault/vault-service";
import { App } from "obsidian";

describe("CardMigration", () => {
  let app: App;
  let vault: VaultService;
  let migration: CardMigration;

  beforeEach(() => {
    app = new App();
    vault = new VaultService(app);
    migration = new CardMigration(vault);
  });

  describe("migrateToSeparateFile", () => {
    it("moves flashcards section from note to separate file", async () => {
      const content = `# My Note

Some content.

## Flashcards

Q1::A1

The answer is {{c1::42}}.
`;
      app.vault._seed("notes/my-note.md", content);

      await migration.migrateToSeparateFile("notes/my-note.md", "AI-Assistant/cards");

      // Source note should have flashcards section removed
      const updatedNote = await vault.readNote("notes/my-note.md");
      expect(updatedNote).not.toContain("## Flashcards");
      expect(updatedNote).toContain("Some content.");

      // Separate file should have the cards
      const cardFile = await vault.readNote("AI-Assistant/cards/notes-my-note-cards.md");
      expect(cardFile).toContain("Q1::A1");
      expect(cardFile).toContain("{{c1::42}}");
    });

    it("does nothing if note has no flashcards section", async () => {
      app.vault._seed("notes/plain.md", "# Plain note\nNo cards here.");

      await migration.migrateToSeparateFile("notes/plain.md", "AI-Assistant/cards");

      const content = await vault.readNote("notes/plain.md");
      expect(content).toBe("# Plain note\nNo cards here.");
    });
  });

  describe("migrateToInNote", () => {
    it("moves cards from separate file back into the note", async () => {
      app.vault._seed("notes/my-note.md", "# My Note\n\nSome content.");
      app.vault._seed(
        "AI-Assistant/cards/notes-my-note-cards.md",
        "## Flashcards\n\nQ1::A1\n\nQ2::A2\n",
      );

      await migration.migrateToInNote("notes/my-note.md", "AI-Assistant/cards");

      // Note should now have flashcards
      const content = await vault.readNote("notes/my-note.md");
      expect(content).toContain("## Flashcards");
      expect(content).toContain("Q1::A1");

      // Separate file should be removed (content cleared)
      const cardFile = await vault.readNote("AI-Assistant/cards/notes-my-note-cards.md");
      expect(cardFile === null || cardFile.trim() === "").toBe(true);
    });

    it("does nothing if no separate card file exists", async () => {
      app.vault._seed("notes/my-note.md", "# My Note");

      await migration.migrateToInNote("notes/my-note.md", "AI-Assistant/cards");

      const content = await vault.readNote("notes/my-note.md");
      expect(content).toBe("# My Note");
    });
  });

  describe("getCardFilePath", () => {
    it("generates correct card file path with folder prefix", () => {
      expect(migration.getCardFilePath("notes/my-note.md", "AI-Assistant/cards")).toBe(
        "AI-Assistant/cards/notes-my-note-cards.md",
      );
    });

    it("handles notes in vault root", () => {
      expect(migration.getCardFilePath("my-note.md", "AI-Assistant/cards")).toBe(
        "AI-Assistant/cards/my-note-cards.md",
      );
    });

    it("handles deeply nested notes without collisions", () => {
      const path1 = migration.getCardFilePath("notes/physics/intro.md", "cards");
      const path2 = migration.getCardFilePath("notes/math/intro.md", "cards");
      expect(path1).not.toBe(path2);
      expect(path1).toBe("cards/notes-physics-intro-cards.md");
      expect(path2).toBe("cards/notes-math-intro-cards.md");
    });
  });
});
