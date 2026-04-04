import { describe, it, expect } from "vitest";
import { parseTrackingConfig } from "@/dashboard/tracking-config";

describe("parseTrackingConfig", () => {
  it("parses bare entries as boolean", () => {
    const config = "# Tracking\n\n- Exercise\n- Read 30m";
    const entries = parseTrackingConfig(config);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ name: "Exercise", type: "boolean", unit: null, goalDirection: null, goalValue: null });
    expect(entries[1].name).toBe("Read 30m");
    expect(entries[1].type).toBe("boolean");
  });

  it("parses legacy (boolean) syntax", () => {
    const config = "- Exercise (boolean)";
    const entries = parseTrackingConfig(config);
    expect(entries).toHaveLength(1);
    expect(entries[0].type).toBe("boolean");
  });

  it("parses numeric entries with goals", () => {
    const config = "- Sitting Time (hours, goal: <3)\n- Push-ups (reps, goal: >50)";
    const entries = parseTrackingConfig(config);
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ name: "Sitting Time", type: "numeric", unit: "hours", goalDirection: "<", goalValue: 3 });
    expect(entries[1]).toEqual({ name: "Push-ups", type: "numeric", unit: "reps", goalDirection: ">", goalValue: 50 });
  });

  it("parses numeric entries without goals", () => {
    const config = "- Weight (kg)";
    const entries = parseTrackingConfig(config);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({ name: "Weight", type: "numeric", unit: "kg", goalDirection: null, goalValue: null });
  });

  it("ignores blank lines, headings, and non-list content", () => {
    const config = "# Tracking\n\nSome description.\n\n- Exercise\n\n";
    const entries = parseTrackingConfig(config);
    expect(entries).toHaveLength(1);
  });

  it("returns empty array for empty input", () => {
    expect(parseTrackingConfig("")).toEqual([]);
    expect(parseTrackingConfig("# Tracking")).toEqual([]);
  });

  it("handles mixed boolean and numeric", () => {
    const config = "- Exercise\n- Sitting Time (hours, goal: <3)\n- Meditate";
    const entries = parseTrackingConfig(config);
    expect(entries).toHaveLength(3);
    expect(entries[0].type).toBe("boolean");
    expect(entries[1].type).toBe("numeric");
    expect(entries[2].type).toBe("boolean");
  });
});
