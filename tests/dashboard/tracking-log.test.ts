import { describe, it, expect, beforeEach } from "vitest";
import { TrackingLog, parseInputValue } from "@/dashboard/tracking-log";

describe("parseInputValue", () => {
  it("parses integers", () => { expect(parseInputValue("1")).toBe(1); expect(parseInputValue("42")).toBe(42); });
  it("parses floats", () => { expect(parseInputValue("1.3")).toBe(1.3); expect(parseInputValue("0.5")).toBe(0.5); });
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

describe("TrackingLog", () => {
  let log: TrackingLog;
  beforeEach(() => { log = new TrackingLog(); });

  it("logs a numeric value", () => {
    log.logValue("Sitting Time", "2026-04-03", 3.8);
    expect(log.getValue("Sitting Time", "2026-04-03")).toBe(3.8);
  });
  it("logs a boolean value", () => {
    log.logValue("Exercise", "2026-04-03", 1);
    expect(log.getValue("Exercise", "2026-04-03")).toBe(1);
  });
  it("overwrites same-day value", () => {
    log.logValue("Sitting Time", "2026-04-03", 4.0);
    log.logValue("Sitting Time", "2026-04-03", 3.5);
    expect(log.getValue("Sitting Time", "2026-04-03")).toBe(3.5);
  });
  it("returns null for missing entries", () => { expect(log.getValue("Unknown", "2026-04-03")).toBeNull(); });
  it("gets last N days of data", () => {
    log.logValue("Sitting Time", "2026-04-01", 4.2);
    log.logValue("Sitting Time", "2026-04-02", 3.9);
    log.logValue("Sitting Time", "2026-04-03", 3.8);
    const data = log.getRecentValues("Sitting Time", "2026-04-03", 7);
    expect(data).toHaveLength(7);
    expect(data[4]).toEqual({ date: "2026-04-01", value: 4.2 });
    expect(data[5]).toEqual({ date: "2026-04-02", value: 3.9 });
    expect(data[6]).toEqual({ date: "2026-04-03", value: 3.8 });
    expect(data[0].value).toBeNull();
  });
  it("toggles boolean value", () => {
    expect(log.getValue("Exercise", "2026-04-03")).toBeNull();
    log.toggleBoolean("Exercise", "2026-04-03");
    expect(log.getValue("Exercise", "2026-04-03")).toBe(1);
    log.toggleBoolean("Exercise", "2026-04-03");
    expect(log.getValue("Exercise", "2026-04-03")).toBe(0);
  });
  it("serializes and deserializes", () => {
    log.logValue("Exercise", "2026-04-03", 1);
    log.logValue("Sitting Time", "2026-04-03", 3.8);
    const json = log.serialize();
    const restored = TrackingLog.deserialize(json);
    expect(restored.getValue("Exercise", "2026-04-03")).toBe(1);
    expect(restored.getValue("Sitting Time", "2026-04-03")).toBe(3.8);
  });
  it("includes schema version in serialized output", () => {
    const data = JSON.parse(log.serialize());
    expect(data.schemaVersion).toBe(1);
  });
  it("migrates from old habit-log format", () => {
    const oldFormat = JSON.stringify({ "Exercise": ["2026-04-01", "2026-04-02", "2026-04-03"], "Read 30m": ["2026-04-01"] });
    const migrated = TrackingLog.migrateFromHabitLog(oldFormat);
    expect(migrated.getValue("Exercise", "2026-04-01")).toBe(1);
    expect(migrated.getValue("Exercise", "2026-04-02")).toBe(1);
    expect(migrated.getValue("Read 30m", "2026-04-01")).toBe(1);
    expect(migrated.getValue("Read 30m", "2026-04-02")).toBeNull();
  });
});
