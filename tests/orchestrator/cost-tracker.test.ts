import { describe, it, expect, beforeEach, vi } from "vitest";
import { CostTracker } from "@/orchestrator/cost-tracker";

describe("CostTracker", () => {
  let tracker: CostTracker;

  beforeEach(() => {
    tracker = new CostTracker();
  });

  describe("recordUsage", () => {
    it("records a call and updates totals", () => {
      tracker.recordUsage({
        model: "claude-haiku-4-5-20251001",
        tokensIn: 1000,
        tokensOut: 500,
        taskType: "tagger",
      });

      const summary = tracker.getSummary();
      expect(summary.todayDollars).toBeGreaterThan(0);
      expect(summary.monthDollars).toBeGreaterThan(0);
      expect(summary.callCount).toBe(1);
    });

    it("calculates cost correctly for Haiku", () => {
      // Haiku: $0.80/1M input, $4.00/1M output
      tracker.recordUsage({
        model: "claude-haiku-4-5-20251001",
        tokensIn: 1_000_000,
        tokensOut: 1_000_000,
        taskType: "tagger",
      });

      const summary = tracker.getSummary();
      // $0.80 + $4.00 = $4.80
      expect(summary.todayDollars).toBeCloseTo(4.80, 2);
    });

    it("calculates cost correctly for Sonnet", () => {
      // Sonnet: $3.00/1M input, $15.00/1M output
      tracker.recordUsage({
        model: "claude-sonnet-4-6",
        tokensIn: 1_000_000,
        tokensOut: 1_000_000,
        taskType: "tagger",
      });

      const summary = tracker.getSummary();
      // $3.00 + $15.00 = $18.00
      expect(summary.todayDollars).toBeCloseTo(18.00, 2);
    });
  });

  describe("budget enforcement", () => {
    it("allows usage under daily budget", () => {
      expect(tracker.wouldExceedBudget(0.01, 1.00, 0)).toBe(false);
    });

    it("blocks usage over daily budget", () => {
      tracker.recordUsage({
        model: "claude-haiku-4-5-20251001",
        tokensIn: 100000,
        tokensOut: 50000,
        taskType: "tagger",
      });

      // Budget of $0.01 — already exceeded by the call above
      expect(tracker.wouldExceedBudget(0.001, 0.01, 0)).toBe(true);
    });

    it("allows unlimited when budget is 0", () => {
      tracker.recordUsage({
        model: "claude-sonnet-4-6",
        tokensIn: 10_000_000,
        tokensOut: 5_000_000,
        taskType: "tagger",
      });

      // 0 means unlimited
      expect(tracker.wouldExceedBudget(0.01, 0, 0)).toBe(false);
    });

    it("checks monthly budget independently", () => {
      tracker.recordUsage({
        model: "claude-haiku-4-5-20251001",
        tokensIn: 100000,
        tokensOut: 50000,
        taskType: "tagger",
      });

      // Daily OK, monthly exceeded
      expect(tracker.wouldExceedBudget(0.001, 100, 0.001)).toBe(true);
    });
  });

  describe("serialization", () => {
    it("serializes and deserializes state", () => {
      tracker.recordUsage({
        model: "claude-haiku-4-5-20251001",
        tokensIn: 1000,
        tokensOut: 500,
        taskType: "tagger",
      });

      const json = tracker.serialize();
      const restored = CostTracker.deserialize(json);
      const original = tracker.getSummary();
      const restoredSummary = restored.getSummary();

      expect(restoredSummary.todayDollars).toBeCloseTo(original.todayDollars, 6);
      expect(restoredSummary.monthDollars).toBeCloseTo(original.monthDollars, 6);
      expect(restoredSummary.callCount).toBe(original.callCount);
    });

    it("resets daily totals on new day", () => {
      tracker.recordUsage({
        model: "claude-haiku-4-5-20251001",
        tokensIn: 1000,
        tokensOut: 500,
        taskType: "tagger",
      });

      const json = tracker.serialize();
      // Simulate loading on a different day
      const data = JSON.parse(json);
      data.currentDay = "1970-01-01";
      const restored = CostTracker.deserialize(JSON.stringify(data));

      expect(restored.getSummary().todayDollars).toBe(0);
      // Monthly should persist
      expect(restored.getSummary().monthDollars).toBeGreaterThan(0);
    });

    it("resets monthly totals on new month", () => {
      tracker.recordUsage({
        model: "claude-haiku-4-5-20251001",
        tokensIn: 1000,
        tokensOut: 500,
        taskType: "tagger",
      });

      const json = tracker.serialize();
      const data = JSON.parse(json);
      data.currentMonth = "1970-01";
      const restored = CostTracker.deserialize(JSON.stringify(data));

      expect(restored.getSummary().monthDollars).toBe(0);
    });
  });
});
