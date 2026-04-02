import { Task, syncIdCounter } from "./task";
import { TaskStatus, TaskPriority, TaskAction, SCHEMA_VERSION } from "../types";

const PRIORITY_ORDER: Record<TaskPriority, number> = {
  [TaskPriority.High]: 0,
  [TaskPriority.Normal]: 1,
  [TaskPriority.Low]: 2,
};

interface QueueState {
  schemaVersion: number;
  tasks: (Task & { _completedAt?: number })[];
}

export class TaskQueue {
  private tasks: Map<string, Task & { _completedAt?: number }> = new Map();

  enqueue(task: Task): void {
    this.tasks.set(task.id, task);
  }

  size(): number {
    return this.tasks.size;
  }

  peek(): Task | undefined {
    return this.getSorted().find((t) => t.status === TaskStatus.Pending);
  }

  /** Dequeue the next pending task, mark it in-progress, and return it. */
  dequeueNext(): Task | undefined {
    const next = this.peek();
    if (next) {
      next.status = TaskStatus.InProgress;
    }
    return next;
  }

  getTask(id: string): (Task & { _completedAt?: number }) | undefined {
    return this.tasks.get(id);
  }

  completeTask(id: string): void {
    const task = this.tasks.get(id);
    if (task) {
      task.status = TaskStatus.Completed;
      task._completedAt = Date.now();
    }
  }

  failTask(id: string, error: string): void {
    const task = this.tasks.get(id);
    if (!task) return;

    task.retryCount += 1;
    task.error = error;

    if (task.retryCount >= task.maxRetries) {
      task.status = TaskStatus.Failed;
    } else {
      task.status = TaskStatus.Pending;
    }
  }

  deferTask(id: string): void {
    const task = this.tasks.get(id);
    if (task) {
      task.status = TaskStatus.Deferred;
    }
  }

  /** On startup, reset in-progress tasks. Increment retry count. */
  recoverOnStartup(): void {
    for (const task of this.tasks.values()) {
      if (task.status === TaskStatus.InProgress) {
        task.retryCount += 1;
        if (task.retryCount > task.maxRetries) {
          task.status = TaskStatus.Failed;
          task.error = "Interrupted by restart and exceeded max retries";
        } else {
          task.status = TaskStatus.Pending;
        }
      }
    }
  }

  /** Remove old completed and failed tasks. */
  cleanup(completedMaxAgeMs: number, failedMaxAgeMs: number): void {
    const now = Date.now();
    for (const [id, task] of this.tasks.entries()) {
      if (task.status === TaskStatus.Completed) {
        const completedAt = task._completedAt ?? task.created;
        if (now - completedAt > completedMaxAgeMs) {
          this.tasks.delete(id);
        }
      }
      if (task.status === TaskStatus.Failed) {
        if (now - task.created > failedMaxAgeMs) {
          this.tasks.delete(id);
        }
      }
    }
  }

  getPendingByAction(action: TaskAction): Task[] {
    return Array.from(this.tasks.values()).filter(
      (t) => t.status === TaskStatus.Pending && t.action === action,
    );
  }

  getFailedTasks(): Task[] {
    return Array.from(this.tasks.values()).filter(
      (t) => t.status === TaskStatus.Failed,
    );
  }

  getCompletedTasks(): Task[] {
    return Array.from(this.tasks.values()).filter(
      (t) => t.status === TaskStatus.Completed,
    );
  }

  private getSorted(): Task[] {
    return Array.from(this.tasks.values()).sort((a, b) => {
      const pa = PRIORITY_ORDER[a.priority] ?? 1;
      const pb = PRIORITY_ORDER[b.priority] ?? 1;
      if (pa !== pb) return pa - pb;
      return a.created - b.created; // FIFO within priority
    });
  }

  serialize(): string {
    const state: QueueState = {
      schemaVersion: SCHEMA_VERSION,
      tasks: Array.from(this.tasks.values()),
    };
    return JSON.stringify(state, null, 2);
  }

  resetTask(id: string): void {
    const task = this.tasks.get(id);
    if (task && task.status === TaskStatus.Failed) {
      task.status = TaskStatus.Pending;
      task.retryCount = 0;
      task.error = null;
    }
  }

  static deserialize(json: string): TaskQueue {
    const queue = new TaskQueue();
    const state: QueueState = JSON.parse(json);
    for (const task of state.tasks) {
      queue.tasks.set(task.id, task);
    }
    syncIdCounter(Array.from(queue.tasks.keys()));
    return queue;
  }
}
