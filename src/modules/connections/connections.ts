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

    const prompt = `Decide which candidate notes, if any, are meaningfully related to the source note.

Rules:
- A connection must be specific and substantive — shared topic, shared concept, or one note extending/contradicting the other.
- Generic similarities do NOT count: "both discuss personal development", "both use structured formats", "both contain templates" are NOT connections.
- Code examples, templates, and syntax-only notes rarely have meaningful connections to prose notes. When the source note is primarily code or a template, it is very likely that NONE of the candidates are related.
- If a candidate is only related through vague thematic overlap, do NOT include it.
- Returning an empty list is the correct answer when no strong connections exist. Most notes are not meaningfully connected.

## Source note: "${input.sourceTitle}"
Tags: ${input.sourceTags.join(", ") || "none"}
${input.sourceSummary}

## Candidates
${candidateList}

Respond with JSON only: {"connections": [{"path": "note.md", "reason": "one sentence explaining the specific connection"}]}
If none are meaningfully related (this is common), return: {"connections": []}`;

    return {
      system:
        "You are a knowledge graph assistant. You identify meaningful connections between notes in a personal vault. Precision matters more than recall — only suggest connections you are confident about. Returning an empty list is preferred over suggesting weak connections. Always respond with valid JSON only.",
      prompt,
      maxTokens: 500,
      temperature: 0.2,
      jsonMode: true,
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
