import { TaskQueue } from "./queue";
import { Task } from "./task";
import { TaskRouter } from "./router";
import { TaskBatcher } from "./batcher";
import { CostTracker } from "./cost-tracker";
import { TaskStatus, ModelRequirement } from "../types";
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

  /**
   * Attempt to process multiple tag-note tasks in a single batched LLM call.
   * Returns true if any tasks were processed (even if the batch contained only one task).
   */
  async processBatch(): Promise<boolean> {
    const pendingTagTasks = this.config.queue.getPendingByAction("tag-note");
    if (pendingTagTasks.length === 0) return false;

    const batches = this.config.batcher.createBatches(pendingTagTasks);
    if (batches.length === 0) return false;

    const batch = batches[0];

    // Single-task batch: fall through to normal processing
    if (batch.tasks.length <= 1) return false;

    // Route using the first task as representative
    const representative = batch.tasks[0];
    const decision = await this.config.router.route(representative);

    if (decision.action === "defer") {
      for (const task of batch.tasks) {
        this.config.queue.deferTask(task.id);
        this.config.onTaskDeferred(task, "Provider unavailable");
      }
      return true;
    }

    const provider = decision.provider!;

    // Skip if claudePaused and routing to Claude
    if (provider.id === "claude" && this.claudePaused) {
      for (const task of batch.tasks) {
        this.config.queue.deferTask(task.id);
        this.config.onTaskDeferred(task, "Claude auth failed — paused");
      }
      return true;
    }

    // Budget check for Claude
    if (provider.id === "claude") {
      const estimatedCost = 0.01;
      if (
        this.config.costTracker.wouldExceedBudget(
          estimatedCost,
          this.config.settings.claudeDailyBudget,
          this.config.settings.claudeMonthlyBudget,
        )
      ) {
        for (const task of batch.tasks) {
          this.config.queue.deferTask(task.id);
          this.config.onTaskDeferred(task, "Claude budget exceeded");
        }
        this.config.onCostWarning("Daily Claude budget reached. Tasks deferred.");
        return true;
      }
    }

    // Mark all tasks in-progress
    for (const task of batch.tasks) {
      task.status = TaskStatus.InProgress;
    }

    // Build combined prompt
    const combinedPrompt = batch.tasks
      .map((t, i) => `[Note ${i + 1}: ${t.payload.notePath ?? "unknown"}]\n${t.payload.noteContent ?? t.payload.prompt ?? ""}`)
      .join("\n\n---\n\n");

    const systemPrompt = representative.payload.systemPrompt ?? "";

    try {
      const response = await provider.complete({
        system: systemPrompt,
        prompt: combinedPrompt,
        maxTokens: representative.payload.maxTokens ?? 2000,
      });

      if (provider.id === "claude") {
        this.config.costTracker.recordUsage({
          model: response.model,
          tokensIn: response.tokensUsed.input,
          tokensOut: response.tokensUsed.output,
          taskType: representative.type,
        });
      }

      // Complete all tasks with the shared response
      for (const task of batch.tasks) {
        this.config.queue.completeTask(task.id);
        this.config.onTaskCompleted(task, response);
      }
      return true;
    } catch (error: any) {
      const message = error.message ?? String(error);

      if (error.name === "ClaudeError" || error.status) {
        if (error.status === 429) {
          for (const task of batch.tasks) {
            this.config.queue.deferTask(task.id);
          }
          const retryAfter = error.retryAfterSeconds ?? 60;
          this.config.onCostWarning(`Claude rate limited — pausing for ${retryAfter}s.`);
          this.pauseUntil = Date.now() + retryAfter * 1000;
          return true;
        }
        if (error.status === 401) {
          for (const task of batch.tasks) {
            this.config.queue.deferTask(task.id);
          }
          this.config.onCostWarning("API key invalid or expired — check plugin settings.");
          this.claudePaused = true;
          return true;
        }
      }

      // Generic error: fail each task individually
      for (const task of batch.tasks) {
        this.config.queue.failTask(task.id, message);
        const updatedTask = this.config.queue.getTask(task.id)!;
        if (updatedTask.status === TaskStatus.Failed) {
          this.config.onTaskFailed(updatedTask, message);
        }
      }
      return true;
    }
  }

  /** Process the next pending task in the queue. Returns true if a task was processed. */
  async processNext(): Promise<boolean> {
    // Respect rate limit pause
    if (Date.now() < this.pauseUntil) return false;

    // Attempt batching for tag-note tasks before falling back to single processing
    const batchHandled = await this.processBatch();
    if (batchHandled) return true;

    const task = this.config.queue.dequeueNext();
    if (!task) return false;

    const decision = await this.config.router.route(task);

    if (decision.action === "defer") {
      this.config.queue.deferTask(task.id);
      this.config.onTaskDeferred(task, "Provider unavailable");
      return true;
    }

    const provider = decision.provider!;

    // Skip Claude-required tasks if auth has failed
    if (provider.id === "claude" && this.claudePaused) {
      this.config.queue.deferTask(task.id);
      this.config.onTaskDeferred(task, "Claude auth failed — paused");
      return true;
    }

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

    // Pre-execution note existence check: if note was deleted, silently complete
    if (task.payload.notePath) {
      // We check via the queue's task payload; actual file check is done by vault-service in handlers.
      // Here we rely on the notePath being present as a signal to check; the vault check happens
      // in the task completion handler. However, if we have access to a vault check we use it.
      // Since orchestrator doesn't directly reference VaultService, we skip and let the handler handle it.
      // Instead: if task.payload.noteDeleted is explicitly set (e.g., by the modify event handler), skip.
      if (task.payload.noteDeleted === true) {
        this.config.queue.completeTask(task.id);
        return true;
      }
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
