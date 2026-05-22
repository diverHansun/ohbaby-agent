import type {
  AgentTaskRecord,
  AgentTaskStore,
  AgentTaskStoreUpdate,
} from "./types.js";

export class InMemoryAgentTaskStore implements AgentTaskStore {
  private readonly records = new Map<string, AgentTaskRecord>();

  create(record: AgentTaskRecord): Promise<AgentTaskRecord> {
    this.records.set(record.taskId, record);
    return Promise.resolve(record);
  }

  get(taskId: string): Promise<AgentTaskRecord | null> {
    return Promise.resolve(this.records.get(taskId) ?? null);
  }

  update(
    taskId: string,
    update: AgentTaskStoreUpdate,
  ): Promise<AgentTaskRecord> {
    const existing = this.records.get(taskId);
    if (!existing) {
      return Promise.reject(new Error(`Agent task not found: ${taskId}`));
    }
    const next = { ...existing, ...update };
    this.records.set(taskId, next);
    return Promise.resolve(next);
  }

  list(): Promise<readonly AgentTaskRecord[]> {
    return Promise.resolve(Array.from(this.records.values()));
  }
}
