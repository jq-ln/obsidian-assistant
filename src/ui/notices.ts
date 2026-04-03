import { Notice } from "obsidian";

export function showNotice(message: string, durationMs = 5000): void {
  new Notice(message, durationMs);
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
