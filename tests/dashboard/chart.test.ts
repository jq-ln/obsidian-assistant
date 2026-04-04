import { describe, it, expect } from "vitest";
import { renderChart, ChartData } from "@/dashboard/chart";

describe("renderChart", () => {
  const sampleData: ChartData = {
    values: [
      { date: "2026-03-28", value: 4.5 }, { date: "2026-03-29", value: 4.2 },
      { date: "2026-03-30", value: null }, { date: "2026-03-31", value: 3.9 },
      { date: "2026-04-01", value: 4.0 }, { date: "2026-04-02", value: 3.6 },
      { date: "2026-04-03", value: 3.8 },
    ],
    goalValue: 3, color: "#7c6ff5",
  };

  it("returns an SVG string", () => { const svg = renderChart(sampleData); expect(svg).toContain("<svg"); expect(svg).toContain("</svg>"); });
  it("includes a polyline for data points", () => { expect(renderChart(sampleData)).toContain("<polyline"); });
  it("includes circle elements for each non-null data point", () => { const circles = renderChart(sampleData).match(/<circle/g); expect(circles).toHaveLength(6); });
  it("includes a dashed goal line when goalValue is set", () => { expect(renderChart(sampleData)).toContain("stroke-dasharray"); });
  it("omits goal line when goalValue is null", () => { expect(renderChart({ ...sampleData, goalValue: null })).not.toContain("stroke-dasharray"); });
  it("includes day-of-week labels", () => { expect(renderChart(sampleData)).toContain(">M<"); });
  it("handles all-null data gracefully", () => {
    const empty: ChartData = { values: Array.from({ length: 7 }, (_, i) => ({ date: `2026-04-0${i + 1}`, value: null })), goalValue: null, color: "#7c6ff5" };
    const svg = renderChart(empty);
    expect(svg).toContain("<svg");
    expect(svg).not.toContain("<circle");
  });
});
