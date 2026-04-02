// src/modules/tagger/tag-audit.ts
import { LLMRequest } from "../../llm/provider";

export interface AuditSuggestion {
  action: "merge";
  tags: string[];
  into: string;
  reason: string;
}

export class TagAuditModule {
  buildAuditPrompt(allTags: string[]): LLMRequest {
    const prompt = `Analyze the following list of tags from a knowledge vault. Identify tags that should be merged because they are:
- Case variants (e.g., "AI" and "ai")
- Plural/singular variants (e.g., "project" and "projects")
- Abbreviations of each other (e.g., "ml" and "machine-learning")
- Semantically equivalent (e.g., "deep-learning" and "dl")

## Tags
${allTags.join(", ")}

For each group of tags that should be merged, suggest which one to keep (prefer the more descriptive, kebab-case form).

Respond with JSON:
{"suggestions": [{"action": "merge", "tags": ["tag1", "tag2"], "into": "preferred-tag", "reason": "why"}]}

If no merges are needed, respond with: {"suggestions": []}`;

    return {
      system:
        "You are a tag taxonomy analyst. You identify redundant or inconsistent tags in a knowledge vault. Always respond with valid JSON only.",
      prompt,
      maxTokens: 1000,
      temperature: 0.1,
    };
  }

  parseAuditResponse(raw: string): AuditSuggestion[] | null {
    try {
      const trimmed = raw.trim();
      const json = trimmed.startsWith("{")
        ? trimmed
        : trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)?.[1]?.trim();
      if (!json) return null;

      const parsed = JSON.parse(json);
      if (!parsed.suggestions || !Array.isArray(parsed.suggestions)) return null;

      return parsed.suggestions.filter(
        (s: any) =>
          s.action === "merge" &&
          Array.isArray(s.tags) &&
          typeof s.into === "string" &&
          typeof s.reason === "string",
      );
    } catch {
      return null;
    }
  }

  /**
   * Given a merge suggestion and an index of tag → files,
   * return the list of files that need to be modified
   * (files containing a tag variant that is NOT the target).
   */
  computeAffectedFiles(
    suggestion: AuditSuggestion,
    tagIndex: Record<string, string[]>,
  ): string[] {
    const affectedSet = new Set<string>();
    for (const tag of suggestion.tags) {
      if (tag !== suggestion.into) {
        const files = tagIndex[tag] ?? [];
        for (const file of files) {
          affectedSet.add(file);
        }
      }
    }
    return Array.from(affectedSet);
  }
}
