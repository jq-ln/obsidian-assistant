import { TaskQueue } from "./queue";
import { Task } from "./task";
import { TaskRouter } from "./router";
import { TaskBatcher } from "./batcher";
import { CostTracker } from "./cost-tracker";
import { TaskStatus } from "../types";
import { LLMProvider, LLMResponse } from "../llm/provider";

export interface OrchestratorConfig {
  queue: TaskQueue;
  router: TaskRouter;
  batcher: TaskBatcher;
  costTracker: CostTracker;
  providers: { ollama: LLMProvider; claude: LLMProvider };
  settings: {
    claudeDailyBudget: number;
    claudeMonthlyBudget: number;
  };
  onTaskCompleted: (task: Task, response: LLMResponse) => void;
  onTaskFailed: (task: Task, error: string) => void;
  onTaskDeferred: (task: Task, reason: string) => void;
  onCostWarning: (message: string) => void;
}

export class Orchestrator {
  private config: OrchestratorConfig;
  private pauseUntil = 0;       // Timestamp: don't process until this time (rate limit)
  private claudePaused = false;  // True when Claude auth has failed

  constructor(config: OrchestratorConfig) {
    this.config = config;
  }

  get queue(): TaskQueue {
    return this.config.queue;
  }

  get costTracker(): CostTracker {
    return this.config.costTracker;
  }

  updateSettings(settings: OrchestratorConfig["settings"]): void {
    this.config.settings = settings;
  }

  /** Process the next pending task in the queue. Returns true if a task was processed. */
  async processNext(): Promise<boolean> {
    // Respect rate limit pause
    if (Date.now() < this.pauseUntil) return false;

    const task = this.config.queue.dequeueNext();
    if (!task) return false;

    const decision = await this.config.router.route(task);

    if (decision.action === "defer") {
      this.config.queue.deferTask(task.id);
      this.config.onTaskDeferred(task, "Provider unavailable");
      return true;
    }

    const provider = decision.provider!;

    // Budget check for Claude
    if (provider.id === "claude") {
      // Estimate cost conservatively (assume max tokens used)
      const estimatedCost = 0.01; // rough estimate per call
      if (
        this.config.costTracker.wouldExceedBudget(
          estimatedCost,
          this.config.settings.claudeDailyBudget,
          this.config.settings.claudeMonthlyBudget,
        )
      ) {
        this.config.queue.deferTask(task.id);
        this.config.onTaskDeferred(task, "Claude budget exceeded");
        this.config.onCostWarning("Daily Claude budget reached. Task deferred.");
        return true;
      }
    }

    if (decision.costWarning) {
      this.config.onCostWarning(
        "Ollama unavailable — using Claude API for this task.",
      );
    }

    try {
      const response = await provider.complete({
        system: task.payload.systemPrompt ?? "",
        prompt: task.payload.prompt ?? JSON.stringify(task.payload),
        maxTokens: task.payload.maxTokens ?? 1000,
      });

      // Record cost if Claude
      if (provider.id === "claude") {
        this.config.costTracker.recordUsage({
          model: response.model,
          tokensIn: response.tokensUsed.input,
          tokensOut: response.tokensUsed.output,
          taskType: task.type,
        });
      }

      this.config.queue.completeTask(task.id);
      this.config.onTaskCompleted(task, response);
      return true;
    } catch (error: any) {
      const message = error.message ?? String(error);

      // Claude-specific error handling
      if (error.name === "ClaudeError" || error.status) {
        if (error.status === 429) {
          // Rate limit: defer task, pause queue temporarily
          this.config.queue.deferTask(task.id);
          const retryAfter = error.retryAfterSeconds ?? 60;
          this.config.onCostWarning(
            `Claude rate limited — pausing for ${retryAfter}s.`,
          );
          // The caller should wait before calling processNext again.
          // Store the pause-until timestamp so the processing loop can check it.
          this.pauseUntil = Date.now() + retryAfter * 1000;
          return true;
        }
        if (error.status === 401) {
          // Auth error: defer all Claude tasks, don't retry
          this.config.queue.deferTask(task.id);
          this.config.onCostWarning(
            "API key invalid or expired — check plugin settings.",
          );
          this.claudePaused = true;
          return true;
        }
      }

      // Generic error: retry logic
      this.config.queue.failTask(task.id, message);
      const updatedTask = this.config.queue.getTask(task.id)!;
      if (updatedTask.status === TaskStatus.Failed) {
        this.config.onTaskFailed(updatedTask, message);
      }
      return true;
    }
  }

  /** Process all pending tasks until the queue is empty or all remaining tasks are deferred/failed. */
  async processAll(): Promise<void> {
    let processed = true;
    while (processed) {
      processed = await this.processNext();
    }
  }
}
