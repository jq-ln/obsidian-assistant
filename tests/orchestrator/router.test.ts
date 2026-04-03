import { describe, it, expect, beforeEach, vi } from "vitest";
import { TaskRouter, RoutingDecision } from "@/orchestrator/router";
import { createTask, _resetIdCounter } from "@/orchestrator/task";
import { TaskTrigger } from "@/types";
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

  beforeEach(() => {
    _resetIdCounter();
  });

  it("routes to provider when available", async () => {
    const ollama = makeMockProvider("ollama", true);
    router = new TaskRouter(ollama);

    const task = createTask({
      type: "tagger",
      action: "tag-note",
      payload: {},
      trigger: TaskTrigger.Automatic,
    });

    const decision = await router.route(task);
    expect(decision.action).toBe("execute");
    expect(decision.provider?.id).toBe("ollama");
  });

  it("defers when provider unavailable", async () => {
    const ollama = makeMockProvider("ollama", false);
    router = new TaskRouter(ollama);

    const task = createTask({
      type: "tagger",
      action: "tag-note",
      payload: {},
      trigger: TaskTrigger.Automatic,
    });

    const decision = await router.route(task);
    expect(decision.action).toBe("defer");
    expect(decision.provider).toBeNull();
  });
});
