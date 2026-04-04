import { describe, it, expect, beforeEach } from "vitest";
import { BriefingBuilder } from "@/dashboard/briefing";

describe("BriefingBuilder", () => {
  let builder: BriefingBuilder;
  beforeEach(() => { builder = new BriefingBuilder(); });

  describe("buildPrompt", () => {
    it("includes tasks in the prompt", () => {
      const prompt = builder.buildPrompt({
        tasks: [{ text: "Fix auth bug", sourcePath: "project.md", dueDate: "2026-04-05" }],
        trackingData: [], recentNoteTitles: [],
      });
      expect(prompt.prompt).toContain("Fix auth bug");
      expect(prompt.prompt).toContain("2026-04-05");
    });
    it("includes tracking trends", () => {
      const prompt = builder.buildPrompt({
        tasks: [],
        trackingData: [{ name: "Sitting Time", unit: "hours", recentValues: [4.2, 3.9, 3.8], goalValue: 3, goalDirection: "<" as const }],
        recentNoteTitles: [],
      });
      expect(prompt.prompt).toContain("Sitting Time");
      expect(prompt.prompt).toContain("3.8");
    });
    it("includes recent note titles", () => {
      const prompt = builder.buildPrompt({
        tasks: [], trackingData: [],
        recentNoteTitles: ["Dream: Flying Over Water", "Meeting Notes"],
      });
      expect(prompt.prompt).toContain("Flying Over Water");
    });
    it("has a system prompt requesting a brief summary", () => {
      const prompt = builder.buildPrompt({ tasks: [], trackingData: [], recentNoteTitles: [] });
      expect(prompt.system).toContain("briefing");
      expect(prompt.maxTokens).toBeLessThanOrEqual(300);
    });
  });

  describe("caching", () => {
    it("returns cached result within TTL", () => {
      builder.setCachedBriefing("Cached summary", Date.now());
      expect(builder.getCachedBriefing(120)).toBe("Cached summary");
    });
    it("returns null when cache is expired", () => {
      builder.setCachedBriefing("Old summary", Date.now() - 200 * 60 * 1000);
      expect(builder.getCachedBriefing(120)).toBeNull();
    });
    it("returns null when no cache exists", () => {
      expect(builder.getCachedBriefing(120)).toBeNull();
    });
  });
});
