# Dashboard Custom View — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the auto-generated markdown dashboard with an interactive custom Obsidian view featuring an AI briefing, quick links, active tasks, rediscovery section, habit streaks, and numeric tracking with SVG charts.

**Architecture:** A custom `ItemView` renders an HTML dashboard via CSS Grid. Data comes from config files (tracking, quick links), a JSON log (tracking data), vault queries (tasks), and LLM calls (AI briefing). Each data source is an independent module tested in isolation; the view composes them.

**Tech Stack:** TypeScript, Obsidian Plugin API (`ItemView`), SVG for charts, Vitest

**Spec:** `docs/superpowers/specs/2026-04-03-dashboard-view-design.md`

---

## File Map

```
src/
├── dashboard/
│   ├── view.ts              # DashboardView (ItemView subclass) — layout, rendering, event handlers
│   ├── tracking-config.ts   # Parse AI-Assistant/tracking.md into typed config objects
│   ├── tracking-log.ts      # TrackingLog: CRUD for daily values, persistence, migration from old habit-log
│   ├── quick-links.ts       # Parse AI-Assistant/quick-links.md, resolve dates, open/create notes
│   ├── rediscovery.ts       # Select random old notes, persist daily selection
│   ├── chart.ts             # SVG line chart renderer (pure function)
│   ├── task-query.ts        # Extract unchecked tasks from vault markdown files
│   └── briefing.ts          # Build AI briefing prompt, cache result
├── settings.ts              # Add new dashboard settings, remove old ones
└── main.ts                  # Wire dashboard view, remove old DashboardModule/HabitTracker

tests/
├── dashboard/
│   ├── tracking-config.test.ts
│   ├── tracking-log.test.ts
│   ├── quick-links.test.ts
│   ├── rediscovery.test.ts
│   ├── chart.test.ts
│   ├── task-query.test.ts
│   └── briefing.test.ts
└── integration/
    └── dashboard-flow.test.ts   # End-to-end: data sources → view rendering

Deleted files:
- src/modules/dashboard/dashboard.ts
- src/modules/dashboard/habits.ts
- tests/modules/dashboard.test.ts
- tests/modules/habits.test.ts
```

---

## Task 1: Tracking Config Parser

**Files:**
- Create: `src/dashboard/tracking-config.ts`
- Create: `tests/dashboard/tracking-config.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/dashboard/tracking-config.test.ts
import { describe, it, expect } from "vitest";
import { parseTrackingConfig, TrackingEntry } from "@/dashboard/tracking-config";

describe("parseTrackingConfig", () => {
  it("parses boolean entries", () => {
    const config = "# Tracking\n\n- Exercise (boolean)\n- Read 30m (boolean)";
    const entries = parseTrackingConfig(config);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      name: "Exercise",
      type: "boolean",
      unit: null,
      goalDirection: null,
      goalValue: null,
    });
    expect(entries[1].name).toBe("Read 30m");
    expect(entries[1].type).toBe("boolean");
  });

  it("parses numeric entries with goals", () => {
    const config = "- Sitting Time (hours, goal: <3)\n- Push-ups (reps, goal: >50)";
    const entries = parseTrackingConfig(config);

    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({
      name: "Sitting Time",
      type: "numeric",
      unit: "hours",
      goalDirection: "<",
      goalValue: 3,
    });
    expect(entries[1]).toEqual({
      name: "Push-ups",
      type: "numeric",
      unit: "reps",
      goalDirection: ">",
      goalValue: 50,
    });
  });

  it("parses numeric entries without goals", () => {
    const config = "- Weight (kg)";
    const entries = parseTrackingConfig(config);

    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      name: "Weight",
      type: "numeric",
      unit: "kg",
      goalDirection: null,
      goalValue: null,
    });
  });

  it("ignores blank lines, headings, and non-list content", () => {
    const config = "# Tracking\n\nSome description.\n\n- Exercise (boolean)\n\n";
    const entries = parseTrackingConfig(config);
    expect(entries).toHaveLength(1);
  });

  it("returns empty array for empty input", () => {
    expect(parseTrackingConfig("")).toEqual([]);
    expect(parseTrackingConfig("# Tracking")).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dashboard/tracking-config.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/dashboard/tracking-config.ts

export interface TrackingEntry {
  name: string;
  type: "boolean" | "numeric";
  unit: string | null;
  goalDirection: "<" | ">" | null;
  goalValue: number | null;
}

const ENTRY_REGEX = /^-\s+(.+?)\s+\((.+)\)\s*$/;

export function parseTrackingConfig(content: string): TrackingEntry[] {
  const entries: TrackingEntry[] = [];

  for (const line of content.split("\n")) {
    const match = line.match(ENTRY_REGEX);
    if (!match) continue;

    const name = match[1].trim();
    const params = match[2].trim();

    if (params === "boolean") {
      entries.push({ name, type: "boolean", unit: null, goalDirection: null, goalValue: null });
      continue;
    }

    // Parse: "hours, goal: <3" or "reps, goal: >50" or just "kg"
    const parts = params.split(",").map((p) => p.trim());
    const unit = parts[0];
    let goalDirection: "<" | ">" | null = null;
    let goalValue: number | null = null;

    const goalPart = parts.find((p) => p.startsWith("goal:"));
    if (goalPart) {
      const goalStr = goalPart.replace("goal:", "").trim();
      if (goalStr.startsWith("<")) {
        goalDirection = "<";
        goalValue = parseFloat(goalStr.slice(1));
      } else if (goalStr.startsWith(">")) {
        goalDirection = ">";
        goalValue = parseFloat(goalStr.slice(1));
      }
    }

    entries.push({ name, type: "numeric", unit, goalDirection, goalValue });
  }

  return entries;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dashboard/tracking-config.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/tracking-config.ts tests/dashboard/tracking-config.test.ts
git commit -m "feat: add tracking config parser for unified habits/metrics"
```

---

## Task 2: Tracking Log with Input Parsing

**Files:**
- Create: `src/dashboard/tracking-log.ts`
- Create: `tests/dashboard/tracking-log.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/dashboard/tracking-log.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { TrackingLog, parseInputValue } from "@/dashboard/tracking-log";

describe("parseInputValue", () => {
  it("parses integers", () => {
    expect(parseInputValue("1")).toBe(1);
    expect(parseInputValue("42")).toBe(42);
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

describe("TrackingLog", () => {
  let log: TrackingLog;

  beforeEach(() => {
    log = new TrackingLog();
  });

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

  it("returns null for missing entries", () => {
    expect(log.getValue("Unknown", "2026-04-03")).toBeNull();
  });

  it("gets last N days of data", () => {
    log.logValue("Sitting Time", "2026-04-01", 4.2);
    log.logValue("Sitting Time", "2026-04-02", 3.9);
    log.logValue("Sitting Time", "2026-04-03", 3.8);

    const data = log.getRecentValues("Sitting Time", "2026-04-03", 7);
    expect(data).toHaveLength(7);
    expect(data[4]).toEqual({ date: "2026-04-01", value: 4.2 });
    expect(data[5]).toEqual({ date: "2026-04-02", value: 3.9 });
    expect(data[6]).toEqual({ date: "2026-04-03", value: 3.8 });
    // Missing days should have null values
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
    const oldFormat = JSON.stringify({
      "Exercise": ["2026-04-01", "2026-04-02", "2026-04-03"],
      "Read 30m": ["2026-04-01"],
    });

    const migrated = TrackingLog.migrateFromHabitLog(oldFormat);
    expect(migrated.getValue("Exercise", "2026-04-01")).toBe(1);
    expect(migrated.getValue("Exercise", "2026-04-02")).toBe(1);
    expect(migrated.getValue("Read 30m", "2026-04-01")).toBe(1);
    expect(migrated.getValue("Read 30m", "2026-04-02")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dashboard/tracking-log.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/dashboard/tracking-log.ts

export interface DayValue {
  date: string;
  value: number | null;
}

export function parseInputValue(input: string): number | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Time format: h:mm or hh:mm
  const timeMatch = trimmed.match(/^(\d+):(\d{2})$/);
  if (timeMatch) {
    const hours = parseInt(timeMatch[1], 10);
    const minutes = parseInt(timeMatch[2], 10);
    if (minutes > 59) return null;
    return hours + minutes / 60;
  }

  const num = parseFloat(trimmed);
  if (isNaN(num) || num < 0) return null;
  return num;
}

interface LogEntry {
  date: string;
  value: number;
}

interface LogState {
  schemaVersion: number;
  entries: Record<string, LogEntry[]>;
}

export class TrackingLog {
  private entries = new Map<string, LogEntry[]>();

  logValue(metric: string, date: string, value: number): void {
    const list = this.entries.get(metric) ?? [];
    const existing = list.findIndex((e) => e.date === date);
    if (existing >= 0) {
      list[existing].value = value;
    } else {
      list.push({ date, value });
      list.sort((a, b) => a.date.localeCompare(b.date));
    }
    this.entries.set(metric, list);
  }

  getValue(metric: string, date: string): number | null {
    const list = this.entries.get(metric);
    if (!list) return null;
    const entry = list.find((e) => e.date === date);
    return entry?.value ?? null;
  }

  toggleBoolean(metric: string, date: string): void {
    const current = this.getValue(metric, date);
    this.logValue(metric, date, current === 1 ? 0 : 1);
  }

  getRecentValues(metric: string, today: string, days: number): DayValue[] {
    const result: DayValue[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const date = daysAgo(today, i);
      result.push({ date, value: this.getValue(metric, date) });
    }
    return result;
  }

  serialize(): string {
    const entries: Record<string, LogEntry[]> = {};
    for (const [metric, list] of this.entries) {
      entries[metric] = list;
    }
    return JSON.stringify({ schemaVersion: 1, entries }, null, 2);
  }

  static deserialize(json: string): TrackingLog {
    const log = new TrackingLog();
    const data: LogState = JSON.parse(json);
    if (data.schemaVersion !== 1) {
      throw new Error(`Unknown tracking log schema: ${data.schemaVersion}`);
    }
    for (const [metric, list] of Object.entries(data.entries)) {
      log.entries.set(metric, list);
    }
    return log;
  }

  static migrateFromHabitLog(json: string): TrackingLog {
    const log = new TrackingLog();
    const old: Record<string, string[]> = JSON.parse(json);
    for (const [name, dates] of Object.entries(old)) {
      for (const date of dates) {
        log.logValue(name, date, 1);
      }
    }
    return log;
  }
}

function daysAgo(today: string, n: number): string {
  const date = new Date(today + "T00:00:00");
  date.setDate(date.getDate() - n);
  return date.toISOString().split("T")[0];
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dashboard/tracking-log.test.ts`
Expected: All 11 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/tracking-log.ts tests/dashboard/tracking-log.test.ts
git commit -m "feat: add TrackingLog with input parsing, boolean toggle, and migration"
```

---

## Task 3: SVG Chart Renderer

**Files:**
- Create: `src/dashboard/chart.ts`
- Create: `tests/dashboard/chart.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/dashboard/chart.test.ts
import { describe, it, expect } from "vitest";
import { renderChart, ChartData } from "@/dashboard/chart";

describe("renderChart", () => {
  const sampleData: ChartData = {
    values: [
      { date: "2026-03-28", value: 4.5 },
      { date: "2026-03-29", value: 4.2 },
      { date: "2026-03-30", value: null },
      { date: "2026-03-31", value: 3.9 },
      { date: "2026-04-01", value: 4.0 },
      { date: "2026-04-02", value: 3.6 },
      { date: "2026-04-03", value: 3.8 },
    ],
    goalValue: 3,
    color: "#7c6ff5",
  };

  it("returns an SVG string", () => {
    const svg = renderChart(sampleData);
    expect(svg).toContain("<svg");
    expect(svg).toContain("</svg>");
  });

  it("includes a polyline for data points", () => {
    const svg = renderChart(sampleData);
    expect(svg).toContain("<polyline");
  });

  it("includes circle elements for each non-null data point", () => {
    const svg = renderChart(sampleData);
    // 6 non-null values
    const circles = svg.match(/<circle/g);
    expect(circles).toHaveLength(6);
  });

  it("includes a dashed goal line when goalValue is set", () => {
    const svg = renderChart(sampleData);
    expect(svg).toContain("stroke-dasharray");
  });

  it("omits goal line when goalValue is null", () => {
    const svg = renderChart({ ...sampleData, goalValue: null });
    expect(svg).not.toContain("stroke-dasharray");
  });

  it("includes day-of-week labels", () => {
    const svg = renderChart(sampleData);
    // Should have day labels
    expect(svg).toContain(">M<");
  });

  it("handles all-null data gracefully", () => {
    const empty: ChartData = {
      values: Array.from({ length: 7 }, (_, i) => ({
        date: `2026-04-0${i + 1}`,
        value: null,
      })),
      goalValue: null,
      color: "#7c6ff5",
    };
    const svg = renderChart(empty);
    expect(svg).toContain("<svg");
    // No circles or polyline when all null
    expect(svg).not.toContain("<circle");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dashboard/chart.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/dashboard/chart.ts

export interface ChartData {
  values: Array<{ date: string; value: number | null }>;
  goalValue: number | null;
  color: string;
}

const CHART_WIDTH = 240;
const CHART_HEIGHT = 70;
const PADDING_X = 15;
const PADDING_TOP = 12;
const PADDING_BOTTOM = 18;
const PLOT_WIDTH = CHART_WIDTH - PADDING_X * 2;
const PLOT_HEIGHT = CHART_HEIGHT - PADDING_TOP - PADDING_BOTTOM;
const DOT_RADIUS = 2.5;

const DAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];

export function renderChart(data: ChartData): string {
  const nonNull = data.values.filter((v) => v.value !== null) as Array<{ date: string; value: number }>;

  if (nonNull.length === 0) {
    return `<svg viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}" xmlns="http://www.w3.org/2000/svg"></svg>`;
  }

  // Compute Y range
  let minVal = Math.min(...nonNull.map((v) => v.value));
  let maxVal = Math.max(...nonNull.map((v) => v.value));
  if (data.goalValue !== null) {
    minVal = Math.min(minVal, data.goalValue);
    maxVal = Math.max(maxVal, data.goalValue);
  }
  // Add 10% padding
  const range = maxVal - minVal || 1;
  minVal -= range * 0.1;
  maxVal += range * 0.1;

  function yPos(value: number): number {
    return PADDING_TOP + PLOT_HEIGHT * (1 - (value - minVal) / (maxVal - minVal));
  }

  function xPos(index: number): number {
    return PADDING_X + (index / (data.values.length - 1)) * PLOT_WIDTH;
  }

  const parts: string[] = [];
  parts.push(`<svg viewBox="0 0 ${CHART_WIDTH} ${CHART_HEIGHT}" xmlns="http://www.w3.org/2000/svg">`);

  // Goal line
  if (data.goalValue !== null) {
    const gy = yPos(data.goalValue);
    parts.push(`<line x1="${PADDING_X}" y1="${gy}" x2="${CHART_WIDTH - PADDING_X}" y2="${gy}" stroke="var(--text-muted, #888)" stroke-width="0.5" stroke-dasharray="3,3"/>`);
  }

  // Data polyline (skip nulls by breaking into segments)
  const points: string[] = [];
  for (let i = 0; i < data.values.length; i++) {
    const v = data.values[i];
    if (v.value !== null) {
      points.push(`${xPos(i)},${yPos(v.value)}`);
    }
  }
  if (points.length > 1) {
    parts.push(`<polyline points="${points.join(" ")}" fill="none" stroke="${data.color}" stroke-width="2"/>`);
  }

  // Data point circles
  for (let i = 0; i < data.values.length; i++) {
    const v = data.values[i];
    if (v.value !== null) {
      parts.push(`<circle cx="${xPos(i)}" cy="${yPos(v.value)}" r="${DOT_RADIUS}" fill="${data.color}"/>`);
    }
  }

  // Day labels
  for (let i = 0; i < data.values.length; i++) {
    const date = new Date(data.values[i].date + "T00:00:00");
    const dayLabel = DAY_LABELS[date.getDay()];
    parts.push(`<text x="${xPos(i)}" y="${CHART_HEIGHT - 2}" font-size="6" fill="var(--text-muted, #888)" text-anchor="middle">${dayLabel}</text>`);
  }

  parts.push("</svg>");
  return parts.join("\n");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dashboard/chart.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/chart.ts tests/dashboard/chart.test.ts
git commit -m "feat: add SVG line chart renderer"
```

---

## Task 4: Quick Links Parser

**Files:**
- Create: `src/dashboard/quick-links.ts`
- Create: `tests/dashboard/quick-links.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/dashboard/quick-links.test.ts
import { describe, it, expect } from "vitest";
import { parseQuickLinks, QuickLink, resolveNotePath } from "@/dashboard/quick-links";

describe("parseQuickLinks", () => {
  it("parses daily entries with explicit folder and format", () => {
    const config = "# Quick Links\n\n- Dream Journal (daily, folder: Dreams/, format: YYYY-MM-DD)";
    const links = parseQuickLinks(config);

    expect(links).toHaveLength(1);
    expect(links[0]).toEqual({
      label: "Dream Journal",
      frequency: "daily",
      folder: "Dreams/",
      dateFormat: "YYYY-MM-DD",
      useDailyNoteSettings: false,
    });
  });

  it("parses entries using daily note settings", () => {
    const config = "- Journal (daily, use daily note settings)";
    const links = parseQuickLinks(config);

    expect(links).toHaveLength(1);
    expect(links[0]).toEqual({
      label: "Journal",
      frequency: "daily",
      folder: null,
      dateFormat: null,
      useDailyNoteSettings: true,
    });
  });

  it("parses weekly entries", () => {
    const config = "- Weekly Review (weekly, folder: Reviews/, format: YYYY-[W]ww)";
    const links = parseQuickLinks(config);

    expect(links).toHaveLength(1);
    expect(links[0].frequency).toBe("weekly");
    expect(links[0].dateFormat).toBe("YYYY-[W]ww");
  });

  it("returns empty array for empty input", () => {
    expect(parseQuickLinks("")).toEqual([]);
  });
});

describe("resolveNotePath", () => {
  it("resolves a daily note path", () => {
    const link: QuickLink = {
      label: "Dream",
      frequency: "daily",
      folder: "Dreams/",
      dateFormat: "YYYY-MM-DD",
      useDailyNoteSettings: false,
    };

    const path = resolveNotePath(link, new Date("2026-04-03T12:00:00"));
    expect(path).toBe("Dreams/2026-04-03.md");
  });

  it("resolves a weekly note path", () => {
    const link: QuickLink = {
      label: "Review",
      frequency: "weekly",
      folder: "Reviews/",
      dateFormat: "YYYY-[W]ww",
      useDailyNoteSettings: false,
    };

    const path = resolveNotePath(link, new Date("2026-04-03T12:00:00"));
    // Apr 3 2026 is a Friday, ISO week 14
    expect(path).toBe("Reviews/2026-W14.md");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dashboard/quick-links.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/dashboard/quick-links.ts

export interface QuickLink {
  label: string;
  frequency: "daily" | "weekly";
  folder: string | null;
  dateFormat: string | null;
  useDailyNoteSettings: boolean;
}

const LINK_REGEX = /^-\s+(.+?)\s+\((.+)\)\s*$/;

export function parseQuickLinks(content: string): QuickLink[] {
  const links: QuickLink[] = [];

  for (const line of content.split("\n")) {
    const match = line.match(LINK_REGEX);
    if (!match) continue;

    const label = match[1].trim();
    const params = match[2].trim();

    if (params.includes("use daily note settings")) {
      const frequency = params.startsWith("weekly") ? "weekly" : "daily";
      links.push({ label, frequency, folder: null, dateFormat: null, useDailyNoteSettings: true });
      continue;
    }

    const parts = params.split(",").map((p) => p.trim());
    const frequency = parts[0] === "weekly" ? "weekly" : "daily";

    let folder: string | null = null;
    let dateFormat: string | null = null;

    for (const part of parts.slice(1)) {
      if (part.startsWith("folder:")) {
        folder = part.replace("folder:", "").trim();
      } else if (part.startsWith("format:")) {
        dateFormat = part.replace("format:", "").trim();
      }
    }

    links.push({ label, frequency, folder, dateFormat, useDailyNoteSettings: false });
  }

  return links;
}

export function resolveNotePath(link: QuickLink, now: Date): string {
  const folder = link.folder ?? "";
  const format = link.dateFormat ?? "YYYY-MM-DD";
  const filename = formatDate(format, now);
  return `${folder}${filename}.md`;
}

function formatDate(format: string, date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");

  let result = format.replace("YYYY", String(year));
  result = result.replace("MM", month);
  result = result.replace("DD", day);

  // ISO week number
  if (result.includes("ww")) {
    const week = String(getISOWeek(date)).padStart(2, "0");
    result = result.replace("ww", week);
  }

  // Handle literal brackets: [W] → W
  result = result.replace(/\[(.+?)\]/g, "$1");

  return result;
}

function getISOWeek(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  d.setUTCDate(d.getUTCDate() + 4 - (d.getUTCDay() || 7));
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dashboard/quick-links.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/quick-links.ts tests/dashboard/quick-links.test.ts
git commit -m "feat: add quick links config parser with date resolution"
```

---

## Task 5: Rediscovery Selection

**Files:**
- Create: `src/dashboard/rediscovery.ts`
- Create: `tests/dashboard/rediscovery.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/dashboard/rediscovery.test.ts
import { describe, it, expect, vi } from "vitest";
import { selectRediscoveryNotes, RediscoverySelection } from "@/dashboard/rediscovery";

describe("selectRediscoveryNotes", () => {
  const today = "2026-04-03";

  const files = [
    { path: "Notes/old-idea.md", mtime: Date.now() - 60 * 24 * 60 * 60 * 1000 },  // 60 days old
    { path: "Notes/recent.md", mtime: Date.now() - 5 * 24 * 60 * 60 * 1000 },     // 5 days old
    { path: "Ideas/forgotten.md", mtime: Date.now() - 90 * 24 * 60 * 60 * 1000 },  // 90 days old
    { path: "Ideas/ancient.md", mtime: Date.now() - 120 * 24 * 60 * 60 * 1000 },   // 120 days old
    { path: "Journal/2026-01-01.md", mtime: Date.now() - 92 * 24 * 60 * 60 * 1000 },
  ];

  it("selects notes older than minAgeDays from configured folders", () => {
    const result = selectRediscoveryNotes(files, {
      folders: ["Notes/", "Ideas/"],
      minAgeDays: 30,
      count: 3,
      today,
    });

    expect(result.length).toBeLessThanOrEqual(3);
    // "recent.md" is only 5 days old, should not appear
    expect(result.every((p) => p !== "Notes/recent.md")).toBe(true);
    // Journal folder not included
    expect(result.every((p) => !p.startsWith("Journal/"))).toBe(true);
  });

  it("returns fewer notes if not enough qualify", () => {
    const result = selectRediscoveryNotes(files, {
      folders: ["Notes/"],
      minAgeDays: 30,
      count: 10,
      today,
    });

    // Only "old-idea.md" qualifies (60 days, in Notes/)
    expect(result).toHaveLength(1);
    expect(result[0]).toBe("Notes/old-idea.md");
  });

  it("returns empty array when no notes qualify", () => {
    const result = selectRediscoveryNotes(files, {
      folders: ["Nonexistent/"],
      minAgeDays: 30,
      count: 3,
      today,
    });
    expect(result).toEqual([]);
  });

  it("uses entire vault when folders is empty", () => {
    const result = selectRediscoveryNotes(files, {
      folders: [],
      minAgeDays: 30,
      count: 10,
      today,
    });
    // Should include notes from all folders that are old enough
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("RediscoverySelection", () => {
  it("serializes and deserializes", () => {
    const selection: RediscoverySelection = {
      date: "2026-04-03",
      paths: ["Notes/old.md", "Ideas/forgotten.md"],
    };

    const json = JSON.stringify(selection);
    const restored: RediscoverySelection = JSON.parse(json);
    expect(restored.date).toBe("2026-04-03");
    expect(restored.paths).toEqual(["Notes/old.md", "Ideas/forgotten.md"]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dashboard/rediscovery.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/dashboard/rediscovery.ts

export interface RediscoverySelection {
  date: string;
  paths: string[];
}

export interface RediscoveryConfig {
  folders: string[];
  minAgeDays: number;
  count: number;
  today: string;
}

export function selectRediscoveryNotes(
  files: Array<{ path: string; mtime: number }>,
  config: RediscoveryConfig,
): string[] {
  const now = new Date(config.today + "T00:00:00").getTime();
  const minAgeMs = config.minAgeDays * 24 * 60 * 60 * 1000;

  const eligible = files.filter((f) => {
    // Age check
    if (now - f.mtime < minAgeMs) return false;

    // Folder check (empty = all folders)
    if (config.folders.length > 0) {
      if (!config.folders.some((folder) => f.path.startsWith(folder))) return false;
    }

    return true;
  });

  // Shuffle using Fisher-Yates
  const shuffled = [...eligible];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  return shuffled.slice(0, config.count).map((f) => f.path);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dashboard/rediscovery.test.ts`
Expected: All 5 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/rediscovery.ts tests/dashboard/rediscovery.test.ts
git commit -m "feat: add rediscovery note selection with folder filtering and age threshold"
```

---

## Task 6: Task Query (Vault Task Extraction)

**Files:**
- Create: `src/dashboard/task-query.ts`
- Create: `tests/dashboard/task-query.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/dashboard/task-query.test.ts
import { describe, it, expect } from "vitest";
import { extractTasks, VaultTask, rankTasks } from "@/dashboard/task-query";

describe("extractTasks", () => {
  it("extracts unchecked tasks", () => {
    const content = "# Notes\n- [ ] Fix the bug\n- [x] Already done\n- [ ] Write tests";
    const tasks = extractTasks(content, "project.md");

    expect(tasks).toHaveLength(2);
    expect(tasks[0].text).toBe("Fix the bug");
    expect(tasks[1].text).toBe("Write tests");
    expect(tasks[0].sourcePath).toBe("project.md");
  });

  it("parses due dates", () => {
    const content = "- [ ] Deploy 📅 2026-04-05";
    const tasks = extractTasks(content, "ops.md");

    expect(tasks[0].dueDate).toBe("2026-04-05");
    expect(tasks[0].text).toBe("Deploy");
  });

  it("handles lines without tasks", () => {
    const content = "# Heading\nSome text\n- Regular list item";
    expect(extractTasks(content, "note.md")).toEqual([]);
  });
});

describe("rankTasks", () => {
  it("sorts dated tasks before undated, earlier dates first", () => {
    const tasks: VaultTask[] = [
      { text: "No date", sourcePath: "a.md", dueDate: null },
      { text: "Later", sourcePath: "b.md", dueDate: "2026-04-10" },
      { text: "Sooner", sourcePath: "c.md", dueDate: "2026-04-05" },
    ];

    const ranked = rankTasks(tasks);
    expect(ranked[0].text).toBe("Sooner");
    expect(ranked[1].text).toBe("Later");
    expect(ranked[2].text).toBe("No date");
  });

  it("respects limit", () => {
    const tasks = Array.from({ length: 10 }, (_, i) => ({
      text: `Task ${i}`,
      sourcePath: "a.md",
      dueDate: null,
    }));

    expect(rankTasks(tasks, 5)).toHaveLength(5);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dashboard/task-query.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/dashboard/task-query.ts

export interface VaultTask {
  text: string;
  sourcePath: string;
  dueDate: string | null;
}

const UNCHECKED_TASK_REGEX = /^-\s+\[\s\]\s+(.+)$/;
const DUE_DATE_REGEX = /📅\s*(\d{4}-\d{2}-\d{2})/;

export function extractTasks(content: string, sourcePath: string): VaultTask[] {
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

    tasks.push({ text, sourcePath, dueDate });
  }

  return tasks;
}

export function rankTasks(tasks: VaultTask[], limit = 25): VaultTask[] {
  const sorted = [...tasks].sort((a, b) => {
    if (a.dueDate && !b.dueDate) return -1;
    if (!a.dueDate && b.dueDate) return 1;
    if (a.dueDate && b.dueDate) return a.dueDate.localeCompare(b.dueDate);
    return 0;
  });

  return sorted.slice(0, limit);
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dashboard/task-query.test.ts`
Expected: All 4 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/task-query.ts tests/dashboard/task-query.test.ts
git commit -m "feat: add vault task extraction and ranking"
```

---

## Task 7: AI Briefing Builder

**Files:**
- Create: `src/dashboard/briefing.ts`
- Create: `tests/dashboard/briefing.test.ts`

- [ ] **Step 1: Write the failing tests**

```typescript
// tests/dashboard/briefing.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { BriefingBuilder } from "@/dashboard/briefing";

describe("BriefingBuilder", () => {
  let builder: BriefingBuilder;

  beforeEach(() => {
    builder = new BriefingBuilder();
  });

  describe("buildPrompt", () => {
    it("includes tasks in the prompt", () => {
      const prompt = builder.buildPrompt({
        tasks: [
          { text: "Fix auth bug", sourcePath: "project.md", dueDate: "2026-04-05" },
        ],
        trackingData: [],
        recentNoteTitles: [],
      });

      expect(prompt.prompt).toContain("Fix auth bug");
      expect(prompt.prompt).toContain("2026-04-05");
    });

    it("includes tracking trends", () => {
      const prompt = builder.buildPrompt({
        tasks: [],
        trackingData: [
          { name: "Sitting Time", unit: "hours", recentValues: [4.2, 3.9, 3.8], goalValue: 3, goalDirection: "<" as const },
        ],
        recentNoteTitles: [],
      });

      expect(prompt.prompt).toContain("Sitting Time");
      expect(prompt.prompt).toContain("3.8");
    });

    it("includes recent note titles", () => {
      const prompt = builder.buildPrompt({
        tasks: [],
        trackingData: [],
        recentNoteTitles: ["Dream: Flying Over Water", "Meeting Notes"],
      });

      expect(prompt.prompt).toContain("Flying Over Water");
    });

    it("has a system prompt requesting a brief summary", () => {
      const prompt = builder.buildPrompt({
        tasks: [],
        trackingData: [],
        recentNoteTitles: [],
      });

      expect(prompt.system).toContain("briefing");
      expect(prompt.maxTokens).toBeLessThanOrEqual(300);
    });
  });

  describe("caching", () => {
    it("returns cached result within TTL", () => {
      builder.setCachedBriefing("Cached summary", Date.now());
      const result = builder.getCachedBriefing(120);
      expect(result).toBe("Cached summary");
    });

    it("returns null when cache is expired", () => {
      builder.setCachedBriefing("Old summary", Date.now() - 200 * 60 * 1000);
      const result = builder.getCachedBriefing(120);
      expect(result).toBeNull();
    });

    it("returns null when no cache exists", () => {
      expect(builder.getCachedBriefing(120)).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/dashboard/briefing.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Write the implementation**

```typescript
// src/dashboard/briefing.ts
import { LLMRequest } from "../llm/provider";

export interface BriefingInput {
  tasks: Array<{ text: string; sourcePath: string; dueDate: string | null }>;
  trackingData: Array<{
    name: string;
    unit: string | null;
    recentValues: (number | null)[];
    goalValue: number | null;
    goalDirection: "<" | ">" | null;
  }>;
  recentNoteTitles: string[];
}

export class BriefingBuilder {
  private cachedText: string | null = null;
  private cachedAt = 0;

  buildPrompt(input: BriefingInput): LLMRequest {
    const sections: string[] = [];

    if (input.tasks.length > 0) {
      sections.push("## Active Tasks");
      for (const t of input.tasks.slice(0, 15)) {
        const due = t.dueDate ? ` (due ${t.dueDate})` : "";
        sections.push(`- ${t.text}${due}`);
      }
    }

    if (input.trackingData.length > 0) {
      sections.push("\n## Tracking (last 7 days)");
      for (const t of input.trackingData) {
        const vals = t.recentValues.filter((v) => v !== null);
        const latest = vals.length > 0 ? vals[vals.length - 1] : "no data";
        const unit = t.unit ?? "";
        const goal = t.goalValue !== null ? ` (goal: ${t.goalDirection}${t.goalValue} ${unit})` : "";
        sections.push(`- ${t.name}: latest ${latest} ${unit}${goal}, values: [${t.recentValues.map((v) => v ?? "—").join(", ")}]`);
      }
    }

    if (input.recentNoteTitles.length > 0) {
      sections.push("\n## Recent Notes (last 7 days)");
      for (const title of input.recentNoteTitles.slice(0, 20)) {
        sections.push(`- ${title}`);
      }
    }

    return {
      system: "You are a personal productivity assistant. Write a 2-3 sentence daily briefing highlighting what's urgent, what's trending, and any notable patterns. Be specific and concise. No filler.",
      prompt: `Based on this vault data, write a brief daily briefing:\n\n${sections.join("\n")}`,
      maxTokens: 200,
      temperature: 0.3,
    };
  }

  setCachedBriefing(text: string, timestamp: number): void {
    this.cachedText = text;
    this.cachedAt = timestamp;
  }

  getCachedBriefing(ttlMinutes: number): string | null {
    if (!this.cachedText) return null;
    if (Date.now() - this.cachedAt > ttlMinutes * 60 * 1000) return null;
    return this.cachedText;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/dashboard/briefing.test.ts`
Expected: All 6 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/dashboard/briefing.ts tests/dashboard/briefing.test.ts
git commit -m "feat: add AI briefing builder with prompt construction and caching"
```

---

## Task 8: Dashboard View (UI Rendering)

This is the main view class. It composes all the data modules into an interactive HTML layout.

**Files:**
- Create: `src/dashboard/view.ts`

- [ ] **Step 1: Write the view**

```typescript
// src/dashboard/view.ts
import { ItemView, WorkspaceLeaf, TFile } from "obsidian";
import { parseTrackingConfig, TrackingEntry } from "./tracking-config";
import { TrackingLog, parseInputValue, DayValue } from "./tracking-log";
import { renderChart } from "./chart";
import { parseQuickLinks, resolveNotePath, QuickLink } from "./quick-links";
import { selectRediscoveryNotes, RediscoverySelection } from "./rediscovery";
import { extractTasks, rankTasks, VaultTask } from "./task-query";
import { BriefingBuilder, BriefingInput } from "./briefing";
import { LLMProvider } from "../llm/provider";

export const DASHBOARD_VIEW_TYPE = "assistant-dashboard";

const METRIC_COLORS = ["#7c6ff5", "#f59e0b", "#4ade80", "#f87171", "#38bdf8", "#a78bfa"];

export interface DashboardDeps {
  readNote: (path: string) => Promise<string | null>;
  writeNote: (path: string, content: string) => Promise<void>;
  getMarkdownFiles: () => Array<{ path: string; stat: { mtime: number }; basename: string }>;
  openNote: (path: string) => void;
  llmProvider: LLMProvider;
  assistantFolder: string;
  settings: {
    aiBriefingCacheMinutes: number;
    rediscoveryFolders: string[];
    rediscoveryMinAgeDays: number;
    rediscoveryCount: number;
  };
}

export class DashboardView extends ItemView {
  private deps: DashboardDeps;
  private trackingLog: TrackingLog = new TrackingLog();
  private briefingBuilder = new BriefingBuilder();
  private rediscoveryCache: RediscoverySelection | null = null;

  constructor(leaf: WorkspaceLeaf, deps: DashboardDeps) {
    super(leaf);
    this.deps = deps;
  }

  getViewType(): string { return DASHBOARD_VIEW_TYPE; }
  getDisplayText(): string { return "Dashboard"; }
  getIcon(): string { return "layout-dashboard"; }

  async onOpen(): Promise<void> {
    await this.loadData();
    this.render();
  }

  async onClose(): Promise<void> {}

  async refresh(): Promise<void> {
    await this.loadData();
    this.render();
  }

  private async loadData(): Promise<void> {
    // Load tracking log
    const logJson = await this.deps.readNote(`${this.deps.assistantFolder}/tracking-log.json`);
    if (logJson) {
      try { this.trackingLog = TrackingLog.deserialize(logJson); } catch { this.trackingLog = new TrackingLog(); }
    }

    // Load rediscovery (persisted daily)
    const rediscoveryJson = await this.deps.readNote(`${this.deps.assistantFolder}/rediscovery.json`);
    if (rediscoveryJson) {
      try { this.rediscoveryCache = JSON.parse(rediscoveryJson); } catch { this.rediscoveryCache = null; }
    }
  }

  private async saveTrackingLog(): Promise<void> {
    await this.deps.writeNote(
      `${this.deps.assistantFolder}/tracking-log.json`,
      this.trackingLog.serialize(),
    );
  }

  private async saveRediscovery(selection: RediscoverySelection): Promise<void> {
    this.rediscoveryCache = selection;
    await this.deps.writeNote(
      `${this.deps.assistantFolder}/rediscovery.json`,
      JSON.stringify(selection, null, 2),
    );
  }

  private render(): void {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("assistant-dashboard");
    container.style.padding = "16px";
    container.style.overflow = "auto";

    this.renderAsync(container);
  }

  private async renderAsync(container: HTMLElement): Promise<void> {
    const today = new Date().toISOString().split("T")[0];
    const now = new Date();

    // --- AI Briefing ---
    const briefingCard = container.createDiv({ cls: "dashboard-briefing" });
    briefingCard.style.background = "var(--background-secondary-alt)";
    briefingCard.style.borderRadius = "6px";
    briefingCard.style.padding = "14px";
    briefingCard.style.marginBottom = "12px";

    const briefingLabel = briefingCard.createDiv();
    briefingLabel.style.fontSize = "0.75em";
    briefingLabel.style.fontWeight = "600";
    briefingLabel.style.textTransform = "uppercase";
    briefingLabel.style.letterSpacing = "0.5px";
    briefingLabel.style.color = "var(--text-muted)";
    briefingLabel.style.marginBottom = "6px";
    briefingLabel.setText("AI Briefing");

    const briefingText = briefingCard.createDiv();
    briefingText.style.fontSize = "0.85em";
    briefingText.style.color = "var(--text-normal)";
    briefingText.style.lineHeight = "1.5";

    const cached = this.briefingBuilder.getCachedBriefing(this.deps.settings.aiBriefingCacheMinutes);
    if (cached) {
      briefingText.setText(cached);
    } else {
      briefingText.setText("Generating briefing...");
      briefingText.style.color = "var(--text-muted)";
      this.generateBriefing(briefingText, today);
    }

    // --- Main grid ---
    const grid = container.createDiv();
    grid.style.display = "grid";
    grid.style.gridTemplateColumns = "1fr 280px";
    grid.style.gap = "12px";

    const leftCol = grid.createDiv();
    leftCol.style.display = "flex";
    leftCol.style.flexDirection = "column";
    leftCol.style.gap = "12px";

    const rightCol = grid.createDiv();
    rightCol.style.display = "flex";
    rightCol.style.flexDirection = "column";
    rightCol.style.gap = "12px";

    // --- Quick Links ---
    const quickLinksContent = await this.deps.readNote(`${this.deps.assistantFolder}/quick-links.md`);
    const quickLinks = quickLinksContent ? parseQuickLinks(quickLinksContent) : [];

    if (quickLinks.length > 0) {
      const qlCard = this.createCard(leftCol, "Quick Links");
      const qlRow = qlCard.createDiv();
      qlRow.style.display = "flex";
      qlRow.style.gap = "8px";
      qlRow.style.flexWrap = "wrap";

      for (const link of quickLinks) {
        const btn = qlRow.createEl("button");
        btn.setText(link.label);
        btn.style.background = "var(--background-secondary-alt)";
        btn.style.border = "none";
        btn.style.borderRadius = "4px";
        btn.style.padding = "8px 14px";
        btn.style.cursor = "pointer";
        btn.style.fontSize = "0.85em";
        btn.style.color = "var(--text-normal)";
        btn.addEventListener("click", () => {
          const path = resolveNotePath(link, now);
          this.deps.openNote(path);
        });
      }
    }

    // --- Active Tasks ---
    const taskCard = this.createCard(leftCol, "Active Tasks");
    const allFiles = this.deps.getMarkdownFiles();
    const allTasks: VaultTask[] = [];
    for (const file of allFiles) {
      if (file.path.startsWith(`${this.deps.assistantFolder}/`)) continue;
      const content = await this.deps.readNote(file.path);
      if (content) {
        allTasks.push(...extractTasks(content, file.path));
      }
    }
    const ranked = rankTasks(allTasks);

    if (ranked.length === 0) {
      const empty = taskCard.createDiv();
      empty.style.color = "var(--text-muted)";
      empty.style.fontSize = "0.85em";
      empty.setText("No open tasks.");
    } else {
      for (const task of ranked) {
        const row = taskCard.createDiv();
        row.style.fontSize = "0.85em";
        row.style.padding = "2px 0";
        row.style.cursor = "pointer";
        row.addEventListener("click", () => this.deps.openNote(task.sourcePath));

        let display = `☐ ${task.text}`;
        if (task.dueDate) display += ` · due ${task.dueDate}`;
        row.setText(display);
      }
    }

    // --- Rediscovery ---
    const rediscoveryPaths = await this.getRediscoveryPaths(today);
    if (rediscoveryPaths.length > 0) {
      const rdCard = this.createCard(leftCol, "Rediscovery");
      const rdLabel = rdCard.querySelector(".dashboard-card-label") as HTMLElement;
      if (rdLabel) {
        const sub = rdLabel.createSpan();
        sub.style.fontWeight = "normal";
        sub.style.textTransform = "none";
        sub.style.letterSpacing = "normal";
        sub.style.marginLeft = "8px";
        sub.style.fontSize = "0.9em";
        sub.setText("Notes you haven't seen in a while");
      }

      for (const path of rediscoveryPaths) {
        const file = allFiles.find((f) => f.path === path);
        if (!file) continue;

        const row = rdCard.createDiv();
        row.style.background = "var(--background-secondary-alt)";
        row.style.borderRadius = "4px";
        row.style.padding = "8px 12px";
        row.style.cursor = "pointer";
        row.style.marginBottom = "4px";
        row.addEventListener("click", () => this.deps.openNote(path));

        const title = row.createDiv();
        title.style.fontSize = "0.85em";
        title.style.fontWeight = "500";
        title.setText(file.basename);

        const meta = row.createDiv();
        meta.style.fontSize = "0.75em";
        meta.style.color = "var(--text-muted)";
        meta.style.marginTop = "2px";
        const daysAgo = Math.floor((Date.now() - file.stat.mtime) / (24 * 60 * 60 * 1000));
        const folder = path.includes("/") ? path.split("/").slice(0, -1).join("/") : "";
        meta.setText(`${folder ? folder + " · " : ""}last opened ${daysAgo} days ago`);
      }
    }

    // --- Right Column: Tracking Config ---
    const trackingContent = await this.deps.readNote(`${this.deps.assistantFolder}/tracking.md`);
    const entries = trackingContent ? parseTrackingConfig(trackingContent) : [];
    const booleans = entries.filter((e) => e.type === "boolean");
    const numerics = entries.filter((e) => e.type === "numeric");

    if (entries.length === 0) {
      const emptyCard = this.createCard(rightCol, "Tracking");
      const msg = emptyCard.createDiv();
      msg.style.fontSize = "0.85em";
      msg.style.color = "var(--text-muted)";
      msg.setText("No metrics configured. Edit AI-Assistant/tracking.md to add habits and metrics.");
    }

    // --- Habits (boolean) ---
    if (booleans.length > 0) {
      const habitCard = this.createCard(rightCol, "Habits");

      for (const entry of booleans) {
        const row = habitCard.createDiv();
        row.style.display = "flex";
        row.style.justifyContent = "space-between";
        row.style.alignItems = "center";
        row.style.fontSize = "0.85em";
        row.style.padding = "2px 0";

        row.createSpan({ text: entry.name });

        const gridSpan = row.createSpan();
        const recentData = this.trackingLog.getRecentValues(entry.name, today, 7);

        for (let i = 0; i < recentData.length; i++) {
          const day = recentData[i];
          const isToday = day.date === today;
          const cell = gridSpan.createSpan();
          cell.setText(day.value === 1 ? "■" : "□");
          cell.style.color = day.value === 1 ? "#4ade80" : "var(--text-muted)";
          if (isToday) {
            cell.style.cursor = "pointer";
            cell.addEventListener("click", async () => {
              this.trackingLog.toggleBoolean(entry.name, today);
              await this.saveTrackingLog();
              this.render();
            });
          }
        }

        const count = recentData.filter((d) => d.value === 1).length;
        const countSpan = gridSpan.createSpan({ text: ` ${count}/7` });
        countSpan.style.color = "var(--text-muted)";
        countSpan.style.fontSize = "0.85em";
        countSpan.style.marginLeft = "4px";
      }
    }

    // --- Tracking graphs (numeric) ---
    for (let idx = 0; idx < numerics.length; idx++) {
      const entry = numerics[idx];
      const color = METRIC_COLORS[idx % METRIC_COLORS.length];
      const card = this.createCard(rightCol, "");

      // Header row
      const header = card.createDiv();
      header.style.display = "flex";
      header.style.justifyContent = "space-between";
      header.style.alignItems = "baseline";
      header.style.marginBottom = "4px";

      const nameEl = header.createDiv();
      nameEl.style.fontSize = "0.75em";
      nameEl.style.fontWeight = "600";
      nameEl.style.textTransform = "uppercase";
      nameEl.style.letterSpacing = "0.5px";
      nameEl.style.color = "var(--text-muted)";
      nameEl.setText(entry.name);

      if (entry.goalValue !== null) {
        const goalEl = header.createDiv();
        goalEl.style.fontSize = "0.75em";
        goalEl.style.color = "var(--text-muted)";
        goalEl.setText(`Goal: ${entry.goalDirection}${entry.goalValue}${entry.unit ? " " + entry.unit : ""}`);
      }

      // Input row
      const inputRow = card.createDiv();
      inputRow.style.display = "flex";
      inputRow.style.alignItems = "center";
      inputRow.style.gap = "8px";
      inputRow.style.marginBottom = "8px";

      const currentValue = this.trackingLog.getValue(entry.name, today);

      const input = inputRow.createEl("input");
      input.type = "text";
      input.placeholder = entry.unit ?? "value";
      input.value = currentValue !== null ? String(currentValue) : "";
      input.style.width = "80px";
      input.style.padding = "4px 8px";
      input.style.fontSize = "0.85em";
      input.style.border = "1px solid var(--background-modifier-border)";
      input.style.borderRadius = "4px";
      input.style.background = "var(--background-primary)";
      input.style.color = "var(--text-normal)";

      input.addEventListener("keydown", async (e) => {
        if (e.key !== "Enter") return;
        const parsed = parseInputValue(input.value);
        if (parsed === null) {
          input.style.borderColor = "#f87171";
          setTimeout(() => { input.style.borderColor = "var(--background-modifier-border)"; }, 1000);
          return;
        }
        this.trackingLog.logValue(entry.name, today, parsed);
        await this.saveTrackingLog();
        this.render();
      });

      // Trend display
      const recentData = this.trackingLog.getRecentValues(entry.name, today, 7);
      const nonNullValues = recentData.map((d) => d.value).filter((v) => v !== null) as number[];

      if (nonNullValues.length >= 2) {
        const latest = nonNullValues[nonNullValues.length - 1];
        const prev = nonNullValues[nonNullValues.length - 2];
        const diff = latest - prev;

        const trendEl = inputRow.createSpan();
        trendEl.style.fontSize = "1.2em";
        trendEl.style.fontWeight = "600";
        trendEl.setText(String(latest));

        if (diff !== 0) {
          const arrow = inputRow.createSpan();
          arrow.style.fontSize = "0.75em";
          const isGood = entry.goalDirection === "<" ? diff < 0 : diff > 0;
          arrow.style.color = isGood ? "#4ade80" : "#f87171";
          arrow.setText(`${diff > 0 ? "↑" : "↓"} ${Math.abs(diff).toFixed(1)}`);
        }
      }

      // Chart
      const chartData = {
        values: recentData,
        goalValue: entry.goalValue,
        color,
      };
      const svgStr = renderChart(chartData);
      const chartDiv = card.createDiv();
      chartDiv.innerHTML = svgStr;
      const svgEl = chartDiv.querySelector("svg");
      if (svgEl) svgEl.style.width = "100%";
    }
  }

  private createCard(parent: HTMLElement, label: string): HTMLElement {
    const card = parent.createDiv();
    card.style.background = "var(--background-secondary)";
    card.style.borderRadius = "4px";
    card.style.padding = "12px";

    if (label) {
      const labelEl = card.createDiv({ cls: "dashboard-card-label" });
      labelEl.style.fontSize = "0.75em";
      labelEl.style.fontWeight = "600";
      labelEl.style.textTransform = "uppercase";
      labelEl.style.letterSpacing = "0.5px";
      labelEl.style.color = "var(--text-muted)";
      labelEl.style.marginBottom = "8px";
      labelEl.setText(label);
    }

    return card;
  }

  private async getRediscoveryPaths(today: string): Promise<string[]> {
    // Check persisted selection
    if (this.rediscoveryCache && this.rediscoveryCache.date === today) {
      return this.rediscoveryCache.paths.filter((p) =>
        this.deps.getMarkdownFiles().some((f) => f.path === p),
      );
    }

    // Generate new selection
    const files = this.deps.getMarkdownFiles()
      .filter((f) => !f.path.startsWith(`${this.deps.assistantFolder}/`))
      .map((f) => ({ path: f.path, mtime: f.stat.mtime }));

    const paths = selectRediscoveryNotes(files, {
      folders: this.deps.settings.rediscoveryFolders,
      minAgeDays: this.deps.settings.rediscoveryMinAgeDays,
      count: this.deps.settings.rediscoveryCount,
      today,
    });

    await this.saveRediscovery({ date: today, paths });
    return paths;
  }

  private async generateBriefing(targetEl: HTMLElement, today: string): Promise<void> {
    try {
      // Gather data for the briefing
      const allFiles = this.deps.getMarkdownFiles();
      const allTasks: VaultTask[] = [];
      for (const file of allFiles) {
        if (file.path.startsWith(`${this.deps.assistantFolder}/`)) continue;
        const content = await this.deps.readNote(file.path);
        if (content) allTasks.push(...extractTasks(content, file.path));
      }

      const trackingContent = await this.deps.readNote(`${this.deps.assistantFolder}/tracking.md`);
      const entries = trackingContent ? parseTrackingConfig(trackingContent) : [];
      const trackingData = entries
        .filter((e) => e.type === "numeric")
        .map((e) => ({
          name: e.name,
          unit: e.unit,
          recentValues: this.trackingLog.getRecentValues(e.name, today, 7).map((d) => d.value),
          goalValue: e.goalValue,
          goalDirection: e.goalDirection,
        }));

      const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const recentNoteTitles = allFiles
        .filter((f) => f.stat.mtime > sevenDaysAgo && !f.path.startsWith(`${this.deps.assistantFolder}/`))
        .sort((a, b) => b.stat.mtime - a.stat.mtime)
        .slice(0, 20)
        .map((f) => f.basename);

      const prompt = this.briefingBuilder.buildPrompt({
        tasks: rankTasks(allTasks, 15),
        trackingData,
        recentNoteTitles,
      });

      const response = await this.deps.llmProvider.complete(prompt);
      this.briefingBuilder.setCachedBriefing(response.content, Date.now());
      targetEl.style.color = "var(--text-normal)";
      targetEl.setText(response.content);
    } catch {
      targetEl.setText("AI briefing unavailable — Ollama not running.");
      targetEl.style.color = "var(--text-muted)";
    }
  }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `npx tsc -noEmit -skipLibCheck`
Expected: PASS (no errors)

- [ ] **Step 3: Commit**

```bash
git add src/dashboard/view.ts
git commit -m "feat: add DashboardView with all sections and interactive tracking"
```

---

## Task 9: Update Settings and Wire Into Plugin Lifecycle

**Files:**
- Modify: `src/settings.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: Update settings**

In `src/settings.ts`, replace the old dashboard settings in the `PluginSettings` interface. Remove `dashboardPath`, `autoDashboardRefresh`, `dashboardRefreshIntervalHours`. Add:

```typescript
  openDashboardOnStartup: boolean;
  aiBriefingCacheMinutes: number;
  rediscoveryFolders: string;       // comma-separated
  rediscoveryMinAgeDays: number;
  rediscoveryCount: number;
```

Update `DEFAULT_SETTINGS` — remove the three old keys, add:

```typescript
  openDashboardOnStartup: true,
  aiBriefingCacheMinutes: 120,
  rediscoveryFolders: "",
  rediscoveryMinAgeDays: 30,
  rediscoveryCount: 3,
```

In the `display()` method, remove the Dashboard section (dashboard path setting) and the auto-refresh dashboard toggle/interval. Replace with:

```typescript
    // --- Dashboard ---
    containerEl.createEl("h3", { text: "Dashboard" });

    new Setting(containerEl)
      .setName("Open dashboard on startup")
      .setDesc("Show the dashboard when Obsidian opens")
      .addToggle((toggle) =>
        (toggle as any)
          .setValue(this.settings.openDashboardOnStartup)
          .onChange(async (value: boolean) => {
            this.settings.openDashboardOnStartup = value;
            await this.save();
          }),
      );

    new Setting(containerEl)
      .setName("AI briefing cache (minutes)")
      .setDesc("How long to cache the AI briefing before regenerating")
      .addSlider((slider) =>
        (slider as any)
          .setLimits(15, 480, 15)
          .setValue(this.settings.aiBriefingCacheMinutes)
          .setDynamicTooltip()
          .onChange(async (value: number) => {
            this.settings.aiBriefingCacheMinutes = value;
            await this.save();
          }),
      );

    new Setting(containerEl)
      .setName("Rediscovery folders")
      .setDesc("Comma-separated folders to draw rediscovery notes from. Empty = entire vault.")
      .addText((text) =>
        (text as any)
          .setPlaceholder("Notes/, Ideas/")
          .setValue(this.settings.rediscoveryFolders)
          .onChange(async (value: string) => {
            this.settings.rediscoveryFolders = value;
            await this.save();
          }),
      );

    new Setting(containerEl)
      .setName("Rediscovery minimum age (days)")
      .setDesc("Only show notes not opened for at least this many days")
      .addSlider((slider) =>
        (slider as any)
          .setLimits(7, 180, 7)
          .setValue(this.settings.rediscoveryMinAgeDays)
          .setDynamicTooltip()
          .onChange(async (value: number) => {
            this.settings.rediscoveryMinAgeDays = value;
            await this.save();
          }),
      );
```

- [ ] **Step 2: Update main.ts — imports and fields**

Remove imports:
```typescript
import { HabitTracker } from "./modules/dashboard/habits";
import { DashboardModule } from "./modules/dashboard/dashboard";
```

Add import:
```typescript
import { DashboardView, DASHBOARD_VIEW_TYPE, DashboardDeps } from "./dashboard/view";
```

Remove fields:
```typescript
  private habitTracker = new HabitTracker();
  private dashboard = new DashboardModule();
```

Add field:
```typescript
  private dashboardView: DashboardView | null = null;
```

- [ ] **Step 3: Update main.ts — register the dashboard view**

In `onload`, after the suggestions panel `registerView` block, add:

```typescript
    this.registerView(DASHBOARD_VIEW_TYPE, (leaf) => {
      this.dashboardView = new DashboardView(leaf, this.createDashboardDeps());
      return this.dashboardView;
    });
```

Replace the "update-dashboard" command callback:

```typescript
    this.addCommand({
      id: "open-dashboard",
      name: "Open dashboard",
      callback: () => this.activateDashboard(),
    });
```

- [ ] **Step 4: Update main.ts — add dashboard activation and deps**

Add methods:

```typescript
  private async activateDashboard(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: DASHBOARD_VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  private createDashboardDeps(): DashboardDeps {
    return {
      readNote: (path) => this.vaultService.readNote(path),
      writeNote: (path, content) => this.vaultService.writeNote(path, content),
      getMarkdownFiles: () => this.vaultService.getMarkdownFiles(),
      openNote: (path) => this.app.workspace.openLinkText(path, ""),
      llmProvider: this.ollama,
      assistantFolder: ASSISTANT_FOLDER,
      settings: {
        aiBriefingCacheMinutes: this.settings.aiBriefingCacheMinutes,
        rediscoveryFolders: this.settings.rediscoveryFolders
          .split(",")
          .map((s) => s.trim())
          .filter((s) => s.length > 0),
        rediscoveryMinAgeDays: this.settings.rediscoveryMinAgeDays,
        rediscoveryCount: this.settings.rediscoveryCount,
      },
    };
  }
```

- [ ] **Step 5: Update main.ts — onLayoutReady**

In `onLayoutReady`, replace the old dashboard refresh block:

```typescript
    if (this.settings.autoDashboardRefresh) {
      this.registerInterval(
        window.setInterval(
          () => this.updateDashboard(),
          this.settings.dashboardRefreshIntervalHours * 60 * 60 * 1000,
        ),
      );
      this.updateDashboard();
    }
```

with:

```typescript
    if (this.settings.openDashboardOnStartup) {
      this.activateDashboard();
    }
```

- [ ] **Step 6: Update main.ts — remove old dashboard and habit methods**

Remove the entire `updateDashboard` method and the `logHabit` method (habit logging is now done via the dashboard's interactive toggle). Remove the "log-habit" command registration. Remove the `SuggestionModal` import if it's only used by `logHabit` — check first.

- [ ] **Step 7: Verify**

Run: `npx tsc -noEmit -skipLibCheck`
Expected: PASS

Run: `npx vitest run`
Expected: All tests PASS (old dashboard/habits tests may fail — handled in Task 10)

- [ ] **Step 8: Commit**

```bash
git add src/settings.ts src/main.ts
git commit -m "feat: wire DashboardView into plugin lifecycle, remove old dashboard"
```

---

## Task 10: Remove Old Dashboard and Habits Modules, Update Tests

**Files:**
- Delete: `src/modules/dashboard/dashboard.ts`
- Delete: `src/modules/dashboard/habits.ts`
- Delete: `tests/modules/dashboard.test.ts`
- Delete: `tests/modules/habits.test.ts`
- Modify: any remaining test files that import removed modules

- [ ] **Step 1: Delete old files**

```bash
rm src/modules/dashboard/dashboard.ts src/modules/dashboard/habits.ts
rm tests/modules/dashboard.test.ts tests/modules/habits.test.ts
```

- [ ] **Step 2: Check for remaining references**

```bash
grep -r "modules/dashboard" src/ tests/ --include="*.ts"
```

Fix any remaining imports. If `src/modules/dashboard/` is now empty, remove the directory.

- [ ] **Step 3: Migrate habit-log on first load**

In `src/dashboard/view.ts`, update `loadData` to handle migration:

In the `loadData` method, after loading the tracking log, add migration logic:

```typescript
    // Migrate from old habit-log format if needed
    if (!logJson) {
      const oldLog = await this.deps.readNote(`${this.deps.assistantFolder}/habit-log.md`);
      if (oldLog && oldLog.trim() !== "{}") {
        try {
          this.trackingLog = TrackingLog.migrateFromHabitLog(oldLog);
          await this.saveTrackingLog();
        } catch { /* old format unreadable, start fresh */ }
      }
    }
```

- [ ] **Step 4: Verify full suite**

Run: `npx tsc -noEmit -skipLibCheck`
Expected: PASS

Run: `npx vitest run`
Expected: All tests PASS

Run: `node esbuild.config.mjs`
Expected: Build succeeds

- [ ] **Step 5: Commit**

```bash
git rm src/modules/dashboard/dashboard.ts src/modules/dashboard/habits.ts
git rm tests/modules/dashboard.test.ts tests/modules/habits.test.ts
git add src/dashboard/view.ts
git commit -m "refactor: remove old dashboard/habits modules, add habit-log migration"
```

---

## Task 11: Integration Test

**Files:**
- Create: `tests/integration/dashboard-flow.test.ts`

- [ ] **Step 1: Write the integration tests**

```typescript
// tests/integration/dashboard-flow.test.ts
import { describe, it, expect, vi } from "vitest";
import { parseTrackingConfig } from "@/dashboard/tracking-config";
import { TrackingLog, parseInputValue } from "@/dashboard/tracking-log";
import { renderChart } from "@/dashboard/chart";
import { parseQuickLinks, resolveNotePath } from "@/dashboard/quick-links";
import { selectRediscoveryNotes } from "@/dashboard/rediscovery";
import { extractTasks, rankTasks } from "@/dashboard/task-query";
import { BriefingBuilder } from "@/dashboard/briefing";

describe("Dashboard data pipeline", () => {
  it("tracking config → log → chart renders end-to-end", () => {
    const config = "- Sitting Time (hours, goal: <3)\n- Exercise (boolean)";
    const entries = parseTrackingConfig(config);
    expect(entries).toHaveLength(2);

    const log = new TrackingLog();
    log.logValue("Sitting Time", "2026-04-01", 4.2);
    log.logValue("Sitting Time", "2026-04-02", 3.9);
    log.logValue("Sitting Time", "2026-04-03", 3.8);

    const recentData = log.getRecentValues("Sitting Time", "2026-04-03", 7);
    const numeric = entries.find((e) => e.type === "numeric")!;

    const svg = renderChart({
      values: recentData,
      goalValue: numeric.goalValue,
      color: "#7c6ff5",
    });

    expect(svg).toContain("<svg");
    expect(svg).toContain("<polyline");
    expect(svg).toContain("stroke-dasharray"); // goal line
  });

  it("quick links resolve to correct paths", () => {
    const config = "- Dream (daily, folder: Dreams/, format: YYYY-MM-DD)";
    const links = parseQuickLinks(config);
    const path = resolveNotePath(links[0], new Date("2026-04-03T12:00:00"));
    expect(path).toBe("Dreams/2026-04-03.md");
  });

  it("task extraction feeds into briefing builder", () => {
    const content = "- [ ] Fix bug 📅 2026-04-05\n- [ ] Write docs\n- [x] Done task";
    const tasks = extractTasks(content, "project.md");
    const ranked = rankTasks(tasks);

    const builder = new BriefingBuilder();
    const prompt = builder.buildPrompt({
      tasks: ranked,
      trackingData: [],
      recentNoteTitles: [],
    });

    expect(prompt.prompt).toContain("Fix bug");
    expect(prompt.prompt).toContain("2026-04-05");
    expect(prompt.prompt).not.toContain("Done task");
  });

  it("rediscovery respects folder and age filters", () => {
    const files = [
      { path: "Notes/old.md", mtime: Date.now() - 60 * 24 * 60 * 60 * 1000 },
      { path: "Journal/2026-01-01.md", mtime: Date.now() - 90 * 24 * 60 * 60 * 1000 },
    ];

    const paths = selectRediscoveryNotes(files, {
      folders: ["Notes/"],
      minAgeDays: 30,
      count: 3,
      today: "2026-04-03",
    });

    expect(paths).toEqual(["Notes/old.md"]);
  });

  it("input parsing handles all formats", () => {
    expect(parseInputValue("42")).toBe(42);
    expect(parseInputValue("1.5")).toBe(1.5);
    expect(parseInputValue("2:30")).toBeCloseTo(2.5);
    expect(parseInputValue("invalid")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests**

Run: `npx vitest run tests/integration/dashboard-flow.test.ts`
Expected: All 5 tests PASS

Run: `npx vitest run`
Expected: Full suite PASS

- [ ] **Step 3: Final build**

Run: `npx tsc -noEmit -skipLibCheck && node esbuild.config.mjs`
Expected: Both pass

- [ ] **Step 4: Commit**

```bash
git add tests/integration/dashboard-flow.test.ts
git commit -m "test: add integration tests for dashboard data pipeline"
```
