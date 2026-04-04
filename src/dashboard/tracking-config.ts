export interface TrackingEntry {
  name: string;
  type: "boolean" | "numeric";
  unit: string | null;
  goalDirection: "<" | ">" | null;
  goalValue: number | null;
}

const NUMERIC_ENTRY_REGEX = /^-\s+(.+?)\s+\((.+)\)\s*$/;
const BARE_ENTRY_REGEX = /^-\s+(.+?)\s*$/;

export function parseTrackingConfig(content: string): TrackingEntry[] {
  const entries: TrackingEntry[] = [];
  for (const line of content.split("\n")) {
    // Try numeric format first: - Name (unit, goal: <3)
    const numMatch = line.match(NUMERIC_ENTRY_REGEX);
    if (numMatch) {
      const name = numMatch[1].trim();
      const params = numMatch[2].trim();

      // Legacy: skip explicit "(boolean)" — treat as bare entry
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
      continue;
    }

    // Bare entry: - Name (boolean habit)
    const bareMatch = line.match(BARE_ENTRY_REGEX);
    if (bareMatch) {
      entries.push({ name: bareMatch[1].trim(), type: "boolean", unit: null, goalDirection: null, goalValue: null });
    }
  }
  return entries;
}
