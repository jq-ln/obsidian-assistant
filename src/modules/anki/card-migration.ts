import { VaultService } from "../../vault/vault-service";
import { AnkiModule } from "./anki";

export class CardMigration {
  private vault: VaultService;
  private anki = new AnkiModule();

  constructor(vault: VaultService) {
    this.vault = vault;
  }

  getCardFilePath(notePath: string, cardsFolder: string): string {
    const basename = notePath.split("/").pop()?.replace(/\.md$/, "") ?? "unknown";
    return `${cardsFolder}/${basename}-cards.md`;
  }

  async migrateToSeparateFile(notePath: string, cardsFolder: string): Promise<void> {
    const content = await this.vault.readNote(notePath);
    if (!content) return;

    const existingCards = this.anki.extractExistingCards(content);
    if (existingCards.length === 0) return;

    // Write cards to separate file
    const cardFilePath = this.getCardFilePath(notePath, cardsFolder);
    const cardContent = `## Flashcards\n\n${existingCards.join("\n\n")}\n`;
    await this.vault.writeNote(cardFilePath, cardContent);

    // Remove flashcards section from source note
    const cleaned = this.removeFlashcardsSection(content);
    await this.vault.writeNote(notePath, cleaned);
  }

  async migrateToInNote(notePath: string, cardsFolder: string): Promise<void> {
    const cardFilePath = this.getCardFilePath(notePath, cardsFolder);
    const cardFileContent = await this.vault.readNote(cardFilePath);
    if (!cardFileContent) return;

    const cards = this.anki.extractExistingCards(cardFileContent);
    if (cards.length === 0) return;

    // Append cards to source note
    const noteContent = await this.vault.readNote(notePath);
    if (!noteContent) return;

    const updated = this.anki.appendCardsToContent(noteContent, cards);
    await this.vault.writeNote(notePath, updated);

    // Clear the separate file
    await this.vault.writeNote(cardFilePath, "");
  }

  private removeFlashcardsSection(content: string): string {
    // Remove ## Flashcards and everything after it (it's always the last section)
    const idx = content.indexOf("\n## Flashcards");
    if (idx === -1) return content;
    return content.slice(0, idx).replace(/\s+$/, "\n");
  }
}
