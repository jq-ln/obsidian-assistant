// tests/modules/habits.test.ts
import { describe, it, expect } from "vitest";
import { HabitTracker, Habit, HabitLog } from "@/modules/dashboard/habits";

describe("HabitTracker", () => {
  const tracker = new HabitTracker();

  describe("parseHabitsConfig", () => {
    it("parses habits from markdown list", () => {
      const config = `# My Habits
- Exercise (daily)
- Read 30 min (daily)
- Weekly review (weekly)
`;
      const habits = tracker.parseHabitsConfig(config);
      expect(habits).toEqual([
        { name: "Exercise", frequency: "daily" },
        { name: "Read 30 min", frequency: "daily" },
        { name: "Weekly review", frequency: "weekly" },
      ]);
    });

    it("defaults to daily if no frequency specified", () => {
      const habits = tracker.parseHabitsConfig("- Meditate\n");
      expect(habits[0].frequency).toBe("daily");
    });

    it("handles empty config", () => {
      expect(tracker.parseHabitsConfig("")).toEqual([]);
    });
  });

  describe("logCompletion / getLog", () => {
    it("records and retrieves habit completions", () => {
      const log: HabitLog = {};
      const updated = tracker.logCompletion(log, "Exercise", "2026-04-02");
      expect(updated["Exercise"]).toContain("2026-04-02");
    });

    it("does not duplicate completions for same day", () => {
      let log: HabitLog = {};
      log = tracker.logCompletion(log, "Exercise", "2026-04-02");
      log = tracker.logCompletion(log, "Exercise", "2026-04-02");
      expect(log["Exercise"].filter((d) => d === "2026-04-02")).toHaveLength(1);
    });
  });

  describe("calculateStreak", () => {
    it("counts consecutive days", () => {
      const completions = ["2026-04-01", "2026-04-02", "2026-04-03"];
      expect(tracker.calculateStreak(completions, "2026-04-03")).toBe(3);
    });

    it("breaks streak on gap", () => {
      const completions = ["2026-04-01", "2026-04-03"];
      expect(tracker.calculateStreak(completions, "2026-04-03")).toBe(1);
    });

    it("returns 0 if not completed today", () => {
      const completions = ["2026-04-01", "2026-04-02"];
      expect(tracker.calculateStreak(completions, "2026-04-04")).toBe(0);
    });
  });

  describe("renderStreakGrid", () => {
    it("renders last 7 days as grid", () => {
      const completions = ["2026-03-28", "2026-03-29", "2026-03-31", "2026-04-01", "2026-04-02"];
      const grid = tracker.renderStreakGrid(completions, "2026-04-02", 7);
      // Last 7 days: Mar 27-Apr 2
      // Mar 27: miss, Mar 28: hit, Mar 29: hit, Mar 30: miss, Mar 31: hit, Apr 1: hit, Apr 2: hit
      expect(grid).toBe("[ ][x][x][ ][x][x][x]");
    });
  });

  describe("renderHabitsMarkdown", () => {
    it("renders habit table with streaks", () => {
      const habits: Habit[] = [
        { name: "Exercise", frequency: "daily" },
        { name: "Read", frequency: "daily" },
      ];
      const log: HabitLog = {
        Exercise: ["2026-04-01", "2026-04-02"],
        Read: ["2026-04-02"],
      };

      const md = tracker.renderHabitsMarkdown(habits, log, "2026-04-02");
      expect(md).toContain("Exercise");
      expect(md).toContain("Read");
      expect(md).toContain("[x]");
    });
  });

  describe("serializeLog / deserializeLog", () => {
    it("round-trips through JSON", () => {
      const log: HabitLog = {
        Exercise: ["2026-04-01", "2026-04-02"],
        Read: ["2026-04-02"],
      };

      const json = tracker.serializeLog(log);
      const restored = tracker.deserializeLog(json);
      expect(restored).toEqual(log);
    });
  });
});
