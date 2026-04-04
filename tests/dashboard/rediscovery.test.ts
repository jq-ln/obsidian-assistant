import { describe, it, expect } from "vitest";
import { selectRediscoveryNotes, RediscoverySelection } from "@/dashboard/rediscovery";

describe("selectRediscoveryNotes", () => {
  const today = "2026-04-03";
  const files = [
    { path: "Notes/old-idea.md", mtime: Date.now() - 60 * 24 * 60 * 60 * 1000 },
    { path: "Notes/recent.md", mtime: Date.now() - 5 * 24 * 60 * 60 * 1000 },
    { path: "Ideas/forgotten.md", mtime: Date.now() - 90 * 24 * 60 * 60 * 1000 },
    { path: "Ideas/ancient.md", mtime: Date.now() - 120 * 24 * 60 * 60 * 1000 },
    { path: "Journal/2026-01-01.md", mtime: Date.now() - 92 * 24 * 60 * 60 * 1000 },
  ];

  it("selects notes older than minAgeDays from configured folders", () => {
    const result = selectRediscoveryNotes(files, { folders: ["Notes/", "Ideas/"], minAgeDays: 30, count: 3, today });
    expect(result.length).toBeLessThanOrEqual(3);
    expect(result.every((p) => p !== "Notes/recent.md")).toBe(true);
    expect(result.every((p) => !p.startsWith("Journal/"))).toBe(true);
  });
  it("returns fewer notes if not enough qualify", () => {
    const result = selectRediscoveryNotes(files, { folders: ["Notes/"], minAgeDays: 30, count: 10, today });
    expect(result).toHaveLength(1);
    expect(result[0]).toBe("Notes/old-idea.md");
  });
  it("returns empty array when no notes qualify", () => {
    expect(selectRediscoveryNotes(files, { folders: ["Nonexistent/"], minAgeDays: 30, count: 3, today })).toEqual([]);
  });
  it("uses entire vault when folders is empty", () => {
    const result = selectRediscoveryNotes(files, { folders: [], minAgeDays: 30, count: 10, today });
    expect(result.length).toBeGreaterThan(0);
  });
});

describe("RediscoverySelection", () => {
  it("serializes and deserializes", () => {
    const selection: RediscoverySelection = { date: "2026-04-03", paths: ["Notes/old.md", "Ideas/forgotten.md"] };
    const json = JSON.stringify(selection);
    const restored: RediscoverySelection = JSON.parse(json);
    expect(restored.date).toBe("2026-04-03");
    expect(restored.paths).toEqual(["Notes/old.md", "Ideas/forgotten.md"]);
  });
});
