// src/modules/dashboard/task-aggregator.ts

export interface VaultTask {
  text: string;
  sourcePath: string;
  dueDate: string | null; // YYYY-MM-DD
  fileModified: number;   // timestamp for recency sorting
}

const DUE_DATE_REGEX = /📅\s*(\d{4}-\d{2}-\d{2})/;
const UNCHECKED_TASK_REGEX = /^-\s+\[\s\]\s+(.+)$/;

export class TaskAggregator {
  extractTasks(content: string, sourcePath: string, fileModified = 0): VaultTask[] {
    const tasks: VaultTask[] = [];

    for (const line of content.split("\n")) {
      const match = line.match(UNCHECKED_TASK_REGEX);
      if (!match) continue;

      let text = match[1].trim();
      let dueDate: string | null = null;

      const dateMatch = text.match(DUE_DATE_REGEX);
      if (dateMatch) {
        dueDate = dateMatch[1];
        text = text.replace(DUE_DATE_REGEX, "").trim();
      }

      tasks.push({ text, sourcePath, dueDate, fileModified });
    }

    return tasks;
  }

  rankTasks(tasks: VaultTask[], topN?: number): VaultTask[] {
    const sorted = [...tasks].sort((a, b) => {
      // Tasks with due dates first
      if (a.dueDate && !b.dueDate) return -1;
      if (!a.dueDate && b.dueDate) return 1;

      // Among dated tasks, earlier due date first
      if (a.dueDate && b.dueDate) {
        return a.dueDate.localeCompare(b.dueDate);
      }

      // Among undated tasks, more recently modified first
      return b.fileModified - a.fileModified;
    });

    return topN ? sorted.slice(0, topN) : sorted;
  }

  renderTasksMarkdown(tasks: VaultTask[]): string {
    if (tasks.length === 0) return "*No open tasks found.*\n";

    return tasks
      .map((t) => {
        const link = `[[${t.sourcePath.replace(/\.md$/, "")}]]`;
        const date = t.dueDate ? ` 📅 ${t.dueDate}` : "";
        return `- [ ] ${t.text}${date} *(${link})*`;
      })
      .join("\n") + "\n";
  }
}
