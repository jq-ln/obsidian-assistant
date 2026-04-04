export interface VaultTask {
  text: string;
  sourcePath: string;
  dueDate: string | null;
}

const TASK_REGEX = /^-\s+\[\s\]\s+(.+)$/;
const DUE_DATE_REGEX = /📅\s*(\d{4}-\d{2}-\d{2})/;

export function extractTasks(content: string, sourcePath: string): VaultTask[] {
  const tasks: VaultTask[] = [];
  for (const line of content.split("\n")) {
    const match = line.match(TASK_REGEX);
    if (!match) continue;
    const raw = match[1];
    const dateMatch = raw.match(DUE_DATE_REGEX);
    const dueDate = dateMatch ? dateMatch[1] : null;
    const text = raw.replace(DUE_DATE_REGEX, "").replace(/📅\s*$/, "").trim();
    tasks.push({ text, sourcePath, dueDate });
  }
  return tasks;
}

export function rankTasks(tasks: VaultTask[], limit = 25): VaultTask[] {
  const sorted = [...tasks].sort((a, b) => {
    if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
    if (a.dueDate) return -1;
    if (b.dueDate) return 1;
    return 0;
  });
  return sorted.slice(0, limit);
}
