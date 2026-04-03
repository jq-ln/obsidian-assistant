import { TaskQueue } from "./queue";
import { Task } from "./task";
import { TaskRouter } from "./router";
import { TaskBatcher } from "./batcher";
import { TaskStatus } from "../types";
import { LLMResponse } from "../llm/provider";

export interface OrchestratorConfig {
  queue: TaskQueue;
  router: TaskRouter;
  batcher: TaskBatcher;
  onTaskCompleted: (task: Task, response: LLMResponse) => void;
  onTaskFailed: (task: Task, error: string) => void;
  onTaskDeferred: (task: Task, reason: string) => void;
}

export class Orchestrator {
  private config: OrchestratorConfig;

  constructor(config: OrchestratorConfig) {
    this.config = config;
  }

  get queue(): TaskQueue {
    return this.config.queue;
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

      // Complete all tasks, attaching batch metadata so handlers can parse per-task results
      for (const task of batch.tasks) {
        task.payload._batchResponse = response.content;
        task.payload._batchSize = batch.tasks.length;
        this.config.queue.completeTask(task.id);
        this.config.onTaskCompleted(task, response);
      }
      return true;
    } catch (error: any) {
      const message = error.message ?? String(error);

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

    // Pre-execution note existence check: if note was deleted, silently complete
    if (task.payload.notePath) {
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

      this.config.queue.completeTask(task.id);
      this.config.onTaskCompleted(task, response);
      return true;
    } catch (error: any) {
      const message = error.message ?? String(error);

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
