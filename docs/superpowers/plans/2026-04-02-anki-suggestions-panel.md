# Anki Card Suggestions & Persistent Suggestions Panel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add AI-generated Anki flashcard suggestions and a persistent sidebar panel that aggregates all suggestion types (tags, connections, Anki cards) with contextual filtering by active note.

**Architecture:** A new `SuggestionsStore` provides CRUD and persistence for a unified `Suggestion` type. The `AnkiModule` builds prompts and parses Claude's flashcard responses. A `SuggestionsPanel` (Obsidian `ItemView`) renders suggestions in a sidebar with accept/edit/dismiss actions. Existing tag and connection suggestion flows are migrated from toast notifications to the panel. Card migration handles moving flashcards between in-note and separate-file locations.

**Tech Stack:** TypeScript, Obsidian Plugin API (1.4.0+), existing orchestrator/LLM infrastructure, Vitest

**Spec:** `docs/superpowers/specs/2026-04-02-anki-cards-suggestions-panel-design.md`

---

## File Map

```
src/
├── types.ts                          # (modified: add "anki" TaskType, "suggest-cards"/"migrate-cards" TaskActions)
├── settings.ts                       # (modified: add Anki settings section with conditional visibility, new PluginSettings fields)
├── suggestions/
│   ├── suggestion.ts                 # Suggestion interface, SuggestionType, SuggestionStatus
│   ├── store.ts                      # SuggestionsStore: CRUD, filtering, persistence to suggestions.json
│   └── panel.ts                      # SuggestionsPanel: Obsidian ItemView for the sidebar
├── modules/
│   └── anki/
│       ├── anki.ts                   # AnkiModule: prompt building, response parsing, card formatting
│       └── card-migration.ts         # CardMigration: move cards between in-note and separate-file
├── main.ts                           # (modified: register panel, Anki commands, wire acceptance handlers, migrate toast flow)
└── ui/
    └── notices.ts                    # (existing, unchanged)

tests/
├── suggestions/
│   └── store.test.ts
├── modules/
│   ├── anki.test.ts
│   └── card-migration.test.ts
└── integration/
    └── anki-flow.test.ts
```

---

## Task 1: Suggestion Types & Store

**Files:**
- Create: `src/suggestions/suggestion.ts`, `src/suggestions/store.ts`
- Test: `tests/suggestions/store.test.ts`

- [ ] **Step 1: Create src/suggestions/suggestion.ts**

```typescript
import { SCHEMA_VERSION } from "../types";

export type SuggestionType = "tag" | "connection" | "anki-card";
export type SuggestionStatus = "pending" | "accepted" | "dismissed";

export interface Suggestion {
  id: string;
  type: SuggestionType;
  sourceNotePath: string;
  title: string;
  detail: string;
  editable?: string;
  created: number;
  status: SuggestionStatus;
}

let nextSuggestionId = 1;

export function createSuggestion(
  params: Pick<Suggestion, "type" | "sourceNotePath" | "title" | "detail"> &
    Partial<Pick<Suggestion, "editable">>,
): Suggestion {
  return {
    id: `sug-${nextSuggestionId++}`,
    type: params.type,
    sourceNotePath: params.sourceNotePath,
    title: params.title,
    detail: params.detail,
    editable: params.editable,
    created: Date.now(),
    status: "pending",
  };
}

export function syncSuggestionIdCounter(existingIds: string[]): void {
  const maxId = existingIds.reduce((max, id) => {
    const match = id.match(/^sug-(\d+)$/);
    return match ? Math.max(max, parseInt(match[1], 10)) : max;
  }, 0);
  nextSuggestionId = maxId + 1;
}

export function _resetSuggestionIdCounter(): void {
  nextSuggestionId = 1;
}
```

- [ ] **Step 2: Write failing tests for SuggestionsStore**

```typescript
// tests/suggestions/store.test.ts
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- tests/suggestions/store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement SuggestionsStore**

```typescript
// src/suggestions/store.ts
import {
  Suggestion,
  SuggestionType,
  SuggestionStatus,
  syncSuggestionIdCounter,
} from "./suggestion";
import { SCHEMA_VERSION } from "../types";

interface StoreState {
  schemaVersion: number;
  suggestions: Array<Suggestion & { _resolvedAt?: number }>;
}

export class SuggestionsStore {
  private suggestions: Map<string, Suggestion & { _resolvedAt?: number }> = new Map();

  add(suggestion: Suggestion): void {
    this.suggestions.set(suggestion.id, suggestion);
  }

  get(id: string): (Suggestion & { _resolvedAt?: number }) | undefined {
    return this.suggestions.get(id);
  }

  accept(id: string): void {
    const sug = this.suggestions.get(id);
    if (sug) {
      sug.status = "accepted";
      sug._resolvedAt = Date.now();
    }
  }

  dismiss(id: string): void {
    const sug = this.suggestions.get(id);
    if (sug) {
      sug.status = "dismissed";
      sug._resolvedAt = Date.now();
    }
  }

  updateEditable(id: string, value: string): void {
    const sug = this.suggestions.get(id);
    if (sug) {
      sug.editable = value;
    }
  }

  getForNote(notePath: string): Suggestion[] {
    return Array.from(this.suggestions.values()).filter(
      (s) => s.sourceNotePath === notePath && s.status === "pending",
    );
  }

  getByType(type: SuggestionType): Suggestion[] {
    return Array.from(this.suggestions.values()).filter(
      (s) => s.type === type && s.status === "pending",
    );
  }

  getAllPending(): Suggestion[] {
    return Array.from(this.suggestions.values()).filter(
      (s) => s.status === "pending",
    );
  }

  getPendingCounts(): Record<SuggestionType, number> {
    const counts: Record<SuggestionType, number> = {
      tag: 0,
      connection: 0,
      "anki-card": 0,
    };
    for (const sug of this.suggestions.values()) {
      if (sug.status === "pending") {
        counts[sug.type]++;
      }
    }
    return counts;
  }

  removeForNote(notePath: string): void {
    for (const [id, sug] of this.suggestions.entries()) {
      if (sug.sourceNotePath === notePath) {
        this.suggestions.delete(id);
      }
    }
  }

  cleanup(maxAgeMs: number): void {
    const now = Date.now();
    for (const [id, sug] of this.suggestions.entries()) {
      if (sug.status === "accepted" || sug.status === "dismissed") {
        const resolvedAt = sug._resolvedAt ?? sug.created;
        if (now - resolvedAt > maxAgeMs) {
          this.suggestions.delete(id);
        }
      }
    }
  }

  serialize(): string {
    const state: StoreState = {
      schemaVersion: SCHEMA_VERSION,
      suggestions: Array.from(this.suggestions.values()),
    };
    return JSON.stringify(state, null, 2);
  }

  static deserialize(json: string): SuggestionsStore {
    const store = new SuggestionsStore();
    const state: StoreState = JSON.parse(json);
    for (const sug of state.suggestions) {
      store.suggestions.set(sug.id, sug);
    }
    syncSuggestionIdCounter(Array.from(store.suggestions.keys()));
    return store;
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- tests/suggestions/store.test.ts`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/suggestions/suggestion.ts src/suggestions/store.ts tests/suggestions/store.test.ts
git commit -m "feat: add suggestions store with CRUD, filtering, and persistence"
```

---

## Task 2: Anki Module — Prompt Building & Response Parsing

**Files:**
- Create: `src/modules/anki/anki.ts`
- Test: `tests/modules/anki.test.ts`
- Modify: `src/types.ts` (add Anki task types)

- [ ] **Step 1: Update src/types.ts**

Add to the `TaskType` union:

```typescript
export type TaskType = "tagger" | "connection-detector" | "dashboard" | "anki";
```

Add to the `TaskAction` union:

```typescript
export type TaskAction =
  | "tag-note"
  | "tag-batch"
  | "audit-tags"
  | "scan-connections"
  | "scan-connections-deep"
  | "generate-dashboard"
  | "log-habit"
  | "suggest-cards"
  | "migrate-cards";
```

- [ ] **Step 2: Write failing tests for AnkiModule**

```typescript
// tests/modules/anki.test.ts
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
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- tests/modules/anki.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement AnkiModule**

```typescript
// src/modules/anki/anki.ts
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
{"cards": [{"type": "basic", "front": "question", "back": "answer"}, {"type": "cloze", "text": "sentence with {{c1::answer}}"}]}

Suggest 3-8 cards depending on note complexity.`;

    return {
      system:
        "You are a spaced repetition expert. Analyze notes and suggest high-yield flashcards that test understanding, not just recall. Focus on concepts worth remembering long-term. Avoid trivial or surface-level cards. Respond with valid JSON only.",
      prompt,
      maxTokens: 1500,
      temperature: 0.3,
    };
  }

  private getFormatInstructions(format: CardFormat): string {
    switch (format) {
      case "basic-only":
        return "Create basic Q&A cards using the Front::Back format only. Do NOT use cloze deletions.";
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
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- tests/modules/anki.test.ts`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/types.ts src/modules/anki/anki.ts tests/modules/anki.test.ts
git commit -m "feat: add Anki module with prompt building, response parsing, and card formatting"
```

---

## Task 3: Card Migration

**Files:**
- Create: `src/modules/anki/card-migration.ts`
- Test: `tests/modules/card-migration.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/modules/card-migration.test.ts
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
      const cardFile = await vault.readNote("AI-Assistant/cards/my-note-cards.md");
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
        "AI-Assistant/cards/my-note-cards.md",
        "## Flashcards\n\nQ1::A1\n\nQ2::A2\n",
      );

      await migration.migrateToInNote("notes/my-note.md", "AI-Assistant/cards");

      // Note should now have flashcards
      const content = await vault.readNote("notes/my-note.md");
      expect(content).toContain("## Flashcards");
      expect(content).toContain("Q1::A1");

      // Separate file should be removed (content cleared)
      const cardFile = await vault.readNote("AI-Assistant/cards/my-note-cards.md");
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
    it("generates correct card file path", () => {
      expect(migration.getCardFilePath("notes/my-note.md", "AI-Assistant/cards")).toBe(
        "AI-Assistant/cards/my-note-cards.md",
      );
    });

    it("handles notes in vault root", () => {
      expect(migration.getCardFilePath("my-note.md", "AI-Assistant/cards")).toBe(
        "AI-Assistant/cards/my-note-cards.md",
      );
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/modules/card-migration.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement CardMigration**

```typescript
// src/modules/anki/card-migration.ts
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/modules/card-migration.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/modules/anki/card-migration.ts tests/modules/card-migration.test.ts
git commit -m "feat: add card migration between in-note and separate-file locations"
```

---

## Task 4: Settings — Anki Configuration

**Files:**
- Modify: `src/settings.ts`

- [ ] **Step 1: Add Anki fields to PluginSettings interface**

Add to the `PluginSettings` interface in `src/settings.ts`:

```typescript
  ankiEnabled: boolean;
  ankiAutoSuggestOnSave: boolean;
  ankiCardFormat: "both" | "basic-only" | "cloze-only";
  ankiCardLocation: "in-note" | "separate-file";
```

Add to `DEFAULT_SETTINGS`:

```typescript
  ankiEnabled: false,
  ankiAutoSuggestOnSave: false,
  ankiCardFormat: "both",
  ankiCardLocation: "in-note",
```

- [ ] **Step 2: Add Anki settings section to display()**

Add after the Dashboard section in `display()`:

```typescript
    // --- Anki ---
    containerEl.createEl("h3", { text: "Anki Cards" });

    new Setting(containerEl)
      .setName("Enable Anki card suggestions")
      .setDesc("Use Claude to suggest flashcards from your notes")
      .addToggle((toggle) =>
        (toggle as any)
          .setValue(this.settings.ankiEnabled)
          .onChange(async (value: boolean) => {
            this.settings.ankiEnabled = value;
            await this.save();
            this.display(); // Re-render to show/hide sub-settings
          }),
      );

    if (this.settings.ankiEnabled) {
      new Setting(containerEl)
        .setName("Auto-suggest cards on save")
        .setDesc("Warning: uses Claude API on every save. Debounced to 10s.")
        .addToggle((toggle) =>
          (toggle as any)
            .setValue(this.settings.ankiAutoSuggestOnSave)
            .onChange(async (value: boolean) => {
              this.settings.ankiAutoSuggestOnSave = value;
              await this.save();
            }),
        );

      new Setting(containerEl)
        .setName("Card format")
        .setDesc("Which flashcard formats to generate")
        .addDropdown((dropdown) =>
          (dropdown as any)
            .addOption("both", "Both (basic + cloze)")
            .addOption("basic-only", "Basic only (Front::Back)")
            .addOption("cloze-only", "Cloze only ({{c1::...}})")
            .setValue(this.settings.ankiCardFormat)
            .onChange(async (value: string) => {
              this.settings.ankiCardFormat = value as PluginSettings["ankiCardFormat"];
              await this.save();
            }),
        );

      new Setting(containerEl)
        .setName("Card location")
        .setDesc("Where to insert flashcard markdown. Changing this migrates existing cards.")
        .addDropdown((dropdown) =>
          (dropdown as any)
            .addOption("in-note", "In the source note (## Flashcards)")
            .addOption("separate-file", "Separate file (AI-Assistant/cards/)")
            .setValue(this.settings.ankiCardLocation)
            .onChange(async (value: string) => {
              const oldValue = this.settings.ankiCardLocation;
              this.settings.ankiCardLocation = value as PluginSettings["ankiCardLocation"];
              await this.save();
              if (oldValue !== value && this.onCardLocationChange) {
                this.onCardLocationChange(oldValue, value as PluginSettings["ankiCardLocation"]);
              }
            }),
        );
    }
```

- [ ] **Step 3: Add onCardLocationChange callback to constructor**

Update the `AssistantSettingTab` constructor to accept an optional card location change callback:

```typescript
  private onCardLocationChange?: (
    oldLocation: string,
    newLocation: string,
  ) => void;

  constructor(
    app: App,
    plugin: Plugin,
    settings: PluginSettings,
    onSettingsChange: (settings: PluginSettings) => Promise<void>,
    onCardLocationChange?: (oldLocation: string, newLocation: string) => void,
  ) {
    super(app, plugin);
    this.settings = settings;
    this.onSettingsChange = onSettingsChange;
    this.onCardLocationChange = onCardLocationChange;
  }
```

- [ ] **Step 4: Verify build compiles**

Run: `npm run build`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add src/settings.ts
git commit -m "feat: add Anki settings with conditional visibility and migration callback"
```

---

## Task 5: Suggestions Panel — Obsidian ItemView

**Files:**
- Create: `src/suggestions/panel.ts`

This is an Obsidian UI component — no automated tests, verified manually.

- [ ] **Step 1: Create src/suggestions/panel.ts**

```typescript
import { ItemView, WorkspaceLeaf, MarkdownView } from "obsidian";
import { SuggestionsStore } from "./store";
import { Suggestion, SuggestionType } from "./suggestion";

export const SUGGESTIONS_VIEW_TYPE = "assistant-suggestions";

export interface SuggestionHandler {
  onAccept(suggestion: Suggestion): Promise<void>;
  onDismiss(suggestion: Suggestion): Promise<void>;
}

export class SuggestionsPanel extends ItemView {
  private store: SuggestionsStore;
  private handler: SuggestionHandler;
  private setupGuideHtml: string | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    store: SuggestionsStore,
    handler: SuggestionHandler,
  ) {
    super(leaf);
    this.store = store;
    this.handler = handler;
  }

  getViewType(): string {
    return SUGGESTIONS_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "AI Suggestions";
  }

  getIcon(): string {
    return "lightbulb";
  }

  setSetupGuide(html: string | null): void {
    this.setupGuideHtml = html;
    this.refresh();
  }

  refresh(): void {
    const container = this.containerEl.children[1] as HTMLElement;
    if (!container) return;
    container.empty();
    this.renderContent(container);
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("assistant-suggestions-panel");
    this.renderContent(container);

    // Listen for active file changes
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.refresh()),
    );
  }

  async onClose(): Promise<void> {
    // Nothing to clean up
  }

  private renderContent(container: HTMLElement): void {
    // Setup guide (if Anki plugin not detected)
    if (this.setupGuideHtml) {
      const guideEl = container.createDiv({ cls: "suggestion-setup-guide" });
      guideEl.innerHTML = this.setupGuideHtml;
      guideEl.style.padding = "12px";
      guideEl.style.marginBottom = "12px";
      guideEl.style.border = "1px solid var(--background-modifier-border)";
      guideEl.style.borderRadius = "6px";
      guideEl.style.fontSize = "0.85em";
    }

    // Current Note section
    const activeFile = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
    const currentNotePath = activeFile?.path ?? null;

    container.createEl("h4", { text: "Current Note" });
    if (currentNotePath) {
      const noteSuggestions = this.store.getForNote(currentNotePath);
      if (noteSuggestions.length === 0) {
        container.createEl("p", {
          text: "No suggestions for this note.",
          cls: "suggestion-empty",
        }).style.color = "var(--text-muted)";
      } else {
        for (const sug of noteSuggestions) {
          this.renderSuggestionRow(container, sug);
        }
      }
    } else {
      container.createEl("p", {
        text: "No note open.",
        cls: "suggestion-empty",
      }).style.color = "var(--text-muted)";
    }

    // All Pending section
    container.createEl("h4", { text: "All Pending" }).style.marginTop = "16px";

    const counts = this.store.getPendingCounts();
    const types: Array<{ type: SuggestionType; label: string }> = [
      { type: "tag", label: "Tags" },
      { type: "connection", label: "Connections" },
      { type: "anki-card", label: "Cards" },
    ];

    for (const { type, label } of types) {
      const count = counts[type];
      if (count === 0) continue;

      const group = container.createDiv({ cls: "suggestion-group" });
      const header = group.createDiv({ cls: "suggestion-group-header" });
      header.style.cursor = "pointer";
      header.style.display = "flex";
      header.style.justifyContent = "space-between";
      header.style.padding = "4px 0";

      const titleEl = header.createEl("span", { text: label });
      titleEl.style.fontWeight = "600";

      const badge = header.createEl("span", { text: String(count) });
      badge.style.background = "var(--interactive-accent)";
      badge.style.color = "var(--text-on-accent)";
      badge.style.borderRadius = "10px";
      badge.style.padding = "0 8px";
      badge.style.fontSize = "0.8em";

      const body = group.createDiv({ cls: "suggestion-group-body" });
      body.style.display = "none"; // Collapsed by default

      header.addEventListener("click", () => {
        body.style.display = body.style.display === "none" ? "block" : "none";
      });

      const suggestions = this.store.getByType(type).filter(
        (s) => s.sourceNotePath !== currentNotePath, // Don't duplicate current note items
      );
      for (const sug of suggestions) {
        this.renderSuggestionRow(body, sug);
      }
    }
  }

  private renderSuggestionRow(parent: HTMLElement, suggestion: Suggestion): void {
    const row = parent.createDiv({ cls: "suggestion-row" });
    row.style.padding = "8px";
    row.style.marginBottom = "4px";
    row.style.border = "1px solid var(--background-modifier-border)";
    row.style.borderRadius = "4px";

    // Title (clickable → navigate to source note)
    const titleEl = row.createEl("div", { text: suggestion.title });
    titleEl.style.fontWeight = "500";
    titleEl.style.cursor = "pointer";
    titleEl.addEventListener("click", () => {
      const file = this.app.vault.getAbstractFileByPath(suggestion.sourceNotePath);
      if (file) {
        this.app.workspace.openLinkText(suggestion.sourceNotePath, "");
      }
    });

    // Detail
    if (suggestion.detail) {
      const detailEl = row.createEl("div", { text: suggestion.detail });
      detailEl.style.fontSize = "0.85em";
      detailEl.style.color = "var(--text-muted)";
      detailEl.style.marginTop = "2px";
    }

    // Editable area for Anki cards
    if (suggestion.type === "anki-card" && suggestion.editable !== undefined) {
      const textarea = row.createEl("textarea");
      textarea.value = suggestion.editable;
      textarea.style.width = "100%";
      textarea.style.minHeight = "40px";
      textarea.style.marginTop = "6px";
      textarea.style.fontFamily = "var(--font-monospace)";
      textarea.style.fontSize = "0.85em";
      textarea.style.resize = "vertical";
      textarea.addEventListener("input", () => {
        this.store.updateEditable(suggestion.id, textarea.value);
      });
    }

    // Action buttons
    const actions = row.createDiv();
    actions.style.marginTop = "6px";
    actions.style.display = "flex";
    actions.style.gap = "6px";

    const acceptBtn = actions.createEl("button", { text: "Accept" });
    acceptBtn.style.fontSize = "0.8em";
    acceptBtn.addClass("mod-cta");
    acceptBtn.addEventListener("click", async () => {
      await this.handler.onAccept(suggestion);
      this.store.accept(suggestion.id);
      this.refresh();
    });

    const dismissBtn = actions.createEl("button", { text: "Dismiss" });
    dismissBtn.style.fontSize = "0.8em";
    dismissBtn.addEventListener("click", async () => {
      await this.handler.onDismiss(suggestion);
      this.store.dismiss(suggestion.id);
      this.refresh();
    });
  }
}
```

- [ ] **Step 2: Verify build compiles**

Run: `npm run build`
Expected: No errors. (May need to add stubs to the obsidian mock for `ItemView`, `WorkspaceLeaf`, `workspace.on`, `workspace.openLinkText`.)

- [ ] **Step 3: Update obsidian mock if needed**

Add to `tests/__mocks__/obsidian.ts` if not already present:

```typescript
export class ItemView {
  app: App;
  containerEl: HTMLElement = {
    children: [{}, { empty: () => {}, createEl: () => ({}), createDiv: () => ({}), addClass: () => {} }],
  } as any;
  leaf: WorkspaceLeaf;

  constructor(leaf: WorkspaceLeaf) {
    this.leaf = leaf;
    this.app = leaf.app ?? new App();
  }

  getViewType(): string { return ""; }
  getDisplayText(): string { return ""; }
  getIcon(): string { return ""; }
  registerEvent(_event: unknown): void {}

  async onOpen(): Promise<void> {}
  async onClose(): Promise<void> {}
}

export class WorkspaceLeaf {
  app = new App();
}
```

- [ ] **Step 4: Commit**

```bash
git add src/suggestions/panel.ts tests/__mocks__/obsidian.ts
git commit -m "feat: add suggestions panel sidebar view with accept/edit/dismiss actions"
```

---

## Task 6: Wire Anki Module & Panel into main.ts

**Files:**
- Modify: `src/main.ts`

This is the integration task. It wires together the suggestions store, Anki module, panel, and migrates the existing toast-based tag/connection flows to emit suggestions.

- [ ] **Step 1: Add imports and new instance variables**

Add at the top of `main.ts`:

```typescript
import { AnkiModule } from "./modules/anki/anki";
import { CardMigration } from "./modules/anki/card-migration";
import { SuggestionsStore } from "./suggestions/store";
import { SuggestionsPanel, SUGGESTIONS_VIEW_TYPE, SuggestionHandler } from "./suggestions/panel";
import { createSuggestion, Suggestion } from "./suggestions/suggestion";
```

Add instance variables to `AssistantPlugin`:

```typescript
  private ankiModule = new AnkiModule();
  private cardMigration!: CardMigration;
  private suggestionsStore!: SuggestionsStore;
  private suggestionsPanel: SuggestionsPanel | null = null;
```

- [ ] **Step 2: Initialize suggestions store and panel in onload()**

After `await this.initializeVaultFolder();`, add:

```typescript
    // Load suggestions store
    this.suggestionsStore = await this.loadSuggestionsStore();
    this.cardMigration = new CardMigration(this.vaultService);

    // Register suggestions panel view
    this.registerView(SUGGESTIONS_VIEW_TYPE, (leaf) => {
      this.suggestionsPanel = new SuggestionsPanel(
        leaf,
        this.suggestionsStore,
        this.createSuggestionHandler(),
      );
      this.checkAnkiPlugin();
      return this.suggestionsPanel;
    });

    // Add ribbon icon to open panel
    this.addRibbonIcon("lightbulb", "AI Suggestions", () => {
      this.activateSuggestionsPanel();
    });
```

- [ ] **Step 3: Add suggestions store persistence methods**

```typescript
  private async loadSuggestionsStore(): Promise<SuggestionsStore> {
    const content = await this.vaultService.readNote(`${ASSISTANT_FOLDER}/suggestions.json`);
    if (content) {
      try { return SuggestionsStore.deserialize(content); } catch { /* start fresh */ }
    }
    return new SuggestionsStore();
  }

  private async saveSuggestionsStore(): Promise<void> {
    await this.vaultService.writeNote(
      `${ASSISTANT_FOLDER}/suggestions.json`,
      this.suggestionsStore.serialize(),
    );
  }
```

- [ ] **Step 4: Add panel activation and Anki plugin check**

```typescript
  private async activateSuggestionsPanel(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(SUGGESTIONS_VIEW_TYPE);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: SUGGESTIONS_VIEW_TYPE, active: true });
      this.app.workspace.revealLeaf(leaf);
    }
  }

  private checkAnkiPlugin(): void {
    if (!this.settings.ankiEnabled || !this.suggestionsPanel) return;

    const ankiPlugin = (this.app as any).plugins?.getPlugin?.("obsidian-to-anki-plugin");
    if (!ankiPlugin) {
      this.suggestionsPanel.setSetupGuide(
        `<strong>Anki Setup Required</strong><br>
        To sync flashcards to Anki:<br>
        1. Install <em>Obsidian to Anki</em> from Community Plugins<br>
        2. Install <em>AnkiConnect</em> add-on in Anki (code: 2055492159)<br>
        3. Have Anki running when you want to sync<br><br>
        <em>Cards still work as markdown study material without Anki.</em>`,
      );
    } else {
      this.suggestionsPanel.setSetupGuide(null);
    }
  }
```

- [ ] **Step 5: Add Anki commands**

Register in `onload()`:

```typescript
    this.addCommand({
      id: "suggest-anki-cards",
      name: "Suggest Anki cards for this note",
      callback: () => this.suggestAnkiCards(),
    });
```

Implement the command:

```typescript
  private async suggestAnkiCards(): Promise<void> {
    if (!this.settings.ankiEnabled) {
      showNotice("Enable Anki card suggestions in settings first.");
      return;
    }

    const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
    if (!file) {
      showNotice("No active note.");
      return;
    }

    const content = await this.vaultService.readNote(file.path);
    if (!content) return;

    const existingCards = this.ankiModule.extractExistingCards(content);
    const prompt = this.ankiModule.buildPrompt({
      noteContent: content,
      existingCards,
      cardFormat: this.settings.ankiCardFormat,
    });

    const task = createTask({
      type: "anki",
      action: "suggest-cards",
      payload: {
        notePath: file.path,
        systemPrompt: prompt.system,
        prompt: prompt.prompt,
        maxTokens: prompt.maxTokens,
      },
      modelRequirement: ModelRequirement.ClaudeRequired,
      trigger: TaskTrigger.Manual,
    });

    this.orchestrator.queue.enqueue(task);
    showNotice(`Queued card suggestions for ${file.basename}`);
  }
```

- [ ] **Step 6: Add Anki auto-suggest trigger in onload()**

After the existing auto-trigger registrations:

```typescript
    if (this.settings.ankiEnabled && this.settings.ankiAutoSuggestOnSave) {
      this.registerEvent(
        this.app.vault.on("modify", (file) => {
          if (file instanceof TFile && file.extension === "md") {
            this.debounceAnkiSuggest(file.path, 10000);
          }
        }),
      );
    }
```

Add the debounce method (reusing the existing debounceTimers pattern with a prefix):

```typescript
  private debounceAnkiSuggest(path: string, delayMs: number): void {
    const key = `anki:${path}`;
    const existing = this.debounceTimers.get(key);
    if (existing) clearTimeout(existing);

    this.debounceTimers.set(
      key,
      setTimeout(() => {
        this.debounceTimers.delete(key);
        this.enqueueAnkiSuggest(path);
      }, delayMs),
    );
  }

  private async enqueueAnkiSuggest(path: string): Promise<void> {
    if (!this.settings.ankiEnabled) return;

    const content = await this.vaultService.readNote(path);
    if (!content) return;

    const existingCards = this.ankiModule.extractExistingCards(content);
    const prompt = this.ankiModule.buildPrompt({
      noteContent: content,
      existingCards,
      cardFormat: this.settings.ankiCardFormat,
    });

    const task = createTask({
      type: "anki",
      action: "suggest-cards",
      payload: {
        notePath: path,
        systemPrompt: prompt.system,
        prompt: prompt.prompt,
        maxTokens: prompt.maxTokens,
      },
      modelRequirement: ModelRequirement.ClaudeRequired,
      trigger: TaskTrigger.Automatic,
    });

    this.orchestrator.queue.enqueue(task);
  }
```

- [ ] **Step 7: Add Anki task completion handler**

In `handleTaskCompleted`, add a new case:

```typescript
      case "suggest-cards":
        await this.handleAnkiResult(task, response);
        break;
```

Implement the handler:

```typescript
  private async handleAnkiResult(task: Task, response: LLMResponse): Promise<void> {
    const cards = this.ankiModule.parseResponse(response.content);
    if (!cards || cards.length === 0) return;

    const notePath = task.payload.notePath;
    if (!this.vaultService.noteExists(notePath)) return;

    // Emit each card as a suggestion
    for (const card of cards) {
      const cardText = this.ankiModule.formatCardMarkdown(card);
      const sug = createSuggestion({
        type: "anki-card",
        sourceNotePath: notePath,
        title: card.type === "basic" ? card.front : card.text.slice(0, 50) + "...",
        detail: card.type === "basic" ? `${card.front}::${card.back}` : card.text,
        editable: cardText,
      });
      this.suggestionsStore.add(sug);
    }

    await this.saveSuggestionsStore();
    this.suggestionsPanel?.refresh();
    showNotice(`${cards.length} card suggestions — check the panel`);
  }
```

- [ ] **Step 8: Create the suggestion acceptance handler**

```typescript
  private createSuggestionHandler(): SuggestionHandler {
    return {
      onAccept: async (suggestion: Suggestion) => {
        switch (suggestion.type) {
          case "tag":
            await this.acceptTagSuggestion(suggestion);
            break;
          case "connection":
            await this.acceptConnectionSuggestion(suggestion);
            break;
          case "anki-card":
            await this.acceptAnkiCardSuggestion(suggestion);
            break;
        }
        await this.saveSuggestionsStore();
      },
      onDismiss: async (suggestion: Suggestion) => {
        if (suggestion.type === "tag") {
          await this.dismissTagSuggestion(suggestion);
        }
        await this.saveSuggestionsStore();
      },
    };
  }

  private async acceptTagSuggestion(suggestion: Suggestion): Promise<void> {
    const fm = await this.vaultService.parseFrontmatter(suggestion.sourceNotePath);
    const existingTags = fm.tags ?? [];
    const existingRejected = fm["rejected-tags"] ?? [];
    await this.vaultService.updateFrontmatter(suggestion.sourceNotePath, {
      tags: [...existingTags, suggestion.title],
      "suggested-tags": undefined,
      "ai-tagged": true,
    });
  }

  private async dismissTagSuggestion(suggestion: Suggestion): Promise<void> {
    const fm = await this.vaultService.parseFrontmatter(suggestion.sourceNotePath);
    const existingRejected = fm["rejected-tags"] ?? [];
    await this.vaultService.updateFrontmatter(suggestion.sourceNotePath, {
      "rejected-tags": [...existingRejected, suggestion.title],
    });
  }

  private async acceptConnectionSuggestion(suggestion: Suggestion): Promise<void> {
    const content = await this.vaultService.readNote(suggestion.sourceNotePath);
    if (!content) return;

    const linkName = suggestion.title;
    const relatedLine = `- [[${linkName}]] — ${suggestion.detail}`;

    if (content.includes("\n## Related")) {
      const beforeRelated = content.split("\n## Related")[0];
      const afterParts = content.split("\n## Related")[1] ?? "";
      const updated = `${beforeRelated}\n## Related${afterParts.replace(/\s*$/, "")}\n${relatedLine}\n`;
      await this.vaultService.writeNote(suggestion.sourceNotePath, updated);
    } else {
      await this.vaultService.writeNote(
        suggestion.sourceNotePath,
        `${content.replace(/\s*$/, "")}\n\n## Related\n${relatedLine}\n`,
      );
    }
  }

  private async acceptAnkiCardSuggestion(suggestion: Suggestion): Promise<void> {
    const cardText = suggestion.editable ?? suggestion.detail;
    const notePath = suggestion.sourceNotePath;

    if (this.settings.ankiCardLocation === "separate-file") {
      const cardFilePath = this.cardMigration.getCardFilePath(
        notePath,
        `${ASSISTANT_FOLDER}/cards`,
      );
      const existing = await this.vaultService.readNote(cardFilePath);
      if (existing) {
        const updated = this.ankiModule.appendCardsToContent(existing, [cardText]);
        await this.vaultService.writeNote(cardFilePath, updated);
      } else {
        const content = this.ankiModule.buildFlashcardsSection([cardText]);
        await this.vaultService.writeNote(cardFilePath, content.trim() + "\n");
      }
    } else {
      const content = await this.vaultService.readNote(notePath);
      if (!content) return;
      const updated = this.ankiModule.appendCardsToContent(content, [cardText]);
      await this.vaultService.writeNote(notePath, updated);
    }
  }
```

- [ ] **Step 9: Wire card location migration**

Update the `AssistantSettingTab` constructor call in `onload()` to pass the migration callback:

```typescript
    this.addSettingTab(
      new AssistantSettingTab(
        this.app,
        this,
        this.settings,
        async (s) => {
          this.settings = s;
          await this.saveSettings();
        },
        (oldLocation, newLocation) => {
          this.queueCardMigration(oldLocation, newLocation);
        },
      ),
    );
```

Add the migration method:

```typescript
  private queueCardMigration(
    oldLocation: string,
    newLocation: string,
  ): void {
    const task = createTask({
      type: "anki",
      action: "migrate-cards",
      payload: { from: oldLocation, to: newLocation },
      modelRequirement: ModelRequirement.LocalOnly,
      trigger: TaskTrigger.Manual,
    });
    this.orchestrator.queue.enqueue(task);
    showNotice("Card migration queued. Cards will be moved in the background.");
  }
```

Add the migration handler to `handleTaskCompleted`:

```typescript
      case "migrate-cards":
        await this.handleCardMigration(task);
        break;
```

```typescript
  private async handleCardMigration(task: Task): Promise<void> {
    const { from, to } = task.payload;
    const cardsFolder = `${ASSISTANT_FOLDER}/cards`;
    const files = this.vaultService.getMarkdownFiles();

    for (const file of files) {
      if (file.path.startsWith(`${ASSISTANT_FOLDER}/`)) continue; // Skip plugin files

      if (to === "separate-file") {
        await this.cardMigration.migrateToSeparateFile(file.path, cardsFolder);
      } else {
        await this.cardMigration.migrateToInNote(file.path, cardsFolder);
      }
    }
    showNotice("Card migration complete.");
  }
```

- [ ] **Step 10: Add persistence to onunload()**

Add to `onunload()`:

```typescript
    await this.saveSuggestionsStore();
```

- [ ] **Step 11: Verify build compiles**

Run: `npm run build`
Expected: No errors.

- [ ] **Step 12: Run full test suite**

Run: `npm test`
Expected: All existing tests still pass (new code is additive).

- [ ] **Step 13: Commit**

```bash
git add src/main.ts
git commit -m "feat: wire Anki module, suggestions panel, and acceptance handlers into plugin lifecycle"
```

---

## Task 7: Migrate Existing Tag & Connection Suggestions to Panel

**Files:**
- Modify: `src/main.ts`

This task changes the existing `handleTagResult` and `handleConnectionResult` to emit suggestions into the store instead of opening modals directly.

- [ ] **Step 1: Rewrite handleTagResult to emit suggestions**

Replace the existing `handleTagResult` method body. Instead of showing a clickable notice that opens a SuggestionModal, emit tag suggestions into the store:

```typescript
  private async handleTagResult(task: Task, response: LLMResponse): Promise<void> {
    let suggestedTags: string[] | null = null;

    if (task.payload._batchSize > 1) {
      const batchResult = this.tagger.parseBatchResponse(task.payload._batchResponse);
      if (batchResult) {
        suggestedTags = batchResult[task.payload.notePath] ?? null;
      }
    } else {
      const result = this.tagger.parseResponse(response.content);
      suggestedTags = result?.tags ?? null;
    }

    if (!suggestedTags || suggestedTags.length === 0) return;

    const notePath = task.payload.notePath;
    if (!this.vaultService.noteExists(notePath)) return;

    // Still write to frontmatter for backwards compat
    await this.vaultService.updateFrontmatter(notePath, {
      "suggested-tags": suggestedTags,
    });

    // Emit to suggestions store
    for (const tag of suggestedTags) {
      const sug = createSuggestion({
        type: "tag",
        sourceNotePath: notePath,
        title: tag,
        detail: `Suggested tag for ${notePath.split("/").pop()}`,
      });
      this.suggestionsStore.add(sug);
    }

    await this.saveSuggestionsStore();
    this.suggestionsPanel?.refresh();
    showNotice(`${suggestedTags.length} tag suggestions — check the panel`);
  }
```

- [ ] **Step 2: Rewrite handleConnectionResult to emit suggestions**

Replace the existing `handleConnectionResult` method body:

```typescript
  private async handleConnectionResult(task: Task, response: LLMResponse): Promise<void> {
    const suggestions = this.connections.parseResponse(response.content);
    if (!suggestions || suggestions.length === 0) return;

    const notePath = task.payload.notePath;
    if (!this.vaultService.noteExists(notePath)) return;

    for (const conn of suggestions) {
      const linkName = conn.path.replace(/\.md$/, "");
      const sug = createSuggestion({
        type: "connection",
        sourceNotePath: notePath,
        title: linkName,
        detail: conn.reason,
      });
      this.suggestionsStore.add(sug);
    }

    await this.saveSuggestionsStore();
    this.suggestionsPanel?.refresh();
    showNotice(`${suggestions.length} connection suggestions — check the panel`);
  }
```

- [ ] **Step 3: Verify build compiles and tests pass**

Run: `npm run build && npm test`
Expected: No errors, all tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/main.ts
git commit -m "feat: migrate tag and connection suggestions from toast/modal to suggestions panel"
```

---

## Task 8: Integration Test — Anki Flow

**Files:**
- Create: `tests/integration/anki-flow.test.ts`

- [ ] **Step 1: Write integration test**

```typescript
// tests/integration/anki-flow.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Orchestrator } from "@/orchestrator/orchestrator";
import { TaskQueue } from "@/orchestrator/queue";
import { TaskRouter } from "@/orchestrator/router";
import { TaskBatcher } from "@/orchestrator/batcher";
import { CostTracker } from "@/orchestrator/cost-tracker";
import { AnkiModule } from "@/modules/anki/anki";
import { SuggestionsStore } from "@/suggestions/store";
import { createSuggestion, _resetSuggestionIdCounter } from "@/suggestions/suggestion";
import { createTask, _resetIdCounter } from "@/orchestrator/task";
import { ModelRequirement, TaskTrigger, TaskStatus } from "@/types";
import { LLMProvider, LLMResponse } from "@/llm/provider";

describe("Anki card suggestion end-to-end flow", () => {
  let queue: TaskQueue;
  let costTracker: CostTracker;
  let onTaskCompleted: ReturnType<typeof vi.fn>;
  let orchestrator: Orchestrator;
  const anki = new AnkiModule();
  let suggestionsStore: SuggestionsStore;

  beforeEach(() => {
    _resetIdCounter();
    _resetSuggestionIdCounter();
    queue = new TaskQueue();
    costTracker = new CostTracker();
    suggestionsStore = new SuggestionsStore();
    onTaskCompleted = vi.fn();

    const mockClaude: LLMProvider = {
      id: "claude",
      isAvailable: vi.fn().mockResolvedValue(true),
      complete: vi.fn().mockResolvedValue({
        content: JSON.stringify({
          cards: [
            { type: "basic", front: "What is attention?", back: "A mechanism for weighing input relevance" },
            { type: "cloze", text: "Transformers use {{c1::self-attention}} to process sequences." },
          ],
        }),
        tokensUsed: { input: 500, output: 200 },
        model: "claude-haiku-4-5-20251001",
        durationMs: 1200,
      } satisfies LLMResponse),
    };

    const mockOllama: LLMProvider = {
      id: "ollama",
      isAvailable: vi.fn().mockResolvedValue(false),
      complete: vi.fn(),
    };

    orchestrator = new Orchestrator({
      queue,
      router: new TaskRouter(mockOllama, mockClaude, false),
      batcher: new TaskBatcher({ maxBatchSize: 10, contextWindowTokens: 8000 }),
      costTracker,
      providers: { ollama: mockOllama, claude: mockClaude },
      settings: { claudeDailyBudget: 0, claudeMonthlyBudget: 0 },
      onTaskCompleted,
      onTaskFailed: vi.fn(),
      onTaskDeferred: vi.fn(),
      onCostWarning: vi.fn(),
    });
  });

  it("processes a suggest-cards task and returns parseable cards", async () => {
    const noteContent = "# Transformers\nTransformers use self-attention mechanisms.";
    const prompt = anki.buildPrompt({
      noteContent,
      existingCards: [],
      cardFormat: "both",
    });

    const task = createTask({
      type: "anki",
      action: "suggest-cards",
      payload: {
        notePath: "transformers.md",
        systemPrompt: prompt.system,
        prompt: prompt.prompt,
        maxTokens: prompt.maxTokens,
      },
      modelRequirement: ModelRequirement.ClaudeRequired,
      trigger: TaskTrigger.Manual,
    });

    queue.enqueue(task);
    await orchestrator.processNext();

    expect(queue.getTask(task.id)?.status).toBe(TaskStatus.Completed);
    expect(onTaskCompleted).toHaveBeenCalledTimes(1);

    const [completedTask, response] = onTaskCompleted.mock.calls[0];
    const cards = anki.parseResponse(response.content);
    expect(cards).toHaveLength(2);
    expect(cards![0].type).toBe("basic");
    expect(cards![1].type).toBe("cloze");

    // Simulate what main.ts handleAnkiResult would do
    for (const card of cards!) {
      const cardText = anki.formatCardMarkdown(card);
      const sug = createSuggestion({
        type: "anki-card",
        sourceNotePath: completedTask.payload.notePath,
        title: card.type === "basic" ? card.front! : card.text!.slice(0, 50),
        detail: cardText,
        editable: cardText,
      });
      suggestionsStore.add(sug);
    }

    const pending = suggestionsStore.getForNote("transformers.md");
    expect(pending).toHaveLength(2);
    expect(pending[0].type).toBe("anki-card");
    expect(pending[0].editable).toContain("::");
    expect(pending[1].editable).toContain("{{c1::");
  });

  it("routes suggest-cards to Claude, not Ollama", async () => {
    const prompt = anki.buildPrompt({
      noteContent: "# Test",
      existingCards: [],
      cardFormat: "both",
    });

    const task = createTask({
      type: "anki",
      action: "suggest-cards",
      payload: {
        notePath: "test.md",
        systemPrompt: prompt.system,
        prompt: prompt.prompt,
        maxTokens: prompt.maxTokens,
      },
      modelRequirement: ModelRequirement.ClaudeRequired,
      trigger: TaskTrigger.Manual,
    });

    queue.enqueue(task);
    await orchestrator.processNext();

    const ollama = orchestrator["config"].providers.ollama;
    expect(ollama.complete).not.toHaveBeenCalled();
  });

  it("records Claude cost for card suggestions", async () => {
    const prompt = anki.buildPrompt({
      noteContent: "# Test",
      existingCards: [],
      cardFormat: "both",
    });

    const task = createTask({
      type: "anki",
      action: "suggest-cards",
      payload: {
        notePath: "test.md",
        systemPrompt: prompt.system,
        prompt: prompt.prompt,
        maxTokens: prompt.maxTokens,
      },
      modelRequirement: ModelRequirement.ClaudeRequired,
      trigger: TaskTrigger.Manual,
    });

    queue.enqueue(task);
    await orchestrator.processNext();

    const summary = costTracker.getSummary();
    expect(summary.callCount).toBe(1);
    expect(summary.todayDollars).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run integration tests**

Run: `npm test -- tests/integration/anki-flow.test.ts`
Expected: All tests pass.

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/anki-flow.test.ts
git commit -m "test: add end-to-end integration test for Anki card suggestion flow"
```

---

## Task 9: Final Verification

- [ ] **Step 1: Run full test suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 2: Run production build**

Run: `npm run build`
Expected: `main.js` produced with no errors.

- [ ] **Step 3: Verify new file structure**

Run: `find src/suggestions src/modules/anki tests/suggestions tests/modules/anki* tests/modules/card* tests/integration/anki* -type f | sort`

Expected:
```
src/modules/anki/anki.ts
src/modules/anki/card-migration.ts
src/suggestions/panel.ts
src/suggestions/store.ts
src/suggestions/suggestion.ts
tests/integration/anki-flow.test.ts
tests/modules/anki.test.ts
tests/modules/card-migration.test.ts
tests/suggestions/store.test.ts
```

- [ ] **Step 4: Commit any remaining changes**

```bash
git add -A
git status
# Only commit if there are changes
git commit -m "chore: final cleanup for Anki and suggestions panel feature"
```
