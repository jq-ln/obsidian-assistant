// tests/modules/task-aggregator.test.ts
import { describe, it, expect } from "vitest";
import { TaskAggregator, VaultTask } from "@/modules/dashboard/task-aggregator";

describe("TaskAggregator", () => {
  const aggregator = new TaskAggregator();

  describe("extractTasks", () => {
    it("extracts unchecked tasks from markdown", () => {
      const content = `# Project Plan
- [x] Done task
- [ ] Open task one
- [ ] Open task two
Some paragraph text.
- [ ] Another task`;

      const tasks = aggregator.extractTasks(content, "plan.md");
      expect(tasks).toHaveLength(3);
      expect(tasks[0].text).toBe("Open task one");
      expect(tasks[0].sourcePath).toBe("plan.md");
    });

    it("parses due dates from task text", () => {
      const content = "- [ ] Submit report 📅 2026-04-05";
      const tasks = aggregator.extractTasks(content, "tasks.md");
      expect(tasks[0].dueDate).toBe("2026-04-05");
      expect(tasks[0].text).toBe("Submit report");
    });

    it("handles tasks without due dates", () => {
      const content = "- [ ] No deadline here";
      const tasks = aggregator.extractTasks(content, "tasks.md");
      expect(tasks[0].dueDate).toBeNull();
    });

    it("ignores checked tasks", () => {
      const content = "- [x] Already done\n- [ ] Still open";
      const tasks = aggregator.extractTasks(content, "tasks.md");
      expect(tasks).toHaveLength(1);
      expect(tasks[0].text).toBe("Still open");
    });
  });

  describe("rankTasks", () => {
    it("sorts by due date first, then by recency", () => {
      const tasks: VaultTask[] = [
        { text: "No date", sourcePath: "a.md", dueDate: null, fileModified: 1000 },
        { text: "Far future", sourcePath: "b.md", dueDate: "2099-12-31", fileModified: 500 },
        { text: "Soon", sourcePath: "c.md", dueDate: "2026-04-03", fileModified: 500 },
      ];

      const ranked = aggregator.rankTasks(tasks);
      expect(ranked[0].text).toBe("Soon");
      expect(ranked[1].text).toBe("Far future");
      expect(ranked[2].text).toBe("No date");
    });

    it("respects topN limit", () => {
      const tasks: VaultTask[] = Array.from({ length: 20 }, (_, i) => ({
        text: `Task ${i}`,
        sourcePath: "a.md",
        dueDate: null,
        fileModified: 20 - i,
      }));

      const ranked = aggregator.rankTasks(tasks, 5);
      expect(ranked).toHaveLength(5);
    });
  });

  describe("renderTasksMarkdown", () => {
    it("renders tasks as markdown checklist with source links", () => {
      const tasks: VaultTask[] = [
        { text: "Fix bug", sourcePath: "bugs.md", dueDate: "2026-04-05", fileModified: 0 },
        { text: "Review PR", sourcePath: "work.md", dueDate: null, fileModified: 0 },
      ];

      const md = aggregator.renderTasksMarkdown(tasks);
      expect(md).toContain("- [ ] Fix bug");
      expect(md).toContain("📅 2026-04-05");
      expect(md).toContain("[[bugs]]");
      expect(md).toContain("[[work]]");
    });
  });
});
