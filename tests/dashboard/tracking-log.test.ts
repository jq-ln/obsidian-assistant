import { describe, it, expect } from "vitest";
import { parseInputValue, daysAgo, metricToKey, getRecentValues } from "@/dashboard/tracking-log";

describe("parseInputValue", () => {
  it("parses integers", () => {
    expect(parseInputValue("1")).toBe(1);
    expect(parseInputValue("42")).toBe(42);
    expect(parseInputValue("0")).toBe(0);
  });

  it("parses floats", () => {
    expect(parseInputValue("1.3")).toBe(1.3);
    expect(parseInputValue("0.5")).toBe(0.5);
  });

  it("parses time format h:mm to decimal", () => {
    expect(parseInputValue("2:30")).toBeCloseTo(2.5);
    expect(parseInputValue("1:15")).toBeCloseTo(1.25);
    expect(parseInputValue("0:45")).toBeCloseTo(0.75);
  });

  it("returns null for invalid input", () => {
    expect(parseInputValue("")).toBeNull();
    expect(parseInputValue("abc")).toBeNull();
    expect(parseInputValue("-1")).toBeNull();
    expect(parseInputValue("2:61")).toBeNull();
  });
});

describe("daysAgo", () => {
  it("computes correct dates", () => {
    expect(daysAgo("2026-04-03", 0)).toBe("2026-04-03");
    expect(daysAgo("2026-04-03", 1)).toBe("2026-04-02");
    expect(daysAgo("2026-04-03", 7)).toBe("2026-03-27");
  });
});

describe("metricToKey", () => {
  it("converts to lowercase hyphenated", () => {
    expect(metricToKey("Sitting Time")).toBe("sitting-time");
    expect(metricToKey("Exercise")).toBe("exercise");
    expect(metricToKey("Read 30m")).toBe("read-30m");
  });
});

describe("getRecentValues", () => {
  it("reads values from daily frontmatters", () => {
    const fms = new Map<string, Record<string, any>>([
      ["2026-04-01", { "sitting-time": 4.2 }],
      ["2026-04-02", { "sitting-time": 3.9 }],
      ["2026-04-03", { "sitting-time": 3.8 }],
    ]);

    const result = getRecentValues(fms, "Sitting Time", "2026-04-03", 7);
    expect(result).toHaveLength(7);
    expect(result[4]).toEqual({ date: "2026-04-01", value: 4.2 });
    expect(result[5]).toEqual({ date: "2026-04-02", value: 3.9 });
    expect(result[6]).toEqual({ date: "2026-04-03", value: 3.8 });
    expect(result[0].value).toBeNull();
  });

  it("handles boolean values in frontmatter", () => {
    const fms = new Map<string, Record<string, any>>([
      ["2026-04-03", { exercise: true }],
      ["2026-04-02", { exercise: false }],
    ]);

    const result = getRecentValues(fms, "Exercise", "2026-04-03", 3);
    expect(result[2]).toEqual({ date: "2026-04-03", value: 1 });
    expect(result[1]).toEqual({ date: "2026-04-02", value: 0 });
    expect(result[0].value).toBeNull();
  });

  it("returns all nulls when no frontmatters exist", () => {
    const result = getRecentValues(new Map(), "Anything", "2026-04-03", 7);
    expect(result.every((d) => d.value === null)).toBe(true);
  });
});
