export enum TaskPriority {
  High = "high",       // manual/user-initiated
  Normal = "normal",   // automatic triggers
  Low = "low",         // background scans
}

export enum TaskStatus {
  Pending = "pending",
  InProgress = "in-progress",
  Completed = "completed",
  Deferred = "deferred",
  Failed = "failed",
}

export enum TaskTrigger {
  Automatic = "automatic",
  Manual = "manual",
}

export type TaskType = "tagger" | "connection-detector" | "dashboard" | "anki";

export type TaskAction =
  | "tag-note"
  | "tag-batch"
  | "audit-tags"
  | "scan-connections"
  | "scan-connections-deep"
  | "generate-dashboard"
  | "log-habit"
  | "suggest-cards"
  | "migrate-cards";

export const SCHEMA_VERSION = 1;

export const DEFAULT_TAG_STYLE_GUIDE = `# Tag Style Guide

- Use kebab-case (e.g., \`machine-learning\`, not \`MachineLearning\`)
- Use singular form (e.g., \`project\`, not \`projects\`)
- Maximum nesting depth: 3 levels (e.g., \`tech/ml/transformers\`)
- Keep tags descriptive but concise
`;

export const ASSISTANT_FOLDER = "AI-Assistant";
