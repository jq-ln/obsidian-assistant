import { describe, it, expect, beforeEach } from "vitest";
import { TaskBatcher } from "@/orchestrator/batcher";
import { createTask, _resetIdCounter, Task } from "@/orchestrator/task";
import { TaskTrigger } from "@/types";

function makeTagTask(notePath: string, noteContent: string): Task {
  return createTask({
    type: "tagger",
    action: "tag-note",
    payload: { notePath, noteContent },
    trigger: TaskTrigger.Automatic,
  });
}

describe("TaskBatcher", () => {
  let batcher: TaskBatcher;

  beforeEach(() => {
    _resetIdCounter();
    batcher = new TaskBatcher({ maxBatchSize: 10, contextWindowTokens: 8000 });
  });

  it("groups tasks by action", () => {
    const tasks = [
      makeTagTask("a.md", "Note A content"),
      makeTagTask("b.md", "Note B content"),
      createTask({
        type: "connection-detector",
        action: "scan-connections",
        payload: { notePath: "c.md" },
        trigger: TaskTrigger.Automatic,
      }),
    ];

    const batches = batcher.createBatches(tasks);
    // Two batches: one for tag-note, one for scan-connections
    expect(batches).toHaveLength(2);
    expect(batches[0].tasks).toHaveLength(2);
    expect(batches[0].action).toBe("tag-note");
    expect(batches[1].tasks).toHaveLength(1);
    expect(batches[1].action).toBe("scan-connections");
  });

  it("respects max batch size", () => {
    const tasks = Array.from({ length: 15 }, (_, i) =>
      makeTagTask(`note-${i}.md`, `Content for note ${i}`),
    );

    const batches = batcher.createBatches(tasks);
    // 15 tasks with max 10 per batch → 2 batches
    expect(batches).toHaveLength(2);
    expect(batches[0].tasks).toHaveLength(10);
    expect(batches[1].tasks).toHaveLength(5);
  });

  it("respects token limit", () => {
    // Each note has ~1000 tokens worth of content (rough estimate: 4 chars per token)
    const longContent = "word ".repeat(1000); // ~5000 chars ≈ 1250 tokens
    const tasks = Array.from({ length: 10 }, (_, i) =>
      makeTagTask(`note-${i}.md`, longContent),
    );

    // With 8000 token context window and 80% threshold = 6400 tokens
    // Each task ~1250 tokens, so ~5 per batch
    const batches = batcher.createBatches(tasks);
    expect(batches.length).toBeGreaterThan(1);
    // First batch should have fewer than 10 tasks
    expect(batches[0].tasks.length).toBeLessThan(10);
  });

  it("returns single-task batches for non-batchable actions", () => {
    const tasks = [
      createTask({
        type: "tagger",
        action: "audit-tags",
        payload: {},
        trigger: TaskTrigger.Manual,
      }),
    ];

    const batches = batcher.createBatches(tasks);
    expect(batches).toHaveLength(1);
    expect(batches[0].tasks).toHaveLength(1);
  });
});
