import { describe, it, expect } from "vitest";
import { extractTasks, VaultTask, rankTasks } from "@/dashboard/task-query";

describe("extractTasks", () => {
  it("extracts unchecked tasks", () => {
    const content = "# Notes\n- [ ] Fix the bug\n- [x] Already done\n- [ ] Write tests";
    const tasks = extractTasks(content, "project.md");
    expect(tasks).toHaveLength(2);
    expect(tasks[0].text).toBe("Fix the bug");
    expect(tasks[1].text).toBe("Write tests");
    expect(tasks[0].sourcePath).toBe("project.md");
  });
  it("parses due dates", () => {
    const content = "- [ ] Deploy 📅 2026-04-05";
    const tasks = extractTasks(content, "ops.md");
    expect(tasks[0].dueDate).toBe("2026-04-05");
    expect(tasks[0].text).toBe("Deploy");
  });
  it("handles lines without tasks", () => {
    expect(extractTasks("# Heading\nSome text\n- Regular list item", "note.md")).toEqual([]);
  });
});

describe("rankTasks", () => {
  it("sorts dated tasks before undated, earlier dates first", () => {
    const tasks: VaultTask[] = [
      { text: "No date", sourcePath: "a.md", dueDate: null },
      { text: "Later", sourcePath: "b.md", dueDate: "2026-04-10" },
      { text: "Sooner", sourcePath: "c.md", dueDate: "2026-04-05" },
    ];
    const ranked = rankTasks(tasks);
    expect(ranked[0].text).toBe("Sooner");
    expect(ranked[1].text).toBe("Later");
    expect(ranked[2].text).toBe("No date");
  });
  it("respects limit", () => {
    const tasks = Array.from({ length: 10 }, (_, i) => ({ text: `Task ${i}`, sourcePath: "a.md", dueDate: null }));
    expect(rankTasks(tasks, 5)).toHaveLength(5);
  });
});
