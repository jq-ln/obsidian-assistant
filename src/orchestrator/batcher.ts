import { Task } from "./task";
import { TaskAction } from "../types";

export interface TaskBatch {
  action: TaskAction;
  tasks: Task[];
}

export interface BatcherConfig {
  maxBatchSize: number;
  contextWindowTokens: number;
}

/** Rough token estimate: ~4 characters per token. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Actions that support batching (multiple items in one LLM call). */
const BATCHABLE_ACTIONS: Set<TaskAction> = new Set(["tag-note"]);

export class TaskBatcher {
  private config: BatcherConfig;

  constructor(config: BatcherConfig) {
    this.config = config;
  }

  createBatches(tasks: Task[]): TaskBatch[] {
    // Group by action
    const groups = new Map<TaskAction, Task[]>();
    for (const task of tasks) {
      const existing = groups.get(task.action) ?? [];
      existing.push(task);
      groups.set(task.action, existing);
    }

    const batches: TaskBatch[] = [];

    for (const [action, groupTasks] of groups.entries()) {
      if (!BATCHABLE_ACTIONS.has(action)) {
        // Non-batchable: each task is its own batch
        for (const task of groupTasks) {
          batches.push({ action, tasks: [task] });
        }
        continue;
      }

      // Batchable: group by size constraints
      const tokenLimit = Math.floor(this.config.contextWindowTokens * 0.8);
      let currentBatch: Task[] = [];
      let currentTokens = 0;

      for (const task of groupTasks) {
        const taskTokens = this.estimateTaskTokens(task);

        const wouldExceedSize = currentBatch.length >= this.config.maxBatchSize;
        const wouldExceedTokens = currentTokens + taskTokens > tokenLimit;

        if (currentBatch.length > 0 && (wouldExceedSize || wouldExceedTokens)) {
          batches.push({ action, tasks: currentBatch });
          currentBatch = [];
          currentTokens = 0;
        }

        currentBatch.push(task);
        currentTokens += taskTokens;
      }

      if (currentBatch.length > 0) {
        batches.push({ action, tasks: currentBatch });
      }
    }

    return batches;
  }

  private estimateTaskTokens(task: Task): number {
    let total = 0;
    if (task.payload.noteContent) {
      total += estimateTokens(task.payload.noteContent);
    }
    if (task.payload.notePath) {
      total += estimateTokens(task.payload.notePath);
    }
    // Base overhead for formatting each task in a prompt
    total += 50;
    return total;
  }
}
