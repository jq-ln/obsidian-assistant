// tests/orchestrator/orchestrator.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Orchestrator } from "@/orchestrator/orchestrator";
import { TaskQueue } from "@/orchestrator/queue";
import { TaskRouter } from "@/orchestrator/router";
import { TaskBatcher } from "@/orchestrator/batcher";
import { CostTracker } from "@/orchestrator/cost-tracker";
import { createTask, _resetIdCounter } from "@/orchestrator/task";
import { ModelRequirement, TaskTrigger, TaskStatus } from "@/types";
import { LLMProvider, LLMResponse } from "@/llm/provider";

function makeMockProvider(id: string, available: boolean): LLMProvider & { complete: ReturnType<typeof vi.fn> } {
  return {
    id,
    isAvailable: vi.fn().mockResolvedValue(available),
    complete: vi.fn().mockResolvedValue({
      content: '{"tags": ["test"]}',
      tokensUsed: { input: 100, output: 50 },
      model: id === "ollama" ? "llama3:8b" : "claude-haiku-4-5-20251001",
      durationMs: 200,
    } satisfies LLMResponse),
  };
}

describe("Orchestrator", () => {
  let queue: TaskQueue;
  let costTracker: CostTracker;
  let ollama: ReturnType<typeof makeMockProvider>;
  let claude: ReturnType<typeof makeMockProvider>;
  let orchestrator: Orchestrator;

  beforeEach(() => {
    _resetIdCounter();
    queue = new TaskQueue();
    costTracker = new CostTracker();
    ollama = makeMockProvider("ollama", true);
    claude = makeMockProvider("claude", true);

    orchestrator = new Orchestrator({
      queue,
      router: new TaskRouter(ollama, claude, false),
      batcher: new TaskBatcher({ maxBatchSize: 10, contextWindowTokens: 8000 }),
      costTracker,
      providers: { ollama, claude },
      settings: {
        claudeDailyBudget: 0,
        claudeMonthlyBudget: 0,
      },
      onTaskCompleted: vi.fn(),
      onTaskFailed: vi.fn(),
      onTaskDeferred: vi.fn(),
      onCostWarning: vi.fn(),
    });
  });

  it("processes a pending task through to completion", async () => {
    const task = createTask({
      type: "tagger",
      action: "tag-note",
      payload: { notePath: "test.md", noteContent: "# Test" },
      modelRequirement: ModelRequirement.LocalPreferred,
      trigger: TaskTrigger.Manual,
    });
    queue.enqueue(task);

    await orchestrator.processNext();

    const processed = queue.getTask(task.id);
    expect(processed?.status).toBe(TaskStatus.Completed);
    expect(ollama.complete).toHaveBeenCalled();
  });

  it("defers tasks when provider unavailable", async () => {
    ollama = makeMockProvider("ollama", false);
    claude = makeMockProvider("claude", false);
    orchestrator = new Orchestrator({
      queue,
      router: new TaskRouter(ollama, claude, false),
      batcher: new TaskBatcher({ maxBatchSize: 10, contextWindowTokens: 8000 }),
      costTracker,
      providers: { ollama, claude },
      settings: { claudeDailyBudget: 0, claudeMonthlyBudget: 0 },
      onTaskCompleted: vi.fn(),
      onTaskFailed: vi.fn(),
      onTaskDeferred: vi.fn(),
      onCostWarning: vi.fn(),
    });

    const task = createTask({
      type: "tagger",
      action: "tag-note",
      payload: { notePath: "test.md", noteContent: "# Test" },
      modelRequirement: ModelRequirement.LocalPreferred,
      trigger: TaskTrigger.Automatic,
    });
    queue.enqueue(task);

    await orchestrator.processNext();

    const processed = queue.getTask(task.id);
    expect(processed?.status).toBe(TaskStatus.Deferred);
  });

  it("records cost when using Claude", async () => {
    ollama = makeMockProvider("ollama", false);
    claude = makeMockProvider("claude", true);

    orchestrator = new Orchestrator({
      queue,
      router: new TaskRouter(ollama, claude, true), // fallback enabled
      batcher: new TaskBatcher({ maxBatchSize: 10, contextWindowTokens: 8000 }),
      costTracker,
      providers: { ollama, claude },
      settings: { claudeDailyBudget: 0, claudeMonthlyBudget: 0 },
      onTaskCompleted: vi.fn(),
      onTaskFailed: vi.fn(),
      onTaskDeferred: vi.fn(),
      onCostWarning: vi.fn(),
    });

    const task = createTask({
      type: "tagger",
      action: "tag-note",
      payload: { notePath: "test.md", noteContent: "# Test" },
      modelRequirement: ModelRequirement.LocalPreferred,
      trigger: TaskTrigger.Manual,
    });
    queue.enqueue(task);

    await orchestrator.processNext();

    const summary = costTracker.getSummary();
    expect(summary.callCount).toBe(1);
  });

  it("handles LLM errors and retries", async () => {
    ollama.complete.mockRejectedValueOnce(new Error("Ollama crashed"));
    ollama.complete.mockResolvedValueOnce({
      content: '{"tags": ["test"]}',
      tokensUsed: { input: 100, output: 50 },
      model: "llama3:8b",
      durationMs: 200,
    });

    const task = createTask({
      type: "tagger",
      action: "tag-note",
      payload: { notePath: "test.md", noteContent: "# Test" },
      modelRequirement: ModelRequirement.LocalPreferred,
      trigger: TaskTrigger.Manual,
      maxRetries: 2,
    });
    queue.enqueue(task);

    // First attempt fails
    await orchestrator.processNext();
    const afterFail = queue.getTask(task.id)!;
    expect(afterFail.retryCount).toBe(1);
    expect(afterFail.status).toBe(TaskStatus.Pending);

    // Second attempt succeeds
    await orchestrator.processNext();
    const afterSuccess = queue.getTask(task.id)!;
    expect(afterSuccess.status).toBe(TaskStatus.Completed);
  });

  it("does nothing when queue is empty", async () => {
    await orchestrator.processNext();
    expect(ollama.complete).not.toHaveBeenCalled();
    expect(claude.complete).not.toHaveBeenCalled();
  });

  it("attaches _batchResponse and _batchSize to each task in a batch", async () => {
    const batchResponse = JSON.stringify({
      results: [
        { path: "note-a.md", tags: ["ai"] },
        { path: "note-b.md", tags: ["physics"] },
      ],
    });

    ollama.complete.mockResolvedValue({
      content: batchResponse,
      tokensUsed: { input: 200, output: 80 },
      model: "llama3:8b",
      durationMs: 300,
    } satisfies LLMResponse);

    const completedCalls: Array<{ task: any; response: any }> = [];
    orchestrator = new Orchestrator({
      queue,
      router: new TaskRouter(ollama, claude, false),
      batcher: new TaskBatcher({ maxBatchSize: 10, contextWindowTokens: 8000 }),
      costTracker,
      providers: { ollama, claude },
      settings: { claudeDailyBudget: 0, claudeMonthlyBudget: 0 },
      onTaskCompleted: (task, response) => completedCalls.push({ task, response }),
      onTaskFailed: vi.fn(),
      onTaskDeferred: vi.fn(),
      onCostWarning: vi.fn(),
    });

    queue.enqueue(
      createTask({
        type: "tagger",
        action: "tag-note",
        payload: { notePath: "note-a.md", noteContent: "Content A" },
        modelRequirement: ModelRequirement.LocalPreferred,
        trigger: TaskTrigger.Automatic,
      }),
    );
    queue.enqueue(
      createTask({
        type: "tagger",
        action: "tag-note",
        payload: { notePath: "note-b.md", noteContent: "Content B" },
        modelRequirement: ModelRequirement.LocalPreferred,
        trigger: TaskTrigger.Automatic,
      }),
    );

    await orchestrator.processNext();

    expect(completedCalls).toHaveLength(2);
    for (const { task } of completedCalls) {
      expect(task.payload._batchSize).toBe(2);
      expect(task.payload._batchResponse).toBe(batchResponse);
    }

    // Each task should carry its own notePath so handler can extract per-task tags
    const pathA = completedCalls.find((c) => c.task.payload.notePath === "note-a.md");
    const pathB = completedCalls.find((c) => c.task.payload.notePath === "note-b.md");
    expect(pathA).toBeDefined();
    expect(pathB).toBeDefined();
  });

  it("enforces cost budget", async () => {
    orchestrator = new Orchestrator({
      queue,
      router: new TaskRouter(ollama, claude, false),
      batcher: new TaskBatcher({ maxBatchSize: 10, contextWindowTokens: 8000 }),
      costTracker,
      providers: { ollama, claude },
      settings: { claudeDailyBudget: 0.0001, claudeMonthlyBudget: 0 }, // Tiny budget
      onTaskCompleted: vi.fn(),
      onTaskFailed: vi.fn(),
      onTaskDeferred: vi.fn(),
      onCostWarning: vi.fn(),
    });

    // Use up the budget
    costTracker.recordUsage({
      model: "claude-haiku-4-5-20251001",
      tokensIn: 10000,
      tokensOut: 5000,
      taskType: "tagger",
    });

    const task = createTask({
      type: "tagger",
      action: "audit-tags",
      payload: {},
      modelRequirement: ModelRequirement.ClaudeRequired,
      trigger: TaskTrigger.Automatic,
    });
    queue.enqueue(task);

    await orchestrator.processNext();

    const processed = queue.getTask(task.id);
    expect(processed?.status).toBe(TaskStatus.Deferred);
  });
});
