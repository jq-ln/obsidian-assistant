// tests/modules/dashboard.test.ts
import { describe, it, expect } from "vitest";
import { DashboardModule } from "@/modules/dashboard/dashboard";

describe("DashboardModule", () => {
  const dashboard = new DashboardModule();

  describe("renderDashboard", () => {
    it("generates markdown with all sections", () => {
      const md = dashboard.renderDashboard({
        goalsContent: "- Learn Rust\n- Ship the plugin",
        tasksMarkdown: "- [ ] Fix bug *(plan)*\n",
        habitsMarkdown: "| Exercise | [x][x] | 2 days |",
        recentActivity: [
          { path: "new-note.md", action: "created", date: "2026-04-02" },
          { path: "old-note.md", action: "tagged", date: "2026-04-01" },
        ],
        pendingSuggestions: 3,
        failedTasks: 1,
      });

      expect(md).toContain("<!-- AI-Assistant: auto-generated");
      expect(md).toContain("## Goals");
      expect(md).toContain("Learn Rust");
      expect(md).toContain("## Active Tasks");
      expect(md).toContain("Fix bug");
      expect(md).toContain("## Habits");
      expect(md).toContain("Exercise");
      expect(md).toContain("## Recent Activity");
      expect(md).toContain("new-note.md");
      expect(md).toContain("3 pending suggestions");
      expect(md).toContain("1 failed task");
    });

    it("handles empty goals gracefully", () => {
      const md = dashboard.renderDashboard({
        goalsContent: "",
        tasksMarkdown: "",
        habitsMarkdown: "",
        recentActivity: [],
        pendingSuggestions: 0,
        failedTasks: 0,
      });

      expect(md).toContain("## Goals");
      expect(md).toContain("Edit `AI-Assistant/goals.md`");
    });
  });
});
