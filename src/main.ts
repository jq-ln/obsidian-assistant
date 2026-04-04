// src/main.ts
import { Plugin, TFile, MarkdownView } from "obsidian";
import { PluginSettings, DEFAULT_SETTINGS, AssistantSettingTab } from "./settings";
import { ASSISTANT_FOLDER, DEFAULT_TAG_STYLE_GUIDE, TaskTrigger } from "./types";
import { OllamaProvider } from "./llm/ollama";
import { VaultService } from "./vault/vault-service";
import { TaskQueue } from "./orchestrator/queue";
import { TaskRouter } from "./orchestrator/router";
import { TaskBatcher } from "./orchestrator/batcher";
import { Orchestrator } from "./orchestrator/orchestrator";
import { createTask } from "./orchestrator/task";
import { Task } from "./orchestrator/task";
import { LLMResponse } from "./llm/provider";
import { TaggerModule } from "./modules/tagger/tagger";
import { TagAuditModule } from "./modules/tagger/tag-audit";
import { extractKeywords } from "./modules/connections/keyword-extractor";
import { OllamaEmbeddingProvider } from "./embeddings/provider";
import { EmbeddingStore, fnv1aHash } from "./embeddings/store";
import { SimilarityScorer } from "./embeddings/similarity";
import { ConnectionModule } from "./modules/connections/connections";

import { SuggestionModal } from "./ui/suggestion-modal";
import { DashboardView, DASHBOARD_VIEW_TYPE } from "./dashboard/view";
import { showNotice, showClickableNotice } from "./ui/notices";
import { AnkiModule } from "./modules/anki/anki";
import { CardMigration } from "./modules/anki/card-migration";
import { SuggestionsStore } from "./suggestions/store";
import { SuggestionsPanel, SUGGESTIONS_VIEW_TYPE, SuggestionHandler } from "./suggestions/panel";
import { createSuggestion, Suggestion } from "./suggestions/suggestion";

export default class AssistantPlugin extends Plugin {
  settings: PluginSettings = DEFAULT_SETTINGS;
  private vaultService!: VaultService;
  private orchestrator!: Orchestrator;
  private tagger = new TaggerModule();
  private tagAudit = new TagAuditModule();
  private embeddingProvider!: OllamaEmbeddingProvider;
  private embeddingStore!: EmbeddingStore;
  private similarityScorer!: SimilarityScorer;
  private connections = new ConnectionModule();

  private dashboardView: DashboardView | null = null;
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private ankiModule = new AnkiModule();
  private cardMigration!: CardMigration;
  private ankiAutoSuggestRef: (() => void) | null = null;
  private suggestionsStore!: SuggestionsStore;
  private suggestionsPanel: SuggestionsPanel | null = null;
  private ollama!: OllamaProvider;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.vaultService = new VaultService(this.app);

    this.ollama = new OllamaProvider(
      this.settings.ollamaEndpoint,
      this.settings.ollamaModel,
    );

    this.embeddingProvider = new OllamaEmbeddingProvider(
      this.settings.ollamaEndpoint,
    );

    // Load persisted state
    const queue = await this.loadQueue();
    queue.recoverOnStartup();

    // Load embedding store
    this.embeddingStore = await this.loadEmbeddingStore();
    this.similarityScorer = new SimilarityScorer(this.embeddingStore);

    const router = new TaskRouter(this.ollama);
    const batcher = new TaskBatcher({
      maxBatchSize: 10,
      contextWindowTokens: 8000,
    });

    this.orchestrator = new Orchestrator({
      queue,
      router,
      batcher,
      onTaskCompleted: (task, response) => this.handleTaskCompleted(task, response),
      onTaskFailed: (task, error) => showNotice(`Task failed: ${error}`),
      onTaskDeferred: (task, reason) => showNotice(`Task deferred: ${reason}`),
    });

    // Load suggestions store
    this.suggestionsStore = await this.loadSuggestionsStore();
    this.cardMigration = new CardMigration(this.vaultService);

    // Register UI immediately — these don't depend on vault readiness
    this.registerView(SUGGESTIONS_VIEW_TYPE, (leaf) => {
      this.suggestionsPanel = new SuggestionsPanel(
        leaf,
        this.suggestionsStore,
        this.createSuggestionHandler(),
        () => this.orchestrator.queue.getActiveTasks().map((t) => ({
          action: t.action,
          notePath: t.payload.notePath,
          status: t.status,
        })),
      );
      this.checkAnkiPlugin();
      return this.suggestionsPanel;
    });

    this.registerView(DASHBOARD_VIEW_TYPE, (leaf) => {
      this.dashboardView = new DashboardView(leaf, this.createDashboardDeps());
      return this.dashboardView;
    });

    this.addRibbonIcon("lightbulb", "AI Suggestions", () => {
      this.activateSuggestionsPanel();
    });

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
      id: "open-dashboard",
      name: "Open dashboard",
      callback: () => this.activateDashboard(),
    });

    this.addCommand({
      id: "retry-failed-tasks",
      name: "Retry failed tasks",
      callback: () => this.retryFailedTasks(),
    });

    this.addCommand({
      id: "suggest-anki-cards",
      name: "Suggest Anki cards for this note",
      callback: () => this.suggestAnkiCards(),
    });

    this.addSettingTab(
      new AssistantSettingTab(
        this.app,
        this,
        this.settings,
        async (s) => {
          this.settings = s;
          await this.saveSettings();
        },
        (oldLocation, newLocation) => {
          this.queueCardMigration(oldLocation, newLocation);
        },
      ),
    );

    // Clean up suggestions when notes are deleted
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (file instanceof TFile) {
          this.suggestionsStore.removeForNote(file.path);
          this.embeddingStore.remove(file.path);
          this.saveSuggestionsStore();
          this.suggestionsPanel?.refresh();
        }
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

    this.updateAnkiAutoSuggest();

    // Process queue periodically
    this.registerInterval(
      window.setInterval(() => this.orchestrator.processNext(), 3000),
    );

    // Cleanup resolved suggestions every hour
    this.registerInterval(
      window.setInterval(() => {
        this.suggestionsStore.cleanup(24 * 60 * 60 * 1000);
        this.saveSuggestionsStore();
      }, 60 * 60 * 1000),
    );

    // Defer vault-dependent initialization until the layout is ready,
    // which guarantees the vault metadata cache is populated.
    this.app.workspace.onLayoutReady(() => this.onLayoutReady());
  }

  private async onLayoutReady(): Promise<void> {
    await this.initializeVaultFolder();

    // Start background embedding index
    const allFiles = this.vaultService.getMarkdownFiles();
    const filesToIndex: Array<{ path: string }> = [];
    for (const file of allFiles) {
      if (file.path.startsWith(`${ASSISTANT_FOLDER}/`)) continue;
      const content = await this.vaultService.readNote(file.path);
      if (!content) continue;
      const currentHash = fnv1aHash(content);
      const storedHash = this.embeddingStore.getContentHash(file.path);
      if (storedHash !== currentHash) {
        filesToIndex.push({ path: file.path });
      }
    }
    this.embeddingStore.startBackgroundIndex(
      filesToIndex,
      (path) => this.vaultService.readNote(path),
      () => this.saveEmbeddingStore(),
    );

    if (this.settings.autoConnectionScan) {
      this.registerInterval(
        window.setInterval(
          () => this.scanRecentConnections(),
          this.settings.connectionScanIntervalMin * 60 * 1000,
        ),
      );
    }

    if (this.settings.openDashboardOnStartup) {
      this.activateDashboard();
    }
  }

  async onunload(): Promise<void> {
    this.ankiAutoSuggestRef?.();
    this.ankiAutoSuggestRef = null;
    this.embeddingStore.stopBackgroundIndex();
    await this.embeddingStore.flush();
    await this.saveQueue();
    await this.saveSuggestionsStore();
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
    this.ollama.updateConfig({
      endpoint: this.settings.ollamaEndpoint,
      model: this.settings.ollamaModel,
    });
    this.embeddingProvider.updateConfig({
      endpoint: this.settings.ollamaEndpoint,
    });
    this.updateAnkiAutoSuggest();
  }

  private updateAnkiAutoSuggest(): void {
    if (this.settings.ankiEnabled && this.settings.ankiAutoSuggestOnSave) {
      if (!this.ankiAutoSuggestRef) {
        const handler = (file: any) => {
          if (file instanceof TFile && file.extension === "md") {
            this.debounceAnkiSuggest(file.path, 10000);
          }
        };
        this.app.vault.on("modify", handler);
        this.ankiAutoSuggestRef = () => this.app.vault.off("modify", handler);
      }
    } else {
      if (this.ankiAutoSuggestRef) {
        this.ankiAutoSuggestRef();
        this.ankiAutoSuggestRef = null;
      }
    }
  }

  // --- Queue persistence ---

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

  // --- Embedding store persistence ---

  private async loadEmbeddingStore(): Promise<EmbeddingStore> {
    const content = await this.vaultService.readNote(`${ASSISTANT_FOLDER}/embeddings.json`);
    if (content) {
      try { return EmbeddingStore.deserialize(content, this.embeddingProvider); } catch { /* start fresh */ }
    }
    return new EmbeddingStore(this.embeddingProvider);
  }

  private async saveEmbeddingStore(): Promise<void> {
    await this.vaultService.writeNote(
      `${ASSISTANT_FOLDER}/embeddings.json`,
      this.embeddingStore.serialize(),
    );
  }

  // --- Suggestions store persistence ---

  private async loadSuggestionsStore(): Promise<SuggestionsStore> {
    const content = await this.vaultService.readNote(`${ASSISTANT_FOLDER}/suggestions.json`);
    if (content) {
      try { return SuggestionsStore.deserialize(content); } catch { /* start fresh */ }
    }
    return new SuggestionsStore();
  }

  private async saveSuggestionsStore(): Promise<void> {
    await this.vaultService.writeNote(
      `${ASSISTANT_FOLDER}/suggestions.json`,
      this.suggestionsStore.serialize(),
    );
  }

  // --- Panel activation ---

  private async activateDashboard(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(DASHBOARD_VIEW_TYPE);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getLeaf(true);
    await leaf.setViewState({ type: DASHBOARD_VIEW_TYPE, active: true });
    this.app.workspace.revealLeaf(leaf);
  }

  private createDashboardDeps() {
    return {
      readNote: (path: string) => this.vaultService.readNote(path),
      writeNote: (path: string, content: string) => this.vaultService.writeNote(path, content),
      getMarkdownFiles: () => this.vaultService.getMarkdownFiles(),
      openNote: (path: string) => this.app.workspace.openLinkText(path, ""),
      llmProvider: this.ollama,
      assistantFolder: ASSISTANT_FOLDER,
      settings: {
        aiBriefingCacheMinutes: this.settings.aiBriefingCacheMinutes,
        rediscoveryFolders: this.settings.rediscoveryFolders
          .split(",").map((s) => s.trim()).filter((s) => s.length > 0),
        rediscoveryMinAgeDays: this.settings.rediscoveryMinAgeDays,
        rediscoveryCount: this.settings.rediscoveryCount,
      },
    };
  }

  private async activateSuggestionsPanel(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(SUGGESTIONS_VIEW_TYPE);
    if (existing.length > 0) {
      this.app.workspace.revealLeaf(existing[0]);
      return;
    }
    const leaf = this.app.workspace.getRightLeaf(false);
    if (leaf) {
      await leaf.setViewState({ type: SUGGESTIONS_VIEW_TYPE, active: true });
      this.app.workspace.revealLeaf(leaf);
    }
  }

  private checkAnkiPlugin(): void {
    if (!this.settings.ankiEnabled || !this.suggestionsPanel) return;

    const ankiPlugin = (this.app as any).plugins?.getPlugin?.("obsidian-to-anki-plugin");
    if (!ankiPlugin) {
      this.suggestionsPanel.setSetupGuide(
        `<strong>Anki Setup Required</strong><br>
        To sync flashcards to Anki:<br>
        1. Install <em>Obsidian to Anki</em> from Community Plugins<br>
        2. Install <em>AnkiConnect</em> add-on in Anki (code: 2055492159)<br>
        3. Have Anki running when you want to sync<br><br>
        <em>Cards still work as markdown study material without Anki.</em>`,
      );
    } else {
      this.suggestionsPanel.setSetupGuide(null);
    }
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
  }

  // --- Tagger commands ---

  private debounceTagNote(path: string, delayMs: number): void {
    const existing = this.debounceTimers.get(path);
    if (existing) clearTimeout(existing);

    this.debounceTimers.set(
      path,
      setTimeout(async () => {
        this.debounceTimers.delete(path);
        // Ensure embedding is fresh before tagging
        const content = await this.vaultService.readNote(path);
        if (content) {
          try { await this.embeddingStore.ensureEmbedding(path, content); } catch { /* Ollama may be down */ }
        }
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
    // Skip automatic re-tagging of notes that were already AI-tagged
    if (trigger === TaskTrigger.Automatic && fm["ai-tagged"]) return;

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

  private async enqueueConnectionScan(notePath: string, trigger: TaskTrigger): Promise<void> {
    const content = await this.vaultService.readNote(notePath);
    if (!content) return;

    // On-demand embed for the active note
    try {
      await this.embeddingStore.ensureEmbedding(notePath, content);
    } catch {
      showNotice("Connection scan skipped — Ollama unavailable.");
      return;
    }

    // Extract existing links to exclude
    const linkMatches = content.matchAll(/\[\[([^\]]+)\]\]/g);
    const linkedPaths = new Set<string>();
    for (const m of linkMatches) {
      linkedPaths.add(m[1] + ".md");
      linkedPaths.add(m[1]);
    }

    // Collect candidate paths (exclude source and already-linked)
    const candidatePaths = this.vaultService.getMarkdownFiles()
      .filter((f) => f.path !== notePath && !linkedPaths.has(f.path))
      .map((f) => f.path);

    // Rank by embedding similarity
    const ranked = this.similarityScorer.rankCandidates(notePath, candidatePaths, {
      topK: 10,
      minScore: this.settings.connectionMinScore,
    });

    if (ranked.length === 0) return;

    // Build prompt with keyword summaries for each candidate
    const wordFreqs = this.embeddingStore.getWordFrequencies();
    const fm = await this.vaultService.parseFrontmatter(notePath);
    const sourceTags = fm.tags ?? [];

    const candidateSummaries = [];
    for (const r of ranked) {
      const candidateContent = await this.vaultService.readNote(r.path);
      if (!candidateContent) continue;
      const keywords = extractKeywords(candidateContent, wordFreqs);
      candidateSummaries.push({
        path: r.path,
        title: r.path.replace(/\.md$/, "").split("/").pop() ?? "",
        tags: ((await this.vaultService.parseFrontmatter(r.path)).tags ?? []),
        keywords,
        summary: candidateContent.slice(0, 400),
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
      trigger,
    });

    this.orchestrator.queue.enqueue(task);
  }

  // --- Task completion handlers ---

  private async handleTaskCompleted(task: Task, response: LLMResponse): Promise<void> {
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
      case "suggest-cards":
        await this.handleAnkiResult(task, response);
        break;
    }

    // Persist state after each completion
    await this.saveQueue();
  }

  private async handleTagResult(task: Task, response: LLMResponse): Promise<void> {
    let suggestedTags: string[] | null = null;

    if (task.payload._batchSize > 1) {
      // Batch response — parse as batch and extract this note's tags
      const batchResult = this.tagger.parseBatchResponse(task.payload._batchResponse);
      if (batchResult) {
        suggestedTags = batchResult[task.payload.notePath] ?? null;
      }
    } else {
      // Single response
      const result = this.tagger.parseResponse(response.content);
      suggestedTags = result?.tags ?? null;
    }

    if (!suggestedTags || suggestedTags.length === 0) return;

    const notePath = task.payload.notePath;
    if (!this.vaultService.noteExists(notePath)) return;

    // Still write to frontmatter for backwards compat
    await this.vaultService.updateFrontmatter(notePath, {
      "suggested-tags": suggestedTags,
    });

    // Emit to suggestions store
    for (const tag of suggestedTags) {
      const sug = createSuggestion({
        type: "tag",
        sourceNotePath: notePath,
        title: tag,
        detail: `Suggested tag for ${notePath.split("/").pop()}`,
      });
      this.suggestionsStore.add(sug);
    }

    await this.saveSuggestionsStore();
    this.suggestionsPanel?.refresh();
    showNotice(`${suggestedTags.length} tag suggestions — check the panel`);
  }

  private async handleAuditResult(task: Task, response: LLMResponse): Promise<void> {
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

  private async handleConnectionResult(task: Task, response: LLMResponse): Promise<void> {
    const suggestions = this.connections.parseResponse(response.content);
    if (!suggestions || suggestions.length === 0) return;

    const notePath = task.payload.notePath;
    if (!this.vaultService.noteExists(notePath)) return;

    const sourceNormalized = notePath.replace(/\.md$/, "");
    let added = 0;
    for (const conn of suggestions) {
      const connNormalized = conn.path.replace(/\.md$/, "");
      if (connNormalized === sourceNormalized) continue;
      const sug = createSuggestion({
        type: "connection",
        sourceNotePath: notePath,
        title: connNormalized,
        detail: conn.reason,
      });
      this.suggestionsStore.add(sug);
      added++;
    }

    if (added === 0) return;

    await this.saveSuggestionsStore();
    this.suggestionsPanel?.refresh();
    showNotice(`${added} connection suggestions — check the panel`);
  }

  private retryFailedTasks(): void {
    const failed = this.orchestrator.queue.getFailedTasks();
    if (failed.length === 0) {
      showNotice("No failed tasks to retry.");
      return;
    }

    for (const task of failed) {
      this.orchestrator.queue.resetTask(task.id);
    }

    showNotice(`Retrying ${failed.length} failed tasks.`);
  }

  // --- Anki commands ---

  private async suggestAnkiCards(): Promise<void> {
    if (!this.settings.ankiEnabled) {
      showNotice("Enable Anki card suggestions in settings first.");
      return;
    }

    const file = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
    if (!file) {
      showNotice("No active note.");
      return;
    }

    const content = await this.vaultService.readNote(file.path);
    if (!content) return;

    const existingCards = this.ankiModule.extractExistingCards(content);
    const prompt = this.ankiModule.buildPrompt({
      noteContent: content,
      existingCards,
      cardFormat: this.settings.ankiCardFormat,
    });

    const task = createTask({
      type: "anki",
      action: "suggest-cards",
      payload: {
        notePath: file.path,
        systemPrompt: prompt.system,
        prompt: prompt.prompt,
        maxTokens: prompt.maxTokens,
      },
      trigger: TaskTrigger.Manual,
    });

    this.orchestrator.queue.enqueue(task);
    showNotice(`Queued card suggestions for ${file.basename}`);
  }

  private debounceAnkiSuggest(path: string, delayMs: number): void {
    const key = `anki:${path}`;
    const existing = this.debounceTimers.get(key);
    if (existing) clearTimeout(existing);

    this.debounceTimers.set(
      key,
      setTimeout(() => {
        this.debounceTimers.delete(key);
        this.enqueueAnkiSuggest(path);
      }, delayMs),
    );
  }

  private async enqueueAnkiSuggest(path: string): Promise<void> {
    if (!this.settings.ankiEnabled) return;

    const content = await this.vaultService.readNote(path);
    if (!content) return;

    const existingCards = this.ankiModule.extractExistingCards(content);
    const prompt = this.ankiModule.buildPrompt({
      noteContent: content,
      existingCards,
      cardFormat: this.settings.ankiCardFormat,
    });

    const task = createTask({
      type: "anki",
      action: "suggest-cards",
      payload: {
        notePath: path,
        systemPrompt: prompt.system,
        prompt: prompt.prompt,
        maxTokens: prompt.maxTokens,
      },
      trigger: TaskTrigger.Automatic,
    });

    this.orchestrator.queue.enqueue(task);
  }

  // --- Anki completion handler ---

  private async handleAnkiResult(task: Task, response: LLMResponse): Promise<void> {
    const cards = this.ankiModule.parseResponse(response.content);
    if (!cards || cards.length === 0) return;

    const notePath = task.payload.notePath;
    if (!this.vaultService.noteExists(notePath)) return;

    // Emit each card as a suggestion
    for (const card of cards) {
      const cardText = this.ankiModule.formatCardMarkdown(card);
      const sug = createSuggestion({
        type: "anki-card",
        sourceNotePath: notePath,
        title: card.type === "basic" ? card.front : card.text.slice(0, 50) + "...",
        detail: card.type === "basic" ? `${card.front}::${card.back}` : card.text,
        editable: cardText,
      });
      this.suggestionsStore.add(sug);
    }

    await this.saveSuggestionsStore();
    this.suggestionsPanel?.refresh();
    showNotice(`${cards.length} card suggestions — check the panel`);
  }

  // --- Suggestion acceptance handler ---

  private createSuggestionHandler(): SuggestionHandler {
    return {
      onAccept: async (suggestion: Suggestion) => {
        switch (suggestion.type) {
          case "tag":
            await this.acceptTagSuggestion(suggestion);
            break;
          case "connection":
            await this.acceptConnectionSuggestion(suggestion);
            break;
          case "anki-card":
            await this.acceptAnkiCardSuggestion(suggestion);
            break;
        }
        await this.saveSuggestionsStore();
      },
      onDismiss: async (suggestion: Suggestion) => {
        if (suggestion.type === "tag") {
          await this.dismissTagSuggestion(suggestion);
        }
        await this.saveSuggestionsStore();
      },
    };
  }

  private async acceptTagSuggestion(suggestion: Suggestion): Promise<void> {
    const fm = await this.vaultService.parseFrontmatter(suggestion.sourceNotePath);
    const existingTags: string[] = fm.tags ?? [];
    const suggestedTags: string[] = fm["suggested-tags"] ?? [];

    // Remove just this tag from suggested-tags
    const remainingSuggested = suggestedTags.filter(t => t !== suggestion.title);

    await this.vaultService.updateFrontmatter(suggestion.sourceNotePath, {
      tags: [...new Set([...existingTags, suggestion.title])],
      "suggested-tags": remainingSuggested.length > 0 ? remainingSuggested : undefined,
      "ai-tagged": true,
    });
  }

  private async dismissTagSuggestion(suggestion: Suggestion): Promise<void> {
    const fm = await this.vaultService.parseFrontmatter(suggestion.sourceNotePath);
    const existingRejected: string[] = fm["rejected-tags"] ?? [];
    const suggestedTags: string[] = fm["suggested-tags"] ?? [];
    const remainingSuggested = suggestedTags.filter(t => t !== suggestion.title);

    await this.vaultService.updateFrontmatter(suggestion.sourceNotePath, {
      "rejected-tags": [...existingRejected, suggestion.title],
      "suggested-tags": remainingSuggested.length > 0 ? remainingSuggested : undefined,
    });
  }

  private async acceptConnectionSuggestion(suggestion: Suggestion): Promise<void> {
    const content = await this.vaultService.readNote(suggestion.sourceNotePath);
    if (!content) return;

    const linkName = suggestion.title;
    const relatedLine = `- [[${linkName}]] — ${suggestion.detail}`;

    if (content.includes("\n## Related")) {
      const beforeRelated = content.split("\n## Related")[0];
      const afterParts = content.split("\n## Related")[1] ?? "";
      const updated = `${beforeRelated}\n## Related${afterParts.replace(/\s*$/, "")}\n${relatedLine}\n`;
      await this.vaultService.writeNote(suggestion.sourceNotePath, updated);
    } else {
      await this.vaultService.writeNote(
        suggestion.sourceNotePath,
        `${content.replace(/\s*$/, "")}\n\n## Related\n${relatedLine}\n`,
      );
    }
  }

  private async acceptAnkiCardSuggestion(suggestion: Suggestion): Promise<void> {
    const cardText = suggestion.editable ?? suggestion.detail;
    const notePath = suggestion.sourceNotePath;

    if (this.settings.ankiCardLocation === "separate-file") {
      const cardFilePath = this.cardMigration.getCardFilePath(
        notePath,
        `${ASSISTANT_FOLDER}/cards`,
      );
      const existing = await this.vaultService.readNote(cardFilePath);
      if (existing) {
        const updated = this.ankiModule.appendCardsToContent(existing, [cardText]);
        await this.vaultService.writeNote(cardFilePath, updated);
      } else {
        const content = this.ankiModule.buildFlashcardsSection([cardText]);
        await this.vaultService.writeNote(cardFilePath, content.trim() + "\n");
      }
    } else {
      const content = await this.vaultService.readNote(notePath);
      if (!content) return;
      const updated = this.ankiModule.appendCardsToContent(content, [cardText]);
      await this.vaultService.writeNote(notePath, updated);
    }
  }

  // --- Card migration ---

  private async queueCardMigration(oldLocation: string, newLocation: string): Promise<void> {
    showNotice("Migrating cards...");
    await this.handleCardMigration(newLocation);
  }

  private async handleCardMigration(toLocation: string): Promise<void> {
    const cardsFolder = `${ASSISTANT_FOLDER}/cards`;
    const files = this.vaultService.getMarkdownFiles();

    for (const file of files) {
      if (file.path.startsWith(`${ASSISTANT_FOLDER}/`)) continue;

      if (toLocation === "separate-file") {
        await this.cardMigration.migrateToSeparateFile(file.path, cardsFolder);
      } else {
        await this.cardMigration.migrateToInNote(file.path, cardsFolder);
      }
    }
    showNotice("Card migration complete.");
  }
}
