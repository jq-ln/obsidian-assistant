// src/modules/dashboard/habits.ts

export interface Habit {
  name: string;
  frequency: "daily" | "weekly";
}

/** Map of habit name → sorted array of completion dates (YYYY-MM-DD). */
export type HabitLog = Record<string, string[]>;

const HABIT_REGEX = /^-\s+(.+?)(?:\s+\((daily|weekly)\))?\s*$/;

export class HabitTracker {
  parseHabitsConfig(content: string): Habit[] {
    const habits: Habit[] = [];
    for (const line of content.split("\n")) {
      const match = line.match(HABIT_REGEX);
      if (match) {
        habits.push({
          name: match[1].trim(),
          frequency: (match[2] as Habit["frequency"]) ?? "daily",
        });
      }
    }
    return habits;
  }

  logCompletion(log: HabitLog, habitName: string, date: string): HabitLog {
    const existing = log[habitName] ?? [];
    if (existing.includes(date)) return log;
    return {
      ...log,
      [habitName]: [...existing, date].sort(),
    };
  }

  calculateStreak(completions: string[], today: string): number {
    if (!completions.includes(today)) return 0;

    let streak = 1;
    let current = this.prevDay(today);

    while (completions.includes(current)) {
      streak++;
      current = this.prevDay(current);
    }

    return streak;
  }

  renderStreakGrid(completions: string[], today: string, days: number): string {
    const completionSet = new Set(completions);
    const cells: string[] = [];

    for (let i = days - 1; i >= 0; i--) {
      const date = this.daysAgo(today, i);
      cells.push(completionSet.has(date) ? "[x]" : "[ ]");
    }

    return cells.join("");
  }

  renderHabitsMarkdown(habits: Habit[], log: HabitLog, today: string): string {
    if (habits.length === 0) return "*No habits defined. Edit `AI-Assistant/habits.md` to add some.*\n";

    const lines = habits.map((h) => {
      const completions = log[h.name] ?? [];
      const streak = this.calculateStreak(completions, today);
      const grid = this.renderStreakGrid(completions, today, 7);
      return `| ${h.name} | ${grid} | ${streak} day${streak !== 1 ? "s" : ""} |`;
    });

    return `| Habit | Last 7 Days | Streak |
|-------|-------------|--------|
${lines.join("\n")}
`;
  }

  serializeLog(log: HabitLog): string {
    return JSON.stringify(log, null, 2);
  }

  deserializeLog(json: string): HabitLog {
    try {
      return JSON.parse(json);
    } catch {
      return {};
    }
  }

  private prevDay(dateStr: string): string {
    const date = new Date(dateStr + "T00:00:00");
    date.setDate(date.getDate() - 1);
    return date.toISOString().split("T")[0];
  }

  private daysAgo(today: string, n: number): string {
    const date = new Date(today + "T00:00:00");
    date.setDate(date.getDate() - n);
    return date.toISOString().split("T")[0];
  }
}
