export class App {
  vault = new Vault();
}

export class Vault {
  private files: Map<string, string> = new Map();

  getAbstractFileByPath(path: string): TFile | null {
    if (this.files.has(path)) {
      const f = new TFile();
      f.path = path;
      f.basename = path.split("/").pop()?.replace(".md", "") ?? "";
      return f;
    }
    return null;
  }

  async read(file: TFile): Promise<string> {
    return this.files.get(file.path) ?? "";
  }

  async modify(file: TFile, content: string): Promise<void> {
    this.files.set(file.path, content);
  }

  async create(path: string, content: string): Promise<TFile> {
    this.files.set(path, content);
    const f = new TFile();
    f.path = path;
    f.basename = path.split("/").pop()?.replace(".md", "") ?? "";
    return f;
  }

  async adapter_read(path: string): Promise<string> {
    return this.files.get(path) ?? "";
  }

  getMarkdownFiles(): TFile[] {
    const files: TFile[] = [];
    for (const path of this.files.keys()) {
      if (path.endsWith(".md")) {
        const f = new TFile();
        f.path = path;
        f.basename = path.split("/").pop()?.replace(".md", "") ?? "";
        files.push(f);
      }
    }
    return files;
  }

  _seed(path: string, content: string): void {
    this.files.set(path, content);
  }
}

export class TFile {
  path = "";
  basename = "";
  extension = "md";
  stat = { mtime: Date.now(), ctime: Date.now(), size: 0 };
}

export class TFolder {
  path = "";
  children: (TFile | TFolder)[] = [];
}

export class Plugin {
  app: App = new App();
  manifest = { id: "obsidian-assistant", version: "0.1.0" };

  addCommand(_cmd: unknown): void {}
  addSettingTab(_tab: unknown): void {}
  registerInterval(_id: number): number { return 0; }
  registerEvent(_event: unknown): void {}
  loadData(): Promise<unknown> { return Promise.resolve({}); }
  saveData(_data: unknown): Promise<void> { return Promise.resolve(); }
}

export class PluginSettingTab {
  app: App;
  plugin: Plugin;
  containerEl = { empty: () => {}, createEl: (_tag: string, _opts?: unknown) => ({}) };

  constructor(app: App, plugin: Plugin) {
    this.app = app;
    this.plugin = plugin;
  }

  display(): void {}
  hide(): void {}
}

export class Modal {
  app: App;
  contentEl = {
    empty: () => {},
    createEl: (_tag: string, _opts?: unknown) => ({ createEl: () => ({}), setText: () => {}, addEventListener: () => {} }),
    createDiv: (_cls?: string) => ({ createEl: () => ({}), setText: () => {}, style: {} }),
  };

  constructor(app: App) {
    this.app = app;
  }

  open(): void {}
  close(): void {}
}

export class Notice {
  constructor(_message: string, _duration?: number) {}
  setMessage(_message: string): this { return this; }
  hide(): void {}
}

export class Setting {
  settingEl = {};
  constructor(_containerEl: unknown) {}
  setName(_name: string): this { return this; }
  setDesc(_desc: string): this { return this; }
  addText(_cb: (text: unknown) => unknown): this { return this; }
  addToggle(_cb: (toggle: unknown) => unknown): this { return this; }
  addDropdown(_cb: (dropdown: unknown) => unknown): this { return this; }
  addSlider(_cb: (slider: unknown) => unknown): this { return this; }
  addButton(_cb: (button: unknown) => unknown): this { return this; }
}

export function normalizePath(path: string): string {
  return path.replace(/\\/g, "/").replace(/\/+/g, "/");
}

export class MarkdownView {
  file: TFile | null = null;
}

export function parseFrontMatterTags(fm: unknown): string[] | null {
  if (fm && typeof fm === "object" && "tags" in fm) {
    return (fm as { tags: string[] }).tags;
  }
  return null;
}

export function parseFrontMatterStringArray(fm: unknown, key: string): string[] | null {
  if (fm && typeof fm === "object" && key in fm) {
    return (fm as Record<string, string[]>)[key];
  }
  return null;
}
