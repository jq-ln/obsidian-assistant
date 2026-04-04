export type DayValue = { date: string; value: number | null };

/**
 * Parse a user input string into a numeric value.
 * Accepts: integers, floats, and h:mm time strings (converted to decimal hours).
 * Returns null for empty, negative, or unparseable input.
 */
export function parseInputValue(input: string): number | null {
  if (!input || input.trim() === "") return null;

  const trimmed = input.trim();

  // h:mm time format
  const timeMatch = trimmed.match(/^(\d+):(\d{2})$/);
  if (timeMatch) {
    const hours = parseInt(timeMatch[1], 10);
    const minutes = parseInt(timeMatch[2], 10);
    if (minutes > 59) return null;
    return hours + minutes / 60;
  }

  // Numeric (int or float)
  const num = Number(trimmed);
  if (!isNaN(num) && trimmed !== "" && num >= 0) return num;

  return null;
}

/**
 * Compute the date string for n days before a given ISO date string (YYYY-MM-DD).
 */
export function daysAgo(today: string, n: number): string {
  const d = new Date(today + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

/** Convert a metric name to a frontmatter-safe key: lowercase, spaces to hyphens. */
export function metricToKey(name: string): string {
  return name.toLowerCase().replace(/\s+/g, "-");
}

/** Read tracking values from daily note frontmatter for the last N days. */
export function getRecentValues(
  dailyFrontmatters: Map<string, Record<string, any>>,
  metricName: string,
  today: string,
  days: number,
): DayValue[] {
  const key = metricToKey(metricName);
  const result: DayValue[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const date = daysAgo(today, i);
    const fm = dailyFrontmatters.get(date);
    const raw = fm?.[key];
    let value: number | null = null;
    if (raw === true) value = 1;
    else if (raw === false) value = 0;
    else if (typeof raw === "number") value = raw;
    result.push({ date, value });
  }
  return result;
}
