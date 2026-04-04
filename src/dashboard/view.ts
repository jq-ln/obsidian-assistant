import { ItemView, WorkspaceLeaf, TFile } from "obsidian";
import { parseTrackingConfig, TrackingEntry } from "./tracking-config";
import { TrackingLog, parseInputValue, DayValue } from "./tracking-log";
import { renderChart } from "./chart";
import { parseQuickLinks, resolveNotePath, QuickLink } from "./quick-links";
import { selectRediscoveryNotes, RediscoverySelection } from "./rediscovery";
import { extractTasks, rankTasks, VaultTask } from "./task-query";
import { BriefingBuilder, BriefingInput } from "./briefing";
import { LLMProvider } from "../llm/provider";

export const DASHBOARD_VIEW_TYPE = "assistant-dashboard";

const METRIC_COLORS = ["#7c6ff5", "#f59e0b", "#4ade80", "#f87171", "#38bdf8", "#a78bfa"];

export interface DashboardDeps {
  readNote: (path: string) => Promise<string | null>;
  writeNote: (path: string, content: string) => Promise<void>;
  getMarkdownFiles: () => Array<{ path: string; stat: { mtime: number }; basename: string }>;
  openNote: (path: string) => void;
  llmProvider: LLMProvider;
  assistantFolder: string;
  settings: {
    aiBriefingCacheMinutes: number;
    rediscoveryFolders: string[];
    rediscoveryMinAgeDays: number;
    rediscoveryCount: number;
  };
}

export class DashboardView extends ItemView {
  private deps: DashboardDeps;
  private trackingLog: TrackingLog = new TrackingLog();
  private briefingBuilder = new BriefingBuilder();
  private rediscoveryCache: RediscoverySelection | null = null;

  constructor(leaf: WorkspaceLeaf, deps: DashboardDeps) {
    super(leaf);
    this.deps = deps;
  }

  getViewType(): string { return DASHBOARD_VIEW_TYPE; }
  getDisplayText(): string { return "Dashboard"; }
  getIcon(): string { return "layout-dashboard"; }

  async onOpen(): Promise<void> {
    await this.loadData();
    this.render();
  }

  async onClose(): Promise<void> {}

  async refresh(): Promise<void> {
    await this.loadData();
    this.render();
  }

  private async loadData(): Promise<void> {
    const logJson = await this.deps.readNote(`${this.deps.assistantFolder}/tracking-log.json`);
    if (logJson) {
      try { this.trackingLog = TrackingLog.deserialize(logJson); } catch { this.trackingLog = new TrackingLog(); }
    }

    // Migrate from old habit-log format if needed
    if (!logJson) {
      const oldLog = await this.deps.readNote(`${this.deps.assistantFolder}/habit-log.md`);
      if (oldLog && oldLog.trim() !== "{}") {
        try {
          this.trackingLog = TrackingLog.migrateFromHabitLog(oldLog);
          await this.saveTrackingLog();
        } catch { /* old format unreadable, start fresh */ }
      }
    }

    const rediscoveryJson = await this.deps.readNote(`${this.deps.assistantFolder}/rediscovery.json`);
    if (rediscoveryJson) {
      try { this.rediscoveryCache = JSON.parse(rediscoveryJson); } catch { this.rediscoveryCache = null; }
    }
  }

  private async saveTrackingLog(): Promise<void> {
    await this.deps.writeNote(
      `${this.deps.assistantFolder}/tracking-log.json`,
      this.trackingLog.serialize(),
    );
  }

  private async saveRediscovery(selection: RediscoverySelection): Promise<void> {
    this.rediscoveryCache = selection;
    await this.deps.writeNote(
      `${this.deps.assistantFolder}/rediscovery.json`,
      JSON.stringify(selection, null, 2),
    );
  }

  private render(): void {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("assistant-dashboard");
    container.style.padding = "16px";
    container.style.overflow = "auto";
    this.renderAsync(container);
  }

  private async renderAsync(container: HTMLElement): Promise<void> {
    const today = new Date().toISOString().split("T")[0];
    const now = new Date();

    // --- AI Briefing ---
    const briefingCard = container.createDiv({ cls: "dashboard-briefing" });
    briefingCard.style.background = "var(--background-secondary-alt)";
    briefingCard.style.borderRadius = "6px";
    briefingCard.style.padding = "14px";
    briefingCard.style.marginBottom = "12px";

    const briefingLabel = briefingCard.createDiv();
    briefingLabel.style.fontSize = "0.75em";
    briefingLabel.style.fontWeight = "600";
    briefingLabel.style.textTransform = "uppercase";
    briefingLabel.style.letterSpacing = "0.5px";
    briefingLabel.style.color = "var(--text-muted)";
    briefingLabel.style.marginBottom = "6px";
    briefingLabel.setText("AI Briefing");

    const briefingText = briefingCard.createDiv();
    briefingText.style.fontSize = "0.85em";
    briefingText.style.color = "var(--text-normal)";
    briefingText.style.lineHeight = "1.5";

    const cached = this.briefingBuilder.getCachedBriefing(this.deps.settings.aiBriefingCacheMinutes);
    if (cached) {
      briefingText.setText(cached);
    } else {
      briefingText.setText("Generating briefing...");
      briefingText.style.color = "var(--text-muted)";
      this.generateBriefing(briefingText, today);
    }

    // --- Main grid ---
    const grid = container.createDiv();
    grid.style.display = "grid";
    grid.style.gridTemplateColumns = "1fr 280px";
    grid.style.gap = "12px";

    const leftCol = grid.createDiv();
    leftCol.style.display = "flex";
    leftCol.style.flexDirection = "column";
    leftCol.style.gap = "12px";

    const rightCol = grid.createDiv();
    rightCol.style.display = "flex";
    rightCol.style.flexDirection = "column";
    rightCol.style.gap = "12px";

    // --- Quick Links ---
    const quickLinksContent = await this.deps.readNote(`${this.deps.assistantFolder}/quick-links.md`);
    const quickLinks = quickLinksContent ? parseQuickLinks(quickLinksContent) : [];

    if (quickLinks.length > 0) {
      const qlCard = this.createCard(leftCol, "Quick Links");
      const qlRow = qlCard.createDiv();
      qlRow.style.display = "flex";
      qlRow.style.gap = "8px";
      qlRow.style.flexWrap = "wrap";

      for (const link of quickLinks) {
        const btn = qlRow.createEl("button");
        btn.setText(link.label);
        btn.style.background = "var(--background-secondary-alt)";
        btn.style.border = "none";
        btn.style.borderRadius = "4px";
        btn.style.padding = "8px 14px";
        btn.style.cursor = "pointer";
        btn.style.fontSize = "0.85em";
        btn.style.color = "var(--text-normal)";
        btn.addEventListener("click", () => {
          const path = resolveNotePath(link, now);
          this.deps.openNote(path);
        });
      }
    }

    // --- Active Tasks ---
    const taskCard = this.createCard(leftCol, "Active Tasks");
    const allFiles = this.deps.getMarkdownFiles();
    const allTasks: VaultTask[] = [];
    for (const file of allFiles) {
      if (file.path.startsWith(`${this.deps.assistantFolder}/`)) continue;
      const content = await this.deps.readNote(file.path);
      if (content) {
        allTasks.push(...extractTasks(content, file.path));
      }
    }
    const ranked = rankTasks(allTasks);

    if (ranked.length === 0) {
      const empty = taskCard.createDiv();
      empty.style.color = "var(--text-muted)";
      empty.style.fontSize = "0.85em";
      empty.setText("No open tasks.");
    } else {
      for (const task of ranked) {
        const row = taskCard.createDiv();
        row.style.fontSize = "0.85em";
        row.style.padding = "2px 0";
        row.style.cursor = "pointer";
        row.addEventListener("click", () => this.deps.openNote(task.sourcePath));

        let display = `☐ ${task.text}`;
        if (task.dueDate) display += ` · due ${task.dueDate}`;
        row.setText(display);
      }
    }

    // --- Rediscovery ---
    const rediscoveryPaths = await this.getRediscoveryPaths(today);
    if (rediscoveryPaths.length > 0) {
      const rdCard = this.createCard(leftCol, "Rediscovery");

      for (const path of rediscoveryPaths) {
        const file = allFiles.find((f) => f.path === path);
        if (!file) continue;

        const row = rdCard.createDiv();
        row.style.background = "var(--background-secondary-alt)";
        row.style.borderRadius = "4px";
        row.style.padding = "8px 12px";
        row.style.cursor = "pointer";
        row.style.marginBottom = "4px";
        row.addEventListener("click", () => this.deps.openNote(path));

        const title = row.createDiv();
        title.style.fontSize = "0.85em";
        title.style.fontWeight = "500";
        title.setText(file.basename);

        const meta = row.createDiv();
        meta.style.fontSize = "0.75em";
        meta.style.color = "var(--text-muted)";
        meta.style.marginTop = "2px";
        const daysAgo = Math.floor((Date.now() - file.stat.mtime) / (24 * 60 * 60 * 1000));
        const folder = path.includes("/") ? path.split("/").slice(0, -1).join("/") : "";
        meta.setText(`${folder ? folder + " · " : ""}last opened ${daysAgo} days ago`);
      }
    }

    // --- Right Column: Tracking Config ---
    const trackingContent = await this.deps.readNote(`${this.deps.assistantFolder}/tracking.md`);
    const entries = trackingContent ? parseTrackingConfig(trackingContent) : [];
    const booleans = entries.filter((e) => e.type === "boolean");
    const numerics = entries.filter((e) => e.type === "numeric");

    if (entries.length === 0) {
      const emptyCard = this.createCard(rightCol, "Tracking");
      const msg = emptyCard.createDiv();
      msg.style.fontSize = "0.85em";
      msg.style.color = "var(--text-muted)";
      msg.setText("No metrics configured. Edit AI-Assistant/tracking.md to add habits and metrics.");
    }

    // --- Habits (boolean) ---
    if (booleans.length > 0) {
      const habitCard = this.createCard(rightCol, "Habits");

      for (const entry of booleans) {
        const row = habitCard.createDiv();
        row.style.display = "flex";
        row.style.justifyContent = "space-between";
        row.style.alignItems = "center";
        row.style.fontSize = "0.85em";
        row.style.padding = "2px 0";

        row.createSpan({ text: entry.name });

        const gridSpan = row.createSpan();
        const recentData = this.trackingLog.getRecentValues(entry.name, today, 7);

        for (let i = 0; i < recentData.length; i++) {
          const day = recentData[i];
          const isToday = day.date === today;
          const cell = gridSpan.createSpan();
          cell.setText(day.value === 1 ? "■" : "□");
          cell.style.color = day.value === 1 ? "#4ade80" : "var(--text-muted)";
          if (isToday) {
            cell.style.cursor = "pointer";
            cell.addEventListener("click", async () => {
              this.trackingLog.toggleBoolean(entry.name, today);
              await this.saveTrackingLog();
              this.render();
            });
          }
        }

        const count = recentData.filter((d) => d.value === 1).length;
        const countSpan = gridSpan.createSpan({ text: ` ${count}/7` });
        countSpan.style.color = "var(--text-muted)";
        countSpan.style.fontSize = "0.85em";
        countSpan.style.marginLeft = "4px";
      }
    }

    // --- Tracking graphs (numeric) ---
    for (let idx = 0; idx < numerics.length; idx++) {
      const entry = numerics[idx];
      const color = METRIC_COLORS[idx % METRIC_COLORS.length];
      const card = this.createCard(rightCol, "");

      // Header row
      const header = card.createDiv();
      header.style.display = "flex";
      header.style.justifyContent = "space-between";
      header.style.alignItems = "baseline";
      header.style.marginBottom = "4px";

      const nameEl = header.createDiv();
      nameEl.style.fontSize = "0.75em";
      nameEl.style.fontWeight = "600";
      nameEl.style.textTransform = "uppercase";
      nameEl.style.letterSpacing = "0.5px";
      nameEl.style.color = "var(--text-muted)";
      nameEl.setText(entry.name);

      if (entry.goalValue !== null) {
        const goalEl = header.createDiv();
        goalEl.style.fontSize = "0.75em";
        goalEl.style.color = "var(--text-muted)";
        goalEl.setText(`Goal: ${entry.goalDirection}${entry.goalValue}${entry.unit ? " " + entry.unit : ""}`);
      }

      // Input row
      const inputRow = card.createDiv();
      inputRow.style.display = "flex";
      inputRow.style.alignItems = "center";
      inputRow.style.gap = "8px";
      inputRow.style.marginBottom = "8px";

      const currentValue = this.trackingLog.getValue(entry.name, today);

      const input = inputRow.createEl("input");
      input.type = "text";
      input.placeholder = entry.unit ?? "value";
      input.value = currentValue !== null ? String(currentValue) : "";
      input.style.width = "80px";
      input.style.padding = "4px 8px";
      input.style.fontSize = "0.85em";
      input.style.border = "1px solid var(--background-modifier-border)";
      input.style.borderRadius = "4px";
      input.style.background = "var(--background-primary)";
      input.style.color = "var(--text-normal)";

      input.addEventListener("keydown", async (e) => {
        if (e.key !== "Enter") return;
        const parsed = parseInputValue(input.value);
        if (parsed === null) {
          input.style.borderColor = "#f87171";
          setTimeout(() => { input.style.borderColor = "var(--background-modifier-border)"; }, 1000);
          return;
        }
        this.trackingLog.logValue(entry.name, today, parsed);
        await this.saveTrackingLog();
        this.render();
      });

      // Trend display
      const recentData = this.trackingLog.getRecentValues(entry.name, today, 7);
      const nonNullValues = recentData.map((d) => d.value).filter((v) => v !== null) as number[];

      if (nonNullValues.length >= 2) {
        const latest = nonNullValues[nonNullValues.length - 1];
        const prev = nonNullValues[nonNullValues.length - 2];
        const diff = latest - prev;

        const trendEl = inputRow.createSpan();
        trendEl.style.fontSize = "1.2em";
        trendEl.style.fontWeight = "600";
        trendEl.setText(String(latest));

        if (diff !== 0) {
          const arrow = inputRow.createSpan();
          arrow.style.fontSize = "0.75em";
          const isGood = entry.goalDirection === "<" ? diff < 0 : diff > 0;
          arrow.style.color = isGood ? "#4ade80" : "#f87171";
          arrow.setText(`${diff > 0 ? "↑" : "↓"} ${Math.abs(diff).toFixed(1)}`);
        }
      }

      // Chart
      const chartData = {
        values: recentData,
        goalValue: entry.goalValue,
        color,
      };
      const svgStr = renderChart(chartData);
      const chartDiv = card.createDiv();
      chartDiv.innerHTML = svgStr;
      const svgEl = chartDiv.querySelector("svg");
      if (svgEl) svgEl.style.width = "100%";
    }
  }

  private createCard(parent: HTMLElement, label: string): HTMLElement {
    const card = parent.createDiv();
    card.style.background = "var(--background-secondary)";
    card.style.borderRadius = "4px";
    card.style.padding = "12px";

    if (label) {
      const labelEl = card.createDiv({ cls: "dashboard-card-label" });
      labelEl.style.fontSize = "0.75em";
      labelEl.style.fontWeight = "600";
      labelEl.style.textTransform = "uppercase";
      labelEl.style.letterSpacing = "0.5px";
      labelEl.style.color = "var(--text-muted)";
      labelEl.style.marginBottom = "8px";
      labelEl.setText(label);
    }

    return card;
  }

  private async getRediscoveryPaths(today: string): Promise<string[]> {
    if (this.rediscoveryCache && this.rediscoveryCache.date === today) {
      return this.rediscoveryCache.paths.filter((p) =>
        this.deps.getMarkdownFiles().some((f) => f.path === p),
      );
    }

    const files = this.deps.getMarkdownFiles()
      .filter((f) => !f.path.startsWith(`${this.deps.assistantFolder}/`))
      .map((f) => ({ path: f.path, mtime: f.stat.mtime }));

    const paths = selectRediscoveryNotes(files, {
      folders: this.deps.settings.rediscoveryFolders,
      minAgeDays: this.deps.settings.rediscoveryMinAgeDays,
      count: this.deps.settings.rediscoveryCount,
      today,
    });

    await this.saveRediscovery({ date: today, paths });
    return paths;
  }

  private async generateBriefing(targetEl: HTMLElement, today: string): Promise<void> {
    try {
      const allFiles = this.deps.getMarkdownFiles();
      const allTasks: VaultTask[] = [];
      for (const file of allFiles) {
        if (file.path.startsWith(`${this.deps.assistantFolder}/`)) continue;
        const content = await this.deps.readNote(file.path);
        if (content) allTasks.push(...extractTasks(content, file.path));
      }

      const trackingContent = await this.deps.readNote(`${this.deps.assistantFolder}/tracking.md`);
      const entries = trackingContent ? parseTrackingConfig(trackingContent) : [];
      const trackingData = entries
        .filter((e) => e.type === "numeric")
        .map((e) => ({
          name: e.name,
          unit: e.unit ?? "",
          recentValues: this.trackingLog.getRecentValues(e.name, today, 7).map((d) => d.value).filter((v): v is number => v !== null),
          goalValue: e.goalValue ?? undefined,
          goalDirection: (e.goalDirection ?? undefined) as "<" | ">" | "=" | undefined,
        }));

      const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
      const recentNoteTitles = allFiles
        .filter((f) => f.stat.mtime > sevenDaysAgo && !f.path.startsWith(`${this.deps.assistantFolder}/`))
        .sort((a, b) => b.stat.mtime - a.stat.mtime)
        .slice(0, 20)
        .map((f) => f.basename);

      const prompt = this.briefingBuilder.buildPrompt({
        tasks: rankTasks(allTasks, 15).map((t) => ({
          text: t.text,
          sourcePath: t.sourcePath,
          dueDate: t.dueDate ?? undefined,
        })),
        trackingData,
        recentNoteTitles,
      });

      const response = await this.deps.llmProvider.complete(prompt);
      this.briefingBuilder.setCachedBriefing(response.content, Date.now());
      targetEl.style.color = "var(--text-normal)";
      targetEl.setText(response.content);
    } catch {
      targetEl.setText("AI briefing unavailable — Ollama not running.");
      targetEl.style.color = "var(--text-muted)";
    }
  }
}
