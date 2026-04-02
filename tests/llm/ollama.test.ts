import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OllamaProvider } from "@/llm/ollama";

// We mock global fetch — the HTTP boundary
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("OllamaProvider", () => {
  let provider: OllamaProvider;

  beforeEach(() => {
    provider = new OllamaProvider("http://localhost:11434", "llama3:8b");
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("isAvailable", () => {
    it("returns true when Ollama responds to health check", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ models: [{ name: "llama3:8b" }] }),
      });

      expect(await provider.isAvailable()).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith("http://localhost:11434/api/tags");
    });

    it("returns false when Ollama is unreachable", async () => {
      mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      expect(await provider.isAvailable()).toBe(false);
    });

    it("caches availability for 30 seconds", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ models: [] }),
      });

      await provider.isAvailable();
      await provider.isAvailable();

      // Only one fetch call — second was cached
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("invalidates cache after 30 seconds", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ models: [] }),
      });

      await provider.isAvailable();

      // Advance time past cache TTL
      vi.useFakeTimers();
      vi.advanceTimersByTime(31_000);

      await provider.isAvailable();
      vi.useRealTimers();

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("invalidates cache on error", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ models: [] }),
      });
      await provider.isAvailable();

      // Force cache invalidation by simulating an error on complete()
      mockFetch.mockRejectedValueOnce(new Error("connection lost"));
      try { await provider.complete({ system: "", prompt: "test", maxTokens: 100 }); } catch {}

      // Next isAvailable should re-check (cache invalidated)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ models: [] }),
      });
      await provider.isAvailable();

      // 3 calls: health check, failed complete, re-health-check
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });

  describe("complete", () => {
    it("sends correct request and parses response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: '{"tags": ["ai", "ml"]}',
          eval_count: 50,
          prompt_eval_count: 120,
          total_duration: 1500000000, // nanoseconds
        }),
      });

      const result = await provider.complete({
        system: "You are a tagger.",
        prompt: "Tag this note.",
        maxTokens: 200,
        temperature: 0.3,
      });

      expect(result.content).toBe('{"tags": ["ai", "ml"]}');
      expect(result.tokensUsed).toEqual({ input: 120, output: 50 });
      expect(result.model).toBe("llama3:8b");
      expect(result.durationMs).toBeCloseTo(1500, -1);

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:11434/api/generate");
      const body = JSON.parse(options.body);
      expect(body.model).toBe("llama3:8b");
      expect(body.system).toBe("You are a tagger.");
      expect(body.prompt).toBe("Tag this note.");
      expect(body.stream).toBe(false);
      expect(body.options.num_predict).toBe(200);
      expect(body.options.temperature).toBe(0.3);
    });

    it("throws on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      });

      await expect(
        provider.complete({ system: "", prompt: "test", maxTokens: 100 }),
      ).rejects.toThrow("Ollama request failed: 500 Internal Server Error");
    });

    it("throws on network error", async () => {
      mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      await expect(
        provider.complete({ system: "", prompt: "test", maxTokens: 100 }),
      ).rejects.toThrow("ECONNREFUSED");
    });
  });
});
