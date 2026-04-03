import { LLMRequest } from "../../llm/provider";

export type CardFormat = "both" | "basic-only" | "cloze-only";

export interface AnkiPromptInput {
  noteContent: string;
  existingCards: string[];
  cardFormat: CardFormat;
}

export interface BasicCard {
  type: "basic";
  front: string;
  back: string;
  text?: undefined;
}

export interface ClozeCard {
  type: "cloze";
  text: string;
  front?: undefined;
  back?: undefined;
}

export type AnkiCard = BasicCard | ClozeCard;

export class AnkiModule {
  buildPrompt(input: AnkiPromptInput): LLMRequest {
    const formatInstructions = this.getFormatInstructions(input.cardFormat);
    const existingSection =
      input.existingCards.length > 0
        ? `\n\n## Existing cards (do NOT duplicate these)\n${input.existingCards.join("\n")}`
        : "";

    const jsonExample = this.getJsonExample(input.cardFormat);

    const prompt = `Analyze the following note and suggest high-yield flashcards for spaced repetition study.

${formatInstructions}

Focus on:
- Concepts worth remembering long-term
- Questions that test understanding, not just recall
- Key relationships, distinctions, and principles
- Avoid trivial or surface-level cards
${existingSection}

## Note content
${input.noteContent}

Respond with JSON:
${jsonExample}

Suggest 3-8 cards depending on note complexity.`;

    return {
      system:
        "You are a spaced repetition expert. Analyze notes and suggest high-yield flashcards that test understanding, not just recall. Focus on concepts worth remembering long-term. Avoid trivial or surface-level cards. Respond with valid JSON only.",
      prompt,
      maxTokens: 1500,
      temperature: 0.3,
    };
  }

  private getJsonExample(format: CardFormat): string {
    switch (format) {
      case "basic-only":
        return '{"cards": [{"type": "basic", "front": "question", "back": "answer"}]}';
      case "cloze-only":
        return '{"cards": [{"type": "cloze", "text": "sentence with {{c1::answer}}"}]}';
      case "both":
        return '{"cards": [{"type": "basic", "front": "question", "back": "answer"}, {"type": "cloze", "text": "sentence with {{c1::answer}}"}]}';
    }
  }

  private getFormatInstructions(format: CardFormat): string {
    switch (format) {
      case "basic-only":
        return "Create basic Q&A cards using the Front::Back format only. Do NOT use deletion-style cards.";
      case "cloze-only":
        return "Create cloze deletion cards using the {{c1::answer}} format only. Do NOT use basic Q&A format.";
      case "both":
        return "Create a mix of basic Q&A cards (Front::Back format) and cloze deletion cards ({{c1::answer}} format). Use whichever format best fits each concept.";
    }
  }

  parseResponse(raw: string): AnkiCard[] | null {
    const json = this.extractJson(raw);
    if (!json) return null;

    try {
      const parsed = JSON.parse(json);
      if (!parsed.cards || !Array.isArray(parsed.cards)) return null;

      return parsed.cards.filter((card: any) => {
        if (card.type === "basic") {
          return typeof card.front === "string" && typeof card.back === "string";
        }
        if (card.type === "cloze") {
          return typeof card.text === "string";
        }
        return false;
      });
    } catch {
      return null;
    }
  }

  formatCardMarkdown(card: AnkiCard): string {
    if (card.type === "basic") {
      return `${card.front}::${card.back}`;
    }
    return card.text;
  }

  buildFlashcardsSection(cardLines: string[]): string {
    return `\n\n## Flashcards\n\n${cardLines.join("\n\n")}\n`;
  }

  extractExistingCards(content: string): string[] {
    const match = content.match(/## Flashcards\n\n([\s\S]*?)(?=\n## |\s*$)/);
    if (!match) return [];

    return match[1]
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  appendCardsToContent(content: string, newCardLines: string[]): string {
    const newCards = newCardLines.join("\n\n");

    if (content.includes("## Flashcards")) {
      // Append to existing section
      const trimmed = content.replace(/\s*$/, "");
      return `${trimmed}\n\n${newCards}\n`;
    }

    // Create new section
    const trimmed = content.replace(/\s*$/, "");
    return `${trimmed}\n\n## Flashcards\n\n${newCards}\n`;
  }

  private extractJson(raw: string): string | null {
    const trimmed = raw.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      return trimmed;
    }
    const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (codeBlockMatch) {
      return codeBlockMatch[1].trim();
    }
    return null;
  }
}
