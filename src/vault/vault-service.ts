import { App, TFile, normalizePath } from "obsidian";

export class VaultService {
  private app: App;

  constructor(app: App) {
    this.app = app;
  }

  async readNote(path: string): Promise<string | null> {
    const file = this.app.vault.getAbstractFileByPath(normalizePath(path));
    if (!file || !(file instanceof TFile)) return null;
    return this.app.vault.read(file);
  }

  async writeNote(path: string, content: string): Promise<void> {
    const normalized = normalizePath(path);
    const maxAttempts = 3;
    const delayMs = 2000;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const existing = this.app.vault.getAbstractFileByPath(normalized);
        if (existing && existing instanceof TFile) {
          await this.app.vault.modify(existing, content);
        } else {
          await this.app.vault.create(normalized, content);
        }
        return; // success
      } catch (err) {
        if (attempt === maxAttempts) throw err;
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  noteExists(path: string): boolean {
    return this.app.vault.getAbstractFileByPath(normalizePath(path)) !== null;
  }

  getMarkdownFiles(): TFile[] {
    return this.app.vault.getMarkdownFiles();
  }

  async getAllTags(): Promise<string[]> {
    const tagSet = new Set<string>();
    for (const file of this.getMarkdownFiles()) {
      const fm = await this.parseFrontmatter(file.path);
      const tags = fm.tags;
      if (Array.isArray(tags)) {
        for (const tag of tags) {
          tagSet.add(String(tag));
        }
      }
    }
    return Array.from(tagSet);
  }

  async getUntaggedNotes(): Promise<TFile[]> {
    const untagged: TFile[] = [];
    for (const file of this.getMarkdownFiles()) {
      const fm = await this.parseFrontmatter(file.path);
      const tags = fm.tags;
      if (!tags || (Array.isArray(tags) && tags.length === 0)) {
        untagged.push(file);
      }
    }
    return untagged;
  }

  async parseFrontmatter(path: string): Promise<Record<string, any>> {
    const content = await this.readNote(path);
    if (!content) return {};

    const match = content.match(/^---\n([\s\S]*?)\n---/);
    if (!match) return {};

    return this.parseYamlSimple(match[1]);
  }

  async updateFrontmatter(
    path: string,
    updates: Record<string, any>,
  ): Promise<void> {
    const content = await this.readNote(path);
    if (content === null) return;

    const existing = await this.parseFrontmatter(path);
    const merged = { ...existing };

    for (const [key, value] of Object.entries(updates)) {
      if (value === undefined) {
        delete merged[key];
      } else {
        merged[key] = value;
      }
    }

    const fmString = this.serializeYamlSimple(merged);
    const bodyMatch = content.match(/^---\n[\s\S]*?\n---\n?([\s\S]*)$/);
    const body = bodyMatch ? bodyMatch[1] : content;

    const newContent = Object.keys(merged).length > 0
      ? `---\n${fmString}---\n${body}`
      : body;

    await this.writeNote(path, newContent);
  }

  /** Minimal YAML parser for frontmatter. Handles flat key-value pairs and simple arrays. */
  private parseYamlSimple(yaml: string): Record<string, any> {
    const result: Record<string, any> = {};
    const lines = yaml.split("\n");
    let currentKey: string | null = null;
    let currentArray: string[] | null = null;

    for (const line of lines) {
      const keyMatch = line.match(/^(\w[\w-]*):\s*(.*)$/);
      if (keyMatch) {
        if (currentKey && currentArray) {
          result[currentKey] = currentArray;
        }
        currentKey = keyMatch[1];
        let value = keyMatch[2].trim();

        // Strip surrounding quotes from string values
        if (
          (value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))
        ) {
          value = value.slice(1, -1);
        }

        if (value === "" || value === "[]") {
          // Could be start of array or empty value
          if (value === "[]") {
            result[currentKey] = [];
            currentKey = null;
            currentArray = null;
          } else {
            currentArray = [];
          }
        } else if (value.startsWith("[") && value.endsWith("]")) {
          // Inline array: [a, b, c]
          result[currentKey] = value
            .slice(1, -1)
            .split(",")
            .map((s) => s.trim())
            .filter((s) => s.length > 0);
          currentKey = null;
          currentArray = null;
        } else if (value === "true") {
          result[currentKey] = true;
          currentKey = null;
          currentArray = null;
        } else if (value === "false") {
          result[currentKey] = false;
          currentKey = null;
          currentArray = null;
        } else if (!isNaN(Number(value))) {
          result[currentKey] = Number(value);
          currentKey = null;
          currentArray = null;
        } else {
          result[currentKey] = value;
          currentKey = null;
          currentArray = null;
        }
      } else if (currentKey && currentArray !== null) {
        const itemMatch = line.match(/^\s+-\s+(.+)$/);
        if (itemMatch) {
          currentArray.push(itemMatch[1].trim());
        }
      }
    }

    if (currentKey && currentArray) {
      result[currentKey] = currentArray;
    }

    return result;
  }

  /** Minimal YAML serializer for frontmatter. */
  private serializeYamlSimple(obj: Record<string, any>): string {
    let yaml = "";
    for (const [key, value] of Object.entries(obj)) {
      if (Array.isArray(value)) {
        if (value.length === 0) {
          yaml += `${key}: []\n`;
        } else {
          yaml += `${key}:\n`;
          for (const item of value) {
            yaml += `  - ${item}\n`;
          }
        }
      } else {
        yaml += `${key}: ${value}\n`;
      }
    }
    return yaml;
  }
}
