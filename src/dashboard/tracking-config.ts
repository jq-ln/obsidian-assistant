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
    const parts = params.split(",").map((p) => p.trim());
    const unit = parts[0];
    let goalDirection: "<" | ">" | null = null;
    let goalValue: number | null = null;
    const goalPart = parts.find((p) => p.startsWith("goal:"));
    if (goalPart) {
      const goalStr = goalPart.replace("goal:", "").trim();
      if (goalStr.startsWith("<")) { goalDirection = "<"; goalValue = parseFloat(goalStr.slice(1)); }
      else if (goalStr.startsWith(">")) { goalDirection = ">"; goalValue = parseFloat(goalStr.slice(1)); }
    }
    entries.push({ name, type: "numeric", unit, goalDirection, goalValue });
  }
  return entries;
}
