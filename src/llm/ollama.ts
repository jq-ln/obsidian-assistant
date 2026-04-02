import { LLMProvider, LLMRequest, LLMResponse } from "./provider";

interface OllamaGenerateResponse {
  response: string;
  eval_count?: number;
  prompt_eval_count?: number;
  total_duration?: number; // nanoseconds
}

export class OllamaProvider implements LLMProvider {
  readonly id = "ollama";

  private endpoint: string;
  private model: string;
  private cachedAvailable: boolean | null = null;
  private cacheTimestamp = 0;
  private readonly CACHE_TTL_MS = 30_000;

  constructor(endpoint: string, model: string) {
    this.endpoint = endpoint.replace(/\/$/, "");
    this.model = model;
  }

  async isAvailable(): Promise<boolean> {
    const now = Date.now();
    if (this.cachedAvailable !== null && now - this.cacheTimestamp < this.CACHE_TTL_MS) {
      return this.cachedAvailable;
    }

    try {
      const response = await fetch(`${this.endpoint}/api/tags`);
      this.cachedAvailable = response.ok;
    } catch {
      this.cachedAvailable = false;
    }

    this.cacheTimestamp = now;
    return this.cachedAvailable;
  }

  private invalidateCache(): void {
    this.cachedAvailable = null;
    this.cacheTimestamp = 0;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const startMs = Date.now();

    let response: Response;
    try {
      response = await fetch(`${this.endpoint}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          system: request.system,
          prompt: request.prompt,
          stream: false,
          format: "json",
          options: {
            num_predict: request.maxTokens,
            temperature: request.temperature ?? 0.3,
          },
        }),
      });
    } catch (error) {
      this.invalidateCache();
      throw error;
    }

    if (!response.ok) {
      this.invalidateCache();
      throw new Error(`Ollama request failed: ${response.status} ${response.statusText}`);
    }

    const data: OllamaGenerateResponse = await response.json();

    return {
      content: data.response,
      tokensUsed: {
        input: data.prompt_eval_count ?? 0,
        output: data.eval_count ?? 0,
      },
      model: this.model,
      durationMs: data.total_duration ? data.total_duration / 1_000_000 : Date.now() - startMs,
    };
  }
}
