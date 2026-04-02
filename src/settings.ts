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
    containerEl.createEl("p", {
      text: "Note: Changes to API key, endpoint, or model settings require reloading the plugin to take effect.",
      cls: "setting-item-description",
    });

    // --- Claude ---
    containerEl.createEl("h3", { text: "Claude API" });

    new Setting(containerEl)
      .setName("API Key")
      .setDesc("Your Anthropic API key. Warning: stored in plugin data — exclude from sync if using Git.")
      .addText((text) => {
        const t = text as any;
        t.setPlaceholder("sk-ant-...");
        t.setValue(this.settings.claudeApiKey);
        t.onChange(async (value: string) => {
          this.settings.claudeApiKey = value;
          await this.save();
        });
        if (t.inputEl) t.inputEl.type = "password";
        return t;
      });

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
