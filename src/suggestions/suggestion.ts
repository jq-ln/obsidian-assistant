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
