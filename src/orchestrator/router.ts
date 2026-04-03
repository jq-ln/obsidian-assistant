import { Task } from "./task";
import { LLMProvider } from "../llm/provider";

export interface RoutingDecision {
  action: "execute" | "defer";
  provider: LLMProvider | null;
}

export class TaskRouter {
  private provider: LLMProvider;

  constructor(provider: LLMProvider) {
    this.provider = provider;
  }

  async route(_task: Task): Promise<RoutingDecision> {
    if (await this.provider.isAvailable()) {
      return { action: "execute", provider: this.provider };
    }
    return { action: "defer", provider: null };
  }
}
