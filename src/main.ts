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

    // Collect recently modified files (last 7 days)
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;
    const recentActivity = this.vaultService
      .getMarkdownFiles()
      .filter((f) => f.stat.mtime > sevenDaysAgo)
      .sort((a, b) => b.stat.mtime - a.stat.mtime)
      .map((f) => ({
        path: f.path,
        action: "modified",
        date: new Date(f.stat.mtime).toISOString().split("T")[0],
      }));

    // Count notes that have suggested-tags in their frontmatter
    let pendingSuggestions = 0;
    for (const file of this.vaultService.getMarkdownFiles()) {
      const fm = await this.vaultService.parseFrontmatter(file.path);
      if (Array.isArray(fm["suggested-tags"]) && fm["suggested-tags"].length > 0) {
        pendingSuggestions++;
      }
    }

    const md = this.dashboard.renderDashboard({
      goalsContent,
      tasksMarkdown: this.taskAggregator.renderTasksMarkdown(rankedTasks),
      habitsMarkdown: this.habitTracker.renderHabitsMarkdown(habits, habitLog, today),
      recentActivity,
      pendingSuggestions,
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
