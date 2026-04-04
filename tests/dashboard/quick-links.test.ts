import { describe, it, expect } from "vitest";
import { parseQuickLinks, QuickLink, resolveNotePath } from "@/dashboard/quick-links";

describe("parseQuickLinks", () => {
  it("parses daily entries with explicit folder and format", () => {
    const config = "# Quick Links\n\n- Dream Journal (daily, folder: Dreams/, format: YYYY-MM-DD)";
    const links = parseQuickLinks(config);
    expect(links).toHaveLength(1);
    expect(links[0]).toEqual({ label: "Dream Journal", frequency: "daily", folder: "Dreams/", dateFormat: "YYYY-MM-DD", useDailyNoteSettings: false });
  });
  it("parses entries using daily note settings", () => {
    const config = "- Journal (daily, use daily note settings)";
    const links = parseQuickLinks(config);
    expect(links).toHaveLength(1);
    expect(links[0]).toEqual({ label: "Journal", frequency: "daily", folder: null, dateFormat: null, useDailyNoteSettings: true });
  });
  it("parses weekly entries", () => {
    const config = "- Weekly Review (weekly, folder: Reviews/, format: YYYY-[W]ww)";
    const links = parseQuickLinks(config);
    expect(links[0].frequency).toBe("weekly");
    expect(links[0].dateFormat).toBe("YYYY-[W]ww");
  });
  it("returns empty array for empty input", () => { expect(parseQuickLinks("")).toEqual([]); });
});

describe("resolveNotePath", () => {
  it("resolves a daily note path", () => {
    const link: QuickLink = { label: "Dream", frequency: "daily", folder: "Dreams/", dateFormat: "YYYY-MM-DD", useDailyNoteSettings: false };
    expect(resolveNotePath(link, new Date("2026-04-03T12:00:00"))).toBe("Dreams/2026-04-03.md");
  });
  it("resolves a weekly note path", () => {
    const link: QuickLink = { label: "Review", frequency: "weekly", folder: "Reviews/", dateFormat: "YYYY-[W]ww", useDailyNoteSettings: false };
    expect(resolveNotePath(link, new Date("2026-04-03T12:00:00"))).toBe("Reviews/2026-W14.md");
  });
});
