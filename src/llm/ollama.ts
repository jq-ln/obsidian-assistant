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
  private readonly HEALTH_TIMEOUT_MS = 5_000;
  private readonly REQUEST_TIMEOUT_MS = 120_000;

  constructor(endpoint: string, model: string) {
    this.endpoint = endpoint.replace(/\/$/, "");
    this.model = model;
  }

  updateConfig(config: Record<string, string>): void {
    if (config.endpoint !== undefined) {
      this.endpoint = config.endpoint.replace(/\/$/, "");
      this.cachedAvailable = null;
      this.cacheTimestamp = 0;
    }
    if (config.model !== undefined) {
      this.model = config.model;
    }
  }

  async isAvailable(): Promise<boolean> {
    const now = Date.now();
    if (this.cachedAvailable !== null && now - this.cacheTimestamp < this.CACHE_TTL_MS) {
      return this.cachedAvailable;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.HEALTH_TIMEOUT_MS);
      try {
        const response = await fetch(`${this.endpoint}/api/tags`, { signal: controller.signal });
        this.cachedAvailable = response.ok;
      } finally {
        clearTimeout(timeoutId);
      }
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
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.REQUEST_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${this.endpoint}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: this.model,
          system: request.system,
          prompt: request.prompt,
          stream: false,
          ...(request.jsonMode !== false ? { format: "json" } : {}),
          options: {
            num_predict: request.maxTokens,
            temperature: request.temperature ?? 0.3,
          },
        }),
      });
    } catch (error: any) {
      clearTimeout(timeoutId);
      this.invalidateCache();
      if (error.name === "AbortError") {
        throw new Error(`Ollama request timed out after ${this.REQUEST_TIMEOUT_MS / 1000}s`);
      }
      throw error;
    }

    clearTimeout(timeoutId);

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
