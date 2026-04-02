import { Plugin } from "obsidian";

export default class AssistantPlugin extends Plugin {
  async onload() {
    console.log("AI Assistant loaded");
  }

  onunload() {
    console.log("AI Assistant unloaded");
  }
}
