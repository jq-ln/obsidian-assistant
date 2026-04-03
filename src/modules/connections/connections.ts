// src/modules/connections/connections.ts
import { LLMRequest } from "../../llm/provider";

export interface ConnectionPromptInput {
  sourceTitle: string;
  sourceTags: string[];
  sourceSummary: string;
  candidates: Array<{
    path: string;
    title: string;
    tags: string[];
    keywords: string[];
    summary: string;
  }>;
}

export interface ConnectionSuggestion {
  path: string;
  reason: string;
}

export class ConnectionModule {
  buildPrompt(input: ConnectionPromptInput): LLMRequest {
    const candidateList = input.candidates
      .map(
        (c) =>
          `### ${c.path} — "${c.title}"\nTags: ${c.tags.join(", ") || "none"}\nKey concepts: ${c.keywords.join(", ") || "none"}\n${c.summary}`,
      )
      .join("\n\n");

    const prompt = `Analyze whether any of the candidate notes are meaningfully related to the source note. Return only strong, non-obvious connections — not just surface-level keyword overlap.

## Source note: "${input.sourceTitle}"
Tags: ${input.sourceTags.join(", ") || "none"}
${input.sourceSummary}

## Candidates
${candidateList}

Respond with JSON: {"connections": [{"path": "note.md", "reason": "one sentence explaining the connection"}]}
If none are meaningfully related, return: {"connections": []}`;

    return {
      system:
        "You are a knowledge graph assistant. You identify meaningful connections between notes in a knowledge vault. Only suggest strong connections. Always respond with valid JSON only.",
      prompt,
      maxTokens: 500,
      temperature: 0.2,
    };
  }

  parseResponse(raw: string): ConnectionSuggestion[] | null {
    try {
      const trimmed = raw.trim();
      const json = trimmed.startsWith("{")
        ? trimmed
        : trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)?.[1]?.trim();
      if (!json) return null;

      const parsed = JSON.parse(json);
      if (!parsed.connections || !Array.isArray(parsed.connections)) return null;

      return parsed.connections
        .filter(
          (c: any) => typeof c.path === "string" && typeof c.reason === "string",
        )
        .map((c: any) => ({ path: c.path, reason: c.reason }));
    } catch {
      return null;
    }
  }

  buildRelatedSection(connections: ConnectionSuggestion[]): string {
    const links = connections
      .map((c) => {
        const linkName = c.path.replace(/\.md$/, "");
        return `- [[${linkName}]] — ${c.reason}`;
      })
      .join("\n");

    return `\n\n## Related\n${links}\n`;
  }
}
