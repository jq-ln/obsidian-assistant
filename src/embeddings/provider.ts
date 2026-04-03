export interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  isAvailable(): Promise<boolean>;
  updateConfig?(config: { endpoint: string }): void;
}

export class OllamaEmbeddingProvider implements EmbeddingProvider {
  private endpoint: string;
  private cachedAvailable: boolean | null = null;
  private cacheTimestamp = 0;
  private readonly CACHE_TTL_MS = 30_000;
  private readonly HEALTH_TIMEOUT_MS = 5_000;
  private readonly EMBED_TIMEOUT_MS = 10_000;

  constructor(endpoint: string) {
    this.endpoint = endpoint.replace(/\/$/, "");
  }

  updateConfig(config: { endpoint: string }): void {
    if (config.endpoint !== undefined) {
      this.endpoint = config.endpoint.replace(/\/$/, "");
      this.cachedAvailable = null;
      this.cacheTimestamp = 0;
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

  async embed(text: string): Promise<number[]> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.EMBED_TIMEOUT_MS);

    let response: Response;
    try {
      response = await fetch(`${this.endpoint}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: controller.signal,
        body: JSON.stringify({
          model: "nomic-embed-text",
          input: text,
        }),
      });
    } catch (error: any) {
      clearTimeout(timeoutId);
      if (error.name === "AbortError") {
        throw new Error(`Embed request timed out after ${this.EMBED_TIMEOUT_MS / 1000}s`);
      }
      throw error;
    }

    clearTimeout(timeoutId);

    if (!response.ok) {
      throw new Error(`Embed request failed: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    return data.embeddings[0];
  }
}
