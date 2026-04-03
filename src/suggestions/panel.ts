import { ItemView, WorkspaceLeaf, MarkdownView } from "obsidian";
import { SuggestionsStore } from "./store";
import { Suggestion, SuggestionType } from "./suggestion";

export const SUGGESTIONS_VIEW_TYPE = "assistant-suggestions";

export interface SuggestionHandler {
  onAccept(suggestion: Suggestion): Promise<void>;
  onDismiss(suggestion: Suggestion): Promise<void>;
}

export class SuggestionsPanel extends ItemView {
  private store: SuggestionsStore;
  private handler: SuggestionHandler;
  private setupGuideHtml: string | null = null;
  private expandedGroups = new Set<SuggestionType>();

  constructor(
    leaf: WorkspaceLeaf,
    store: SuggestionsStore,
    handler: SuggestionHandler,
  ) {
    super(leaf);
    this.store = store;
    this.handler = handler;
  }

  getViewType(): string {
    return SUGGESTIONS_VIEW_TYPE;
  }

  getDisplayText(): string {
    return "AI Suggestions";
  }

  getIcon(): string {
    return "lightbulb";
  }

  setSetupGuide(html: string | null): void {
    this.setupGuideHtml = html;
    this.refresh();
  }

  refresh(): void {
    const container = this.containerEl.children[1] as HTMLElement;
    if (!container) return;
    container.empty();
    this.renderContent(container);
  }

  async onOpen(): Promise<void> {
    const container = this.containerEl.children[1] as HTMLElement;
    container.empty();
    container.addClass("assistant-suggestions-panel");
    this.renderContent(container);

    // Listen for active file changes
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", () => this.refresh()),
    );
  }

  async onClose(): Promise<void> {
    // Nothing to clean up
  }

  private renderContent(container: HTMLElement): void {
    // Setup guide (if Anki plugin not detected)
    if (this.setupGuideHtml) {
      const guideEl = container.createDiv({ cls: "suggestion-setup-guide" });
      guideEl.innerHTML = this.setupGuideHtml;
      guideEl.style.padding = "12px";
      guideEl.style.marginBottom = "12px";
      guideEl.style.border = "1px solid var(--background-modifier-border)";
      guideEl.style.borderRadius = "6px";
      guideEl.style.fontSize = "0.85em";
    }

    // Current Note section
    const activeFile = this.app.workspace.getActiveViewOfType(MarkdownView)?.file;
    const currentNotePath = activeFile?.path ?? null;

    container.createEl("h4", { text: "Current Note" });
    if (currentNotePath) {
      const noteSuggestions = this.store.getForNote(currentNotePath);
      if (noteSuggestions.length === 0) {
        container.createEl("p", {
          text: "No suggestions for this note.",
          cls: "suggestion-empty",
        }).style.color = "var(--text-muted)";
      } else {
        for (const sug of noteSuggestions) {
          this.renderSuggestionRow(container, sug);
        }
      }
    } else {
      container.createEl("p", {
        text: "No note open.",
        cls: "suggestion-empty",
      }).style.color = "var(--text-muted)";
    }

    // All Pending section
    container.createEl("h4", { text: "All Pending" }).style.marginTop = "16px";

    const counts = this.store.getPendingCounts();
    const types: Array<{ type: SuggestionType; label: string }> = [
      { type: "tag", label: "Tags" },
      { type: "connection", label: "Connections" },
      { type: "anki-card", label: "Cards" },
    ];

    for (const { type, label } of types) {
      const count = counts[type];
      if (count === 0) {
        this.expandedGroups.delete(type);
        continue;
      }

      const group = container.createDiv({ cls: "suggestion-group" });
      const header = group.createDiv({ cls: "suggestion-group-header" });
      header.style.cursor = "pointer";
      header.style.display = "flex";
      header.style.justifyContent = "space-between";
      header.style.padding = "4px 0";

      const titleEl = header.createEl("span", { text: label });
      titleEl.style.fontWeight = "600";

      const badge = header.createEl("span", { text: String(count) });
      badge.style.background = "var(--interactive-accent)";
      badge.style.color = "var(--text-on-accent)";
      badge.style.borderRadius = "10px";
      badge.style.padding = "0 8px";
      badge.style.fontSize = "0.8em";

      const body = group.createDiv({ cls: "suggestion-group-body" });
      const isExpanded = this.expandedGroups.has(type);
      body.style.display = isExpanded ? "block" : "none";

      header.addEventListener("click", () => {
        const opening = body.style.display === "none";
        body.style.display = opening ? "block" : "none";
        if (opening) {
          this.expandedGroups.add(type);
        } else {
          this.expandedGroups.delete(type);
        }
      });

      const suggestions = this.store.getByType(type).filter(
        (s) => s.sourceNotePath !== currentNotePath, // Don't duplicate current note items
      );
      for (const sug of suggestions) {
        this.renderSuggestionRow(body, sug);
      }
    }
  }

  private renderSuggestionRow(parent: HTMLElement, suggestion: Suggestion): void {
    const row = parent.createDiv({ cls: "suggestion-row" });
    row.style.padding = "8px";
    row.style.marginBottom = "4px";
    row.style.border = "1px solid var(--background-modifier-border)";
    row.style.borderRadius = "4px";

    // Title line — for connections, show both notes
    if (suggestion.type === "connection") {
      const sourceName = suggestion.sourceNotePath.replace(/\.md$/, "").split("/").pop() ?? "";
      const targetName = suggestion.title.split("/").pop() ?? "";
      const linkLine = row.createDiv();
      linkLine.style.fontWeight = "500";
      linkLine.style.display = "flex";
      linkLine.style.gap = "4px";
      linkLine.style.alignItems = "center";

      const sourceLink = linkLine.createEl("span", { text: sourceName });
      sourceLink.style.cursor = "pointer";
      sourceLink.style.textDecoration = "underline";
      sourceLink.style.textDecorationStyle = "dotted";
      sourceLink.addEventListener("click", () => {
        this.app.workspace.openLinkText(suggestion.sourceNotePath, "");
      });

      linkLine.createEl("span", { text: " ↔ " });

      const targetLink = linkLine.createEl("span", { text: targetName });
      targetLink.style.cursor = "pointer";
      targetLink.style.textDecoration = "underline";
      targetLink.style.textDecorationStyle = "dotted";
      targetLink.addEventListener("click", () => {
        this.app.workspace.openLinkText(suggestion.title, "");
      });
    } else {
      const titleEl = row.createEl("div", { text: suggestion.title });
      titleEl.style.fontWeight = "500";
      titleEl.style.cursor = "pointer";
      titleEl.addEventListener("click", () => {
        this.app.workspace.openLinkText(suggestion.sourceNotePath, "");
      });
    }

    // Detail
    if (suggestion.detail) {
      const detailEl = row.createEl("div", { text: suggestion.detail });
      detailEl.style.fontSize = "0.85em";
      detailEl.style.color = "var(--text-muted)";
      detailEl.style.marginTop = "2px";
    }

    // Editable area for Anki cards
    if (suggestion.type === "anki-card" && suggestion.editable !== undefined) {
      const textarea = row.createEl("textarea");
      textarea.value = suggestion.editable;
      textarea.style.width = "100%";
      textarea.style.minHeight = "40px";
      textarea.style.marginTop = "6px";
      textarea.style.fontFamily = "var(--font-monospace)";
      textarea.style.fontSize = "0.85em";
      textarea.style.resize = "vertical";
      textarea.addEventListener("input", () => {
        this.store.updateEditable(suggestion.id, textarea.value);
      });
    }

    // Action buttons
    const actions = row.createDiv();
    actions.style.marginTop = "6px";
    actions.style.display = "flex";
    actions.style.gap = "6px";

    const acceptBtn = actions.createEl("button", { text: "Accept" });
    acceptBtn.style.fontSize = "0.8em";
    acceptBtn.addClass("mod-cta");
    acceptBtn.addEventListener("click", async () => {
      try {
        await this.handler.onAccept(suggestion);
        this.store.accept(suggestion.id);
      } catch (e: any) {
        const { Notice } = await import("obsidian");
        new Notice(`Failed to accept suggestion: ${e.message ?? e}`);
      }
      this.refresh();
    });

    const dismissBtn = actions.createEl("button", { text: "Dismiss" });
    dismissBtn.style.fontSize = "0.8em";
    dismissBtn.addEventListener("click", async () => {
      try {
        await this.handler.onDismiss(suggestion);
        this.store.dismiss(suggestion.id);
      } catch (e: any) {
        const { Notice } = await import("obsidian");
        new Notice(`Failed to dismiss suggestion: ${e.message ?? e}`);
      }
      this.refresh();
    });
  }
}
