// tests/integration/anki-flow.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Orchestrator } from "@/orchestrator/orchestrator";
import { TaskQueue } from "@/orchestrator/queue";
import { TaskRouter } from "@/orchestrator/router";
import { TaskBatcher } from "@/orchestrator/batcher";
import { CostTracker } from "@/orchestrator/cost-tracker";
import { AnkiModule } from "@/modules/anki/anki";
import { SuggestionsStore } from "@/suggestions/store";
import { createSuggestion, _resetSuggestionIdCounter } from "@/suggestions/suggestion";
import { createTask, _resetIdCounter } from "@/orchestrator/task";
import { ModelRequirement, TaskTrigger, TaskStatus } from "@/types";
import { LLMProvider, LLMResponse } from "@/llm/provider";

describe("Anki card suggestion end-to-end flow", () => {
  let queue: TaskQueue;
  let costTracker: CostTracker;
  let onTaskCompleted: ReturnType<typeof vi.fn>;
  let orchestrator: Orchestrator;
  const anki = new AnkiModule();
  let suggestionsStore: SuggestionsStore;

  beforeEach(() => {
    _resetIdCounter();
    _resetSuggestionIdCounter();
    queue = new TaskQueue();
    costTracker = new CostTracker();
    suggestionsStore = new SuggestionsStore();
    onTaskCompleted = vi.fn();

    const mockClaude: LLMProvider = {
      id: "claude",
      isAvailable: vi.fn().mockResolvedValue(true),
      complete: vi.fn().mockResolvedValue({
        content: JSON.stringify({
          cards: [
            { type: "basic", front: "What is attention?", back: "A mechanism for weighing input relevance" },
            { type: "cloze", text: "Transformers use {{c1::self-attention}} to process sequences." },
          ],
        }),
        tokensUsed: { input: 500, output: 200 },
        model: "claude-haiku-4-5-20251001",
        durationMs: 1200,
      } satisfies LLMResponse),
    };

    const mockOllama: LLMProvider = {
      id: "ollama",
      isAvailable: vi.fn().mockResolvedValue(false),
      complete: vi.fn(),
    };

    orchestrator = new Orchestrator({
      queue,
      router: new TaskRouter(mockOllama, mockClaude, false),
      batcher: new TaskBatcher({ maxBatchSize: 10, contextWindowTokens: 8000 }),
      costTracker,
      providers: { ollama: mockOllama, claude: mockClaude },
      settings: { claudeDailyBudget: 0, claudeMonthlyBudget: 0 },
      onTaskCompleted,
      onTaskFailed: vi.fn(),
      onTaskDeferred: vi.fn(),
      onCostWarning: vi.fn(),
    });
  });

  it("processes a suggest-cards task and returns parseable cards", async () => {
    const noteContent = "# Transformers\nTransformers use self-attention mechanisms.";
    const prompt = anki.buildPrompt({
      noteContent,
      existingCards: [],
      cardFormat: "both",
    });

    const task = createTask({
      type: "anki",
      action: "suggest-cards",
      payload: {
        notePath: "transformers.md",
        systemPrompt: prompt.system,
        prompt: prompt.prompt,
        maxTokens: prompt.maxTokens,
      },
      modelRequirement: ModelRequirement.ClaudeRequired,
      trigger: TaskTrigger.Manual,
    });

    queue.enqueue(task);
    await orchestrator.processNext();

    expect(queue.getTask(task.id)?.status).toBe(TaskStatus.Completed);
    expect(onTaskCompleted).toHaveBeenCalledTimes(1);

    const [completedTask, response] = onTaskCompleted.mock.calls[0];
    const cards = anki.parseResponse(response.content);
    expect(cards).toHaveLength(2);
    expect(cards![0].type).toBe("basic");
    expect(cards![1].type).toBe("cloze");

    // Simulate what main.ts handleAnkiResult would do
    for (const card of cards!) {
      const cardText = anki.formatCardMarkdown(card);
      const sug = createSuggestion({
        type: "anki-card",
        sourceNotePath: completedTask.payload.notePath,
        title: card.type === "basic" ? card.front! : card.text!.slice(0, 50),
        detail: cardText,
        editable: cardText,
      });
      suggestionsStore.add(sug);
    }

    const pending = suggestionsStore.getForNote("transformers.md");
    expect(pending).toHaveLength(2);
    expect(pending[0].type).toBe("anki-card");
    expect(pending[0].editable).toContain("::");
    expect(pending[1].editable).toContain("{{c1::");
  });

  it("routes suggest-cards to Claude, not Ollama", async () => {
    const prompt = anki.buildPrompt({
      noteContent: "# Test",
      existingCards: [],
      cardFormat: "both",
    });

    const task = createTask({
      type: "anki",
      action: "suggest-cards",
      payload: {
        notePath: "test.md",
        systemPrompt: prompt.system,
        prompt: prompt.prompt,
        maxTokens: prompt.maxTokens,
      },
      modelRequirement: ModelRequirement.ClaudeRequired,
      trigger: TaskTrigger.Manual,
    });

    queue.enqueue(task);
    await orchestrator.processNext();

    const ollama = orchestrator["config"].providers.ollama;
    expect(ollama.complete).not.toHaveBeenCalled();
  });

  it("records Claude cost for card suggestions", async () => {
    const prompt = anki.buildPrompt({
      noteContent: "# Test",
      existingCards: [],
      cardFormat: "both",
    });

    const task = createTask({
      type: "anki",
      action: "suggest-cards",
      payload: {
        notePath: "test.md",
        systemPrompt: prompt.system,
        prompt: prompt.prompt,
        maxTokens: prompt.maxTokens,
      },
      modelRequirement: ModelRequirement.ClaudeRequired,
      trigger: TaskTrigger.Manual,
    });

    queue.enqueue(task);
    await orchestrator.processNext();

    const summary = costTracker.getSummary();
    expect(summary.callCount).toBe(1);
    expect(summary.todayDollars).toBeGreaterThan(0);
  });
});
