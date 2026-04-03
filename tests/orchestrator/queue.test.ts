import { describe, it, expect, beforeEach } from "vitest";
import { TaskQueue } from "@/orchestrator/queue";
import { createTask, _resetIdCounter, syncIdCounter, Task } from "@/orchestrator/task";
import {
  TaskTrigger,
  TaskStatus,
  TaskPriority,
  SCHEMA_VERSION,
} from "@/types";

function makeTask(overrides?: Partial<Parameters<typeof createTask>[0]>): Task {
  return createTask({
    type: "tagger",
    action: "tag-note",
    payload: { notePath: "test.md" },
    trigger: TaskTrigger.Automatic,
    ...overrides,
  });
}

describe("TaskQueue", () => {
  let queue: TaskQueue;

  beforeEach(() => {
    _resetIdCounter();
    queue = new TaskQueue();
  });

  describe("enqueue and dequeue", () => {
    it("adds and retrieves tasks", () => {
      const task = makeTask();
      queue.enqueue(task);
      expect(queue.size()).toBe(1);
      expect(queue.peek()).toEqual(task);
    });

    it("returns tasks in priority order (high > normal > low)", () => {
      const low = makeTask({ priority: TaskPriority.Low } as any);
      low.priority = TaskPriority.Low;
      const normal = makeTask();
      const high = makeTask({ trigger: TaskTrigger.Manual });

      queue.enqueue(low);
      queue.enqueue(normal);
      queue.enqueue(high);

      const next = queue.dequeueNext();
      expect(next?.priority).toBe(TaskPriority.High);

      const next2 = queue.dequeueNext();
      expect(next2?.priority).toBe(TaskPriority.Normal);

      const next3 = queue.dequeueNext();
      expect(next3?.priority).toBe(TaskPriority.Low);
    });

    it("respects FIFO within same priority", () => {
      const first = makeTask();
      const second = makeTask();
      queue.enqueue(first);
      queue.enqueue(second);

      expect(queue.dequeueNext()?.id).toBe(first.id);
      expect(queue.dequeueNext()?.id).toBe(second.id);
    });

    it("skips non-pending tasks", () => {
      const inProgress = makeTask();
      inProgress.status = TaskStatus.InProgress;
      const pending = makeTask();

      queue.enqueue(inProgress);
      queue.enqueue(pending);

      expect(queue.dequeueNext()?.id).toBe(pending.id);
    });
  });

  describe("status transitions", () => {
    it("marks task as in-progress on dequeue", () => {
      queue.enqueue(makeTask());
      const task = queue.dequeueNext();
      expect(task?.status).toBe(TaskStatus.InProgress);
    });

    it("marks task as completed", () => {
      queue.enqueue(makeTask());
      const task = queue.dequeueNext()!;
      queue.completeTask(task.id);
      const found = queue.getTask(task.id);
      expect(found?.status).toBe(TaskStatus.Completed);
    });

    it("marks task as failed with error", () => {
      const task = makeTask({ maxRetries: 1 });
      queue.enqueue(task);
      const dequeued = queue.dequeueNext()!;
      queue.failTask(dequeued.id, "Something broke");
      const found = queue.getTask(dequeued.id);
      expect(found?.status).toBe(TaskStatus.Failed);
      expect(found?.error).toBe("Something broke");
      expect(found?.retryCount).toBe(1);
    });

    it("allows retry up to maxRetries", () => {
      const task = makeTask();
      task.maxRetries = 2;
      queue.enqueue(task);

      // Fail once — should go back to pending
      const t1 = queue.dequeueNext()!;
      queue.failTask(t1.id, "error 1");
      const after1 = queue.getTask(t1.id)!;
      expect(after1.status).toBe(TaskStatus.Pending);
      expect(after1.retryCount).toBe(1);

      // Fail twice — should go to terminal failed
      const t2 = queue.dequeueNext()!;
      queue.failTask(t2.id, "error 2");
      const after2 = queue.getTask(t2.id)!;
      expect(after2.status).toBe(TaskStatus.Failed);
      expect(after2.retryCount).toBe(2);
    });

    it("defers a task", () => {
      queue.enqueue(makeTask());
      const task = queue.dequeueNext()!;
      queue.deferTask(task.id);
      const found = queue.getTask(task.id);
      expect(found?.status).toBe(TaskStatus.Deferred);
    });
  });

  describe("recovery on startup", () => {
    it("resets in-progress tasks to pending on recover", () => {
      const task = makeTask();
      queue.enqueue(task);
      queue.dequeueNext(); // marks in-progress
      queue.recoverOnStartup();
      const found = queue.getTask(task.id)!;
      expect(found.status).toBe(TaskStatus.Pending);
      expect(found.retryCount).toBe(1);
    });

    it("moves task to failed if recovery exceeds maxRetries", () => {
      const task = makeTask();
      task.maxRetries = 1;
      task.retryCount = 1;
      task.status = TaskStatus.InProgress;
      queue.enqueue(task);
      queue.recoverOnStartup();
      const found = queue.getTask(task.id)!;
      expect(found.status).toBe(TaskStatus.Failed);
    });
  });

  describe("serialization", () => {
    it("round-trips through serialize/deserialize", () => {
      queue.enqueue(makeTask());
      queue.enqueue(makeTask());

      const json = queue.serialize();
      const restored = TaskQueue.deserialize(json);
      expect(restored.size()).toBe(queue.size());
    });

    it("includes schema version", () => {
      const json = queue.serialize();
      const data = JSON.parse(json);
      expect(data.schemaVersion).toBe(SCHEMA_VERSION);
    });

    it("syncs ID counter after deserialize to avoid collisions", () => {
      queue.enqueue(makeTask()); // id "1"
      queue.enqueue(makeTask()); // id "2"

      const json = queue.serialize();
      _resetIdCounter(); // Simulate plugin reload resetting the counter
      TaskQueue.deserialize(json); // Should sync counter to 3

      // Next task created should not collide with restored tasks
      const newTask = makeTask();
      expect(newTask.id).toBe("3");
    });
  });

  describe("resetTask", () => {
    it("resets a failed task back to pending with zero retries", () => {
      const task = makeTask({ maxRetries: 1 });
      queue.enqueue(task);
      const dequeued = queue.dequeueNext()!;
      queue.failTask(dequeued.id, "something went wrong");
      expect(queue.getTask(dequeued.id)?.status).toBe(TaskStatus.Failed);

      queue.resetTask(dequeued.id);
      const reset = queue.getTask(dequeued.id)!;
      expect(reset.status).toBe(TaskStatus.Pending);
      expect(reset.retryCount).toBe(0);
      expect(reset.error).toBeNull();
    });

    it("does not reset non-failed tasks", () => {
      const task = makeTask();
      queue.enqueue(task);
      queue.resetTask(task.id); // task is Pending, not Failed — should be a no-op
      expect(queue.getTask(task.id)?.status).toBe(TaskStatus.Pending);
    });
  });

  describe("cleanup", () => {
    it("removes completed tasks older than maxAge", () => {
      const task = makeTask();
      queue.enqueue(task);
      const dequeued = queue.dequeueNext()!;
      queue.completeTask(dequeued.id);

      // Pretend it was completed 25 hours ago
      const found = queue.getTask(dequeued.id)!;
      (found as any)._completedAt = Date.now() - 25 * 60 * 60 * 1000;

      queue.cleanup(24 * 60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000);
      expect(queue.getTask(dequeued.id)).toBeUndefined();
    });
  });

  describe("getPendingByAction", () => {
    it("returns pending tasks matching an action", () => {
      queue.enqueue(makeTask({ action: "tag-note" }));
      queue.enqueue(makeTask({ action: "tag-note" }));
      queue.enqueue(makeTask({ action: "scan-connections" }));

      const tagTasks = queue.getPendingByAction("tag-note");
      expect(tagTasks).toHaveLength(2);
    });
  });
});
