// src/modules/dashboard/dashboard.ts

export interface ActivityEntry {
  path: string;
  action: string;
  date: string;
}

export interface DashboardInput {
  goalsContent: string;
  tasksMarkdown: string;
  habitsMarkdown: string;
  recentActivity: ActivityEntry[];
  pendingSuggestions: number;
  failedTasks: number;
}

export class DashboardModule {
  renderDashboard(input: DashboardInput): string {
    const sections: string[] = [];

    sections.push(
      "<!-- AI-Assistant: auto-generated dashboard. Do not edit manually — changes will be overwritten. -->",
    );
    sections.push("# Dashboard\n");

    // Status line
    const statusParts: string[] = [];
    if (input.pendingSuggestions > 0) {
      statusParts.push(`${input.pendingSuggestions} pending suggestion${input.pendingSuggestions !== 1 ? "s" : ""} to review`);
    }
    if (input.failedTasks > 0) {
      statusParts.push(`${input.failedTasks} failed task${input.failedTasks !== 1 ? "s" : ""} (run "Retry failed tasks" from command palette)`);
    }
    if (statusParts.length > 0) {
      sections.push(`> ${statusParts.join(" | ")}\n`);
    }

    // Goals
    sections.push("## Goals\n");
    if (input.goalsContent.trim()) {
      sections.push(input.goalsContent.trim() + "\n");
    } else {
      sections.push("*No goals set. Edit `AI-Assistant/goals.md` to add your goals.*\n");
    }

    // Active Tasks
    sections.push("## Active Tasks\n");
    sections.push(input.tasksMarkdown || "*No open tasks found.*\n");

    // Habits
    sections.push("## Habits\n");
    sections.push(input.habitsMarkdown || "*No habits defined. Edit `AI-Assistant/habits.md` to add some.*\n");

    // Untagged Notes (Dataview query — always current)
    sections.push("## Untagged Notes\n");
    sections.push("```dataview");
    sections.push("TABLE WITHOUT ID");
    sections.push('  file.link AS "Note",');
    sections.push('  file.mtime AS "Last Modified"');
    sections.push("FROM \"\"");
    sections.push("WHERE !contains(file.path, \"AI-Assistant\")");
    sections.push("  AND file.name != this.file.name");
    sections.push("  AND (!file.tags OR length(file.tags) = 0)");
    sections.push("SORT file.mtime DESC");
    sections.push("LIMIT 25");
    sections.push("```\n");

    // Recent Activity
    sections.push("## Recent Activity\n");
    if (input.recentActivity.length > 0) {
      for (const entry of input.recentActivity) {
        sections.push(`- **${entry.date}** — ${entry.path} (${entry.action})`);
      }
      sections.push("");
    } else {
      sections.push("*No recent activity.*\n");
    }

    return sections.join("\n");
  }
}
