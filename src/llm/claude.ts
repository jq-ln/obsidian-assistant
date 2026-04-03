import Anthropic from "@anthropic-ai/sdk";
import { LLMProvider, LLMRequest, LLMResponse } from "./provider";

export class ClaudeError extends Error {
  status: number;
  retryAfterSeconds: number | null;

  constructor(message: string, status: number, retryAfter: number | null = null) {
    super(message);
    this.name = "ClaudeError";
    this.status = status;
    this.retryAfterSeconds = retryAfter;
  }
}

export class ClaudeProvider implements LLMProvider {
  readonly id = "claude";

  private client: Anthropic | null = null;
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.apiKey = apiKey;
    this.model = model;
    if (apiKey) {
      this.client = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
    }
  }

  updateConfig(config: Record<string, string>): void {
    if (config.apiKey !== undefined) {
      this.apiKey = config.apiKey;
      this.client = config.apiKey ? new Anthropic({ apiKey: config.apiKey, dangerouslyAllowBrowser: true }) : null;
    }
    if (config.model !== undefined) {
      this.model = config.model;
    }
  }

  async isAvailable(): Promise<boolean> {
    return this.apiKey.length > 0;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    if (!this.client) {
      throw new ClaudeError("Claude API key not configured", 401);
    }

    const startMs = Date.now();

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: request.maxTokens,
        temperature: request.temperature ?? 0.3,
        system: request.system,
        messages: [{ role: "user", content: request.prompt }],
      });

      const textBlock = response.content.find((b: any) => b.type === "text");
      const content = textBlock ? (textBlock as any).text : "";

      return {
        content,
        tokensUsed: {
          input: response.usage.input_tokens,
          output: response.usage.output_tokens,
        },
        model: this.model,
        durationMs: Date.now() - startMs,
      };
    } catch (error: any) {
      if (error.status === 429) {
        const retryAfter = error.headers?.["retry-after"]
          ? parseInt(error.headers["retry-after"], 10)
          : null;
        throw new ClaudeError(error.message, 429, retryAfter);
      }
      if (error.status) {
        throw new ClaudeError(error.message, error.status);
      }
      throw error;
    }
  }
}
