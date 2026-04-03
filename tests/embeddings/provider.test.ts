import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OllamaEmbeddingProvider } from "@/embeddings/provider";

const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("OllamaEmbeddingProvider", () => {
  let provider: OllamaEmbeddingProvider;

  beforeEach(() => {
    provider = new OllamaEmbeddingProvider("http://localhost:11434");
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("isAvailable", () => {
    it("returns true when Ollama responds to health check", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ models: [{ name: "nomic-embed-text" }] }),
      });

      expect(await provider.isAvailable()).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith(
        "http://localhost:11434/api/tags",
        expect.objectContaining({ signal: expect.any(AbortSignal) }),
      );
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
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });
  });

  describe("embed", () => {
    it("sends correct request and parses response", async () => {
      const vector = Array.from({ length: 768 }, (_, i) => i * 0.001);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ embeddings: [vector] }),
      });

      const result = await provider.embed("Test note content");

      expect(result).toEqual(vector);

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:11434/api/embed");
      const body = JSON.parse(options.body);
      expect(body.model).toBe("nomic-embed-text");
      expect(body.input).toBe("Test note content");
    });

    it("passes abort signal to fetch", async () => {
      const vector = Array.from({ length: 768 }, () => 0);
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ embeddings: [vector] }),
      });

      await provider.embed("test");
      const [, options] = mockFetch.mock.calls[0];
      expect(options.signal).toBeInstanceOf(AbortSignal);
    });

    it("throws timeout error when request is aborted", async () => {
      const abortError = new Error("The operation was aborted");
      abortError.name = "AbortError";
      mockFetch.mockRejectedValueOnce(abortError);

      await expect(provider.embed("test")).rejects.toThrow("timed out");
    });

    it("throws on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      });

      await expect(provider.embed("test")).rejects.toThrow("Embed request failed");
    });
  });

  describe("updateConfig", () => {
    it("updates endpoint and invalidates cache", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ models: [] }),
      });

      await provider.isAvailable();
      provider.updateConfig({ endpoint: "http://other:11434" });
      await provider.isAvailable();

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockFetch.mock.calls[1][0]).toBe("http://other:11434/api/tags");
    });
  });
});
