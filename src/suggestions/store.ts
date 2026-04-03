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
