export interface ChartData {
  values: Array<{ date: string; value: number | null }>;
  goalValue: number | null;
  color: string;
}

const DAY_LABELS = ["S", "M", "T", "W", "T", "F", "S"];

const WIDTH = 240;
const HEIGHT = 70;
const PAD_LEFT = 8;
const PAD_RIGHT = 8;
const PAD_TOP = 8;
const PAD_BOTTOM = 16; // room for day labels

function parseDateDow(dateStr: string): number {
  // Parse YYYY-MM-DD without timezone shifts
  const [y, m, d] = dateStr.split("-").map(Number);
  return new Date(y, m - 1, d).getDay();
}

export function renderChart(data: ChartData): string {
  const nonNull = data.values.filter((v) => v.value !== null) as Array<{
    date: string;
    value: number;
  }>;

  const chartW = WIDTH - PAD_LEFT - PAD_RIGHT;
  const chartH = HEIGHT - PAD_TOP - PAD_BOTTOM;
  const n = data.values.length;

  // Y-axis scaling with 10% padding
  let minV = 0;
  let maxV = 1;
  if (nonNull.length > 0) {
    minV = Math.min(...nonNull.map((v) => v.value));
    maxV = Math.max(...nonNull.map((v) => v.value));
  }
  if (nonNull.length > 0 && data.goalValue !== null) {
    minV = Math.min(minV, data.goalValue);
    maxV = Math.max(maxV, data.goalValue);
  }
  const range = maxV - minV || 1;
  const padV = range * 0.1;
  const yMin = minV - padV;
  const yMax = maxV + padV;
  const yRange = yMax - yMin;

  function xAt(i: number): number {
    if (n <= 1) return PAD_LEFT + chartW / 2;
    return PAD_LEFT + (i / (n - 1)) * chartW;
  }

  function yAt(v: number): number {
    return PAD_TOP + chartH - ((v - yMin) / yRange) * chartH;
  }

  const parts: string[] = [];

  // SVG open
  parts.push(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}">`
  );

  if (nonNull.length > 0) {
    // Build index map for x positions
    const indexedValues = data.values.map((v, i) => ({ ...v, i }));

    // Polyline: connect non-null points in order
    const polyPoints = indexedValues
      .filter((v) => v.value !== null)
      .map((v) => `${xAt(v.i).toFixed(2)},${yAt(v.value as number).toFixed(2)}`)
      .join(" ");
    parts.push(
      `<polyline points="${polyPoints}" fill="none" stroke="${data.color}" stroke-width="1.5"/>`
    );

    // Circles for each non-null point
    for (const v of indexedValues) {
      if (v.value !== null) {
        const cx = xAt(v.i).toFixed(2);
        const cy = yAt(v.value).toFixed(2);
        parts.push(
          `<circle cx="${cx}" cy="${cy}" r="2.5" fill="${data.color}"/>`
        );
      }
    }

    // Dashed goal line
    if (data.goalValue !== null) {
      const gy = yAt(data.goalValue).toFixed(2);
      parts.push(
        `<line x1="${PAD_LEFT}" y1="${gy}" x2="${WIDTH - PAD_RIGHT}" y2="${gy}" stroke="${data.color}" stroke-width="1" stroke-dasharray="3 2" opacity="0.5"/>`
      );
    }
  }

  // Day-of-week labels
  const labelY = HEIGHT - 3;
  for (let i = 0; i < data.values.length; i++) {
    const dow = parseDateDow(data.values[i].date);
    const label = DAY_LABELS[dow];
    const lx = xAt(i).toFixed(2);
    parts.push(
      `<text x="${lx}" y="${labelY}" text-anchor="middle" font-size="7" fill="#888">${label}</text>`
    );
  }

  parts.push("</svg>");
  return parts.join("\n");
}
