export interface QuickLink {
  label: string;
  frequency: "daily" | "weekly";
  folder: string | null;
  dateFormat: string | null;
  useDailyNoteSettings: boolean;
}

const ENTRY_REGEX = /^-\s+(.+?)\s+\((.+)\)\s*$/;

export function parseQuickLinks(content: string): QuickLink[] {
  const links: QuickLink[] = [];
  for (const line of content.split("\n")) {
    const match = line.match(ENTRY_REGEX);
    if (!match) continue;

    const label = match[1].trim();
    const params = match[2].trim();
    const parts = params.split(",").map((p) => p.trim());

    const frequencyRaw = parts[0].toLowerCase();
    if (frequencyRaw !== "daily" && frequencyRaw !== "weekly") continue;
    const frequency = frequencyRaw as "daily" | "weekly";

    if (parts.some((p) => p === "use daily note settings")) {
      links.push({ label, frequency, folder: null, dateFormat: null, useDailyNoteSettings: true });
      continue;
    }

    let folder: string | null = null;
    let dateFormat: string | null = null;

    for (const part of parts.slice(1)) {
      if (part.startsWith("folder:")) {
        folder = part.slice("folder:".length).trim();
      } else if (part.startsWith("format:")) {
        dateFormat = part.slice("format:".length).trim();
      }
    }

    links.push({ label, frequency, folder, dateFormat, useDailyNoteSettings: false });
  }
  return links;
}

/** Returns the ISO week number (1–53) for the given date. */
function isoWeekNumber(date: Date): number {
  // Copy date and set to nearest Thursday (ISO week reference day)
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  // ISO weekday: Mon=1 … Sun=7
  const dayOfWeek = d.getUTCDay() || 7;
  // Shift to Thursday of the same week
  d.setUTCDate(d.getUTCDate() + 4 - dayOfWeek);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
}

/** Returns the ISO week year (the year the Thursday of that week belongs to). */
function isoWeekYear(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayOfWeek = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayOfWeek);
  return d.getUTCFullYear();
}

function pad2(n: number): string {
  return n.toString().padStart(2, "0");
}

/**
 * Applies a subset of moment-style format tokens to a date.
 *
 * Supported tokens: YYYY, MM, DD, ww (ISO week, zero-padded).
 * Text inside square brackets is treated as a literal (e.g. [W] → W).
 */
function formatDate(format: string, date: Date): string {
  const year = isoWeekYear(date);
  const month = date.getMonth() + 1;
  const day = date.getDate();
  const week = isoWeekNumber(date);

  // Split on bracket literals so we don't accidentally replace inside them.
  // Segments alternate: plain text, bracket content, plain text, …
  return format.replace(/\[([^\]]*)\]|YYYY|MM|DD|ww/g, (token, literal) => {
    if (literal !== undefined) return literal; // content inside [...]
    switch (token) {
      case "YYYY": return year.toString();
      case "MM":   return pad2(month);
      case "DD":   return pad2(day);
      case "ww":   return pad2(week);
      default:     return token;
    }
  });
}

export function resolveNotePath(link: QuickLink, now: Date): string {
  const folder = link.folder ?? "";
  const format = link.dateFormat ?? "YYYY-MM-DD";
  const datePart = formatDate(format, now);
  return `${folder}${datePart}.md`;
}
