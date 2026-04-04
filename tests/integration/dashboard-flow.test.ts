import { describe, it, expect } from "vitest";
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
    expect(svg).toContain("stroke-dasharray");
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
