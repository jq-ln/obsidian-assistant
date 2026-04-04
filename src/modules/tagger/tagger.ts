// src/modules/tagger/tagger.ts
import { LLMRequest } from "../../llm/provider";

export interface TagPromptInput {
  noteContent: string;
  existingTags: string[];
  rejectedTags: string[];
  styleGuide: string;
}

export interface BatchTagPromptInput {
  notes: Array<{ path: string; content: string }>;
  existingTags: string[];
  rejectedTagsByNote: Record<string, string[]>;
  styleGuide: string;
}

export interface TagResult {
  tags: string[];
}

export class TaggerModule {
  buildPrompt(input: TagPromptInput): LLMRequest {
    const rejectedSection =
      input.rejectedTags.length > 0
        ? `\n\nThe user has previously rejected these tags for this note — do NOT suggest them again:\n${input.rejectedTags.map((t) => `- ${t}`).join("\n")}`
        : "";

    const prompt = `Given the following note, suggest appropriate tags. Prefer tags from the existing taxonomy. Only propose new tags if nothing in the taxonomy fits.

## Existing tags in vault
${input.existingTags.length > 0 ? input.existingTags.join(", ") : "(none yet)"}

## Style guide
${input.styleGuide || "No specific style guide."}
${rejectedSection}

## Note content
${input.noteContent}

Respond with a JSON object: {"tags": ["tag1", "tag2", ...]}
Return between 1 and 5 tags. Prefer fewer, more relevant tags over many vague ones.`;

    return {
      system:
        "You are a note tagging assistant. You analyze note content and suggest relevant tags. Always respond with valid JSON only, no extra text.",
      prompt,
      maxTokens: 200,
      temperature: 0.2,
      jsonMode: true,
    };
  }

  buildBatchPrompt(input: BatchTagPromptInput): LLMRequest {
    const noteSections = input.notes
      .map((note) => {
        const rejected = input.rejectedTagsByNote[note.path] ?? [];
        const rejectedLine =
          rejected.length > 0
            ? `\nPreviously rejected tags for this note: ${rejected.join(", ")}`
            : "";
        return `### ${note.path}${rejectedLine}\n${note.content}`;
      })
      .join("\n\n---\n\n");

    const prompt = `Tag each of the following notes. Prefer tags from the existing taxonomy.

## Existing tags in vault
${input.existingTags.length > 0 ? input.existingTags.join(", ") : "(none yet)"}

## Style guide
${input.styleGuide || "No specific style guide."}

## Notes
${noteSections}

Respond with JSON: {"results": [{"path": "note.md", "tags": ["tag1"]}, ...]}
Return between 1 and 5 tags per note.`;

    return {
      system:
        "You are a note tagging assistant. You analyze note content and suggest relevant tags. Always respond with valid JSON only, no extra text.",
      prompt,
      maxTokens: 100 * input.notes.length,
      temperature: 0.2,
      jsonMode: true,
    };
  }

  parseResponse(raw: string): TagResult | null {
    const json = this.extractJson(raw);
    if (!json) return null;

    try {
      const parsed = JSON.parse(json);
      if (parsed.tags && Array.isArray(parsed.tags)) {
        return { tags: parsed.tags.map(String) };
      }
      return null;
    } catch {
      return null;
    }
  }

  parseBatchResponse(raw: string): Record<string, string[]> | null {
    const json = this.extractJson(raw);
    if (!json) return null;

    try {
      const parsed = JSON.parse(json);
      if (!parsed.results || !Array.isArray(parsed.results)) return null;

      const result: Record<string, string[]> = {};
      for (const item of parsed.results) {
        if (item.path && Array.isArray(item.tags)) {
          result[item.path] = item.tags.map(String);
        }
      }
      return Object.keys(result).length > 0 ? result : null;
    } catch {
      return null;
    }
  }

  private extractJson(raw: string): string | null {
    // Try raw string first
    const trimmed = raw.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      return trimmed;
    }

    // Try extracting from markdown code block
    const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (codeBlockMatch) {
      return codeBlockMatch[1].trim();
    }

    return null;
  }
}
