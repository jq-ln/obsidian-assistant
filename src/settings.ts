import { App, PluginSettingTab, Plugin, Setting } from "obsidian";

export interface PluginSettings {
  ollamaEndpoint: string;
  ollamaModel: string;
  dashboardPath: string;
  autoTagOnSave: boolean;
  autoTagOnStartup: boolean;
  autoConnectionScan: boolean;
  connectionScanIntervalMin: number;
  connectionMinScore: number;
  autoDashboardRefresh: boolean;
  dashboardRefreshIntervalHours: number;
  ankiEnabled: boolean;
  ankiAutoSuggestOnSave: boolean;
  ankiCardFormat: "both" | "basic-only" | "cloze-only";
  ankiCardLocation: "in-note" | "separate-file";
}

export const DEFAULT_SETTINGS: PluginSettings = {
  ollamaEndpoint: "http://localhost:11434",
  ollamaModel: "qwen2.5:14b",
  dashboardPath: "Dashboard.md",
  autoTagOnSave: true,
  autoTagOnStartup: true,
  autoConnectionScan: true,
  connectionScanIntervalMin: 30,
  connectionMinScore: 0.65,
  autoDashboardRefresh: true,
  dashboardRefreshIntervalHours: 2,
  ankiEnabled: false,
  ankiAutoSuggestOnSave: false,
  ankiCardFormat: "both",
  ankiCardLocation: "in-note",
};

export class AssistantSettingTab extends PluginSettingTab {
  private settings: PluginSettings;
  private onSettingsChange: (settings: PluginSettings) => Promise<void>;
  private onCardLocationChange?: (
    oldLocation: string,
    newLocation: string,
  ) => void;

  constructor(
    app: App,
    plugin: Plugin,
    settings: PluginSettings,
    onSettingsChange: (settings: PluginSettings) => Promise<void>,
    onCardLocationChange?: (oldLocation: string, newLocation: string) => void,
  ) {
    super(app, plugin);
    this.settings = settings;
    this.onSettingsChange = onSettingsChange;
    this.onCardLocationChange = onCardLocationChange;
  }

  private async save(): Promise<void> {
    await this.onSettingsChange(this.settings);
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "AI Assistant Settings" });

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
      .setDesc("Any Ollama-compatible model (e.g., qwen2.5:14b, llama3:8b, mistral)")
      .addText((text) =>
        (text as any)
          .setPlaceholder("llama3:8b")
          .setValue(this.settings.ollamaModel)
          .onChange(async (value: string) => {
            this.settings.ollamaModel = value;
            await this.save();
          }),
      );

    // --- Automation ---
    containerEl.createEl("h3", { text: "Automation" });

    new Setting(containerEl)
      .setName("Auto-tag on save")
      .setDesc("Suggest tags when a note is saved")
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
      .setName("Connection similarity threshold")
      .setDesc("Minimum similarity score for connection suggestions. Higher = fewer but more relevant.")
      .addSlider((slider) =>
        (slider as any)
          .setLimits(0.3, 0.9, 0.05)
          .setValue(this.settings.connectionMinScore)
          .setDynamicTooltip()
          .onChange(async (value: number) => {
            this.settings.connectionMinScore = value;
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

    // --- Anki ---
    containerEl.createEl("h3", { text: "Anki Cards" });

    new Setting(containerEl)
      .setName("Enable Anki card suggestions")
      .setDesc("Suggest flashcards from your notes using the local LLM")
      .addToggle((toggle) =>
        (toggle as any)
          .setValue(this.settings.ankiEnabled)
          .onChange(async (value: boolean) => {
            this.settings.ankiEnabled = value;
            await this.save();
            this.display(); // Re-render to show/hide sub-settings
          }),
      );

    if (this.settings.ankiEnabled) {
      new Setting(containerEl)
        .setName("Auto-suggest cards on save")
        .setDesc("Generate card suggestions on every save. Debounced to 10s.")
        .addToggle((toggle) =>
          (toggle as any)
            .setValue(this.settings.ankiAutoSuggestOnSave)
            .onChange(async (value: boolean) => {
              this.settings.ankiAutoSuggestOnSave = value;
              await this.save();
            }),
        );

      new Setting(containerEl)
        .setName("Card format")
        .setDesc("Which flashcard formats to generate")
        .addDropdown((dropdown) =>
          (dropdown as any)
            .addOption("both", "Both (basic + cloze)")
            .addOption("basic-only", "Basic only (Front::Back)")
            .addOption("cloze-only", "Cloze only ({{c1::...}})")
            .setValue(this.settings.ankiCardFormat)
            .onChange(async (value: string) => {
              this.settings.ankiCardFormat = value as PluginSettings["ankiCardFormat"];
              await this.save();
            }),
        );

      new Setting(containerEl)
        .setName("Card location")
        .setDesc("Where to insert flashcard markdown. Changing this migrates existing cards.")
        .addDropdown((dropdown) =>
          (dropdown as any)
            .addOption("in-note", "In the source note (## Flashcards)")
            .addOption("separate-file", "Separate file (AI-Assistant/cards/)")
            .setValue(this.settings.ankiCardLocation)
            .onChange(async (value: string) => {
              const oldValue = this.settings.ankiCardLocation;
              this.settings.ankiCardLocation = value as PluginSettings["ankiCardLocation"];
              await this.save();
              if (oldValue !== value && this.onCardLocationChange) {
                this.onCardLocationChange(oldValue, value as PluginSettings["ankiCardLocation"]);
              }
            }),
        );
    }
  }
}
