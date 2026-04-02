import { describe, it, expect, vi, beforeEach } from "vitest";
import { ClaudeProvider } from "@/llm/claude";

// Mock the Anthropic SDK at the module boundary
vi.mock("@anthropic-ai/sdk", () => {
  const mockCreate = vi.fn();
  return {
    default: class Anthropic {
      messages = { create: mockCreate };
      static _mockCreate = mockCreate;
    },
  };
});

// Access the mock via the module
async function getMockCreate() {
  const mod = await import("@anthropic-ai/sdk");
  return (mod.default as any)._mockCreate as ReturnType<typeof vi.fn>;
}

describe("ClaudeProvider", () => {
  let provider: ClaudeProvider;
  let mockCreate: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    mockCreate = await getMockCreate();
    mockCreate.mockReset();
    provider = new ClaudeProvider("sk-test-key", "claude-haiku-4-5-20251001");
  });

  describe("isAvailable", () => {
    it("returns true when API key is set", async () => {
      expect(await provider.isAvailable()).toBe(true);
    });

    it("returns false when API key is empty", async () => {
      const noKeyProvider = new ClaudeProvider("", "claude-haiku-4-5-20251001");
      expect(await noKeyProvider.isAvailable()).toBe(false);
    });
  });

  describe("complete", () => {
    it("sends correct request and parses response", async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: '{"tags": ["ai"]}' }],
        usage: { input_tokens: 100, output_tokens: 30 },
      });

      const result = await provider.complete({
        system: "You are a tagger.",
        prompt: "Tag this note.",
        maxTokens: 200,
        temperature: 0.3,
      });

      expect(result.content).toBe('{"tags": ["ai"]}');
      expect(result.tokensUsed).toEqual({ input: 100, output: 30 });
      expect(result.model).toBe("claude-haiku-4-5-20251001");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);

      expect(mockCreate).toHaveBeenCalledWith({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 200,
        temperature: 0.3,
        system: "You are a tagger.",
        messages: [{ role: "user", content: "Tag this note." }],
      });
    });

    it("throws on API error with status info", async () => {
      const apiError = new Error("Unauthorized");
      (apiError as any).status = 401;
      mockCreate.mockRejectedValueOnce(apiError);

      await expect(
        provider.complete({ system: "", prompt: "test", maxTokens: 100 }),
      ).rejects.toThrow("Unauthorized");
    });

    it("extracts rate limit retry-after from error", async () => {
      const rateLimitError = new Error("Rate limited");
      (rateLimitError as any).status = 429;
      (rateLimitError as any).headers = { "retry-after": "30" };
      mockCreate.mockRejectedValueOnce(rateLimitError);

      try {
        await provider.complete({ system: "", prompt: "test", maxTokens: 100 });
      } catch (e: any) {
        expect(e.status).toBe(429);
        expect(e.retryAfterSeconds).toBe(30);
      }
    });
  });
});
