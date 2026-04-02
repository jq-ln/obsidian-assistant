import {
  ModelRequirement,
  TaskPriority,
  TaskStatus,
  TaskTrigger,
  TaskType,
  TaskAction,
} from "../types";

export interface Task {
  id: string;
  type: TaskType;
  action: TaskAction;
  payload: Record<string, any>;
  modelRequirement: ModelRequirement;
  trigger: TaskTrigger;
  priority: TaskPriority;
  status: TaskStatus;
  retryCount: number;
  maxRetries: number;
  error: string | null;
  created: number;
}

let nextId = 1;

export function createTask(
  params: Pick<Task, "type" | "action" | "payload" | "modelRequirement" | "trigger"> &
    Partial<Pick<Task, "priority" | "maxRetries">>,
): Task {
  return {
    id: String(nextId++),
    type: params.type,
    action: params.action,
    payload: params.payload,
    modelRequirement: params.modelRequirement,
    trigger: params.trigger,
    priority:
      params.trigger === TaskTrigger.Manual
        ? TaskPriority.High
        : params.priority ?? TaskPriority.Normal,
    status: TaskStatus.Pending,
    retryCount: 0,
    maxRetries: params.maxRetries ?? 3,
    error: null,
    created: Date.now(),
  };
}

/** Reset the ID counter — only for tests. */
export function _resetIdCounter(): void {
  nextId = 1;
}

/** Sync the ID counter with existing task IDs to avoid collisions after deserialization. */
export function syncIdCounter(existingIds: string[]): void {
  const maxId = existingIds.reduce((max, id) => {
    const num = parseInt(id, 10);
    return isNaN(num) ? max : Math.max(max, num);
  }, 0);
  nextId = maxId + 1;
}
