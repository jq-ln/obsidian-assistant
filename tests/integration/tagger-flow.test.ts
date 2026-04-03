// tests/integration/tagger-flow.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Orchestrator } from "@/orchestrator/orchestrator";
import { TaskQueue } from "@/orchestrator/queue";
import { TaskRouter } from "@/orchestrator/router";
import { TaskBatcher } from "@/orchestrator/batcher";
import { TaggerModule } from "@/modules/tagger/tagger";
import { createTask, _resetIdCounter } from "@/orchestrator/task";
import { TaskTrigger, TaskStatus } from "@/types";
import { LLMProvider, LLMResponse } from "@/llm/provider";

describe("Tagger end-to-end flow", () => {
  let queue: TaskQueue;
  let onTaskCompleted: ReturnType<typeof vi.fn>;
  let orchestrator: Orchestrator;
  const tagger = new TaggerModule();

  beforeEach(() => {
    _resetIdCounter();
    queue = new TaskQueue();
    onTaskCompleted = vi.fn();

    // Mock LLM that returns valid tag suggestions
    const mockOllama: LLMProvider = {
      id: "ollama",
      isAvailable: vi.fn().mockResolvedValue(true),
      complete: vi.fn().mockImplementation(async (req) => {
        const response: LLMResponse = {
          content: JSON.stringify({ tags: ["ai", "deep-learning"] }),
          tokensUsed: { input: 150, output: 30 },
          model: "llama3:8b",
          durationMs: 500,
        };
        return response;
      }),
    };

    orchestrator = new Orchestrator({
      queue,
      router: new TaskRouter(mockOllama),
      batcher: new TaskBatcher({ maxBatchSize: 10, contextWindowTokens: 8000 }),
      onTaskCompleted,
      onTaskFailed: vi.fn(),
      onTaskDeferred: vi.fn(),
    });
  });

  it("processes a tag-note task and returns parsed tags", async () => {
    const noteContent = "# Neural Networks\nTransformers are a type of neural network.";
    const prompt = tagger.buildPrompt({
      noteContent,
      existingTags: ["ai", "physics"],
      rejectedTags: [],
      styleGuide: "Use kebab-case.",
    });

    const task = createTask({
      type: "tagger",
      action: "tag-note",
      payload: {
        notePath: "neural-nets.md",
        noteContent,
        systemPrompt: prompt.system,
        prompt: prompt.prompt,
        maxTokens: prompt.maxTokens,
      },
      trigger: TaskTrigger.Manual,
    });

    queue.enqueue(task);
    await orchestrator.processNext();

    // Task should be completed
    expect(queue.getTask(task.id)?.status).toBe(TaskStatus.Completed);

    // onTaskCompleted should have been called with the task and LLM response
    expect(onTaskCompleted).toHaveBeenCalledTimes(1);
    const [completedTask, response] = onTaskCompleted.mock.calls[0];
    expect(completedTask.payload.notePath).toBe("neural-nets.md");

    // The response should be parseable by the tagger
    const parsed = tagger.parseResponse(response.content);
    expect(parsed).not.toBeNull();
    expect(parsed!.tags).toContain("ai");
    expect(parsed!.tags).toContain("deep-learning");
  });

  it("completes a tag-note task successfully using the provider", async () => {
    const prompt = tagger.buildPrompt({
      noteContent: "# Test",
      existingTags: [],
      rejectedTags: [],
      styleGuide: "",
    });

    const task = createTask({
      type: "tagger",
      action: "tag-note",
      payload: {
        notePath: "test.md",
        noteContent: "# Test",
        systemPrompt: prompt.system,
        prompt: prompt.prompt,
        maxTokens: prompt.maxTokens,
      },
      trigger: TaskTrigger.Automatic,
    });

    queue.enqueue(task);
    await orchestrator.processNext();

    expect(queue.getTask(task.id)?.status).toBe(TaskStatus.Completed);
    expect(onTaskCompleted).toHaveBeenCalledTimes(1);
  });
});
