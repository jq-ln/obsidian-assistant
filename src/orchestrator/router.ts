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
