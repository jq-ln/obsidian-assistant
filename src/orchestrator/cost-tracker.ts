import { MODEL_PRICING, SCHEMA_VERSION } from "../types";

export interface UsageRecord {
  model: string;
  tokensIn: number;
  tokensOut: number;
  taskType: string;
}

export interface CostSummary {
  todayDollars: number;
  monthDollars: number;
  todayTokensIn: number;
  todayTokensOut: number;
  callCount: number;
}

interface CostTrackerState {
  schemaVersion: number;
  currentDay: string;
  currentMonth: string;
  todayDollars: number;
  monthDollars: number;
  todayTokensIn: number;
  todayTokensOut: number;
  callCount: number;
  history: Array<{
    timestamp: number;
    model: string;
    tokensIn: number;
    tokensOut: number;
    cost: number;
    taskType: string;
  }>;
}

export class CostTracker {
  private state: CostTrackerState;

  constructor() {
    const now = new Date();
    this.state = {
      schemaVersion: SCHEMA_VERSION,
      currentDay: this.dayKey(now),
      currentMonth: this.monthKey(now),
      todayDollars: 0,
      monthDollars: 0,
      todayTokensIn: 0,
      todayTokensOut: 0,
      callCount: 0,
      history: [],
    };
  }

  private dayKey(date: Date): string {
    return date.toISOString().split("T")[0];
  }

  private monthKey(date: Date): string {
    return date.toISOString().slice(0, 7);
  }

  private rollOver(): void {
    const now = new Date();
    const today = this.dayKey(now);
    const month = this.monthKey(now);

    if (this.state.currentDay !== today) {
      this.state.todayDollars = 0;
      this.state.todayTokensIn = 0;
      this.state.todayTokensOut = 0;
      this.state.callCount = 0;
      this.state.currentDay = today;
    }

    if (this.state.currentMonth !== month) {
      this.state.monthDollars = 0;
      this.state.currentMonth = month;
    }
  }

  private calculateCost(model: string, tokensIn: number, tokensOut: number): number {
    const pricing = MODEL_PRICING[model];
    if (!pricing) return 0;
    return (tokensIn / 1_000_000) * pricing.input + (tokensOut / 1_000_000) * pricing.output;
  }

  recordUsage(record: UsageRecord): void {
    this.rollOver();
    const cost = this.calculateCost(record.model, record.tokensIn, record.tokensOut);

    this.state.todayDollars += cost;
    this.state.monthDollars += cost;
    this.state.todayTokensIn += record.tokensIn;
    this.state.todayTokensOut += record.tokensOut;
    this.state.callCount += 1;

    this.state.history.push({
      timestamp: Date.now(),
      model: record.model,
      tokensIn: record.tokensIn,
      tokensOut: record.tokensOut,
      cost,
      taskType: record.taskType,
    });

    // Prune entries older than 30 days to prevent unbounded growth
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000;
    this.state.history = this.state.history.filter((h) => h.timestamp > thirtyDaysAgo);
  }

  /** Check if an estimated cost would exceed the configured budgets. 0 means unlimited. */
  wouldExceedBudget(
    estimatedCost: number,
    dailyBudget: number,
    monthlyBudget: number,
  ): boolean {
    this.rollOver();
    if (dailyBudget > 0 && this.state.todayDollars + estimatedCost > dailyBudget) {
      return true;
    }
    if (monthlyBudget > 0 && this.state.monthDollars + estimatedCost > monthlyBudget) {
      return true;
    }
    return false;
  }

  getSummary(): CostSummary {
    this.rollOver();
    return {
      todayDollars: this.state.todayDollars,
      monthDollars: this.state.monthDollars,
      todayTokensIn: this.state.todayTokensIn,
      todayTokensOut: this.state.todayTokensOut,
      callCount: this.state.callCount,
    };
  }

  serialize(): string {
    return JSON.stringify(this.state, null, 2);
  }

  static deserialize(json: string): CostTracker {
    const tracker = new CostTracker();
    const data: CostTrackerState = JSON.parse(json);
    tracker.state = data;
    tracker.rollOver();
    return tracker;
  }
}
