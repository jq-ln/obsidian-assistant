export type DayValue = { date: string; value: number | null };

// Schema: { schemaVersion: 1, entries: { [metric: string]: { [date: string]: number } } }
type LogData = {
  schemaVersion: 1;
  entries: Record<string, Record<string, number>>;
};

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

export class TrackingLog {
  private entries: Record<string, Record<string, number>>;

  constructor() {
    this.entries = {};
  }

  logValue(metric: string, date: string, value: number): void {
    if (!this.entries[metric]) {
      this.entries[metric] = {};
    }
    this.entries[metric][date] = value;
  }

  getValue(metric: string, date: string): number | null {
    const metricData = this.entries[metric];
    if (!metricData) return null;
    const val = metricData[date];
    return val !== undefined ? val : null;
  }

  toggleBoolean(metric: string, date: string): void {
    const current = this.getValue(metric, date);
    // null or 0 -> 1; 1 -> 0
    this.logValue(metric, date, current === 1 ? 0 : 1);
  }

  /**
   * Returns an array of DayValue for the last `days` days ending on `today` (inclusive).
   * Index 0 is the oldest day, index days-1 is today.
   */
  getRecentValues(metric: string, today: string, days: number): DayValue[] {
    const result: DayValue[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const date = daysAgo(today, i);
      result.push({ date, value: this.getValue(metric, date) });
    }
    return result;
  }

  serialize(): string {
    const data: LogData = {
      schemaVersion: 1,
      entries: this.entries,
    };
    return JSON.stringify(data);
  }

  static deserialize(json: string): TrackingLog {
    const data: LogData = JSON.parse(json);
    const log = new TrackingLog();
    log.entries = data.entries ?? {};
    return log;
  }

  /**
   * Migrate from the old habit-log format:
   * { [habitName: string]: string[] }  (array of completed dates)
   */
  static migrateFromHabitLog(json: string): TrackingLog {
    const old: Record<string, string[]> = JSON.parse(json);
    const log = new TrackingLog();
    for (const [habit, dates] of Object.entries(old)) {
      for (const date of dates) {
        log.logValue(habit, date, 1);
      }
    }
    return log;
  }
}
