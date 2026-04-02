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
