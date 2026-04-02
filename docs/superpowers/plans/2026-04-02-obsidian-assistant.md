# Obsidian AI Assistant Plugin — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an Obsidian plugin that reduces vault maintenance friction through AI-assisted tagging, connection detection, and dashboard generation.

**Architecture:** Feature modules emit tasks into a shared orchestrator queue. The orchestrator routes tasks to either a local Ollama instance or the Claude API based on model requirements, availability, and cost budget. A vault service abstracts Obsidian's API. All features are non-destructive by default — suggestions require user review before applying.

**Tech Stack:** TypeScript, Obsidian Plugin API (1.4.0+), Anthropic TypeScript SDK, Ollama HTTP API, Vitest, esbuild

**Spec:** `docs/superpowers/specs/2026-04-02-obsidian-assistant-plugin-design.md`

---

## File Map

```
src/
├── main.ts                          # Plugin lifecycle: onload/onunload, command registration, timer setup
├── settings.ts                      # PluginSettings interface, defaults, AssistantSettingTab class
├── types.ts                         # Shared enums and constants (ModelRequirement, TaskPriority, TaskStatus, etc.)
├── llm/
│   ├── provider.ts                  # LLMProvider interface, LLMRequest, LLMResponse types
│   ├── ollama.ts                    # OllamaProvider: HTTP calls, health check caching, response parsing
│   └── claude.ts                    # ClaudeProvider: Anthropic SDK wrapper, token counting
├── vault/
│   └── vault-service.ts             # VaultService: read/write notes, frontmatter ops, tag queries, file existence checks
├── orchestrator/
│   ├── task.ts                      # Task interface, TaskFactory for creating tasks with defaults
│   ├── queue.ts                     # TaskQueue: persistence (queue.json), load/save, status transitions, cleanup
│   ├── router.ts                    # TaskRouter: model selection logic, fallback/deferral decisions
│   ├── batcher.ts                   # TaskBatcher: groups compatible tasks, token-aware sizing
│   ├── cost-tracker.ts              # CostTracker: per-call recording, daily/monthly totals, budget enforcement
│   └── orchestrator.ts              # Orchestrator: ties queue + router + batcher + cost-tracker, processes loop
├── modules/
│   ├── tagger/
│   │   ├── tagger.ts                # TaggerModule: prompt building, response parsing, frontmatter updates
│   │   └── tag-audit.ts             # TagAuditModule: vault-wide scan, grouping, backup, find-and-replace
│   ├── connections/
│   │   ├── scoring.ts               # CandidateScorer: TF-IDF, composite scoring, threshold filtering
│   │   └── connections.ts           # ConnectionModule: orchestrates scoring → LLM → suggestion presentation
│   └── dashboard/
│       ├── task-aggregator.ts       # TaskAggregator: scans vault for checkboxes, parses due dates, ranks
│       ├── habits.ts                # HabitTracker: parses habits.md, reads/writes habit-log.md, streak calc
│       └── dashboard.ts             # DashboardModule: assembles sections, writes Dashboard.md
└── ui/
    ├── suggestion-modal.ts          # SuggestionModal: accept/reject per-item, calls back with decisions
    └── notices.ts                   # Helper: themed notices with click actions

tests/
├── __mocks__/
│   └── obsidian.ts                  # Manual mock for the obsidian module (App, Vault, TFile, etc.)
├── helpers/
│   └── mock-vault.ts               # In-memory vault for integration tests (implements VaultService interface)
├── llm/
│   ├── ollama.test.ts
│   └── claude.test.ts
├── orchestrator/
│   ├── queue.test.ts
│   ├── router.test.ts
│   ├── batcher.test.ts
│   ├── cost-tracker.test.ts
│   └── orchestrator.test.ts
├── modules/
│   ├── tagger.test.ts
│   ├── tag-audit.test.ts
│   ├── scoring.test.ts
│   ├── connections.test.ts
│   ├── task-aggregator.test.ts
│   ├── habits.test.ts
│   └── dashboard.test.ts
└── integration/
    └── tagger-flow.test.ts          # End-to-end: tagger → orchestrator → mock LLM → vault update
```

---

## Task 1: Project Scaffolding

**Files:**
- Create: `package.json`, `tsconfig.json`, `esbuild.config.mjs`, `manifest.json`, `vitest.config.ts`, `.gitignore`, `tests/__mocks__/obsidian.ts`

- [ ] **Step 1: Initialize package.json**

```bash
cd /home/jqln/Projects/assistant
npm init -y
```

Then replace the generated `package.json`:

```json
{
  "name": "obsidian-assistant",
  "version": "0.1.0",
  "description": "AI assistant plugin for Obsidian",
  "main": "main.js",
  "scripts": {
    "dev": "node esbuild.config.mjs",
    "build": "tsc -noEmit -skipLibCheck && node esbuild.config.mjs production",
    "test": "vitest run",
    "test:watch": "vitest"
  },
  "keywords": [],
  "license": "MIT"
}
```

- [ ] **Step 2: Install dependencies**

```bash
npm install obsidian @anthropic-ai/sdk
npm install -D typescript vitest esbuild builtin-modules @types/node
```

- [ ] **Step 3: Create tsconfig.json**

```json
{
  "compilerOptions": {
    "baseUrl": ".",
    "inlineSourceMap": true,
    "inlineSources": true,
    "module": "ESNext",
    "target": "ES2018",
    "allowJs": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "moduleResolution": "node",
    "importHelpers": true,
    "isolatedModules": true,
    "lib": ["DOM", "ES2018", "ES2021.String"],
    "outDir": "./dist",
    "paths": {
      "@/*": ["src/*"]
    }
  },
  "include": ["src/**/*.ts"],
  "exclude": ["node_modules", "tests"]
}
```

- [ ] **Step 4: Create esbuild.config.mjs**

```javascript
import esbuild from "esbuild";
import process from "process";
import builtins from "builtin-modules";

const prod = process.argv[2] === "production";

esbuild
  .build({
    entryPoints: ["src/main.ts"],
    bundle: true,
    external: [
      "obsidian",
      "electron",
      "@codemirror/autocomplete",
      "@codemirror/collab",
      "@codemirror/commands",
      "@codemirror/language",
      "@codemirror/lint",
      "@codemirror/search",
      "@codemirror/state",
      "@codemirror/view",
      "@lezer/common",
      "@lezer/highlight",
      "@lezer/lr",
      ...builtins,
    ],
    format: "cjs",
    target: "es2018",
    logLevel: "info",
    sourcemap: prod ? false : "inline",
    treeShaking: true,
    outfile: "main.js",
    minify: prod,
  })
  .catch(() => process.exit(1));
```

- [ ] **Step 5: Create manifest.json**

```json
{
  "id": "obsidian-assistant",
  "name": "AI Assistant",
  "version": "0.1.0",
  "minAppVersion": "1.4.0",
  "description": "AI-powered vault assistant for tagging, connections, and productivity",
  "author": "jqln",
  "isDesktopOnly": true
}
```

- [ ] **Step 6: Create vitest.config.ts**

```typescript
import { defineConfig } from "vitest/config";
import path from "path";

export default defineConfig({
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
      obsidian: path.resolve(__dirname, "tests/__mocks__/obsidian.ts"),
    },
  },
  test: {
    globals: true,
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
```

- [ ] **Step 7: Create the obsidian mock**

This mock provides the minimal stubs needed to import modules that reference the `obsidian` package. It only mocks the platform boundary — all plugin logic runs for real in tests.

```typescript
// tests/__mocks__/obsidian.ts

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

  // Helper for tests to seed files
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
  loadData(): Promise<unknown> { return Promise.resolve({}); }
  saveData(_data: unknown): Promise<void> { return Promise.resolve(); }
}

export class PluginSettingTab {
  app: App;
  plugin: Plugin;
  containerEl = { empty: () => {}, createEl: () => ({}) };

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
    createEl: (_tag: string, _opts?: unknown) => ({ createEl: () => ({}), setText: () => {} }),
    createDiv: (_cls?: string) => ({ createEl: () => ({}), setText: () => {} }),
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
```

- [ ] **Step 8: Create .gitignore**

```
node_modules/
main.js
dist/
.DS_Store
data.json
```

- [ ] **Step 9: Create minimal src/main.ts to verify build**

```typescript
import { Plugin } from "obsidian";

export default class AssistantPlugin extends Plugin {
  async onload() {
    console.log("AI Assistant loaded");
  }

  onunload() {
    console.log("AI Assistant unloaded");
  }
}
```

- [ ] **Step 10: Verify build works**

Run: `npm run build`
Expected: `main.js` created in project root with no errors.

- [ ] **Step 11: Verify test runner works**

Create a trivial test `tests/smoke.test.ts`:

```typescript
import { describe, it, expect } from "vitest";

describe("smoke test", () => {
  it("runs", () => {
    expect(1 + 1).toBe(2);
  });
});
```

Run: `npm test`
Expected: 1 test passes.

- [ ] **Step 12: Commit**

```bash
git add package.json package-lock.json tsconfig.json esbuild.config.mjs manifest.json vitest.config.ts .gitignore src/main.ts tests/__mocks__/obsidian.ts tests/smoke.test.ts
git commit -m "feat: scaffold obsidian plugin project with build and test tooling"
```

---

## Task 2: Core Types & Settings

**Files:**
- Create: `src/types.ts`, `src/settings.ts`
- Test: `tests/smoke.test.ts` (extend)

- [ ] **Step 1: Create src/types.ts**

```typescript
export enum ModelRequirement {
  LocalOnly = "local-only",
  LocalPreferred = "local-preferred",
  ClaudeRequired = "claude-required",
}

export enum TaskPriority {
  High = "high",       // manual/user-initiated
  Normal = "normal",   // automatic triggers
  Low = "low",         // background scans
}

export enum TaskStatus {
  Pending = "pending",
  InProgress = "in-progress",
  Completed = "completed",
  Deferred = "deferred",
  Failed = "failed",
}

export enum TaskTrigger {
  Automatic = "automatic",
  Manual = "manual",
}

export type TaskType = "tagger" | "connection-detector" | "dashboard";

export type TaskAction =
  | "tag-note"
  | "tag-batch"
  | "audit-tags"
  | "scan-connections"
  | "scan-connections-deep"
  | "generate-dashboard"
  | "log-habit";

/** Per-model pricing in dollars per 1M tokens. Updated with SDK versions. */
export const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-haiku-4-5-20251001": { input: 0.80, output: 4.00 },
  "claude-sonnet-4-6": { input: 3.00, output: 15.00 },
};

export const SCHEMA_VERSION = 1;

export const DEFAULT_TAG_STYLE_GUIDE = `# Tag Style Guide

- Use kebab-case (e.g., \`machine-learning\`, not \`MachineLearning\`)
- Use singular form (e.g., \`project\`, not \`projects\`)
- Maximum nesting depth: 3 levels (e.g., \`tech/ml/transformers\`)
- Keep tags descriptive but concise
`;

export const ASSISTANT_FOLDER = "AI-Assistant";
```

- [ ] **Step 2: Create src/settings.ts**

```typescript
import { App, PluginSettingTab, Plugin, Setting } from "obsidian";

export interface PluginSettings {
  claudeApiKey: string;
  claudeModel: "claude-haiku-4-5-20251001" | "claude-sonnet-4-6";
  claudeDailyBudget: number;   // dollars, 0 = unlimited
  claudeMonthlyBudget: number; // dollars, 0 = unlimited
  ollamaEndpoint: string;
  ollamaModel: string;
  dashboardPath: string;
  autoTagOnSave: boolean;
  autoTagOnStartup: boolean;
  autoConnectionScan: boolean;
  connectionScanIntervalMin: number;
  autoDashboardRefresh: boolean;
  dashboardRefreshIntervalHours: number;
  localFallbackToClaude: boolean; // when Ollama unavailable, fall back to Claude for local-preferred tasks?
}

export const DEFAULT_SETTINGS: PluginSettings = {
  claudeApiKey: "",
  claudeModel: "claude-haiku-4-5-20251001",
  claudeDailyBudget: 0,
  claudeMonthlyBudget: 0,
  ollamaEndpoint: "http://localhost:11434",
  ollamaModel: "llama3:8b",
  dashboardPath: "Dashboard.md",
  autoTagOnSave: true,
  autoTagOnStartup: true,
  autoConnectionScan: true,
  connectionScanIntervalMin: 30,
  autoDashboardRefresh: true,
  dashboardRefreshIntervalHours: 2,
  localFallbackToClaude: false,
};

export class AssistantSettingTab extends PluginSettingTab {
  private settings: PluginSettings;
  private onSettingsChange: (settings: PluginSettings) => Promise<void>;

  constructor(
    app: App,
    plugin: Plugin,
    settings: PluginSettings,
    onSettingsChange: (settings: PluginSettings) => Promise<void>,
  ) {
    super(app, plugin);
    this.settings = settings;
    this.onSettingsChange = onSettingsChange;
  }

  private async save(): Promise<void> {
    await this.onSettingsChange(this.settings);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "AI Assistant Settings" });

    // --- Claude ---
    containerEl.createEl("h3", { text: "Claude API" });

    new Setting(containerEl)
      .setName("API Key")
      .setDesc("Your Anthropic API key")
      .addText((text) =>
        (text as any)
          .setPlaceholder("sk-ant-...")
          .setValue(this.settings.claudeApiKey)
          .onChange(async (value: string) => {
            this.settings.claudeApiKey = value;
            await this.save();
          }),
      );

    new Setting(containerEl)
      .setName("Model")
      .setDesc("Haiku is cheaper; Sonnet is stronger for complex tasks")
      .addDropdown((dropdown) =>
        (dropdown as any)
          .addOption("claude-haiku-4-5-20251001", "Haiku (cost-efficient)")
          .addOption("claude-sonnet-4-6", "Sonnet (stronger)")
          .setValue(this.settings.claudeModel)
          .onChange(async (value: string) => {
            this.settings.claudeModel = value as PluginSettings["claudeModel"];
            await this.save();
          }),
      );

    new Setting(containerEl)
      .setName("Daily Budget ($)")
      .setDesc("Max daily Claude spend in dollars. 0 = unlimited.")
      .addText((text) =>
        (text as any)
          .setPlaceholder("0")
          .setValue(String(this.settings.claudeDailyBudget))
          .onChange(async (value: string) => {
            this.settings.claudeDailyBudget = parseFloat(value) || 0;
            await this.save();
          }),
      );

    new Setting(containerEl)
      .setName("Monthly Budget ($)")
      .setDesc("Max monthly Claude spend in dollars. 0 = unlimited.")
      .addText((text) =>
        (text as any)
          .setPlaceholder("0")
          .setValue(String(this.settings.claudeMonthlyBudget))
          .onChange(async (value: string) => {
            this.settings.claudeMonthlyBudget = parseFloat(value) || 0;
            await this.save();
          }),
      );

    // --- Ollama ---
    containerEl.createEl("h3", { text: "Ollama (Local LLM)" });

    new Setting(containerEl)
      .setName("Endpoint")
      .setDesc("Ollama API URL")
      .addText((text) =>
        (text as any)
          .setPlaceholder("http://localhost:11434")
          .setValue(this.settings.ollamaEndpoint)
          .onChange(async (value: string) => {
            this.settings.ollamaEndpoint = value;
            await this.save();
          }),
      );

    new Setting(containerEl)
      .setName("Model")
      .setDesc("Any Ollama-compatible model (e.g., llama3:8b, mistral, phi3)")
      .addText((text) =>
        (text as any)
          .setPlaceholder("llama3:8b")
          .setValue(this.settings.ollamaModel)
          .onChange(async (value: string) => {
            this.settings.ollamaModel = value;
            await this.save();
          }),
      );

    new Setting(containerEl)
      .setName("Fall back to Claude when Ollama unavailable")
      .setDesc("For local-preferred tasks. Warning: this uses your Claude API budget.")
      .addToggle((toggle) =>
        (toggle as any)
          .setValue(this.settings.localFallbackToClaude)
          .onChange(async (value: boolean) => {
            this.settings.localFallbackToClaude = value;
            await this.save();
          }),
      );

    // --- Features ---
    containerEl.createEl("h3", { text: "Automation" });

    new Setting(containerEl)
      .setName("Auto-tag on save")
      .setDesc("Suggest tags when a note is saved (uses local LLM if available)")
      .addToggle((toggle) =>
        (toggle as any)
          .setValue(this.settings.autoTagOnSave)
          .onChange(async (value: boolean) => {
            this.settings.autoTagOnSave = value;
            await this.save();
          }),
      );

    new Setting(containerEl)
      .setName("Auto-tag untagged notes on startup")
      .setDesc("Batch-tag untagged notes when Obsidian opens")
      .addToggle((toggle) =>
        (toggle as any)
          .setValue(this.settings.autoTagOnStartup)
          .onChange(async (value: boolean) => {
            this.settings.autoTagOnStartup = value;
            await this.save();
          }),
      );

    new Setting(containerEl)
      .setName("Auto-scan for connections")
      .setDesc("Periodically suggest links between related notes")
      .addToggle((toggle) =>
        (toggle as any)
          .setValue(this.settings.autoConnectionScan)
          .onChange(async (value: boolean) => {
            this.settings.autoConnectionScan = value;
            await this.save();
          }),
      );

    new Setting(containerEl)
      .setName("Connection scan interval (minutes)")
      .addSlider((slider) =>
        (slider as any)
          .setLimits(5, 120, 5)
          .setValue(this.settings.connectionScanIntervalMin)
          .setDynamicTooltip()
          .onChange(async (value: number) => {
            this.settings.connectionScanIntervalMin = value;
            await this.save();
          }),
      );

    new Setting(containerEl)
      .setName("Auto-refresh dashboard")
      .addToggle((toggle) =>
        (toggle as any)
          .setValue(this.settings.autoDashboardRefresh)
          .onChange(async (value: boolean) => {
            this.settings.autoDashboardRefresh = value;
            await this.save();
          }),
      );

    new Setting(containerEl)
      .setName("Dashboard refresh interval (hours)")
      .addSlider((slider) =>
        (slider as any)
          .setLimits(1, 12, 1)
          .setValue(this.settings.dashboardRefreshIntervalHours)
          .setDynamicTooltip()
          .onChange(async (value: number) => {
            this.settings.dashboardRefreshIntervalHours = value;
            await this.save();
          }),
      );

    // --- Dashboard ---
    containerEl.createEl("h3", { text: "Dashboard" });

    new Setting(containerEl)
      .setName("Dashboard location")
      .setDesc("Path within your vault (e.g., Dashboard.md or AI-Assistant/Dashboard.md)")
      .addText((text) =>
        (text as any)
          .setPlaceholder("Dashboard.md")
          .setValue(this.settings.dashboardPath)
          .onChange(async (value: string) => {
            this.settings.dashboardPath = value;
            await this.save();
          }),
      );
  }
}
```

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit --skipLibCheck`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/types.ts src/settings.ts
git commit -m "feat: add core types, settings interface, and settings tab"
```

---

## Task 3: LLM Provider Interface & Ollama Provider

**Files:**
- Create: `src/llm/provider.ts`, `src/llm/ollama.ts`
- Test: `tests/llm/ollama.test.ts`

- [ ] **Step 1: Create src/llm/provider.ts**

```typescript
export interface LLMRequest {
  system: string;
  prompt: string;
  maxTokens: number;
  temperature?: number;
}

export interface LLMResponse {
  content: string;
  tokensUsed: { input: number; output: number };
  model: string;
  durationMs: number;
}

export interface LLMProvider {
  readonly id: string;
  isAvailable(): Promise<boolean>;
  complete(request: LLMRequest): Promise<LLMResponse>;
}
```

- [ ] **Step 2: Write failing tests for OllamaProvider**

```typescript
// tests/llm/ollama.test.ts
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { OllamaProvider } from "@/llm/ollama";

// We mock global fetch — the HTTP boundary
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

describe("OllamaProvider", () => {
  let provider: OllamaProvider;

  beforeEach(() => {
    provider = new OllamaProvider("http://localhost:11434", "llama3:8b");
    mockFetch.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe("isAvailable", () => {
    it("returns true when Ollama responds to health check", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ models: [{ name: "llama3:8b" }] }),
      });

      expect(await provider.isAvailable()).toBe(true);
      expect(mockFetch).toHaveBeenCalledWith("http://localhost:11434/api/tags");
    });

    it("returns false when Ollama is unreachable", async () => {
      mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      expect(await provider.isAvailable()).toBe(false);
    });

    it("caches availability for 30 seconds", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ models: [] }),
      });

      await provider.isAvailable();
      await provider.isAvailable();

      // Only one fetch call — second was cached
      expect(mockFetch).toHaveBeenCalledTimes(1);
    });

    it("invalidates cache after 30 seconds", async () => {
      mockFetch.mockResolvedValue({
        ok: true,
        json: async () => ({ models: [] }),
      });

      await provider.isAvailable();

      // Advance time past cache TTL
      vi.useFakeTimers();
      vi.advanceTimersByTime(31_000);

      await provider.isAvailable();
      vi.useRealTimers();

      expect(mockFetch).toHaveBeenCalledTimes(2);
    });

    it("invalidates cache on error", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ models: [] }),
      });
      await provider.isAvailable();

      // Force cache invalidation by simulating an error on complete()
      mockFetch.mockRejectedValueOnce(new Error("connection lost"));
      try { await provider.complete({ system: "", prompt: "test", maxTokens: 100 }); } catch {}

      // Next isAvailable should re-check (cache invalidated)
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({ models: [] }),
      });
      await provider.isAvailable();

      // 3 calls: health check, failed complete, re-health-check
      expect(mockFetch).toHaveBeenCalledTimes(3);
    });
  });

  describe("complete", () => {
    it("sends correct request and parses response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          response: '{"tags": ["ai", "ml"]}',
          eval_count: 50,
          prompt_eval_count: 120,
          total_duration: 1500000000, // nanoseconds
        }),
      });

      const result = await provider.complete({
        system: "You are a tagger.",
        prompt: "Tag this note.",
        maxTokens: 200,
        temperature: 0.3,
      });

      expect(result.content).toBe('{"tags": ["ai", "ml"]}');
      expect(result.tokensUsed).toEqual({ input: 120, output: 50 });
      expect(result.model).toBe("llama3:8b");
      expect(result.durationMs).toBeCloseTo(1500, -1);

      const [url, options] = mockFetch.mock.calls[0];
      expect(url).toBe("http://localhost:11434/api/generate");
      const body = JSON.parse(options.body);
      expect(body.model).toBe("llama3:8b");
      expect(body.system).toBe("You are a tagger.");
      expect(body.prompt).toBe("Tag this note.");
      expect(body.stream).toBe(false);
      expect(body.options.num_predict).toBe(200);
      expect(body.options.temperature).toBe(0.3);
    });

    it("throws on non-ok response", async () => {
      mockFetch.mockResolvedValueOnce({
        ok: false,
        status: 500,
        statusText: "Internal Server Error",
      });

      await expect(
        provider.complete({ system: "", prompt: "test", maxTokens: 100 }),
      ).rejects.toThrow("Ollama request failed: 500 Internal Server Error");
    });

    it("throws on network error", async () => {
      mockFetch.mockRejectedValueOnce(new Error("ECONNREFUSED"));

      await expect(
        provider.complete({ system: "", prompt: "test", maxTokens: 100 }),
      ).rejects.toThrow("ECONNREFUSED");
    });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- tests/llm/ollama.test.ts`
Expected: FAIL — `@/llm/ollama` module not found.

- [ ] **Step 4: Implement OllamaProvider**

```typescript
// src/llm/ollama.ts
import { LLMProvider, LLMRequest, LLMResponse } from "./provider";

interface OllamaGenerateResponse {
  response: string;
  eval_count?: number;
  prompt_eval_count?: number;
  total_duration?: number; // nanoseconds
}

export class OllamaProvider implements LLMProvider {
  readonly id = "ollama";

  private endpoint: string;
  private model: string;
  private cachedAvailable: boolean | null = null;
  private cacheTimestamp = 0;
  private readonly CACHE_TTL_MS = 30_000;

  constructor(endpoint: string, model: string) {
    this.endpoint = endpoint.replace(/\/$/, "");
    this.model = model;
  }

  async isAvailable(): Promise<boolean> {
    const now = Date.now();
    if (this.cachedAvailable !== null && now - this.cacheTimestamp < this.CACHE_TTL_MS) {
      return this.cachedAvailable;
    }

    try {
      const response = await fetch(`${this.endpoint}/api/tags`);
      this.cachedAvailable = response.ok;
    } catch {
      this.cachedAvailable = false;
    }

    this.cacheTimestamp = now;
    return this.cachedAvailable;
  }

  private invalidateCache(): void {
    this.cachedAvailable = null;
    this.cacheTimestamp = 0;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    const startMs = Date.now();

    let response: Response;
    try {
      response = await fetch(`${this.endpoint}/api/generate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          system: request.system,
          prompt: request.prompt,
          stream: false,
          format: "json",
          options: {
            num_predict: request.maxTokens,
            temperature: request.temperature ?? 0.3,
          },
        }),
      });
    } catch (error) {
      this.invalidateCache();
      throw error;
    }

    if (!response.ok) {
      this.invalidateCache();
      throw new Error(`Ollama request failed: ${response.status} ${response.statusText}`);
    }

    const data: OllamaGenerateResponse = await response.json();

    return {
      content: data.response,
      tokensUsed: {
        input: data.prompt_eval_count ?? 0,
        output: data.eval_count ?? 0,
      },
      model: this.model,
      durationMs: data.total_duration ? data.total_duration / 1_000_000 : Date.now() - startMs,
    };
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- tests/llm/ollama.test.ts`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/llm/provider.ts src/llm/ollama.ts tests/llm/ollama.test.ts
git commit -m "feat: add LLM provider interface and Ollama provider with health check caching"
```

---

## Task 4: Claude Provider

**Files:**
- Create: `src/llm/claude.ts`
- Test: `tests/llm/claude.test.ts`

- [ ] **Step 1: Write failing tests for ClaudeProvider**

```typescript
// tests/llm/claude.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ClaudeProvider } from "@/llm/claude";

// Mock the Anthropic SDK at the module boundary
vi.mock("@anthropic-ai/sdk", () => {
  const mockCreate = vi.fn();
  return {
    default: class Anthropic {
      messages = { create: mockCreate };
      static _mockCreate = mockCreate;
    },
  };
});

// Access the mock via the module
async function getMockCreate() {
  const mod = await import("@anthropic-ai/sdk");
  return (mod.default as any)._mockCreate as ReturnType<typeof vi.fn>;
}

describe("ClaudeProvider", () => {
  let provider: ClaudeProvider;
  let mockCreate: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    mockCreate = await getMockCreate();
    mockCreate.mockReset();
    provider = new ClaudeProvider("sk-test-key", "claude-haiku-4-5-20251001");
  });

  describe("isAvailable", () => {
    it("returns true when API key is set", async () => {
      expect(await provider.isAvailable()).toBe(true);
    });

    it("returns false when API key is empty", async () => {
      const noKeyProvider = new ClaudeProvider("", "claude-haiku-4-5-20251001");
      expect(await noKeyProvider.isAvailable()).toBe(false);
    });
  });

  describe("complete", () => {
    it("sends correct request and parses response", async () => {
      mockCreate.mockResolvedValueOnce({
        content: [{ type: "text", text: '{"tags": ["ai"]}' }],
        usage: { input_tokens: 100, output_tokens: 30 },
      });

      const result = await provider.complete({
        system: "You are a tagger.",
        prompt: "Tag this note.",
        maxTokens: 200,
        temperature: 0.3,
      });

      expect(result.content).toBe('{"tags": ["ai"]}');
      expect(result.tokensUsed).toEqual({ input: 100, output: 30 });
      expect(result.model).toBe("claude-haiku-4-5-20251001");
      expect(result.durationMs).toBeGreaterThanOrEqual(0);

      expect(mockCreate).toHaveBeenCalledWith({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 200,
        temperature: 0.3,
        system: "You are a tagger.",
        messages: [{ role: "user", content: "Tag this note." }],
      });
    });

    it("throws on API error with status info", async () => {
      const apiError = new Error("Unauthorized");
      (apiError as any).status = 401;
      mockCreate.mockRejectedValueOnce(apiError);

      await expect(
        provider.complete({ system: "", prompt: "test", maxTokens: 100 }),
      ).rejects.toThrow("Unauthorized");
    });

    it("extracts rate limit retry-after from error", async () => {
      const rateLimitError = new Error("Rate limited");
      (rateLimitError as any).status = 429;
      (rateLimitError as any).headers = { "retry-after": "30" };
      mockCreate.mockRejectedValueOnce(rateLimitError);

      try {
        await provider.complete({ system: "", prompt: "test", maxTokens: 100 });
      } catch (e: any) {
        expect(e.status).toBe(429);
        expect(e.retryAfterSeconds).toBe(30);
      }
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/llm/claude.test.ts`
Expected: FAIL — `@/llm/claude` module not found.

- [ ] **Step 3: Implement ClaudeProvider**

```typescript
// src/llm/claude.ts
import Anthropic from "@anthropic-ai/sdk";
import { LLMProvider, LLMRequest, LLMResponse } from "./provider";

export class ClaudeError extends Error {
  status: number;
  retryAfterSeconds: number | null;

  constructor(message: string, status: number, retryAfter: number | null = null) {
    super(message);
    this.name = "ClaudeError";
    this.status = status;
    this.retryAfterSeconds = retryAfter;
  }
}

export class ClaudeProvider implements LLMProvider {
  readonly id = "claude";

  private client: Anthropic | null = null;
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model: string) {
    this.apiKey = apiKey;
    this.model = model;
    if (apiKey) {
      this.client = new Anthropic({ apiKey });
    }
  }

  async isAvailable(): Promise<boolean> {
    return this.apiKey.length > 0;
  }

  async complete(request: LLMRequest): Promise<LLMResponse> {
    if (!this.client) {
      throw new ClaudeError("Claude API key not configured", 401);
    }

    const startMs = Date.now();

    try {
      const response = await this.client.messages.create({
        model: this.model,
        max_tokens: request.maxTokens,
        temperature: request.temperature ?? 0.3,
        system: request.system,
        messages: [{ role: "user", content: request.prompt }],
      });

      const textBlock = response.content.find((b: any) => b.type === "text");
      const content = textBlock ? (textBlock as any).text : "";

      return {
        content,
        tokensUsed: {
          input: response.usage.input_tokens,
          output: response.usage.output_tokens,
        },
        model: this.model,
        durationMs: Date.now() - startMs,
      };
    } catch (error: any) {
      if (error.status === 429) {
        const retryAfter = error.headers?.["retry-after"]
          ? parseInt(error.headers["retry-after"], 10)
          : null;
        throw new ClaudeError(error.message, 429, retryAfter);
      }
      if (error.status) {
        throw new ClaudeError(error.message, error.status);
      }
      throw error;
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/llm/claude.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/llm/claude.ts tests/llm/claude.test.ts
git commit -m "feat: add Claude provider with rate limit handling and error typing"
```

---

## Task 5: Vault Service

**Files:**
- Create: `src/vault/vault-service.ts`
- Test: `tests/vault/vault-service.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/vault/vault-service.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { VaultService } from "@/vault/vault-service";
import { App, Vault } from "obsidian";

describe("VaultService", () => {
  let app: App;
  let vault: Vault;
  let service: VaultService;

  beforeEach(() => {
    app = new App();
    vault = app.vault;
    service = new VaultService(app);
  });

  describe("readNote", () => {
    it("reads note content", async () => {
      vault._seed("notes/test.md", "# Hello\nSome content");
      const content = await service.readNote("notes/test.md");
      expect(content).toBe("# Hello\nSome content");
    });

    it("returns null for non-existent note", async () => {
      const content = await service.readNote("missing.md");
      expect(content).toBeNull();
    });
  });

  describe("writeNote", () => {
    it("creates a new note", async () => {
      await service.writeNote("new.md", "# New note");
      const content = await service.readNote("new.md");
      expect(content).toBe("# New note");
    });

    it("overwrites an existing note", async () => {
      vault._seed("existing.md", "old content");
      await service.writeNote("existing.md", "new content");
      const content = await service.readNote("existing.md");
      expect(content).toBe("new content");
    });
  });

  describe("noteExists", () => {
    it("returns true for existing notes", () => {
      vault._seed("exists.md", "content");
      expect(service.noteExists("exists.md")).toBe(true);
    });

    it("returns false for missing notes", () => {
      expect(service.noteExists("missing.md")).toBe(false);
    });
  });

  describe("getAllTags", () => {
    it("extracts tags from note frontmatter", async () => {
      vault._seed(
        "tagged.md",
        "---\ntags:\n  - ai\n  - ml\n---\n# Note",
      );
      vault._seed(
        "tagged2.md",
        "---\ntags:\n  - ai\n  - physics\n---\n# Note 2",
      );
      const tags = await service.getAllTags();
      expect(tags).toContain("ai");
      expect(tags).toContain("ml");
      expect(tags).toContain("physics");
    });

    it("deduplicates tags", async () => {
      vault._seed("a.md", "---\ntags:\n  - ai\n---\n");
      vault._seed("b.md", "---\ntags:\n  - ai\n---\n");
      const tags = await service.getAllTags();
      const aiCount = tags.filter((t) => t === "ai").length;
      expect(aiCount).toBe(1);
    });
  });

  describe("getUntaggedNotes", () => {
    it("returns notes without tags in frontmatter", async () => {
      vault._seed("tagged.md", "---\ntags:\n  - ai\n---\n# Tagged");
      vault._seed("untagged.md", "# No tags here");
      vault._seed("empty-tags.md", "---\ntags: []\n---\n# Empty tags");
      const untagged = await service.getUntaggedNotes();
      const paths = untagged.map((n) => n.path);
      expect(paths).toContain("untagged.md");
      expect(paths).toContain("empty-tags.md");
      expect(paths).not.toContain("tagged.md");
    });
  });

  describe("parseFrontmatter / updateFrontmatter", () => {
    it("parses YAML frontmatter", async () => {
      vault._seed("fm.md", "---\ntags:\n  - ai\ncustom: value\n---\n# Content");
      const fm = await service.parseFrontmatter("fm.md");
      expect(fm).toEqual({ tags: ["ai"], custom: "value" });
    });

    it("returns empty object for notes without frontmatter", async () => {
      vault._seed("nofm.md", "# Just content");
      const fm = await service.parseFrontmatter("nofm.md");
      expect(fm).toEqual({});
    });

    it("updates frontmatter fields", async () => {
      vault._seed("fm.md", "---\ntags:\n  - ai\n---\n# Content");
      await service.updateFrontmatter("fm.md", { "suggested-tags": ["ml", "physics"] });
      const content = await service.readNote("fm.md");
      expect(content).toContain("suggested-tags");
      const fm = await service.parseFrontmatter("fm.md");
      expect(fm["suggested-tags"]).toEqual(["ml", "physics"]);
    });

    it("merges with existing frontmatter", async () => {
      vault._seed("fm.md", "---\ntags:\n  - ai\n---\n# Content");
      await service.updateFrontmatter("fm.md", { "ai-tagged": true });
      const fm = await service.parseFrontmatter("fm.md");
      expect(fm.tags).toEqual(["ai"]);
      expect(fm["ai-tagged"]).toBe(true);
    });

    it("removes a field when set to undefined", async () => {
      vault._seed("fm.md", "---\ntags:\n  - ai\nremoveme: true\n---\n# Content");
      await service.updateFrontmatter("fm.md", { removeme: undefined });
      const fm = await service.parseFrontmatter("fm.md");
      expect(fm.removeme).toBeUndefined();
    });
  });

  describe("getMarkdownFiles", () => {
    it("returns all markdown files", () => {
      vault._seed("a.md", "");
      vault._seed("folder/b.md", "");
      vault._seed("data.json", "{}");
      const files = service.getMarkdownFiles();
      const paths = files.map((f) => f.path);
      expect(paths).toContain("a.md");
      expect(paths).toContain("folder/b.md");
      expect(paths).not.toContain("data.json");
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/vault/vault-service.test.ts`
Expected: FAIL — `@/vault/vault-service` module not found.

- [ ] **Step 3: Implement VaultService**

```typescript
// src/vault/vault-service.ts
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
    const existing = this.app.vault.getAbstractFileByPath(normalized);
    if (existing && existing instanceof TFile) {
      await this.app.vault.modify(existing, content);
    } else {
      await this.app.vault.create(normalized, content);
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
        const value = keyMatch[2].trim();

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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/vault/vault-service.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/vault/vault-service.ts tests/vault/vault-service.test.ts
git commit -m "feat: add vault service with frontmatter parsing and tag queries"
```

---

## Task 6: Cost Tracker

**Files:**
- Create: `src/orchestrator/cost-tracker.ts`
- Test: `tests/orchestrator/cost-tracker.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/orchestrator/cost-tracker.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { CostTracker } from "@/orchestrator/cost-tracker";

describe("CostTracker", () => {
  let tracker: CostTracker;

  beforeEach(() => {
    tracker = new CostTracker();
  });

  describe("recordUsage", () => {
    it("records a call and updates totals", () => {
      tracker.recordUsage({
        model: "claude-haiku-4-5-20251001",
        tokensIn: 1000,
        tokensOut: 500,
        taskType: "tagger",
      });

      const summary = tracker.getSummary();
      expect(summary.todayDollars).toBeGreaterThan(0);
      expect(summary.monthDollars).toBeGreaterThan(0);
      expect(summary.callCount).toBe(1);
    });

    it("calculates cost correctly for Haiku", () => {
      // Haiku: $0.80/1M input, $4.00/1M output
      tracker.recordUsage({
        model: "claude-haiku-4-5-20251001",
        tokensIn: 1_000_000,
        tokensOut: 1_000_000,
        taskType: "tagger",
      });

      const summary = tracker.getSummary();
      // $0.80 + $4.00 = $4.80
      expect(summary.todayDollars).toBeCloseTo(4.80, 2);
    });

    it("calculates cost correctly for Sonnet", () => {
      // Sonnet: $3.00/1M input, $15.00/1M output
      tracker.recordUsage({
        model: "claude-sonnet-4-6",
        tokensIn: 1_000_000,
        tokensOut: 1_000_000,
        taskType: "tagger",
      });

      const summary = tracker.getSummary();
      // $3.00 + $15.00 = $18.00
      expect(summary.todayDollars).toBeCloseTo(18.00, 2);
    });
  });

  describe("budget enforcement", () => {
    it("allows usage under daily budget", () => {
      expect(tracker.wouldExceedBudget(0.01, 1.00, 0)).toBe(false);
    });

    it("blocks usage over daily budget", () => {
      tracker.recordUsage({
        model: "claude-haiku-4-5-20251001",
        tokensIn: 100000,
        tokensOut: 50000,
        taskType: "tagger",
      });

      // Budget of $0.01 — already exceeded by the call above
      expect(tracker.wouldExceedBudget(0.001, 0.01, 0)).toBe(true);
    });

    it("allows unlimited when budget is 0", () => {
      tracker.recordUsage({
        model: "claude-sonnet-4-6",
        tokensIn: 10_000_000,
        tokensOut: 5_000_000,
        taskType: "tagger",
      });

      // 0 means unlimited
      expect(tracker.wouldExceedBudget(0.01, 0, 0)).toBe(false);
    });

    it("checks monthly budget independently", () => {
      tracker.recordUsage({
        model: "claude-haiku-4-5-20251001",
        tokensIn: 100000,
        tokensOut: 50000,
        taskType: "tagger",
      });

      // Daily OK, monthly exceeded
      expect(tracker.wouldExceedBudget(0.001, 100, 0.001)).toBe(true);
    });
  });

  describe("serialization", () => {
    it("serializes and deserializes state", () => {
      tracker.recordUsage({
        model: "claude-haiku-4-5-20251001",
        tokensIn: 1000,
        tokensOut: 500,
        taskType: "tagger",
      });

      const json = tracker.serialize();
      const restored = CostTracker.deserialize(json);
      const original = tracker.getSummary();
      const restoredSummary = restored.getSummary();

      expect(restoredSummary.todayDollars).toBeCloseTo(original.todayDollars, 6);
      expect(restoredSummary.monthDollars).toBeCloseTo(original.monthDollars, 6);
      expect(restoredSummary.callCount).toBe(original.callCount);
    });

    it("resets daily totals on new day", () => {
      tracker.recordUsage({
        model: "claude-haiku-4-5-20251001",
        tokensIn: 1000,
        tokensOut: 500,
        taskType: "tagger",
      });

      const json = tracker.serialize();
      // Simulate loading on a different day
      const data = JSON.parse(json);
      data.currentDay = "1970-01-01";
      const restored = CostTracker.deserialize(JSON.stringify(data));

      expect(restored.getSummary().todayDollars).toBe(0);
      // Monthly should persist
      expect(restored.getSummary().monthDollars).toBeGreaterThan(0);
    });

    it("resets monthly totals on new month", () => {
      tracker.recordUsage({
        model: "claude-haiku-4-5-20251001",
        tokensIn: 1000,
        tokensOut: 500,
        taskType: "tagger",
      });

      const json = tracker.serialize();
      const data = JSON.parse(json);
      data.currentMonth = "1970-01";
      const restored = CostTracker.deserialize(JSON.stringify(data));

      expect(restored.getSummary().monthDollars).toBe(0);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/orchestrator/cost-tracker.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement CostTracker**

```typescript
// src/orchestrator/cost-tracker.ts
import { MODEL_PRICING, SCHEMA_VERSION } from "../types";

export interface UsageRecord {
  model: string;
  tokensIn: number;
  tokensOut: number;
  taskType: string;
}

export interface CostSummary {
  todayDollars: number;
  monthDollars: number;
  todayTokensIn: number;
  todayTokensOut: number;
  callCount: number;
}

interface CostTrackerState {
  schemaVersion: number;
  currentDay: string;
  currentMonth: string;
  todayDollars: number;
  monthDollars: number;
  todayTokensIn: number;
  todayTokensOut: number;
  callCount: number;
  history: Array<{
    timestamp: number;
    model: string;
    tokensIn: number;
    tokensOut: number;
    cost: number;
    taskType: string;
  }>;
}

export class CostTracker {
  private state: CostTrackerState;

  constructor() {
    const now = new Date();
    this.state = {
      schemaVersion: SCHEMA_VERSION,
      currentDay: this.dayKey(now),
      currentMonth: this.monthKey(now),
      todayDollars: 0,
      monthDollars: 0,
      todayTokensIn: 0,
      todayTokensOut: 0,
      callCount: 0,
      history: [],
    };
  }

  private dayKey(date: Date): string {
    return date.toISOString().split("T")[0];
  }

  private monthKey(date: Date): string {
    return date.toISOString().slice(0, 7);
  }

  private rollOver(): void {
    const now = new Date();
    const today = this.dayKey(now);
    const month = this.monthKey(now);

    if (this.state.currentDay !== today) {
      this.state.todayDollars = 0;
      this.state.todayTokensIn = 0;
      this.state.todayTokensOut = 0;
      this.state.callCount = 0;
      this.state.currentDay = today;
    }

    if (this.state.currentMonth !== month) {
      this.state.monthDollars = 0;
      this.state.currentMonth = month;
    }
  }

  private calculateCost(model: string, tokensIn: number, tokensOut: number): number {
    const pricing = MODEL_PRICING[model];
    if (!pricing) return 0;
    return (tokensIn / 1_000_000) * pricing.input + (tokensOut / 1_000_000) * pricing.output;
  }

  recordUsage(record: UsageRecord): void {
    this.rollOver();
    const cost = this.calculateCost(record.model, record.tokensIn, record.tokensOut);

    this.state.todayDollars += cost;
    this.state.monthDollars += cost;
    this.state.todayTokensIn += record.tokensIn;
    this.state.todayTokensOut += record.tokensOut;
    this.state.callCount += 1;

    this.state.history.push({
      timestamp: Date.now(),
      model: record.model,
      tokensIn: record.tokensIn,
      tokensOut: record.tokensOut,
      cost,
      taskType: record.taskType,
    });
  }

  /** Check if an estimated cost would exceed the configured budgets. 0 means unlimited. */
  wouldExceedBudget(
    estimatedCost: number,
    dailyBudget: number,
    monthlyBudget: number,
  ): boolean {
    this.rollOver();
    if (dailyBudget > 0 && this.state.todayDollars + estimatedCost > dailyBudget) {
      return true;
    }
    if (monthlyBudget > 0 && this.state.monthDollars + estimatedCost > monthlyBudget) {
      return true;
    }
    return false;
  }

  getSummary(): CostSummary {
    this.rollOver();
    return {
      todayDollars: this.state.todayDollars,
      monthDollars: this.state.monthDollars,
      todayTokensIn: this.state.todayTokensIn,
      todayTokensOut: this.state.todayTokensOut,
      callCount: this.state.callCount,
    };
  }

  serialize(): string {
    return JSON.stringify(this.state, null, 2);
  }

  static deserialize(json: string): CostTracker {
    const tracker = new CostTracker();
    const data: CostTrackerState = JSON.parse(json);
    tracker.state = data;
    tracker.rollOver();
    return tracker;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/orchestrator/cost-tracker.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/cost-tracker.ts tests/orchestrator/cost-tracker.test.ts
git commit -m "feat: add cost tracker with daily/monthly budget enforcement and serialization"
```

---

## Task 7: Task Queue

**Files:**
- Create: `src/orchestrator/task.ts`, `src/orchestrator/queue.ts`
- Test: `tests/orchestrator/queue.test.ts`

- [ ] **Step 1: Create src/orchestrator/task.ts**

```typescript
import {
  ModelRequirement,
  TaskPriority,
  TaskStatus,
  TaskTrigger,
  TaskType,
  TaskAction,
} from "../types";

export interface Task {
  id: string;
  type: TaskType;
  action: TaskAction;
  payload: Record<string, any>;
  modelRequirement: ModelRequirement;
  trigger: TaskTrigger;
  priority: TaskPriority;
  status: TaskStatus;
  retryCount: number;
  maxRetries: number;
  error: string | null;
  created: number;
}

let nextId = 1;

export function createTask(
  params: Pick<Task, "type" | "action" | "payload" | "modelRequirement" | "trigger"> &
    Partial<Pick<Task, "priority" | "maxRetries">>,
): Task {
  return {
    id: String(nextId++),
    type: params.type,
    action: params.action,
    payload: params.payload,
    modelRequirement: params.modelRequirement,
    trigger: params.trigger,
    priority:
      params.trigger === TaskTrigger.Manual
        ? TaskPriority.High
        : params.priority ?? TaskPriority.Normal,
    status: TaskStatus.Pending,
    retryCount: 0,
    maxRetries: params.maxRetries ?? 3,
    error: null,
    created: Date.now(),
  };
}

/** Reset the ID counter — only for tests. */
export function _resetIdCounter(): void {
  nextId = 1;
}
```

- [ ] **Step 2: Write failing tests for TaskQueue**

```typescript
// tests/orchestrator/queue.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { TaskQueue } from "@/orchestrator/queue";
import { createTask, _resetIdCounter, Task } from "@/orchestrator/task";
import {
  ModelRequirement,
  TaskTrigger,
  TaskStatus,
  TaskPriority,
  SCHEMA_VERSION,
} from "@/types";

function makeTask(overrides?: Partial<Parameters<typeof createTask>[0]>): Task {
  return createTask({
    type: "tagger",
    action: "tag-note",
    payload: { notePath: "test.md" },
    modelRequirement: ModelRequirement.LocalPreferred,
    trigger: TaskTrigger.Automatic,
    ...overrides,
  });
}

describe("TaskQueue", () => {
  let queue: TaskQueue;

  beforeEach(() => {
    _resetIdCounter();
    queue = new TaskQueue();
  });

  describe("enqueue and dequeue", () => {
    it("adds and retrieves tasks", () => {
      const task = makeTask();
      queue.enqueue(task);
      expect(queue.size()).toBe(1);
      expect(queue.peek()).toEqual(task);
    });

    it("returns tasks in priority order (high > normal > low)", () => {
      const low = makeTask({ priority: TaskPriority.Low } as any);
      low.priority = TaskPriority.Low;
      const normal = makeTask();
      const high = makeTask({ trigger: TaskTrigger.Manual });

      queue.enqueue(low);
      queue.enqueue(normal);
      queue.enqueue(high);

      const next = queue.dequeueNext();
      expect(next?.priority).toBe(TaskPriority.High);

      const next2 = queue.dequeueNext();
      expect(next2?.priority).toBe(TaskPriority.Normal);

      const next3 = queue.dequeueNext();
      expect(next3?.priority).toBe(TaskPriority.Low);
    });

    it("respects FIFO within same priority", () => {
      const first = makeTask();
      const second = makeTask();
      queue.enqueue(first);
      queue.enqueue(second);

      expect(queue.dequeueNext()?.id).toBe(first.id);
      expect(queue.dequeueNext()?.id).toBe(second.id);
    });

    it("skips non-pending tasks", () => {
      const inProgress = makeTask();
      inProgress.status = TaskStatus.InProgress;
      const pending = makeTask();

      queue.enqueue(inProgress);
      queue.enqueue(pending);

      expect(queue.dequeueNext()?.id).toBe(pending.id);
    });
  });

  describe("status transitions", () => {
    it("marks task as in-progress on dequeue", () => {
      queue.enqueue(makeTask());
      const task = queue.dequeueNext();
      expect(task?.status).toBe(TaskStatus.InProgress);
    });

    it("marks task as completed", () => {
      queue.enqueue(makeTask());
      const task = queue.dequeueNext()!;
      queue.completeTask(task.id);
      const found = queue.getTask(task.id);
      expect(found?.status).toBe(TaskStatus.Completed);
    });

    it("marks task as failed with error", () => {
      queue.enqueue(makeTask());
      const task = queue.dequeueNext()!;
      queue.failTask(task.id, "Something broke");
      const found = queue.getTask(task.id);
      expect(found?.status).toBe(TaskStatus.Failed);
      expect(found?.error).toBe("Something broke");
      expect(found?.retryCount).toBe(1);
    });

    it("allows retry up to maxRetries", () => {
      const task = makeTask();
      task.maxRetries = 2;
      queue.enqueue(task);

      // Fail once — should go back to pending
      const t1 = queue.dequeueNext()!;
      queue.failTask(t1.id, "error 1");
      const after1 = queue.getTask(t1.id)!;
      expect(after1.status).toBe(TaskStatus.Pending);
      expect(after1.retryCount).toBe(1);

      // Fail twice — should go to terminal failed
      const t2 = queue.dequeueNext()!;
      queue.failTask(t2.id, "error 2");
      const after2 = queue.getTask(t2.id)!;
      expect(after2.status).toBe(TaskStatus.Failed);
      expect(after2.retryCount).toBe(2);
    });

    it("defers a task", () => {
      queue.enqueue(makeTask());
      const task = queue.dequeueNext()!;
      queue.deferTask(task.id);
      const found = queue.getTask(task.id);
      expect(found?.status).toBe(TaskStatus.Deferred);
    });
  });

  describe("recovery on startup", () => {
    it("resets in-progress tasks to pending on recover", () => {
      const task = makeTask();
      queue.enqueue(task);
      queue.dequeueNext(); // marks in-progress
      queue.recoverOnStartup();
      const found = queue.getTask(task.id)!;
      expect(found.status).toBe(TaskStatus.Pending);
      expect(found.retryCount).toBe(1);
    });

    it("moves task to failed if recovery exceeds maxRetries", () => {
      const task = makeTask();
      task.maxRetries = 1;
      task.retryCount = 1;
      task.status = TaskStatus.InProgress;
      queue.enqueue(task);
      queue.recoverOnStartup();
      const found = queue.getTask(task.id)!;
      expect(found.status).toBe(TaskStatus.Failed);
    });
  });

  describe("serialization", () => {
    it("round-trips through serialize/deserialize", () => {
      queue.enqueue(makeTask());
      queue.enqueue(makeTask());

      const json = queue.serialize();
      const restored = TaskQueue.deserialize(json);
      expect(restored.size()).toBe(queue.size());
    });

    it("includes schema version", () => {
      const json = queue.serialize();
      const data = JSON.parse(json);
      expect(data.schemaVersion).toBe(SCHEMA_VERSION);
    });
  });

  describe("cleanup", () => {
    it("removes completed tasks older than maxAge", () => {
      const task = makeTask();
      queue.enqueue(task);
      const dequeued = queue.dequeueNext()!;
      queue.completeTask(dequeued.id);

      // Pretend it was completed 25 hours ago
      const found = queue.getTask(dequeued.id)!;
      (found as any)._completedAt = Date.now() - 25 * 60 * 60 * 1000;

      queue.cleanup(24 * 60 * 60 * 1000, 7 * 24 * 60 * 60 * 1000);
      expect(queue.getTask(dequeued.id)).toBeUndefined();
    });
  });

  describe("getPendingByAction", () => {
    it("returns pending tasks matching an action", () => {
      queue.enqueue(makeTask({ action: "tag-note" }));
      queue.enqueue(makeTask({ action: "tag-note" }));
      queue.enqueue(makeTask({ action: "scan-connections" }));

      const tagTasks = queue.getPendingByAction("tag-note");
      expect(tagTasks).toHaveLength(2);
    });
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npm test -- tests/orchestrator/queue.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 4: Implement TaskQueue**

```typescript
// src/orchestrator/queue.ts
import { Task } from "./task";
import { TaskStatus, TaskPriority, TaskAction, SCHEMA_VERSION } from "../types";

const PRIORITY_ORDER: Record<TaskPriority, number> = {
  [TaskPriority.High]: 0,
  [TaskPriority.Normal]: 1,
  [TaskPriority.Low]: 2,
};

interface QueueState {
  schemaVersion: number;
  tasks: (Task & { _completedAt?: number })[];
}

export class TaskQueue {
  private tasks: Map<string, Task & { _completedAt?: number }> = new Map();

  enqueue(task: Task): void {
    this.tasks.set(task.id, task);
  }

  size(): number {
    return this.tasks.size;
  }

  peek(): Task | undefined {
    return this.getSorted().find((t) => t.status === TaskStatus.Pending);
  }

  /** Dequeue the next pending task, mark it in-progress, and return it. */
  dequeueNext(): Task | undefined {
    const next = this.peek();
    if (next) {
      next.status = TaskStatus.InProgress;
    }
    return next;
  }

  getTask(id: string): (Task & { _completedAt?: number }) | undefined {
    return this.tasks.get(id);
  }

  completeTask(id: string): void {
    const task = this.tasks.get(id);
    if (task) {
      task.status = TaskStatus.Completed;
      task._completedAt = Date.now();
    }
  }

  failTask(id: string, error: string): void {
    const task = this.tasks.get(id);
    if (!task) return;

    task.retryCount += 1;
    task.error = error;

    if (task.retryCount >= task.maxRetries) {
      task.status = TaskStatus.Failed;
    } else {
      task.status = TaskStatus.Pending;
    }
  }

  deferTask(id: string): void {
    const task = this.tasks.get(id);
    if (task) {
      task.status = TaskStatus.Deferred;
    }
  }

  /** On startup, reset in-progress tasks. Increment retry count. */
  recoverOnStartup(): void {
    for (const task of this.tasks.values()) {
      if (task.status === TaskStatus.InProgress) {
        task.retryCount += 1;
        if (task.retryCount >= task.maxRetries) {
          task.status = TaskStatus.Failed;
          task.error = "Interrupted by restart and exceeded max retries";
        } else {
          task.status = TaskStatus.Pending;
        }
      }
    }
  }

  /** Remove old completed and failed tasks. */
  cleanup(completedMaxAgeMs: number, failedMaxAgeMs: number): void {
    const now = Date.now();
    for (const [id, task] of this.tasks.entries()) {
      if (task.status === TaskStatus.Completed) {
        const completedAt = task._completedAt ?? task.created;
        if (now - completedAt > completedMaxAgeMs) {
          this.tasks.delete(id);
        }
      }
      if (task.status === TaskStatus.Failed) {
        if (now - task.created > failedMaxAgeMs) {
          this.tasks.delete(id);
        }
      }
    }
  }

  getPendingByAction(action: TaskAction): Task[] {
    return Array.from(this.tasks.values()).filter(
      (t) => t.status === TaskStatus.Pending && t.action === action,
    );
  }

  getFailedTasks(): Task[] {
    return Array.from(this.tasks.values()).filter(
      (t) => t.status === TaskStatus.Failed,
    );
  }

  getCompletedTasks(): Task[] {
    return Array.from(this.tasks.values()).filter(
      (t) => t.status === TaskStatus.Completed,
    );
  }

  private getSorted(): Task[] {
    return Array.from(this.tasks.values()).sort((a, b) => {
      const pa = PRIORITY_ORDER[a.priority] ?? 1;
      const pb = PRIORITY_ORDER[b.priority] ?? 1;
      if (pa !== pb) return pa - pb;
      return a.created - b.created; // FIFO within priority
    });
  }

  serialize(): string {
    const state: QueueState = {
      schemaVersion: SCHEMA_VERSION,
      tasks: Array.from(this.tasks.values()),
    };
    return JSON.stringify(state, null, 2);
  }

  static deserialize(json: string): TaskQueue {
    const queue = new TaskQueue();
    const state: QueueState = JSON.parse(json);
    for (const task of state.tasks) {
      queue.tasks.set(task.id, task);
    }
    return queue;
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npm test -- tests/orchestrator/queue.test.ts`
Expected: All tests pass.

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/task.ts src/orchestrator/queue.ts tests/orchestrator/queue.test.ts
git commit -m "feat: add task queue with priority ordering, retry logic, and persistence"
```

---

## Task 8: Task Router

**Files:**
- Create: `src/orchestrator/router.ts`
- Test: `tests/orchestrator/router.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/orchestrator/router.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { TaskRouter, RoutingDecision } from "@/orchestrator/router";
import { createTask, _resetIdCounter } from "@/orchestrator/task";
import { ModelRequirement, TaskTrigger } from "@/types";
import { LLMProvider } from "@/llm/provider";

function makeMockProvider(id: string, available: boolean): LLMProvider {
  return {
    id,
    isAvailable: vi.fn().mockResolvedValue(available),
    complete: vi.fn(),
  };
}

describe("TaskRouter", () => {
  let router: TaskRouter;
  let ollamaAvailable: LLMProvider;
  let ollamaUnavailable: LLMProvider;
  let claudeAvailable: LLMProvider;
  let claudeUnavailable: LLMProvider;

  beforeEach(() => {
    _resetIdCounter();
    ollamaAvailable = makeMockProvider("ollama", true);
    ollamaUnavailable = makeMockProvider("ollama", false);
    claudeAvailable = makeMockProvider("claude", true);
    claudeUnavailable = makeMockProvider("claude", false);
  });

  function makeRouter(
    ollama: LLMProvider,
    claude: LLMProvider,
    localFallbackToClaude = false,
  ): TaskRouter {
    return new TaskRouter(ollama, claude, localFallbackToClaude);
  }

  describe("local-only tasks", () => {
    it("routes to Ollama when available", async () => {
      router = makeRouter(ollamaAvailable, claudeAvailable);
      const task = createTask({
        type: "tagger",
        action: "tag-note",
        payload: {},
        modelRequirement: ModelRequirement.LocalOnly,
        trigger: TaskTrigger.Automatic,
      });

      const decision = await router.route(task);
      expect(decision.action).toBe("execute");
      expect(decision.provider?.id).toBe("ollama");
    });

    it("defers when Ollama unavailable", async () => {
      router = makeRouter(ollamaUnavailable, claudeAvailable);
      const task = createTask({
        type: "dashboard",
        action: "generate-dashboard",
        payload: {},
        modelRequirement: ModelRequirement.LocalOnly,
        trigger: TaskTrigger.Automatic,
      });

      const decision = await router.route(task);
      expect(decision.action).toBe("defer");
    });
  });

  describe("local-preferred tasks", () => {
    it("routes to Ollama when available", async () => {
      router = makeRouter(ollamaAvailable, claudeAvailable);
      const task = createTask({
        type: "tagger",
        action: "tag-note",
        payload: {},
        modelRequirement: ModelRequirement.LocalPreferred,
        trigger: TaskTrigger.Automatic,
      });

      const decision = await router.route(task);
      expect(decision.action).toBe("execute");
      expect(decision.provider?.id).toBe("ollama");
    });

    it("falls back to Claude when Ollama unavailable and fallback enabled", async () => {
      router = makeRouter(ollamaUnavailable, claudeAvailable, true);
      const task = createTask({
        type: "tagger",
        action: "tag-note",
        payload: {},
        modelRequirement: ModelRequirement.LocalPreferred,
        trigger: TaskTrigger.Automatic,
      });

      const decision = await router.route(task);
      expect(decision.action).toBe("execute");
      expect(decision.provider?.id).toBe("claude");
      expect(decision.costWarning).toBe(true);
    });

    it("defers when Ollama unavailable and fallback disabled", async () => {
      router = makeRouter(ollamaUnavailable, claudeAvailable, false);
      const task = createTask({
        type: "tagger",
        action: "tag-note",
        payload: {},
        modelRequirement: ModelRequirement.LocalPreferred,
        trigger: TaskTrigger.Automatic,
      });

      const decision = await router.route(task);
      expect(decision.action).toBe("defer");
    });
  });

  describe("claude-required tasks", () => {
    it("routes to Claude when available", async () => {
      router = makeRouter(ollamaAvailable, claudeAvailable);
      const task = createTask({
        type: "tagger",
        action: "audit-tags",
        payload: {},
        modelRequirement: ModelRequirement.ClaudeRequired,
        trigger: TaskTrigger.Manual,
      });

      const decision = await router.route(task);
      expect(decision.action).toBe("execute");
      expect(decision.provider?.id).toBe("claude");
    });

    it("defers when Claude unavailable", async () => {
      router = makeRouter(ollamaAvailable, claudeUnavailable);
      const task = createTask({
        type: "tagger",
        action: "audit-tags",
        payload: {},
        modelRequirement: ModelRequirement.ClaudeRequired,
        trigger: TaskTrigger.Manual,
      });

      const decision = await router.route(task);
      expect(decision.action).toBe("defer");
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/orchestrator/router.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement TaskRouter**

```typescript
// src/orchestrator/router.ts
import { Task } from "./task";
import { ModelRequirement } from "../types";
import { LLMProvider } from "../llm/provider";

export interface RoutingDecision {
  action: "execute" | "defer";
  provider: LLMProvider | null;
  costWarning: boolean;
}

export class TaskRouter {
  private ollama: LLMProvider;
  private claude: LLMProvider;
  private localFallbackToClaude: boolean;

  constructor(
    ollama: LLMProvider,
    claude: LLMProvider,
    localFallbackToClaude: boolean,
  ) {
    this.ollama = ollama;
    this.claude = claude;
    this.localFallbackToClaude = localFallbackToClaude;
  }

  async route(task: Task): Promise<RoutingDecision> {
    switch (task.modelRequirement) {
      case ModelRequirement.LocalOnly:
        return this.routeLocalOnly();

      case ModelRequirement.LocalPreferred:
        return this.routeLocalPreferred();

      case ModelRequirement.ClaudeRequired:
        return this.routeClaudeRequired();

      default:
        return { action: "defer", provider: null, costWarning: false };
    }
  }

  private async routeLocalOnly(): Promise<RoutingDecision> {
    if (await this.ollama.isAvailable()) {
      return { action: "execute", provider: this.ollama, costWarning: false };
    }
    return { action: "defer", provider: null, costWarning: false };
  }

  private async routeLocalPreferred(): Promise<RoutingDecision> {
    if (await this.ollama.isAvailable()) {
      return { action: "execute", provider: this.ollama, costWarning: false };
    }

    if (this.localFallbackToClaude && (await this.claude.isAvailable())) {
      return { action: "execute", provider: this.claude, costWarning: true };
    }

    return { action: "defer", provider: null, costWarning: false };
  }

  private async routeClaudeRequired(): Promise<RoutingDecision> {
    if (await this.claude.isAvailable()) {
      return { action: "execute", provider: this.claude, costWarning: false };
    }
    return { action: "defer", provider: null, costWarning: false };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/orchestrator/router.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/router.ts tests/orchestrator/router.test.ts
git commit -m "feat: add task router with model requirement routing and fallback logic"
```

---

## Task 9: Task Batcher

**Files:**
- Create: `src/orchestrator/batcher.ts`
- Test: `tests/orchestrator/batcher.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/orchestrator/batcher.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { TaskBatcher } from "@/orchestrator/batcher";
import { createTask, _resetIdCounter, Task } from "@/orchestrator/task";
import { ModelRequirement, TaskTrigger } from "@/types";

function makeTagTask(notePath: string, noteContent: string): Task {
  return createTask({
    type: "tagger",
    action: "tag-note",
    payload: { notePath, noteContent },
    modelRequirement: ModelRequirement.LocalPreferred,
    trigger: TaskTrigger.Automatic,
  });
}

describe("TaskBatcher", () => {
  let batcher: TaskBatcher;

  beforeEach(() => {
    _resetIdCounter();
    batcher = new TaskBatcher({ maxBatchSize: 10, contextWindowTokens: 8000 });
  });

  it("groups tasks by action", () => {
    const tasks = [
      makeTagTask("a.md", "Note A content"),
      makeTagTask("b.md", "Note B content"),
      createTask({
        type: "connection-detector",
        action: "scan-connections",
        payload: { notePath: "c.md" },
        modelRequirement: ModelRequirement.LocalPreferred,
        trigger: TaskTrigger.Automatic,
      }),
    ];

    const batches = batcher.createBatches(tasks);
    // Two batches: one for tag-note, one for scan-connections
    expect(batches).toHaveLength(2);
    expect(batches[0].tasks).toHaveLength(2);
    expect(batches[0].action).toBe("tag-note");
    expect(batches[1].tasks).toHaveLength(1);
    expect(batches[1].action).toBe("scan-connections");
  });

  it("respects max batch size", () => {
    const tasks = Array.from({ length: 15 }, (_, i) =>
      makeTagTask(`note-${i}.md`, `Content for note ${i}`),
    );

    const batches = batcher.createBatches(tasks);
    // 15 tasks with max 10 per batch → 2 batches
    expect(batches).toHaveLength(2);
    expect(batches[0].tasks).toHaveLength(10);
    expect(batches[1].tasks).toHaveLength(5);
  });

  it("respects token limit", () => {
    // Each note has ~1000 tokens worth of content (rough estimate: 4 chars per token)
    const longContent = "word ".repeat(1000); // ~5000 chars ≈ 1250 tokens
    const tasks = Array.from({ length: 10 }, (_, i) =>
      makeTagTask(`note-${i}.md`, longContent),
    );

    // With 8000 token context window and 80% threshold = 6400 tokens
    // Each task ~1250 tokens, so ~5 per batch
    const batches = batcher.createBatches(tasks);
    expect(batches.length).toBeGreaterThan(1);
    // First batch should have fewer than 10 tasks
    expect(batches[0].tasks.length).toBeLessThan(10);
  });

  it("returns single-task batches for non-batchable actions", () => {
    const tasks = [
      createTask({
        type: "tagger",
        action: "audit-tags",
        payload: {},
        modelRequirement: ModelRequirement.ClaudeRequired,
        trigger: TaskTrigger.Manual,
      }),
    ];

    const batches = batcher.createBatches(tasks);
    expect(batches).toHaveLength(1);
    expect(batches[0].tasks).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/orchestrator/batcher.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement TaskBatcher**

```typescript
// src/orchestrator/batcher.ts
import { Task } from "./task";
import { TaskAction } from "../types";

export interface TaskBatch {
  action: TaskAction;
  tasks: Task[];
}

export interface BatcherConfig {
  maxBatchSize: number;
  contextWindowTokens: number;
}

/** Rough token estimate: ~4 characters per token. */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** Actions that support batching (multiple items in one LLM call). */
const BATCHABLE_ACTIONS: Set<TaskAction> = new Set(["tag-note"]);

export class TaskBatcher {
  private config: BatcherConfig;

  constructor(config: BatcherConfig) {
    this.config = config;
  }

  createBatches(tasks: Task[]): TaskBatch[] {
    // Group by action
    const groups = new Map<TaskAction, Task[]>();
    for (const task of tasks) {
      const existing = groups.get(task.action) ?? [];
      existing.push(task);
      groups.set(task.action, existing);
    }

    const batches: TaskBatch[] = [];

    for (const [action, groupTasks] of groups.entries()) {
      if (!BATCHABLE_ACTIONS.has(action)) {
        // Non-batchable: each task is its own batch
        for (const task of groupTasks) {
          batches.push({ action, tasks: [task] });
        }
        continue;
      }

      // Batchable: group by size constraints
      const tokenLimit = Math.floor(this.config.contextWindowTokens * 0.8);
      let currentBatch: Task[] = [];
      let currentTokens = 0;

      for (const task of groupTasks) {
        const taskTokens = this.estimateTaskTokens(task);

        const wouldExceedSize = currentBatch.length >= this.config.maxBatchSize;
        const wouldExceedTokens = currentTokens + taskTokens > tokenLimit;

        if (currentBatch.length > 0 && (wouldExceedSize || wouldExceedTokens)) {
          batches.push({ action, tasks: currentBatch });
          currentBatch = [];
          currentTokens = 0;
        }

        currentBatch.push(task);
        currentTokens += taskTokens;
      }

      if (currentBatch.length > 0) {
        batches.push({ action, tasks: currentBatch });
      }
    }

    return batches;
  }

  private estimateTaskTokens(task: Task): number {
    let total = 0;
    if (task.payload.noteContent) {
      total += estimateTokens(task.payload.noteContent);
    }
    if (task.payload.notePath) {
      total += estimateTokens(task.payload.notePath);
    }
    // Base overhead for formatting each task in a prompt
    total += 50;
    return total;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/orchestrator/batcher.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/batcher.ts tests/orchestrator/batcher.test.ts
git commit -m "feat: add task batcher with token-aware sizing and max batch limits"
```

---

## Task 10: Orchestrator

**Files:**
- Create: `src/orchestrator/orchestrator.ts`
- Test: `tests/orchestrator/orchestrator.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/orchestrator/orchestrator.test.ts
import { describe, it, expect, beforeEach, vi } from "vitest";
import { Orchestrator } from "@/orchestrator/orchestrator";
import { TaskQueue } from "@/orchestrator/queue";
import { TaskRouter } from "@/orchestrator/router";
import { TaskBatcher } from "@/orchestrator/batcher";
import { CostTracker } from "@/orchestrator/cost-tracker";
import { createTask, _resetIdCounter } from "@/orchestrator/task";
import { ModelRequirement, TaskTrigger, TaskStatus } from "@/types";
import { LLMProvider, LLMResponse } from "@/llm/provider";

function makeMockProvider(id: string, available: boolean): LLMProvider & { complete: ReturnType<typeof vi.fn> } {
  return {
    id,
    isAvailable: vi.fn().mockResolvedValue(available),
    complete: vi.fn().mockResolvedValue({
      content: '{"tags": ["test"]}',
      tokensUsed: { input: 100, output: 50 },
      model: id === "ollama" ? "llama3:8b" : "claude-haiku-4-5-20251001",
      durationMs: 200,
    } satisfies LLMResponse),
  };
}

describe("Orchestrator", () => {
  let queue: TaskQueue;
  let costTracker: CostTracker;
  let ollama: ReturnType<typeof makeMockProvider>;
  let claude: ReturnType<typeof makeMockProvider>;
  let orchestrator: Orchestrator;

  beforeEach(() => {
    _resetIdCounter();
    queue = new TaskQueue();
    costTracker = new CostTracker();
    ollama = makeMockProvider("ollama", true);
    claude = makeMockProvider("claude", true);

    orchestrator = new Orchestrator({
      queue,
      router: new TaskRouter(ollama, claude, false),
      batcher: new TaskBatcher({ maxBatchSize: 10, contextWindowTokens: 8000 }),
      costTracker,
      providers: { ollama, claude },
      settings: {
        claudeDailyBudget: 0,
        claudeMonthlyBudget: 0,
      },
      onTaskCompleted: vi.fn(),
      onTaskFailed: vi.fn(),
      onTaskDeferred: vi.fn(),
      onCostWarning: vi.fn(),
    });
  });

  it("processes a pending task through to completion", async () => {
    const task = createTask({
      type: "tagger",
      action: "tag-note",
      payload: { notePath: "test.md", noteContent: "# Test" },
      modelRequirement: ModelRequirement.LocalPreferred,
      trigger: TaskTrigger.Manual,
    });
    queue.enqueue(task);

    await orchestrator.processNext();

    const processed = queue.getTask(task.id);
    expect(processed?.status).toBe(TaskStatus.Completed);
    expect(ollama.complete).toHaveBeenCalled();
  });

  it("defers tasks when provider unavailable", async () => {
    ollama = makeMockProvider("ollama", false);
    claude = makeMockProvider("claude", false);
    orchestrator = new Orchestrator({
      queue,
      router: new TaskRouter(ollama, claude, false),
      batcher: new TaskBatcher({ maxBatchSize: 10, contextWindowTokens: 8000 }),
      costTracker,
      providers: { ollama, claude },
      settings: { claudeDailyBudget: 0, claudeMonthlyBudget: 0 },
      onTaskCompleted: vi.fn(),
      onTaskFailed: vi.fn(),
      onTaskDeferred: vi.fn(),
      onCostWarning: vi.fn(),
    });

    const task = createTask({
      type: "tagger",
      action: "tag-note",
      payload: { notePath: "test.md", noteContent: "# Test" },
      modelRequirement: ModelRequirement.LocalPreferred,
      trigger: TaskTrigger.Automatic,
    });
    queue.enqueue(task);

    await orchestrator.processNext();

    const processed = queue.getTask(task.id);
    expect(processed?.status).toBe(TaskStatus.Deferred);
  });

  it("records cost when using Claude", async () => {
    ollama = makeMockProvider("ollama", false);
    claude = makeMockProvider("claude", true);

    orchestrator = new Orchestrator({
      queue,
      router: new TaskRouter(ollama, claude, true), // fallback enabled
      batcher: new TaskBatcher({ maxBatchSize: 10, contextWindowTokens: 8000 }),
      costTracker,
      providers: { ollama, claude },
      settings: { claudeDailyBudget: 0, claudeMonthlyBudget: 0 },
      onTaskCompleted: vi.fn(),
      onTaskFailed: vi.fn(),
      onTaskDeferred: vi.fn(),
      onCostWarning: vi.fn(),
    });

    const task = createTask({
      type: "tagger",
      action: "tag-note",
      payload: { notePath: "test.md", noteContent: "# Test" },
      modelRequirement: ModelRequirement.LocalPreferred,
      trigger: TaskTrigger.Manual,
    });
    queue.enqueue(task);

    await orchestrator.processNext();

    const summary = costTracker.getSummary();
    expect(summary.callCount).toBe(1);
  });

  it("handles LLM errors and retries", async () => {
    ollama.complete.mockRejectedValueOnce(new Error("Ollama crashed"));
    ollama.complete.mockResolvedValueOnce({
      content: '{"tags": ["test"]}',
      tokensUsed: { input: 100, output: 50 },
      model: "llama3:8b",
      durationMs: 200,
    });

    const task = createTask({
      type: "tagger",
      action: "tag-note",
      payload: { notePath: "test.md", noteContent: "# Test" },
      modelRequirement: ModelRequirement.LocalPreferred,
      trigger: TaskTrigger.Manual,
    });
    queue.enqueue(task);

    // First attempt fails
    await orchestrator.processNext();
    const afterFail = queue.getTask(task.id)!;
    expect(afterFail.retryCount).toBe(1);
    expect(afterFail.status).toBe(TaskStatus.Pending);

    // Second attempt succeeds
    await orchestrator.processNext();
    const afterSuccess = queue.getTask(task.id)!;
    expect(afterSuccess.status).toBe(TaskStatus.Completed);
  });

  it("does nothing when queue is empty", async () => {
    await orchestrator.processNext();
    expect(ollama.complete).not.toHaveBeenCalled();
    expect(claude.complete).not.toHaveBeenCalled();
  });

  it("enforces cost budget", async () => {
    orchestrator = new Orchestrator({
      queue,
      router: new TaskRouter(ollama, claude, false),
      batcher: new TaskBatcher({ maxBatchSize: 10, contextWindowTokens: 8000 }),
      costTracker,
      providers: { ollama, claude },
      settings: { claudeDailyBudget: 0.0001, claudeMonthlyBudget: 0 }, // Tiny budget
      onTaskCompleted: vi.fn(),
      onTaskFailed: vi.fn(),
      onTaskDeferred: vi.fn(),
      onCostWarning: vi.fn(),
    });

    // Use up the budget
    costTracker.recordUsage({
      model: "claude-haiku-4-5-20251001",
      tokensIn: 10000,
      tokensOut: 5000,
      taskType: "tagger",
    });

    const task = createTask({
      type: "tagger",
      action: "audit-tags",
      payload: {},
      modelRequirement: ModelRequirement.ClaudeRequired,
      trigger: TaskTrigger.Automatic,
    });
    queue.enqueue(task);

    await orchestrator.processNext();

    const processed = queue.getTask(task.id);
    expect(processed?.status).toBe(TaskStatus.Deferred);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/orchestrator/orchestrator.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement Orchestrator**

```typescript
// src/orchestrator/orchestrator.ts
import { TaskQueue } from "./queue";
import { Task } from "./task";
import { TaskRouter } from "./router";
import { TaskBatcher } from "./batcher";
import { CostTracker } from "./cost-tracker";
import { TaskStatus } from "../types";
import { LLMProvider, LLMResponse } from "../llm/provider";

export interface OrchestratorConfig {
  queue: TaskQueue;
  router: TaskRouter;
  batcher: TaskBatcher;
  costTracker: CostTracker;
  providers: { ollama: LLMProvider; claude: LLMProvider };
  settings: {
    claudeDailyBudget: number;
    claudeMonthlyBudget: number;
  };
  onTaskCompleted: (task: Task, response: LLMResponse) => void;
  onTaskFailed: (task: Task, error: string) => void;
  onTaskDeferred: (task: Task, reason: string) => void;
  onCostWarning: (message: string) => void;
}

export class Orchestrator {
  private config: OrchestratorConfig;
  private pauseUntil = 0;       // Timestamp: don't process until this time (rate limit)
  private claudePaused = false;  // True when Claude auth has failed

  constructor(config: OrchestratorConfig) {
    this.config = config;
  }

  get queue(): TaskQueue {
    return this.config.queue;
  }

  get costTracker(): CostTracker {
    return this.config.costTracker;
  }

  updateSettings(settings: OrchestratorConfig["settings"]): void {
    this.config.settings = settings;
  }

  /** Process the next pending task in the queue. Returns true if a task was processed. */
  async processNext(): Promise<boolean> {
    // Respect rate limit pause
    if (Date.now() < this.pauseUntil) return false;

    const task = this.config.queue.dequeueNext();
    if (!task) return false;

    const decision = await this.config.router.route(task);

    if (decision.action === "defer") {
      this.config.queue.deferTask(task.id);
      this.config.onTaskDeferred(task, "Provider unavailable");
      return true;
    }

    const provider = decision.provider!;

    // Budget check for Claude
    if (provider.id === "claude") {
      // Estimate cost conservatively (assume max tokens used)
      const estimatedCost = 0.01; // rough estimate per call
      if (
        this.config.costTracker.wouldExceedBudget(
          estimatedCost,
          this.config.settings.claudeDailyBudget,
          this.config.settings.claudeMonthlyBudget,
        )
      ) {
        this.config.queue.deferTask(task.id);
        this.config.onTaskDeferred(task, "Claude budget exceeded");
        this.config.onCostWarning("Daily Claude budget reached. Task deferred.");
        return true;
      }
    }

    if (decision.costWarning) {
      this.config.onCostWarning(
        "Ollama unavailable — using Claude API for this task.",
      );
    }

    try {
      const response = await provider.complete({
        system: task.payload.systemPrompt ?? "",
        prompt: task.payload.prompt ?? JSON.stringify(task.payload),
        maxTokens: task.payload.maxTokens ?? 1000,
      });

      // Record cost if Claude
      if (provider.id === "claude") {
        this.config.costTracker.recordUsage({
          model: response.model,
          tokensIn: response.tokensUsed.input,
          tokensOut: response.tokensUsed.output,
          taskType: task.type,
        });
      }

      this.config.queue.completeTask(task.id);
      this.config.onTaskCompleted(task, response);
      return true;
    } catch (error: any) {
      const message = error.message ?? String(error);

      // Claude-specific error handling
      if (error.name === "ClaudeError" || error.status) {
        if (error.status === 429) {
          // Rate limit: defer task, pause queue temporarily
          this.config.queue.deferTask(task.id);
          const retryAfter = error.retryAfterSeconds ?? 60;
          this.config.onCostWarning(
            `Claude rate limited — pausing for ${retryAfter}s.`,
          );
          // The caller should wait before calling processNext again.
          // Store the pause-until timestamp so the processing loop can check it.
          this.pauseUntil = Date.now() + retryAfter * 1000;
          return true;
        }
        if (error.status === 401) {
          // Auth error: defer all Claude tasks, don't retry
          this.config.queue.deferTask(task.id);
          this.config.onCostWarning(
            "API key invalid or expired — check plugin settings.",
          );
          this.claudePaused = true;
          return true;
        }
      }

      // Generic error: retry logic
      this.config.queue.failTask(task.id, message);
      const updatedTask = this.config.queue.getTask(task.id)!;
      if (updatedTask.status === TaskStatus.Failed) {
        this.config.onTaskFailed(updatedTask, message);
      }
      return true;
    }
  }

  /** Process all pending tasks until the queue is empty or all remaining tasks are deferred/failed. */
  async processAll(): Promise<void> {
    let processed = true;
    while (processed) {
      processed = await this.processNext();
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/orchestrator/orchestrator.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/orchestrator/orchestrator.ts tests/orchestrator/orchestrator.test.ts
git commit -m "feat: add orchestrator with routing, cost enforcement, and error handling"
```

---

## Task 11: Tagger Module

**Files:**
- Create: `src/modules/tagger/tagger.ts`
- Test: `tests/modules/tagger.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/modules/tagger.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { TaggerModule } from "@/modules/tagger/tagger";

describe("TaggerModule", () => {
  let tagger: TaggerModule;

  beforeEach(() => {
    tagger = new TaggerModule();
  });

  describe("buildPrompt", () => {
    it("includes note content, existing tags, and style guide", () => {
      const prompt = tagger.buildPrompt({
        noteContent: "# Neural Networks\nDeep learning is a subset of ML.",
        existingTags: ["ai", "machine-learning", "physics", "math"],
        rejectedTags: [],
        styleGuide: "Use kebab-case. Max depth 3.",
      });

      expect(prompt.system).toContain("tagging assistant");
      expect(prompt.prompt).toContain("Neural Networks");
      expect(prompt.prompt).toContain("machine-learning");
      expect(prompt.prompt).toContain("kebab-case");
    });

    it("includes rejected tags in prompt", () => {
      const prompt = tagger.buildPrompt({
        noteContent: "# Test",
        existingTags: ["ai"],
        rejectedTags: ["generic-tag"],
        styleGuide: "",
      });

      expect(prompt.prompt).toContain("generic-tag");
      expect(prompt.prompt).toContain("rejected");
    });

    it("requests JSON response format", () => {
      const prompt = tagger.buildPrompt({
        noteContent: "# Test",
        existingTags: [],
        rejectedTags: [],
        styleGuide: "",
      });

      expect(prompt.prompt).toContain("JSON");
    });
  });

  describe("buildBatchPrompt", () => {
    it("includes multiple notes in one prompt", () => {
      const prompt = tagger.buildBatchPrompt({
        notes: [
          { path: "a.md", content: "# Note A" },
          { path: "b.md", content: "# Note B" },
        ],
        existingTags: ["ai"],
        rejectedTagsByNote: { "a.md": ["bad-tag"], "b.md": [] },
        styleGuide: "kebab-case",
      });

      expect(prompt.prompt).toContain("a.md");
      expect(prompt.prompt).toContain("b.md");
      expect(prompt.prompt).toContain("Note A");
      expect(prompt.prompt).toContain("Note B");
    });
  });

  describe("parseResponse", () => {
    it("parses valid JSON response with tags array", () => {
      const result = tagger.parseResponse('{"tags": ["ai", "deep-learning"]}');
      expect(result).toEqual({ tags: ["ai", "deep-learning"] });
    });

    it("parses response with tags embedded in markdown code block", () => {
      const result = tagger.parseResponse(
        '```json\n{"tags": ["ai"]}\n```',
      );
      expect(result).toEqual({ tags: ["ai"] });
    });

    it("returns null for invalid JSON", () => {
      const result = tagger.parseResponse("not json at all");
      expect(result).toBeNull();
    });

    it("returns null for JSON without tags array", () => {
      const result = tagger.parseResponse('{"something": "else"}');
      expect(result).toBeNull();
    });
  });

  describe("parseBatchResponse", () => {
    it("parses response with per-note tags", () => {
      const result = tagger.parseBatchResponse(
        JSON.stringify({
          results: [
            { path: "a.md", tags: ["ai"] },
            { path: "b.md", tags: ["physics"] },
          ],
        }),
      );

      expect(result).toEqual({
        "a.md": ["ai"],
        "b.md": ["physics"],
      });
    });

    it("returns null for invalid response", () => {
      const result = tagger.parseBatchResponse("garbage");
      expect(result).toBeNull();
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/modules/tagger.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement TaggerModule**

```typescript
// src/modules/tagger/tagger.ts
import { LLMRequest } from "../../llm/provider";

export interface TagPromptInput {
  noteContent: string;
  existingTags: string[];
  rejectedTags: string[];
  styleGuide: string;
}

export interface BatchTagPromptInput {
  notes: Array<{ path: string; content: string }>;
  existingTags: string[];
  rejectedTagsByNote: Record<string, string[]>;
  styleGuide: string;
}

export interface TagResult {
  tags: string[];
}

export class TaggerModule {
  buildPrompt(input: TagPromptInput): LLMRequest {
    const rejectedSection =
      input.rejectedTags.length > 0
        ? `\n\nThe user has previously rejected these tags for this note — do NOT suggest them again:\n${input.rejectedTags.map((t) => `- ${t}`).join("\n")}`
        : "";

    const prompt = `Given the following note, suggest appropriate tags. Prefer tags from the existing taxonomy. Only propose new tags if nothing in the taxonomy fits.

## Existing tags in vault
${input.existingTags.length > 0 ? input.existingTags.join(", ") : "(none yet)"}

## Style guide
${input.styleGuide || "No specific style guide."}
${rejectedSection}

## Note content
${input.noteContent}

Respond with a JSON object: {"tags": ["tag1", "tag2", ...]}
Return between 1 and 5 tags. Prefer fewer, more relevant tags over many vague ones.`;

    return {
      system:
        "You are a note tagging assistant. You analyze note content and suggest relevant tags. Always respond with valid JSON only, no extra text.",
      prompt,
      maxTokens: 200,
      temperature: 0.2,
    };
  }

  buildBatchPrompt(input: BatchTagPromptInput): LLMRequest {
    const noteSections = input.notes
      .map((note) => {
        const rejected = input.rejectedTagsByNote[note.path] ?? [];
        const rejectedLine =
          rejected.length > 0
            ? `\nPreviously rejected tags for this note: ${rejected.join(", ")}`
            : "";
        return `### ${note.path}${rejectedLine}\n${note.content}`;
      })
      .join("\n\n---\n\n");

    const prompt = `Tag each of the following notes. Prefer tags from the existing taxonomy.

## Existing tags in vault
${input.existingTags.length > 0 ? input.existingTags.join(", ") : "(none yet)"}

## Style guide
${input.styleGuide || "No specific style guide."}

## Notes
${noteSections}

Respond with JSON: {"results": [{"path": "note.md", "tags": ["tag1"]}, ...]}
Return between 1 and 5 tags per note.`;

    return {
      system:
        "You are a note tagging assistant. You analyze note content and suggest relevant tags. Always respond with valid JSON only, no extra text.",
      prompt,
      maxTokens: 100 * input.notes.length,
      temperature: 0.2,
    };
  }

  parseResponse(raw: string): TagResult | null {
    const json = this.extractJson(raw);
    if (!json) return null;

    try {
      const parsed = JSON.parse(json);
      if (parsed.tags && Array.isArray(parsed.tags)) {
        return { tags: parsed.tags.map(String) };
      }
      return null;
    } catch {
      return null;
    }
  }

  parseBatchResponse(raw: string): Record<string, string[]> | null {
    const json = this.extractJson(raw);
    if (!json) return null;

    try {
      const parsed = JSON.parse(json);
      if (!parsed.results || !Array.isArray(parsed.results)) return null;

      const result: Record<string, string[]> = {};
      for (const item of parsed.results) {
        if (item.path && Array.isArray(item.tags)) {
          result[item.path] = item.tags.map(String);
        }
      }
      return Object.keys(result).length > 0 ? result : null;
    } catch {
      return null;
    }
  }

  private extractJson(raw: string): string | null {
    // Try raw string first
    const trimmed = raw.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      return trimmed;
    }

    // Try extracting from markdown code block
    const codeBlockMatch = trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
    if (codeBlockMatch) {
      return codeBlockMatch[1].trim();
    }

    return null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/modules/tagger.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/modules/tagger/tagger.ts tests/modules/tagger.test.ts
git commit -m "feat: add tagger module with single/batch prompt building and response parsing"
```

---

## Task 12: Tag Audit Module

**Files:**
- Create: `src/modules/tagger/tag-audit.ts`
- Test: `tests/modules/tag-audit.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/modules/tag-audit.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { TagAuditModule } from "@/modules/tagger/tag-audit";

describe("TagAuditModule", () => {
  let audit: TagAuditModule;

  beforeEach(() => {
    audit = new TagAuditModule();
  });

  describe("buildPrompt", () => {
    it("includes all vault tags", () => {
      const prompt = audit.buildAuditPrompt([
        "ai",
        "AI",
        "machine-learning",
        "ml",
        "project",
        "projects",
      ]);

      expect(prompt.prompt).toContain("ai");
      expect(prompt.prompt).toContain("machine-learning");
      expect(prompt.prompt).toContain("projects");
    });

    it("requests JSON response", () => {
      const prompt = audit.buildAuditPrompt(["ai", "ml"]);
      expect(prompt.prompt).toContain("JSON");
    });
  });

  describe("parseAuditResponse", () => {
    it("parses merge suggestions", () => {
      const result = audit.parseAuditResponse(
        JSON.stringify({
          suggestions: [
            {
              action: "merge",
              tags: ["ai", "AI"],
              into: "ai",
              reason: "Case variant",
            },
            {
              action: "merge",
              tags: ["ml", "machine-learning"],
              into: "machine-learning",
              reason: "Abbreviation",
            },
          ],
        }),
      );

      expect(result).toHaveLength(2);
      expect(result![0].action).toBe("merge");
      expect(result![0].tags).toEqual(["ai", "AI"]);
      expect(result![0].into).toBe("ai");
    });

    it("returns null for invalid response", () => {
      expect(audit.parseAuditResponse("not json")).toBeNull();
    });
  });

  describe("computeAffectedFiles", () => {
    it("finds files containing the old tag", () => {
      const tagIndex: Record<string, string[]> = {
        "AI": ["note1.md", "note2.md"],
        "ai": ["note3.md"],
        "ml": ["note1.md"],
      };

      const affected = audit.computeAffectedFiles(
        { action: "merge", tags: ["AI", "ai"], into: "ai", reason: "" },
        tagIndex,
      );

      // "AI" needs to be renamed in note1.md and note2.md
      // "ai" is already correct in note3.md
      expect(affected).toEqual(["note1.md", "note2.md"]);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/modules/tag-audit.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement TagAuditModule**

```typescript
// src/modules/tagger/tag-audit.ts
import { LLMRequest } from "../../llm/provider";

export interface AuditSuggestion {
  action: "merge";
  tags: string[];
  into: string;
  reason: string;
}

export class TagAuditModule {
  buildAuditPrompt(allTags: string[]): LLMRequest {
    const prompt = `Analyze the following list of tags from a knowledge vault. Identify tags that should be merged because they are:
- Case variants (e.g., "AI" and "ai")
- Plural/singular variants (e.g., "project" and "projects")
- Abbreviations of each other (e.g., "ml" and "machine-learning")
- Semantically equivalent (e.g., "deep-learning" and "dl")

## Tags
${allTags.join(", ")}

For each group of tags that should be merged, suggest which one to keep (prefer the more descriptive, kebab-case form).

Respond with JSON:
{"suggestions": [{"action": "merge", "tags": ["tag1", "tag2"], "into": "preferred-tag", "reason": "why"}]}

If no merges are needed, respond with: {"suggestions": []}`;

    return {
      system:
        "You are a tag taxonomy analyst. You identify redundant or inconsistent tags in a knowledge vault. Always respond with valid JSON only.",
      prompt,
      maxTokens: 1000,
      temperature: 0.1,
    };
  }

  parseAuditResponse(raw: string): AuditSuggestion[] | null {
    try {
      const trimmed = raw.trim();
      const json = trimmed.startsWith("{")
        ? trimmed
        : trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)?.[1]?.trim();
      if (!json) return null;

      const parsed = JSON.parse(json);
      if (!parsed.suggestions || !Array.isArray(parsed.suggestions)) return null;

      return parsed.suggestions.filter(
        (s: any) =>
          s.action === "merge" &&
          Array.isArray(s.tags) &&
          typeof s.into === "string" &&
          typeof s.reason === "string",
      );
    } catch {
      return null;
    }
  }

  /**
   * Given a merge suggestion and an index of tag → files,
   * return the list of files that need to be modified
   * (files containing a tag variant that is NOT the target).
   */
  computeAffectedFiles(
    suggestion: AuditSuggestion,
    tagIndex: Record<string, string[]>,
  ): string[] {
    const affectedSet = new Set<string>();
    for (const tag of suggestion.tags) {
      if (tag !== suggestion.into) {
        const files = tagIndex[tag] ?? [];
        for (const file of files) {
          affectedSet.add(file);
        }
      }
    }
    return Array.from(affectedSet);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/modules/tag-audit.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/modules/tagger/tag-audit.ts tests/modules/tag-audit.test.ts
git commit -m "feat: add tag audit module with merge detection and affected file computation"
```

---

## Task 13: Connection Scoring

**Files:**
- Create: `src/modules/connections/scoring.ts`
- Test: `tests/modules/scoring.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/modules/scoring.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { CandidateScorer, NoteProfile } from "@/modules/connections/scoring";

describe("CandidateScorer", () => {
  let scorer: CandidateScorer;

  beforeEach(() => {
    scorer = new CandidateScorer();
  });

  describe("extractKeywords", () => {
    it("extracts high-frequency words from a note", () => {
      const noteContent =
        "Machine learning is a subset of artificial intelligence. " +
        "Machine learning algorithms learn from data. " +
        "Data is essential for machine learning.";
      const vaultWordFreqs = new Map<string, number>([
        ["machine", 5],
        ["learning", 5],
        ["subset", 50],
        ["artificial", 50],
        ["intelligence", 50],
        ["algorithms", 50],
        ["data", 50],
        ["essential", 100],
      ]);

      const keywords = scorer.extractKeywords(noteContent, vaultWordFreqs);
      // "machine" and "learning" appear often in this note but not across the vault → high TF-IDF
      expect(keywords).toContain("machine");
      expect(keywords).toContain("learning");
    });

    it("filters out stop words", () => {
      const keywords = scorer.extractKeywords(
        "the is a an and or but not for with this that from",
        new Map(),
      );
      expect(keywords).toHaveLength(0);
    });
  });

  describe("scoreCandidate", () => {
    const source: NoteProfile = {
      path: "source.md",
      tags: ["ai", "machine-learning"],
      titleWords: ["neural", "networks"],
      keywords: ["transformer", "attention", "model"],
      folder: "research",
      linkedPaths: new Set(),
    };

    it("scores high for a note with overlapping tags and keywords", () => {
      const candidate: NoteProfile = {
        path: "related.md",
        tags: ["ai", "deep-learning"],
        titleWords: ["deep", "learning"],
        keywords: ["transformer", "bert", "attention"],
        folder: "research",
        linkedPaths: new Set(),
      };

      const score = scorer.scoreCandidate(source, candidate);
      expect(score).toBeGreaterThan(0.3);
    });

    it("scores low for unrelated notes", () => {
      const candidate: NoteProfile = {
        path: "cooking.md",
        tags: ["recipes", "italian"],
        titleWords: ["pasta", "recipe"],
        keywords: ["tomato", "garlic", "olive"],
        folder: "cooking",
        linkedPaths: new Set(),
      };

      const score = scorer.scoreCandidate(source, candidate);
      expect(score).toBeLessThan(0.15);
    });

    it("excludes already-linked notes", () => {
      const sourceWithLink: NoteProfile = {
        ...source,
        linkedPaths: new Set(["already-linked.md"]),
      };

      const candidate: NoteProfile = {
        path: "already-linked.md",
        tags: ["ai"],
        titleWords: ["ai"],
        keywords: ["transformer"],
        folder: "research",
        linkedPaths: new Set(),
      };

      const score = scorer.scoreCandidate(sourceWithLink, candidate);
      expect(score).toBe(0);
    });

    it("gives folder proximity bonus", () => {
      const sameFolder: NoteProfile = {
        path: "other.md",
        tags: [],
        titleWords: [],
        keywords: ["transformer"],
        folder: "research",
        linkedPaths: new Set(),
      };

      const differentFolder: NoteProfile = {
        path: "other2.md",
        tags: [],
        titleWords: [],
        keywords: ["transformer"],
        folder: "notes",
        linkedPaths: new Set(),
      };

      const scoreSame = scorer.scoreCandidate(source, sameFolder);
      const scoreDiff = scorer.scoreCandidate(source, differentFolder);
      expect(scoreSame).toBeGreaterThan(scoreDiff);
    });
  });

  describe("rankCandidates", () => {
    it("returns top N candidates above threshold", () => {
      const source: NoteProfile = {
        path: "source.md",
        tags: ["ai"],
        titleWords: ["ai"],
        keywords: ["transformer"],
        folder: "research",
        linkedPaths: new Set(),
      };

      const candidates: NoteProfile[] = [
        {
          path: "good.md",
          tags: ["ai", "ml"],
          titleWords: ["machine"],
          keywords: ["transformer", "model"],
          folder: "research",
          linkedPaths: new Set(),
        },
        {
          path: "ok.md",
          tags: ["ai"],
          titleWords: ["data"],
          keywords: ["dataset"],
          folder: "other",
          linkedPaths: new Set(),
        },
        {
          path: "bad.md",
          tags: ["cooking"],
          titleWords: ["pasta"],
          keywords: ["tomato"],
          folder: "cooking",
          linkedPaths: new Set(),
        },
      ];

      const ranked = scorer.rankCandidates(source, candidates, {
        maxCandidates: 10,
        minScore: 0.15,
      });

      // "good.md" should rank highest, "bad.md" should be filtered out
      expect(ranked.length).toBeGreaterThanOrEqual(1);
      expect(ranked[0].profile.path).toBe("good.md");
      expect(ranked.every((r) => r.score >= 0.15)).toBe(true);
    });

    it("respects maxCandidates limit", () => {
      const source: NoteProfile = {
        path: "s.md",
        tags: ["ai"],
        titleWords: [],
        keywords: [],
        folder: "",
        linkedPaths: new Set(),
      };

      const candidates = Array.from({ length: 20 }, (_, i) => ({
        path: `note-${i}.md`,
        tags: ["ai"],
        titleWords: [],
        keywords: [],
        folder: "",
        linkedPaths: new Set<string>(),
      }));

      const ranked = scorer.rankCandidates(source, candidates, {
        maxCandidates: 5,
        minScore: 0,
      });

      expect(ranked).toHaveLength(5);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/modules/scoring.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement CandidateScorer**

```typescript
// src/modules/connections/scoring.ts

export interface NoteProfile {
  path: string;
  tags: string[];
  titleWords: string[];
  keywords: string[];
  folder: string;
  linkedPaths: Set<string>;
}

export interface ScoredCandidate {
  profile: NoteProfile;
  score: number;
}

export interface RankingConfig {
  maxCandidates: number;
  minScore: number;
}

const STOP_WORDS = new Set([
  "the", "is", "a", "an", "and", "or", "but", "not", "for", "with",
  "this", "that", "from", "are", "was", "were", "been", "be", "have",
  "has", "had", "do", "does", "did", "will", "would", "could", "should",
  "may", "might", "can", "shall", "to", "of", "in", "on", "at", "by",
  "it", "its", "as", "if", "so", "no", "up", "out", "then", "than",
  "when", "what", "which", "who", "how", "all", "each", "every",
  "both", "few", "more", "most", "other", "some", "such", "only",
  "own", "same", "also", "just", "about", "into", "over", "after",
]);

const WEIGHTS = {
  tagOverlap: 0.4,
  titleSimilarity: 0.2,
  keywordOverlap: 0.3,
  folderProximity: 0.1,
};

export class CandidateScorer {
  extractKeywords(
    noteContent: string,
    vaultWordFreqs: Map<string, number>,
    maxKeywords = 20,
  ): string[] {
    const words = noteContent
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w));

    // Count word frequency in this note
    const localFreq = new Map<string, number>();
    for (const word of words) {
      localFreq.set(word, (localFreq.get(word) ?? 0) + 1);
    }

    // TF-IDF-like scoring: high local frequency, low vault frequency
    const scored: Array<[string, number]> = [];
    for (const [word, count] of localFreq.entries()) {
      const tf = count / words.length;
      const vaultFreq = vaultWordFreqs.get(word) ?? 1;
      const idf = 1 / Math.log2(1 + vaultFreq);
      scored.push([word, tf * idf]);
    }

    scored.sort((a, b) => b[1] - a[1]);
    return scored.slice(0, maxKeywords).map(([word]) => word);
  }

  scoreCandidate(source: NoteProfile, candidate: NoteProfile): number {
    // Exclude already-linked notes
    if (source.linkedPaths.has(candidate.path)) return 0;
    if (source.path === candidate.path) return 0;

    const tagScore = this.setOverlap(source.tags, candidate.tags);
    const titleScore = this.setOverlap(source.titleWords, candidate.titleWords);
    const keywordScore = this.setOverlap(source.keywords, candidate.keywords);
    const folderScore = source.folder === candidate.folder && source.folder !== "" ? 1 : 0;

    return (
      WEIGHTS.tagOverlap * tagScore +
      WEIGHTS.titleSimilarity * titleScore +
      WEIGHTS.keywordOverlap * keywordScore +
      WEIGHTS.folderProximity * folderScore
    );
  }

  rankCandidates(
    source: NoteProfile,
    candidates: NoteProfile[],
    config: RankingConfig,
  ): ScoredCandidate[] {
    const scored: ScoredCandidate[] = [];

    for (const candidate of candidates) {
      const score = this.scoreCandidate(source, candidate);
      if (score >= config.minScore) {
        scored.push({ profile: candidate, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, config.maxCandidates);
  }

  /** Jaccard-like overlap: |intersection| / |union|, returns 0 if both empty. */
  private setOverlap(a: string[], b: string[]): number {
    if (a.length === 0 && b.length === 0) return 0;
    const setA = new Set(a.map((s) => s.toLowerCase()));
    const setB = new Set(b.map((s) => s.toLowerCase()));
    let intersection = 0;
    for (const item of setA) {
      if (setB.has(item)) intersection++;
    }
    const union = new Set([...setA, ...setB]).size;
    return union === 0 ? 0 : intersection / union;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/modules/scoring.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/modules/connections/scoring.ts tests/modules/scoring.test.ts
git commit -m "feat: add connection candidate scorer with TF-IDF keywords and composite scoring"
```

---

## Task 14: Connection Module

**Files:**
- Create: `src/modules/connections/connections.ts`
- Test: `tests/modules/connections.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/modules/connections.test.ts
import { describe, it, expect, beforeEach } from "vitest";
import { ConnectionModule } from "@/modules/connections/connections";

describe("ConnectionModule", () => {
  let module: ConnectionModule;

  beforeEach(() => {
    module = new ConnectionModule();
  });

  describe("buildPrompt", () => {
    it("includes source note and candidate summaries", () => {
      const prompt = module.buildPrompt({
        sourceTitle: "Neural Networks",
        sourceTags: ["ai", "ml"],
        sourceSummary: "Deep learning architectures...",
        candidates: [
          { path: "backprop.md", title: "Backpropagation", tags: ["ai", "calculus"], summary: "Chain rule applied to neural nets..." },
          { path: "cooking.md", title: "Pasta Recipe", tags: ["cooking"], summary: "How to make pasta..." },
        ],
      });

      expect(prompt.prompt).toContain("Neural Networks");
      expect(prompt.prompt).toContain("backprop.md");
      expect(prompt.prompt).toContain("cooking.md");
      expect(prompt.prompt).toContain("JSON");
    });
  });

  describe("parseResponse", () => {
    it("parses connection suggestions", () => {
      const result = module.parseResponse(
        JSON.stringify({
          connections: [
            {
              path: "backprop.md",
              reason: "Backpropagation is a key training algorithm for neural networks",
            },
          ],
        }),
      );

      expect(result).toHaveLength(1);
      expect(result![0].path).toBe("backprop.md");
      expect(result![0].reason).toContain("Backpropagation");
    });

    it("returns empty array when no connections found", () => {
      const result = module.parseResponse(
        JSON.stringify({ connections: [] }),
      );
      expect(result).toEqual([]);
    });

    it("returns null for invalid response", () => {
      expect(module.parseResponse("not json")).toBeNull();
    });
  });

  describe("buildRelatedSection", () => {
    it("generates markdown for related links", () => {
      const section = module.buildRelatedSection([
        { path: "backprop.md", reason: "Training algorithm for neural nets" },
        { path: "activation.md", reason: "Activation functions used in layers" },
      ]);

      expect(section).toContain("## Related");
      expect(section).toContain("[[backprop]]");
      expect(section).toContain("[[activation]]");
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/modules/connections.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement ConnectionModule**

```typescript
// src/modules/connections/connections.ts
import { LLMRequest } from "../../llm/provider";

export interface ConnectionPromptInput {
  sourceTitle: string;
  sourceTags: string[];
  sourceSummary: string;
  candidates: Array<{
    path: string;
    title: string;
    tags: string[];
    summary: string;
  }>;
}

export interface ConnectionSuggestion {
  path: string;
  reason: string;
}

export class ConnectionModule {
  buildPrompt(input: ConnectionPromptInput): LLMRequest {
    const candidateList = input.candidates
      .map(
        (c) =>
          `### ${c.path} — "${c.title}"\nTags: ${c.tags.join(", ") || "none"}\n${c.summary}`,
      )
      .join("\n\n");

    const prompt = `Analyze whether any of the candidate notes are meaningfully related to the source note. Return only strong, non-obvious connections — not just surface-level keyword overlap.

## Source note: "${input.sourceTitle}"
Tags: ${input.sourceTags.join(", ") || "none"}
${input.sourceSummary}

## Candidates
${candidateList}

Respond with JSON: {"connections": [{"path": "note.md", "reason": "one sentence explaining the connection"}]}
If none are meaningfully related, return: {"connections": []}`;

    return {
      system:
        "You are a knowledge graph assistant. You identify meaningful connections between notes in a knowledge vault. Only suggest strong connections. Always respond with valid JSON only.",
      prompt,
      maxTokens: 500,
      temperature: 0.2,
    };
  }

  parseResponse(raw: string): ConnectionSuggestion[] | null {
    try {
      const trimmed = raw.trim();
      const json = trimmed.startsWith("{")
        ? trimmed
        : trimmed.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/)?.[1]?.trim();
      if (!json) return null;

      const parsed = JSON.parse(json);
      if (!parsed.connections || !Array.isArray(parsed.connections)) return null;

      return parsed.connections
        .filter(
          (c: any) => typeof c.path === "string" && typeof c.reason === "string",
        )
        .map((c: any) => ({ path: c.path, reason: c.reason }));
    } catch {
      return null;
    }
  }

  buildRelatedSection(connections: ConnectionSuggestion[]): string {
    const links = connections
      .map((c) => {
        const linkName = c.path.replace(/\.md$/, "");
        return `- [[${linkName}]] — ${c.reason}`;
      })
      .join("\n");

    return `\n\n## Related\n${links}\n`;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/modules/connections.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/modules/connections/connections.ts tests/modules/connections.test.ts
git commit -m "feat: add connection module with prompt building and link generation"
```

---

## Task 15: Task Aggregator

**Files:**
- Create: `src/modules/dashboard/task-aggregator.ts`
- Test: `tests/modules/task-aggregator.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/modules/task-aggregator.test.ts
import { describe, it, expect } from "vitest";
import { TaskAggregator, VaultTask } from "@/modules/dashboard/task-aggregator";

describe("TaskAggregator", () => {
  const aggregator = new TaskAggregator();

  describe("extractTasks", () => {
    it("extracts unchecked tasks from markdown", () => {
      const content = `# Project Plan
- [x] Done task
- [ ] Open task one
- [ ] Open task two
Some paragraph text.
- [ ] Another task`;

      const tasks = aggregator.extractTasks(content, "plan.md");
      expect(tasks).toHaveLength(3);
      expect(tasks[0].text).toBe("Open task one");
      expect(tasks[0].sourcePath).toBe("plan.md");
    });

    it("parses due dates from task text", () => {
      const content = "- [ ] Submit report 📅 2026-04-05";
      const tasks = aggregator.extractTasks(content, "tasks.md");
      expect(tasks[0].dueDate).toBe("2026-04-05");
      expect(tasks[0].text).toBe("Submit report");
    });

    it("handles tasks without due dates", () => {
      const content = "- [ ] No deadline here";
      const tasks = aggregator.extractTasks(content, "tasks.md");
      expect(tasks[0].dueDate).toBeNull();
    });

    it("ignores checked tasks", () => {
      const content = "- [x] Already done\n- [ ] Still open";
      const tasks = aggregator.extractTasks(content, "tasks.md");
      expect(tasks).toHaveLength(1);
      expect(tasks[0].text).toBe("Still open");
    });
  });

  describe("rankTasks", () => {
    it("sorts by due date first, then by recency", () => {
      const tasks: VaultTask[] = [
        { text: "No date", sourcePath: "a.md", dueDate: null, fileModified: 1000 },
        { text: "Far future", sourcePath: "b.md", dueDate: "2099-12-31", fileModified: 500 },
        { text: "Soon", sourcePath: "c.md", dueDate: "2026-04-03", fileModified: 500 },
      ];

      const ranked = aggregator.rankTasks(tasks);
      expect(ranked[0].text).toBe("Soon");
      expect(ranked[1].text).toBe("Far future");
      expect(ranked[2].text).toBe("No date");
    });

    it("respects topN limit", () => {
      const tasks: VaultTask[] = Array.from({ length: 20 }, (_, i) => ({
        text: `Task ${i}`,
        sourcePath: "a.md",
        dueDate: null,
        fileModified: 20 - i,
      }));

      const ranked = aggregator.rankTasks(tasks, 5);
      expect(ranked).toHaveLength(5);
    });
  });

  describe("renderTasksMarkdown", () => {
    it("renders tasks as markdown checklist with source links", () => {
      const tasks: VaultTask[] = [
        { text: "Fix bug", sourcePath: "bugs.md", dueDate: "2026-04-05", fileModified: 0 },
        { text: "Review PR", sourcePath: "work.md", dueDate: null, fileModified: 0 },
      ];

      const md = aggregator.renderTasksMarkdown(tasks);
      expect(md).toContain("- [ ] Fix bug");
      expect(md).toContain("📅 2026-04-05");
      expect(md).toContain("[[bugs]]");
      expect(md).toContain("[[work]]");
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/modules/task-aggregator.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement TaskAggregator**

```typescript
// src/modules/dashboard/task-aggregator.ts

export interface VaultTask {
  text: string;
  sourcePath: string;
  dueDate: string | null; // YYYY-MM-DD
  fileModified: number;   // timestamp for recency sorting
}

const DUE_DATE_REGEX = /📅\s*(\d{4}-\d{2}-\d{2})/;
const UNCHECKED_TASK_REGEX = /^-\s+\[\s\]\s+(.+)$/;

export class TaskAggregator {
  extractTasks(content: string, sourcePath: string, fileModified = 0): VaultTask[] {
    const tasks: VaultTask[] = [];

    for (const line of content.split("\n")) {
      const match = line.match(UNCHECKED_TASK_REGEX);
      if (!match) continue;

      let text = match[1].trim();
      let dueDate: string | null = null;

      const dateMatch = text.match(DUE_DATE_REGEX);
      if (dateMatch) {
        dueDate = dateMatch[1];
        text = text.replace(DUE_DATE_REGEX, "").trim();
      }

      tasks.push({ text, sourcePath, dueDate, fileModified });
    }

    return tasks;
  }

  rankTasks(tasks: VaultTask[], topN?: number): VaultTask[] {
    const sorted = [...tasks].sort((a, b) => {
      // Tasks with due dates first
      if (a.dueDate && !b.dueDate) return -1;
      if (!a.dueDate && b.dueDate) return 1;

      // Among dated tasks, earlier due date first
      if (a.dueDate && b.dueDate) {
        return a.dueDate.localeCompare(b.dueDate);
      }

      // Among undated tasks, more recently modified first
      return b.fileModified - a.fileModified;
    });

    return topN ? sorted.slice(0, topN) : sorted;
  }

  renderTasksMarkdown(tasks: VaultTask[]): string {
    if (tasks.length === 0) return "*No open tasks found.*\n";

    return tasks
      .map((t) => {
        const link = `[[${t.sourcePath.replace(/\.md$/, "")}]]`;
        const date = t.dueDate ? ` 📅 ${t.dueDate}` : "";
        return `- [ ] ${t.text}${date} *(${link})*`;
      })
      .join("\n") + "\n";
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/modules/task-aggregator.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/modules/dashboard/task-aggregator.ts tests/modules/task-aggregator.test.ts
git commit -m "feat: add task aggregator with due date parsing and ranking"
```

---

## Task 16: Habit Tracker

**Files:**
- Create: `src/modules/dashboard/habits.ts`
- Test: `tests/modules/habits.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/modules/habits.test.ts
import { describe, it, expect } from "vitest";
import { HabitTracker, Habit, HabitLog } from "@/modules/dashboard/habits";

describe("HabitTracker", () => {
  const tracker = new HabitTracker();

  describe("parseHabitsConfig", () => {
    it("parses habits from markdown list", () => {
      const config = `# My Habits
- Exercise (daily)
- Read 30 min (daily)
- Weekly review (weekly)
`;
      const habits = tracker.parseHabitsConfig(config);
      expect(habits).toEqual([
        { name: "Exercise", frequency: "daily" },
        { name: "Read 30 min", frequency: "daily" },
        { name: "Weekly review", frequency: "weekly" },
      ]);
    });

    it("defaults to daily if no frequency specified", () => {
      const habits = tracker.parseHabitsConfig("- Meditate\n");
      expect(habits[0].frequency).toBe("daily");
    });

    it("handles empty config", () => {
      expect(tracker.parseHabitsConfig("")).toEqual([]);
    });
  });

  describe("logCompletion / getLog", () => {
    it("records and retrieves habit completions", () => {
      const log: HabitLog = {};
      const updated = tracker.logCompletion(log, "Exercise", "2026-04-02");
      expect(updated["Exercise"]).toContain("2026-04-02");
    });

    it("does not duplicate completions for same day", () => {
      let log: HabitLog = {};
      log = tracker.logCompletion(log, "Exercise", "2026-04-02");
      log = tracker.logCompletion(log, "Exercise", "2026-04-02");
      expect(log["Exercise"].filter((d) => d === "2026-04-02")).toHaveLength(1);
    });
  });

  describe("calculateStreak", () => {
    it("counts consecutive days", () => {
      const completions = ["2026-04-01", "2026-04-02", "2026-04-03"];
      expect(tracker.calculateStreak(completions, "2026-04-03")).toBe(3);
    });

    it("breaks streak on gap", () => {
      const completions = ["2026-04-01", "2026-04-03"];
      expect(tracker.calculateStreak(completions, "2026-04-03")).toBe(1);
    });

    it("returns 0 if not completed today", () => {
      const completions = ["2026-04-01", "2026-04-02"];
      expect(tracker.calculateStreak(completions, "2026-04-04")).toBe(0);
    });
  });

  describe("renderStreakGrid", () => {
    it("renders last 7 days as grid", () => {
      const completions = ["2026-03-28", "2026-03-29", "2026-03-31", "2026-04-01", "2026-04-02"];
      const grid = tracker.renderStreakGrid(completions, "2026-04-02", 7);
      // Last 7 days: Mar 27-Apr 2
      // Mar 27: miss, Mar 28: hit, Mar 29: hit, Mar 30: miss, Mar 31: hit, Apr 1: hit, Apr 2: hit
      expect(grid).toBe("[ ][x][x][ ][x][x][x]");
    });
  });

  describe("renderHabitsMarkdown", () => {
    it("renders habit table with streaks", () => {
      const habits: Habit[] = [
        { name: "Exercise", frequency: "daily" },
        { name: "Read", frequency: "daily" },
      ];
      const log: HabitLog = {
        Exercise: ["2026-04-01", "2026-04-02"],
        Read: ["2026-04-02"],
      };

      const md = tracker.renderHabitsMarkdown(habits, log, "2026-04-02");
      expect(md).toContain("Exercise");
      expect(md).toContain("Read");
      expect(md).toContain("[x]");
    });
  });

  describe("serializeLog / deserializeLog", () => {
    it("round-trips through JSON", () => {
      const log: HabitLog = {
        Exercise: ["2026-04-01", "2026-04-02"],
        Read: ["2026-04-02"],
      };

      const json = tracker.serializeLog(log);
      const restored = tracker.deserializeLog(json);
      expect(restored).toEqual(log);
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/modules/habits.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement HabitTracker**

```typescript
// src/modules/dashboard/habits.ts

export interface Habit {
  name: string;
  frequency: "daily" | "weekly";
}

/** Map of habit name → sorted array of completion dates (YYYY-MM-DD). */
export type HabitLog = Record<string, string[]>;

const HABIT_REGEX = /^-\s+(.+?)(?:\s+\((daily|weekly)\))?\s*$/;

export class HabitTracker {
  parseHabitsConfig(content: string): Habit[] {
    const habits: Habit[] = [];
    for (const line of content.split("\n")) {
      const match = line.match(HABIT_REGEX);
      if (match) {
        habits.push({
          name: match[1].trim(),
          frequency: (match[2] as Habit["frequency"]) ?? "daily",
        });
      }
    }
    return habits;
  }

  logCompletion(log: HabitLog, habitName: string, date: string): HabitLog {
    const existing = log[habitName] ?? [];
    if (existing.includes(date)) return log;
    return {
      ...log,
      [habitName]: [...existing, date].sort(),
    };
  }

  calculateStreak(completions: string[], today: string): number {
    if (!completions.includes(today)) return 0;

    let streak = 1;
    let current = this.prevDay(today);

    while (completions.includes(current)) {
      streak++;
      current = this.prevDay(current);
    }

    return streak;
  }

  renderStreakGrid(completions: string[], today: string, days: number): string {
    const completionSet = new Set(completions);
    const cells: string[] = [];

    for (let i = days - 1; i >= 0; i--) {
      const date = this.daysAgo(today, i);
      cells.push(completionSet.has(date) ? "[x]" : "[ ]");
    }

    return cells.join("");
  }

  renderHabitsMarkdown(habits: Habit[], log: HabitLog, today: string): string {
    if (habits.length === 0) return "*No habits defined. Edit `AI-Assistant/habits.md` to add some.*\n";

    const lines = habits.map((h) => {
      const completions = log[h.name] ?? [];
      const streak = this.calculateStreak(completions, today);
      const grid = this.renderStreakGrid(completions, today, 7);
      return `| ${h.name} | ${grid} | ${streak} day${streak !== 1 ? "s" : ""} |`;
    });

    return `| Habit | Last 7 Days | Streak |
|-------|-------------|--------|
${lines.join("\n")}
`;
  }

  serializeLog(log: HabitLog): string {
    return JSON.stringify(log, null, 2);
  }

  deserializeLog(json: string): HabitLog {
    try {
      return JSON.parse(json);
    } catch {
      return {};
    }
  }

  private prevDay(dateStr: string): string {
    const date = new Date(dateStr + "T00:00:00");
    date.setDate(date.getDate() - 1);
    return date.toISOString().split("T")[0];
  }

  private daysAgo(today: string, n: number): string {
    const date = new Date(today + "T00:00:00");
    date.setDate(date.getDate() - n);
    return date.toISOString().split("T")[0];
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/modules/habits.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/modules/dashboard/habits.ts tests/modules/habits.test.ts
git commit -m "feat: add habit tracker with streak calculation and grid rendering"
```

---

## Task 17: Dashboard Module

**Files:**
- Create: `src/modules/dashboard/dashboard.ts`
- Test: `tests/modules/dashboard.test.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// tests/modules/dashboard.test.ts
import { describe, it, expect } from "vitest";
import { DashboardModule } from "@/modules/dashboard/dashboard";

describe("DashboardModule", () => {
  const dashboard = new DashboardModule();

  describe("renderDashboard", () => {
    it("generates markdown with all sections", () => {
      const md = dashboard.renderDashboard({
        goalsContent: "- Learn Rust\n- Ship the plugin",
        tasksMarkdown: "- [ ] Fix bug *(plan)*\n",
        habitsMarkdown: "| Exercise | [x][x] | 2 days |",
        recentActivity: [
          { path: "new-note.md", action: "created", date: "2026-04-02" },
          { path: "old-note.md", action: "tagged", date: "2026-04-01" },
        ],
        pendingSuggestions: 3,
        failedTasks: 1,
      });

      expect(md).toContain("<!-- AI-Assistant: auto-generated");
      expect(md).toContain("## Goals");
      expect(md).toContain("Learn Rust");
      expect(md).toContain("## Active Tasks");
      expect(md).toContain("Fix bug");
      expect(md).toContain("## Habits");
      expect(md).toContain("Exercise");
      expect(md).toContain("## Recent Activity");
      expect(md).toContain("new-note.md");
      expect(md).toContain("3 pending suggestions");
      expect(md).toContain("1 failed task");
    });

    it("handles empty goals gracefully", () => {
      const md = dashboard.renderDashboard({
        goalsContent: "",
        tasksMarkdown: "",
        habitsMarkdown: "",
        recentActivity: [],
        pendingSuggestions: 0,
        failedTasks: 0,
      });

      expect(md).toContain("## Goals");
      expect(md).toContain("Edit `AI-Assistant/goals.md`");
    });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- tests/modules/dashboard.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement DashboardModule**

```typescript
// src/modules/dashboard/dashboard.ts

export interface ActivityEntry {
  path: string;
  action: string;
  date: string;
}

export interface DashboardInput {
  goalsContent: string;
  tasksMarkdown: string;
  habitsMarkdown: string;
  recentActivity: ActivityEntry[];
  pendingSuggestions: number;
  failedTasks: number;
}

export class DashboardModule {
  renderDashboard(input: DashboardInput): string {
    const sections: string[] = [];

    sections.push(
      "<!-- AI-Assistant: auto-generated dashboard. Do not edit manually — changes will be overwritten. -->",
    );
    sections.push("# Dashboard\n");

    // Status line
    const statusParts: string[] = [];
    if (input.pendingSuggestions > 0) {
      statusParts.push(`${input.pendingSuggestions} pending suggestion${input.pendingSuggestions !== 1 ? "s" : ""} to review`);
    }
    if (input.failedTasks > 0) {
      statusParts.push(`${input.failedTasks} failed task${input.failedTasks !== 1 ? "s" : ""} (run "Retry failed tasks" from command palette)`);
    }
    if (statusParts.length > 0) {
      sections.push(`> ${statusParts.join(" | ")}\n`);
    }

    // Goals
    sections.push("## Goals\n");
    if (input.goalsContent.trim()) {
      sections.push(input.goalsContent.trim() + "\n");
    } else {
      sections.push("*No goals set. Edit `AI-Assistant/goals.md` to add your goals.*\n");
    }

    // Active Tasks
    sections.push("## Active Tasks\n");
    sections.push(input.tasksMarkdown || "*No open tasks found.*\n");

    // Habits
    sections.push("## Habits\n");
    sections.push(input.habitsMarkdown || "*No habits defined. Edit `AI-Assistant/habits.md` to add some.*\n");

    // Recent Activity
    sections.push("## Recent Activity\n");
    if (input.recentActivity.length > 0) {
      for (const entry of input.recentActivity) {
        sections.push(`- **${entry.date}** — ${entry.path} (${entry.action})`);
      }
      sections.push("");
    } else {
      sections.push("*No recent activity.*\n");
    }

    return sections.join("\n");
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- tests/modules/dashboard.test.ts`
Expected: All tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/modules/dashboard/dashboard.ts tests/modules/dashboard.test.ts
git commit -m "feat: add dashboard module with goals, tasks, habits, and activity rendering"
```

---

## Task 18: UI Components

**Files:**
- Create: `src/ui/suggestion-modal.ts`, `src/ui/notices.ts`

These are thin Obsidian UI wrappers that we verify manually, not with automated tests.

- [ ] **Step 1: Create src/ui/notices.ts**

```typescript
import { Notice } from "obsidian";

export function showNotice(message: string, durationMs = 5000): void {
  new Notice(message, durationMs);
}

export function showCostWarning(message: string): void {
  new Notice(`⚠️ ${message}`, 8000);
}

export function showClickableNotice(
  message: string,
  onClick: () => void,
  durationMs = 8000,
): void {
  const notice = new Notice(message, durationMs);
  // Obsidian Notice doesn't natively support click handlers,
  // but we can extend via the DOM element
  const el = (notice as any).noticeEl;
  if (el) {
    el.style.cursor = "pointer";
    el.addEventListener("click", () => {
      onClick();
      notice.hide();
    });
  }
}
```

- [ ] **Step 2: Create src/ui/suggestion-modal.ts**

```typescript
import { App, Modal } from "obsidian";

export interface SuggestionItem {
  label: string;
  description?: string;
}

export interface SuggestionResult {
  accepted: string[];
  rejected: string[];
}

export class SuggestionModal extends Modal {
  private items: SuggestionItem[];
  private decisions: Map<string, boolean> = new Map();
  private onSubmit: (result: SuggestionResult) => void;
  private title: string;

  constructor(
    app: App,
    title: string,
    items: SuggestionItem[],
    onSubmit: (result: SuggestionResult) => void,
  ) {
    super(app);
    this.title = title;
    this.items = items;
    this.onSubmit = onSubmit;
    // Default all to accepted
    for (const item of items) {
      this.decisions.set(item.label, true);
    }
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: this.title });

    for (const item of this.items) {
      const row = contentEl.createDiv({ cls: "suggestion-row" });
      row.style.display = "flex";
      row.style.alignItems = "center";
      row.style.marginBottom = "8px";

      const checkbox = row.createEl("input", { type: "checkbox" });
      (checkbox as HTMLInputElement).checked = true;
      checkbox.addEventListener("change", () => {
        this.decisions.set(item.label, (checkbox as HTMLInputElement).checked);
      });

      const label = row.createDiv();
      label.style.marginLeft = "8px";
      label.createEl("strong", { text: item.label });
      if (item.description) {
        label.createEl("div", {
          text: item.description,
          cls: "setting-item-description",
        });
      }
    }

    const buttonRow = contentEl.createDiv();
    buttonRow.style.marginTop = "16px";
    buttonRow.style.display = "flex";
    buttonRow.style.justifyContent = "flex-end";
    buttonRow.style.gap = "8px";

    const cancelBtn = buttonRow.createEl("button", { text: "Cancel" });
    cancelBtn.addEventListener("click", () => this.close());

    const submitBtn = buttonRow.createEl("button", {
      text: "Apply",
      cls: "mod-cta",
    });
    submitBtn.addEventListener("click", () => {
      const accepted: string[] = [];
      const rejected: string[] = [];
      for (const [label, isAccepted] of this.decisions) {
        if (isAccepted) {
          accepted.push(label);
        } else {
          rejected.push(label);
        }
      }
      this.onSubmit({ accepted, rejected });
      this.close();
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}
```

- [ ] **Step 3: Verify build compiles**

Run: `npm run build`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add src/ui/notices.ts src/ui/suggestion-modal.ts
git commit -m "feat: add suggestion modal and notice helpers for UI interactions"
```

---

## Task 19: Plugin Main — Vault Initialization & Commands

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Implement the full plugin entry point**

```typescript
// src/main.ts
import { Plugin, TFile, MarkdownView } from "obsidian";
import { PluginSettings, DEFAULT_SETTINGS, AssistantSettingTab } from "./settings";
import { ASSISTANT_FOLDER, DEFAULT_TAG_STYLE_GUIDE, ModelRequirement, TaskTrigger } from "./types";
import { OllamaProvider } from "./llm/ollama";
import { ClaudeProvider } from "./llm/claude";
import { VaultService } from "./vault/vault-service";
import { TaskQueue } from "./orchestrator/queue";
import { TaskRouter } from "./orchestrator/router";
import { TaskBatcher } from "./orchestrator/batcher";
import { CostTracker } from "./orchestrator/cost-tracker";
import { Orchestrator } from "./orchestrator/orchestrator";
import { createTask } from "./orchestrator/task";
import { TaggerModule } from "./modules/tagger/tagger";
import { TagAuditModule } from "./modules/tagger/tag-audit";
import { CandidateScorer } from "./modules/connections/scoring";
import { ConnectionModule } from "./modules/connections/connections";
import { TaskAggregator } from "./modules/dashboard/task-aggregator";
import { HabitTracker } from "./modules/dashboard/habits";
import { DashboardModule } from "./modules/dashboard/dashboard";
import { SuggestionModal } from "./ui/suggestion-modal";
import { showNotice, showCostWarning, showClickableNotice } from "./ui/notices";

export default class AssistantPlugin extends Plugin {
  settings: PluginSettings = DEFAULT_SETTINGS;
  private vaultService!: VaultService;
  private orchestrator!: Orchestrator;
  private tagger = new TaggerModule();
  private tagAudit = new TagAuditModule();
  private scorer = new CandidateScorer();
  private connections = new ConnectionModule();
  private taskAggregator = new TaskAggregator();
  private habitTracker = new HabitTracker();
  private dashboard = new DashboardModule();
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();

  async onload(): Promise<void> {
    await this.loadSettings();
    this.vaultService = new VaultService(this.app);

    const ollama = new OllamaProvider(
      this.settings.ollamaEndpoint,
      this.settings.ollamaModel,
    );
    const claude = new ClaudeProvider(
      this.settings.claudeApiKey,
      this.settings.claudeModel,
    );

    // Load persisted state
    const queue = await this.loadQueue();
    const costTracker = await this.loadCostTracker();
    queue.recoverOnStartup();

    const router = new TaskRouter(
      ollama,
      claude,
      this.settings.localFallbackToClaude,
    );
    const batcher = new TaskBatcher({
      maxBatchSize: 10,
      contextWindowTokens: 8000,
    });

    this.orchestrator = new Orchestrator({
      queue,
      router,
      batcher,
      costTracker,
      providers: { ollama, claude },
      settings: {
        claudeDailyBudget: this.settings.claudeDailyBudget,
        claudeMonthlyBudget: this.settings.claudeMonthlyBudget,
      },
      onTaskCompleted: (task, response) => this.handleTaskCompleted(task, response),
      onTaskFailed: (task, error) => showNotice(`Task failed: ${error}`),
      onTaskDeferred: (task, reason) => showNotice(`Task deferred: ${reason}`),
      onCostWarning: (msg) => showCostWarning(msg),
    });

    // Initialize vault folder structure
    await this.initializeVaultFolder();

    // Register commands
    this.addCommand({
      id: "tag-this-note",
      name: "Tag this note",
      callback: () => this.tagCurrentNote(),
    });

    this.addCommand({
      id: "tag-all-untagged",
      name: "Tag all untagged notes",
      callback: () => this.tagAllUntagged(),
    });

    this.addCommand({
      id: "audit-tags",
      name: "Audit tags",
      callback: () => this.auditTags(),
    });

    this.addCommand({
      id: "find-connections",
      name: "Find connections for this note",
      callback: () => this.findConnectionsForCurrentNote(),
    });

    this.addCommand({
      id: "scan-vault-connections",
      name: "Scan vault for connections",
      callback: () => this.scanVaultConnections(),
    });

    this.addCommand({
      id: "update-dashboard",
      name: "Update dashboard",
      callback: () => this.updateDashboard(),
    });

    this.addCommand({
      id: "log-habit",
      name: "Log habit",
      callback: () => this.logHabit(),
    });

    this.addCommand({
      id: "retry-failed-tasks",
      name: "Retry failed tasks",
      callback: () => this.retryFailedTasks(),
    });

    // Settings tab
    this.addSettingTab(
      new AssistantSettingTab(this.app, this, this.settings, async (s) => {
        this.settings = s;
        await this.saveSettings();
      }),
    );

    // Auto-triggers
    if (this.settings.autoTagOnSave) {
      this.registerEvent(
        this.app.vault.on("modify", (file) => {
          if (file instanceof TFile && file.extension === "md") {
            this.debounceTagNote(file.path, 5000);
          }
        }),
      );
    }

    if (this.settings.autoTagOnStartup) {
      // Delay to let vault fully load
      setTimeout(() => this.tagAllUntagged(), 5000);
    }

    if (this.settings.autoConnectionScan) {
      this.registerInterval(
        window.setInterval(
          () => this.scanRecentConnections(),
          this.settings.connectionScanIntervalMin * 60 * 1000,
        ),
      );
    }

    if (this.settings.autoDashboardRefresh) {
      this.registerInterval(
        window.setInterval(
          () => this.updateDashboard(),
          this.settings.dashboardRefreshIntervalHours * 60 * 60 * 1000,
        ),
      );
      // Also on startup
      setTimeout(() => this.updateDashboard(), 10000);
    }

    // Process queue periodically
    this.registerInterval(
      window.setInterval(() => this.orchestrator.processNext(), 3000),
    );
  }

  async onunload(): Promise<void> {
    await this.saveQueue();
    await this.saveCostTracker();
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
  }

  // --- Settings persistence ---

  private async loadSettings(): Promise<void> {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  private async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
    this.orchestrator.updateSettings({
      claudeDailyBudget: this.settings.claudeDailyBudget,
      claudeMonthlyBudget: this.settings.claudeMonthlyBudget,
    });
  }

  // --- Queue / Cost persistence ---

  private async loadQueue(): Promise<TaskQueue> {
    const content = await this.vaultService.readNote(`${ASSISTANT_FOLDER}/queue.json`);
    if (content) {
      try { return TaskQueue.deserialize(content); } catch { /* start fresh */ }
    }
    return new TaskQueue();
  }

  private async saveQueue(): Promise<void> {
    await this.vaultService.writeNote(
      `${ASSISTANT_FOLDER}/queue.json`,
      this.orchestrator.queue.serialize(),
    );
  }

  private async loadCostTracker(): Promise<CostTracker> {
    const content = await this.vaultService.readNote(`${ASSISTANT_FOLDER}/usage.json`);
    if (content) {
      try { return CostTracker.deserialize(content); } catch { /* start fresh */ }
    }
    return new CostTracker();
  }

  private async saveCostTracker(): Promise<void> {
    await this.vaultService.writeNote(
      `${ASSISTANT_FOLDER}/usage.json`,
      this.orchestrator.costTracker.serialize(),
    );
  }

  // --- Vault initialization ---

  private async initializeVaultFolder(): Promise<void> {
    const folder = ASSISTANT_FOLDER;

    if (!this.vaultService.noteExists(`${folder}/tag-config.md`)) {
      await this.vaultService.writeNote(`${folder}/tag-config.md`, DEFAULT_TAG_STYLE_GUIDE);
    }
    if (!this.vaultService.noteExists(`${folder}/goals.md`)) {
      await this.vaultService.writeNote(
        `${folder}/goals.md`,
        "# Goals\n\n- Add your goals here\n",
      );
    }
    if (!this.vaultService.noteExists(`${folder}/habits.md`)) {
      await this.vaultService.writeNote(
        `${folder}/habits.md`,
        "# Habits\n\n- Exercise (daily)\n- Read 30 min (daily)\n",
      );
    }
    if (!this.vaultService.noteExists(`${folder}/habit-log.md`)) {
      await this.vaultService.writeNote(`${folder}/habit-log.md`, "{}");
    }
  }

  // --- Tagger commands ---

  private debounceTagNote(path: string, delayMs: number): void {
    const existing = this.debounceTimers.get(path);
    if (existing) clearTimeout(existing);

    this.debounceTimers.set(
      path,
      setTimeout(() => {
        this.debounceTimers.delete(path);
        this.enqueueTagNote(path, TaskTrigger.Automatic);
      }, delayMs),
    );
  }

  private async tagCurrentNote(): Promise<void> {
    const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
    if (!file) {
      showNotice("No active note to tag.");
      return;
    }
    await this.enqueueTagNote(file.path, TaskTrigger.Manual);
    showNotice(`Queued tagging for ${file.basename}`);
  }

  private async enqueueTagNote(path: string, trigger: TaskTrigger): Promise<void> {
    const content = await this.vaultService.readNote(path);
    if (content === null) return;

    const fm = await this.vaultService.parseFrontmatter(path);
    // Skip if already has suggested-tags pending review
    if (fm["suggested-tags"]?.length > 0) return;

    const existingTags = await this.vaultService.getAllTags();
    const rejectedTags = fm["rejected-tags"] ?? [];
    const styleGuide =
      (await this.vaultService.readNote(`${ASSISTANT_FOLDER}/tag-config.md`)) ?? "";

    const prompt = this.tagger.buildPrompt({
      noteContent: content,
      existingTags,
      rejectedTags,
      styleGuide,
    });

    const task = createTask({
      type: "tagger",
      action: "tag-note",
      payload: {
        notePath: path,
        noteContent: content,
        systemPrompt: prompt.system,
        prompt: prompt.prompt,
        maxTokens: prompt.maxTokens,
      },
      modelRequirement: ModelRequirement.LocalPreferred,
      trigger,
    });

    this.orchestrator.queue.enqueue(task);
  }

  private async tagAllUntagged(): Promise<void> {
    const untagged = await this.vaultService.getUntaggedNotes();
    if (untagged.length === 0) {
      showNotice("No untagged notes found.");
      return;
    }

    for (const file of untagged) {
      await this.enqueueTagNote(file.path, TaskTrigger.Automatic);
    }
    showNotice(`Queued tagging for ${untagged.length} untagged notes.`);
  }

  private async auditTags(): Promise<void> {
    const allTags = await this.vaultService.getAllTags();
    if (allTags.length === 0) {
      showNotice("No tags found in vault.");
      return;
    }

    const prompt = this.tagAudit.buildAuditPrompt(allTags);
    const task = createTask({
      type: "tagger",
      action: "audit-tags",
      payload: {
        allTags,
        systemPrompt: prompt.system,
        prompt: prompt.prompt,
        maxTokens: prompt.maxTokens,
      },
      modelRequirement: ModelRequirement.ClaudeRequired,
      trigger: TaskTrigger.Manual,
    });

    this.orchestrator.queue.enqueue(task);
    showNotice("Tag audit queued.");
  }

  // --- Connection commands ---

  private async findConnectionsForCurrentNote(): Promise<void> {
    const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
    if (!file) {
      showNotice("No active note.");
      return;
    }
    await this.enqueueConnectionScan(file.path, TaskTrigger.Manual);
    showNotice(`Queued connection scan for ${file.basename}`);
  }

  private async scanVaultConnections(): Promise<void> {
    const files = this.vaultService.getMarkdownFiles();
    for (const file of files) {
      await this.enqueueConnectionScan(file.path, TaskTrigger.Automatic);
    }
    showNotice(`Queued connection scan for ${files.length} notes.`);
  }

  private async scanRecentConnections(): Promise<void> {
    const now = Date.now();
    const intervalMs = this.settings.connectionScanIntervalMin * 60 * 1000;
    const files = this.vaultService.getMarkdownFiles().filter(
      (f) => now - f.stat.mtime < intervalMs,
    );
    for (const file of files) {
      await this.enqueueConnectionScan(file.path, TaskTrigger.Automatic);
    }
  }

  /** Score candidates and build prompt before enqueuing, so the orchestrator just does the LLM call. */
  private async enqueueConnectionScan(notePath: string, trigger: TaskTrigger): Promise<void> {
    const content = await this.vaultService.readNote(notePath);
    if (!content) return;

    const fm = await this.vaultService.parseFrontmatter(notePath);
    const sourceTags = fm.tags ?? [];
    const titleWords = notePath.replace(/\.md$/, "").split(/[\s\-_\/]+/);
    const folder = notePath.includes("/") ? notePath.split("/").slice(0, -1).join("/") : "";

    // Build vault word frequency map for TF-IDF
    const vaultWordFreqs = new Map<string, number>();
    for (const file of this.vaultService.getMarkdownFiles()) {
      const text = await this.vaultService.readNote(file.path);
      if (!text) continue;
      const words = text.toLowerCase().replace(/[^a-z0-9\s-]/g, " ").split(/\s+/);
      for (const w of words) {
        if (w.length > 2) vaultWordFreqs.set(w, (vaultWordFreqs.get(w) ?? 0) + 1);
      }
    }

    const keywords = this.scorer.extractKeywords(content, vaultWordFreqs);

    // Extract existing links from content
    const linkMatches = content.matchAll(/\[\[([^\]]+)\]\]/g);
    const linkedPaths = new Set<string>();
    for (const m of linkMatches) {
      linkedPaths.add(m[1] + ".md");
      linkedPaths.add(m[1]); // handle both with and without .md
    }

    const sourceProfile = { path: notePath, tags: sourceTags, titleWords, keywords, folder, linkedPaths };

    // Build profiles for all other notes
    const candidateProfiles = [];
    for (const file of this.vaultService.getMarkdownFiles()) {
      if (file.path === notePath) continue;
      const cFm = await this.vaultService.parseFrontmatter(file.path);
      const cContent = await this.vaultService.readNote(file.path);
      candidateProfiles.push({
        path: file.path,
        tags: cFm.tags ?? [],
        titleWords: file.basename.split(/[\s\-_]+/),
        keywords: this.scorer.extractKeywords(cContent ?? "", vaultWordFreqs),
        folder: file.path.includes("/") ? file.path.split("/").slice(0, -1).join("/") : "",
        linkedPaths: new Set<string>(),
      });
    }

    // Score and rank
    const ranked = this.scorer.rankCandidates(sourceProfile, candidateProfiles, {
      maxCandidates: 10,
      minScore: 0.15,
    });

    if (ranked.length === 0) return; // No candidates worth asking the LLM about

    // Build prompt with candidate summaries
    const candidateSummaries = [];
    for (const r of ranked) {
      const cContent = await this.vaultService.readNote(r.profile.path);
      const summary = (cContent ?? "").slice(0, 400); // First 100 words ≈ 400 chars
      candidateSummaries.push({
        path: r.profile.path,
        title: r.profile.path.replace(/\.md$/, "").split("/").pop() ?? "",
        tags: r.profile.tags,
        summary,
      });
    }

    const prompt = this.connections.buildPrompt({
      sourceTitle: notePath.replace(/\.md$/, "").split("/").pop() ?? "",
      sourceTags,
      sourceSummary: content.slice(0, 400),
      candidates: candidateSummaries,
    });

    const task = createTask({
      type: "connection-detector",
      action: "scan-connections",
      payload: {
        notePath,
        systemPrompt: prompt.system,
        prompt: prompt.prompt,
        maxTokens: prompt.maxTokens,
      },
      modelRequirement: ModelRequirement.LocalPreferred,
      trigger,
    });

    this.orchestrator.queue.enqueue(task);
  }

  // --- Dashboard commands ---

  private async updateDashboard(): Promise<void> {
    const goalsContent =
      (await this.vaultService.readNote(`${ASSISTANT_FOLDER}/goals.md`)) ?? "";
    const habitsContent =
      (await this.vaultService.readNote(`${ASSISTANT_FOLDER}/habits.md`)) ?? "";
    const habitLogJson =
      (await this.vaultService.readNote(`${ASSISTANT_FOLDER}/habit-log.md`)) ?? "{}";

    const habits = this.habitTracker.parseHabitsConfig(habitsContent);
    const habitLog = this.habitTracker.deserializeLog(habitLogJson);
    const today = new Date().toISOString().split("T")[0];

    // Aggregate tasks from vault
    const allTasks = [];
    for (const file of this.vaultService.getMarkdownFiles()) {
      const content = await this.vaultService.readNote(file.path);
      if (content) {
        allTasks.push(
          ...this.taskAggregator.extractTasks(content, file.path, file.stat.mtime),
        );
      }
    }
    const rankedTasks = this.taskAggregator.rankTasks(allTasks, 15);

    const md = this.dashboard.renderDashboard({
      goalsContent,
      tasksMarkdown: this.taskAggregator.renderTasksMarkdown(rankedTasks),
      habitsMarkdown: this.habitTracker.renderHabitsMarkdown(habits, habitLog, today),
      recentActivity: [], // TODO: pull from queue completed tasks
      pendingSuggestions: 0,
      failedTasks: this.orchestrator.queue.getFailedTasks().length,
    });

    await this.vaultService.writeNote(this.settings.dashboardPath, md);
  }

  // --- Habit commands ---

  private async logHabit(): Promise<void> {
    const habitsContent =
      (await this.vaultService.readNote(`${ASSISTANT_FOLDER}/habits.md`)) ?? "";
    const habits = this.habitTracker.parseHabitsConfig(habitsContent);

    if (habits.length === 0) {
      showNotice("No habits defined. Edit AI-Assistant/habits.md to add some.");
      return;
    }

    const today = new Date().toISOString().split("T")[0];
    const habitLogJson =
      (await this.vaultService.readNote(`${ASSISTANT_FOLDER}/habit-log.md`)) ?? "{}";
    let habitLog = this.habitTracker.deserializeLog(habitLogJson);

    new SuggestionModal(
      this.app,
      `Log habits for ${today}`,
      habits.map((h) => ({
        label: h.name,
        description: `${h.frequency} — ${(habitLog[h.name] ?? []).includes(today) ? "already logged today" : "not yet logged"}`,
      })),
      async (result) => {
        for (const name of result.accepted) {
          habitLog = this.habitTracker.logCompletion(habitLog, name, today);
        }
        await this.vaultService.writeNote(
          `${ASSISTANT_FOLDER}/habit-log.md`,
          this.habitTracker.serializeLog(habitLog),
        );
        showNotice(`Logged ${result.accepted.length} habit(s).`);
      },
    ).open();
  }

  // --- Task completion handlers ---

  private async handleTaskCompleted(task: any, response: any): Promise<void> {
    switch (task.action) {
      case "tag-note":
        await this.handleTagResult(task, response);
        break;
      case "audit-tags":
        await this.handleAuditResult(task, response);
        break;
      case "scan-connections":
        await this.handleConnectionResult(task, response);
        break;
    }

    // Persist state after each completion
    await this.saveQueue();
    await this.saveCostTracker();
  }

  private async handleTagResult(task: any, response: any): Promise<void> {
    const result = this.tagger.parseResponse(response.content);
    if (!result || result.tags.length === 0) return;

    const notePath = task.payload.notePath;
    if (!this.vaultService.noteExists(notePath)) return;

    await this.vaultService.updateFrontmatter(notePath, {
      "suggested-tags": result.tags,
    });

    showClickableNotice(
      `${result.tags.length} tags suggested for ${notePath} — click to review`,
      () => {
        new SuggestionModal(
          this.app,
          `Suggested tags for ${notePath}`,
          result.tags.map((t) => ({ label: t })),
          async (decision) => {
            const fm = await this.vaultService.parseFrontmatter(notePath);
            const existingTags = fm.tags ?? [];
            const existingRejected = fm["rejected-tags"] ?? [];

            await this.vaultService.updateFrontmatter(notePath, {
              tags: [...existingTags, ...decision.accepted],
              "rejected-tags":
                decision.rejected.length > 0
                  ? [...existingRejected, ...decision.rejected]
                  : existingRejected.length > 0
                    ? existingRejected
                    : undefined,
              "suggested-tags": undefined,
              "ai-tagged": decision.accepted.length > 0 ? true : undefined,
            });
            showNotice(
              `Applied ${decision.accepted.length} tags, rejected ${decision.rejected.length}.`,
            );
          },
        ).open();
      },
    );
  }

  private async handleAuditResult(task: any, response: any): Promise<void> {
    const suggestions = this.tagAudit.parseAuditResponse(response.content);
    if (!suggestions || suggestions.length === 0) {
      showNotice("Tag audit complete — no changes suggested.");
      return;
    }

    showNotice(`Tag audit found ${suggestions.length} suggested merges. Opening review...`);

    // Build tag index: tag → files containing it
    const tagIndex: Record<string, string[]> = {};
    for (const file of this.vaultService.getMarkdownFiles()) {
      const fm = await this.vaultService.parseFrontmatter(file.path);
      const tags = fm.tags ?? [];
      for (const tag of tags) {
        if (!tagIndex[tag]) tagIndex[tag] = [];
        tagIndex[tag].push(file.path);
      }
    }

    new SuggestionModal(
      this.app,
      "Tag Audit — Review Merges",
      suggestions.map((s) => ({
        label: `${s.tags.join(", ")} → ${s.into}`,
        description: `${s.reason} (${this.tagAudit.computeAffectedFiles(s, tagIndex).length} files affected)`,
      })),
      async (decision) => {
        // Create backup before making changes
        const today = new Date().toISOString().split("T")[0];
        const backupFolder = `${ASSISTANT_FOLDER}/backups/tag-audit-${today}`;

        const allAffectedFiles = new Set<string>();
        for (const label of decision.accepted) {
          const suggestion = suggestions.find(
            (s) => `${s.tags.join(", ")} → ${s.into}` === label,
          );
          if (!suggestion) continue;
          for (const f of this.tagAudit.computeAffectedFiles(suggestion, tagIndex)) {
            allAffectedFiles.add(f);
          }
        }

        // Backup affected files
        for (const filePath of allAffectedFiles) {
          const content = await this.vaultService.readNote(filePath);
          if (content !== null) {
            await this.vaultService.writeNote(`${backupFolder}/${filePath}`, content);
          }
        }

        // Apply merges
        for (const label of decision.accepted) {
          const suggestion = suggestions.find(
            (s) => `${s.tags.join(", ")} → ${s.into}` === label,
          );
          if (!suggestion) continue;

          const affected = this.tagAudit.computeAffectedFiles(suggestion, tagIndex);
          for (const filePath of affected) {
            const fm = await this.vaultService.parseFrontmatter(filePath);
            const tags: string[] = fm.tags ?? [];
            const newTags = tags.map((t) =>
              suggestion.tags.includes(t) && t !== suggestion.into
                ? suggestion.into
                : t,
            );
            const unique = [...new Set(newTags)];
            await this.vaultService.updateFrontmatter(filePath, { tags: unique });
          }
        }
        showNotice(`Applied ${decision.accepted.length} tag merges. Backup saved to ${backupFolder}/`);
      },
    ).open();
  }

  private async handleConnectionResult(task: any, response: any): Promise<void> {
    const suggestions = this.connections.parseResponse(response.content);
    if (!suggestions || suggestions.length === 0) return;

    const notePath = task.payload.notePath;
    showClickableNotice(
      `${suggestions.length} connections found for ${notePath} — click to review`,
      () => {
        new SuggestionModal(
          this.app,
          `Suggested connections for ${notePath}`,
          suggestions.map((s) => ({
            label: s.path.replace(/\.md$/, ""),
            description: s.reason,
          })),
          async (decision) => {
            if (decision.accepted.length === 0) return;

            const acceptedSuggestions = suggestions.filter((s) =>
              decision.accepted.includes(s.path.replace(/\.md$/, "")),
            );

            const content = await this.vaultService.readNote(notePath);
            if (!content) return;

            const relatedSection = this.connections.buildRelatedSection(acceptedSuggestions);

            // Append or merge with existing Related section
            if (content.includes("## Related")) {
              const updated = content.replace(
                /\n## Related\n[\s\S]*?(?=\n## |$)/,
                relatedSection,
              );
              await this.vaultService.writeNote(notePath, updated);
            } else {
              await this.vaultService.writeNote(notePath, content + relatedSection);
            }

            showNotice(`Added ${decision.accepted.length} connections to ${notePath}.`);
          },
        ).open();
      },
    );
  }

  private retryFailedTasks(): void {
    const failed = this.orchestrator.queue.getFailedTasks();
    if (failed.length === 0) {
      showNotice("No failed tasks to retry.");
      return;
    }

    for (const task of failed) {
      task.status = "pending" as any;
      task.retryCount = 0;
      task.error = null;
    }

    showNotice(`Retrying ${failed.length} failed tasks.`);
  }
}
```

- [ ] **Step 2: Verify build compiles**

Run: `npm run build`
Expected: `main.js` created with no errors.

- [ ] **Step 3: Run all tests to verify nothing is broken**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/main.ts
git commit -m "feat: wire up plugin lifecycle, commands, auto-triggers, and task handlers"
```

---

## Task 20: Integration Test — Tagger End-to-End Flow

**Files:**
- Create: `tests/integration/tagger-flow.test.ts`

- [ ] **Step 1: Write integration test**

This test exercises the full flow: tagger builds prompt → orchestrator routes to mock LLM → result is returned → verify the orchestrator correctly completes the task. All real implementations except the LLM HTTP call.

```typescript
// tests/integration/tagger-flow.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Orchestrator } from "@/orchestrator/orchestrator";
import { TaskQueue } from "@/orchestrator/queue";
import { TaskRouter } from "@/orchestrator/router";
import { TaskBatcher } from "@/orchestrator/batcher";
import { CostTracker } from "@/orchestrator/cost-tracker";
import { TaggerModule } from "@/modules/tagger/tagger";
import { createTask, _resetIdCounter } from "@/orchestrator/task";
import { ModelRequirement, TaskTrigger, TaskStatus } from "@/types";
import { LLMProvider, LLMResponse } from "@/llm/provider";

describe("Tagger end-to-end flow", () => {
  let queue: TaskQueue;
  let costTracker: CostTracker;
  let onTaskCompleted: ReturnType<typeof vi.fn>;
  let orchestrator: Orchestrator;
  const tagger = new TaggerModule();

  beforeEach(() => {
    _resetIdCounter();
    queue = new TaskQueue();
    costTracker = new CostTracker();
    onTaskCompleted = vi.fn();

    // Mock LLM that returns valid tag suggestions
    const mockOllama: LLMProvider = {
      id: "ollama",
      isAvailable: vi.fn().mockResolvedValue(true),
      complete: vi.fn().mockImplementation(async (req) => {
        // The mock actually looks at the prompt to generate a plausible response
        const response: LLMResponse = {
          content: JSON.stringify({ tags: ["ai", "deep-learning"] }),
          tokensUsed: { input: 150, output: 30 },
          model: "llama3:8b",
          durationMs: 500,
        };
        return response;
      }),
    };

    const mockClaude: LLMProvider = {
      id: "claude",
      isAvailable: vi.fn().mockResolvedValue(true),
      complete: vi.fn(),
    };

    orchestrator = new Orchestrator({
      queue,
      router: new TaskRouter(mockOllama, mockClaude, false),
      batcher: new TaskBatcher({ maxBatchSize: 10, contextWindowTokens: 8000 }),
      costTracker,
      providers: { ollama: mockOllama, claude: mockClaude },
      settings: { claudeDailyBudget: 0, claudeMonthlyBudget: 0 },
      onTaskCompleted,
      onTaskFailed: vi.fn(),
      onTaskDeferred: vi.fn(),
      onCostWarning: vi.fn(),
    });
  });

  it("processes a tag-note task and returns parsed tags", async () => {
    const noteContent = "# Neural Networks\nTransformers are a type of neural network.";
    const prompt = tagger.buildPrompt({
      noteContent,
      existingTags: ["ai", "physics"],
      rejectedTags: [],
      styleGuide: "Use kebab-case.",
    });

    const task = createTask({
      type: "tagger",
      action: "tag-note",
      payload: {
        notePath: "neural-nets.md",
        noteContent,
        systemPrompt: prompt.system,
        prompt: prompt.prompt,
        maxTokens: prompt.maxTokens,
      },
      modelRequirement: ModelRequirement.LocalPreferred,
      trigger: TaskTrigger.Manual,
    });

    queue.enqueue(task);
    await orchestrator.processNext();

    // Task should be completed
    expect(queue.getTask(task.id)?.status).toBe(TaskStatus.Completed);

    // onTaskCompleted should have been called with the task and LLM response
    expect(onTaskCompleted).toHaveBeenCalledTimes(1);
    const [completedTask, response] = onTaskCompleted.mock.calls[0];
    expect(completedTask.payload.notePath).toBe("neural-nets.md");

    // The response should be parseable by the tagger
    const parsed = tagger.parseResponse(response.content);
    expect(parsed).not.toBeNull();
    expect(parsed!.tags).toContain("ai");
    expect(parsed!.tags).toContain("deep-learning");
  });

  it("routes local-preferred to Ollama, not Claude", async () => {
    const prompt = tagger.buildPrompt({
      noteContent: "# Test",
      existingTags: [],
      rejectedTags: [],
      styleGuide: "",
    });

    const task = createTask({
      type: "tagger",
      action: "tag-note",
      payload: {
        notePath: "test.md",
        noteContent: "# Test",
        systemPrompt: prompt.system,
        prompt: prompt.prompt,
        maxTokens: prompt.maxTokens,
      },
      modelRequirement: ModelRequirement.LocalPreferred,
      trigger: TaskTrigger.Automatic,
    });

    queue.enqueue(task);
    await orchestrator.processNext();

    // Claude should not have been called
    const claude = orchestrator["config"].providers.claude;
    expect(claude.complete).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run integration tests**

Run: `npm test -- tests/integration/tagger-flow.test.ts`
Expected: All tests pass.

- [ ] **Step 3: Run full test suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/tagger-flow.test.ts
git commit -m "test: add end-to-end integration test for tagger flow through orchestrator"
```

---

## Task 21: Clean Up & Final Verification

- [ ] **Step 1: Remove smoke test**

Delete `tests/smoke.test.ts` — it was scaffolding only.

- [ ] **Step 2: Run full test suite**

Run: `npm test`
Expected: All tests pass.

- [ ] **Step 3: Run production build**

Run: `npm run build`
Expected: `main.js` produced with no errors.

- [ ] **Step 4: Verify file structure matches plan**

Run: `find src tests -type f | sort`

Expected output should match the file map from the top of this plan.

- [ ] **Step 5: Commit**

```bash
git rm tests/smoke.test.ts
git commit -m "chore: remove scaffolding smoke test, final cleanup"
```
