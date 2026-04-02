import { describe, it, expect, beforeEach, vi } from "vitest";
import { TaskRouter, RoutingDecision } from "@/orchestrator/router";
import { createTask, _resetIdCounter } from "@/orchestrator/task";
import { ModelRequirement, TaskTrigger } from "@/types";
import { LLMProvider } from "@/llm/provider";

function makeMockProvider(id: string, available: boolean): LLMProvider {
  return {
    id,
    isAvailable: vi.fn().mockResolvedValue(available),
    complete: vi.fn(),
  };
}

describe("TaskRouter", () => {
  let router: TaskRouter;
  let ollamaAvailable: LLMProvider;
  let ollamaUnavailable: LLMProvider;
  let claudeAvailable: LLMProvider;
  let claudeUnavailable: LLMProvider;

  beforeEach(() => {
    _resetIdCounter();
    ollamaAvailable = makeMockProvider("ollama", true);
    ollamaUnavailable = makeMockProvider("ollama", false);
    claudeAvailable = makeMockProvider("claude", true);
    claudeUnavailable = makeMockProvider("claude", false);
  });

  function makeRouter(
    ollama: LLMProvider,
    claude: LLMProvider,
    localFallbackToClaude = false,
  ): TaskRouter {
    return new TaskRouter(ollama, claude, localFallbackToClaude);
  }

  describe("local-only tasks", () => {
    it("routes to Ollama when available", async () => {
      router = makeRouter(ollamaAvailable, claudeAvailable);
      const task = createTask({
        type: "tagger",
        action: "tag-note",
        payload: {},
        modelRequirement: ModelRequirement.LocalOnly,
        trigger: TaskTrigger.Automatic,
      });

      const decision = await router.route(task);
      expect(decision.action).toBe("execute");
      expect(decision.provider?.id).toBe("ollama");
    });

    it("defers when Ollama unavailable", async () => {
      router = makeRouter(ollamaUnavailable, claudeAvailable);
      const task = createTask({
        type: "dashboard",
        action: "generate-dashboard",
        payload: {},
        modelRequirement: ModelRequirement.LocalOnly,
        trigger: TaskTrigger.Automatic,
      });

      const decision = await router.route(task);
      expect(decision.action).toBe("defer");
    });
  });

  describe("local-preferred tasks", () => {
    it("routes to Ollama when available", async () => {
      router = makeRouter(ollamaAvailable, claudeAvailable);
      const task = createTask({
        type: "tagger",
        action: "tag-note",
        payload: {},
        modelRequirement: ModelRequirement.LocalPreferred,
        trigger: TaskTrigger.Automatic,
      });

      const decision = await router.route(task);
      expect(decision.action).toBe("execute");
      expect(decision.provider?.id).toBe("ollama");
    });

    it("falls back to Claude when Ollama unavailable and fallback enabled", async () => {
      router = makeRouter(ollamaUnavailable, claudeAvailable, true);
      const task = createTask({
        type: "tagger",
        action: "tag-note",
        payload: {},
        modelRequirement: ModelRequirement.LocalPreferred,
        trigger: TaskTrigger.Automatic,
      });

      const decision = await router.route(task);
      expect(decision.action).toBe("execute");
      expect(decision.provider?.id).toBe("claude");
      expect(decision.costWarning).toBe(true);
    });

    it("defers when Ollama unavailable and fallback disabled", async () => {
      router = makeRouter(ollamaUnavailable, claudeAvailable, false);
      const task = createTask({
        type: "tagger",
        action: "tag-note",
        payload: {},
        modelRequirement: ModelRequirement.LocalPreferred,
        trigger: TaskTrigger.Automatic,
      });

      const decision = await router.route(task);
      expect(decision.action).toBe("defer");
    });
  });

  describe("claude-required tasks", () => {
    it("routes to Claude when available", async () => {
      router = makeRouter(ollamaAvailable, claudeAvailable);
      const task = createTask({
        type: "tagger",
        action: "audit-tags",
        payload: {},
        modelRequirement: ModelRequirement.ClaudeRequired,
        trigger: TaskTrigger.Manual,
      });

      const decision = await router.route(task);
      expect(decision.action).toBe("execute");
      expect(decision.provider?.id).toBe("claude");
    });

    it("defers when Claude unavailable", async () => {
      router = makeRouter(ollamaAvailable, claudeUnavailable);
      const task = createTask({
        type: "tagger",
        action: "audit-tags",
        payload: {},
        modelRequirement: ModelRequirement.ClaudeRequired,
        trigger: TaskTrigger.Manual,
      });

      const decision = await router.route(task);
      expect(decision.action).toBe("defer");
    });
  });
});
