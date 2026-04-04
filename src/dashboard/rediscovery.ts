export interface RediscoverySelection {
  date: string;
  paths: string[];
}

export interface RediscoveryConfig {
  folders: string[];
  minAgeDays: number;
  count: number;
  today: string;
}

interface FileEntry {
  path: string;
  mtime: number;
}

export function selectRediscoveryNotes(files: FileEntry[], config: RediscoveryConfig): string[] {
  const { folders, minAgeDays, count } = config;
  const minAgeMs = minAgeDays * 24 * 60 * 60 * 1000;
  const cutoff = Date.now() - minAgeMs;

  const candidates = files.filter((f) => {
    const inFolder =
      folders.length === 0 || folders.some((folder) => f.path.startsWith(folder));
    const oldEnough = f.mtime <= cutoff;
    return inFolder && oldEnough;
  });

  // Fisher-Yates shuffle
  for (let i = candidates.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [candidates[i], candidates[j]] = [candidates[j], candidates[i]];
  }

  return candidates.slice(0, count).map((f) => f.path);
}
