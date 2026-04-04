import { LLMRequest } from "../llm/provider";

export interface TaskItem {
  text: string;
  sourcePath: string;
  dueDate?: string;
}

export interface TrackingDataItem {
  name: string;
  unit: string;
  recentValues: number[];
  goalValue?: number;
  goalDirection?: "<" | ">" | "=";
}

export interface BriefingInput {
  tasks: TaskItem[];
  trackingData: TrackingDataItem[];
  recentNoteTitles: string[];
}

const SYSTEM_PROMPT =
  "You are a personal productivity assistant. Write a 2-3 sentence daily briefing highlighting what's urgent, what's trending, and any notable patterns. Be specific and concise. No filler.";

export class BriefingBuilder {
  private cachedText: string | null = null;
  private cachedAt: number | null = null;

  buildPrompt(input: BriefingInput): LLMRequest {
    const lines: string[] = [];

    const tasks = input.tasks.slice(0, 15);
    if (tasks.length > 0) {
      lines.push("## Tasks");
      for (const task of tasks) {
        const due = task.dueDate ? ` (due: ${task.dueDate})` : "";
        lines.push(`- ${task.text}${due}`);
      }
    }

    if (input.trackingData.length > 0) {
      lines.push("## Tracking");
      for (const item of input.trackingData) {
        const latest = item.recentValues[item.recentValues.length - 1];
        const allValues = item.recentValues.join(", ");
        let goalStr = "";
        if (item.goalValue !== undefined && item.goalDirection !== undefined) {
          goalStr = ` | goal: ${item.goalDirection}${item.goalValue} ${item.unit}`;
        }
        lines.push(
          `- ${item.name}: recent values [${allValues}] ${item.unit} (latest: ${latest})${goalStr}`
        );
      }
    }

    const noteTitles = input.recentNoteTitles.slice(0, 20);
    if (noteTitles.length > 0) {
      lines.push("## Recent Notes");
      for (const title of noteTitles) {
        lines.push(`- ${title}`);
      }
    }

    const prompt =
      lines.length > 0
        ? `Here is today's vault data:\n\n${lines.join("\n")}\n\nPlease write a daily briefing.`
        : "No vault data available. Please write a brief daily briefing.";

    return {
      system: SYSTEM_PROMPT,
      prompt,
      maxTokens: 200,
      jsonMode: false,
    };
  }

  setCachedBriefing(text: string, timestamp: number): void {
    this.cachedText = text;
    this.cachedAt = timestamp;
  }

  getCachedBriefing(ttlMinutes: number): string | null {
    if (this.cachedText === null || this.cachedAt === null) {
      return null;
    }
    const ageMs = Date.now() - this.cachedAt;
    if (ageMs > ttlMinutes * 60 * 1000) {
      return null;
    }
    return this.cachedText;
  }
}
