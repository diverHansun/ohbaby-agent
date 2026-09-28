import type { ShutdownOptions, CleanupTaskResult } from "ohbaby-agent";
import { resolveWorkspaceScope } from "./workspace-scope.js";

export interface DisposableWorkspaceInstance {
  closeAdmission?(): void;
  dispose(
    options?: ShutdownOptions,
  ): Promise<CleanupTaskResult> | CleanupTaskResult;
}

export interface InstanceStoreOptions<T extends DisposableWorkspaceInstance> {
  readonly create: (scopeKey: string) => Promise<T> | T;
  readonly resolveScope?: (directory: string) => Promise<string>;
}

export class InstanceStore<T extends DisposableWorkspaceInstance> {
  private closing = false;
  private readonly instances = new Map<string, T>();
  private readonly entries = new Map<string, Promise<T>>();
  private readonly resolveScope: (directory: string) => Promise<string>;

  constructor(private readonly options: InstanceStoreOptions<T>) {
    this.resolveScope = options.resolveScope ?? resolveWorkspaceScope;
  }

  async load(directory: string): Promise<T> {
    if (this.closing) throw new Error("Workspace store is closing");
    const scopeKey = await this.resolveScope(directory);
    return this.loadScope(scopeKey);
  }

  async loadScope(scopeKey: string): Promise<T> {
    if (this.closing) throw new Error("Workspace store is closing");
    const existing = this.entries.get(scopeKey);
    if (existing) {
      return existing;
    }

    const pending = Promise.resolve()
      .then(() => {
        if (this.closing) throw new Error("Workspace store is closing");
        return this.options.create(scopeKey);
      })
      .then((instance) => {
        this.instances.set(scopeKey, instance);
        if (this.closing) instance.closeAdmission?.();
        return instance;
      });
    this.entries.set(scopeKey, pending);
    try {
      return await pending;
    } catch (error) {
      if (this.entries.get(scopeKey) === pending) {
        this.entries.delete(scopeKey);
      }
      throw error;
    }
  }

  get(scopeKey: string): Promise<T> | undefined {
    return this.entries.get(scopeKey);
  }

  loadedScopeKeys(): readonly string[] {
    return [...this.entries.keys()];
  }

  closeAdmission(): void {
    if (this.closing) return;
    this.closing = true;
    for (const instance of this.instances.values()) instance.closeAdmission?.();
  }

  async disposeAll(options?: ShutdownOptions): Promise<void> {
    this.closeAdmission();
    const entries = [...this.entries.values()];
    this.entries.clear();
    const instances = await Promise.allSettled(entries);
    const disposals = instances.flatMap((result) =>
      result.status === "fulfilled"
        ? [Promise.resolve().then(() => result.value.dispose(options))]
        : [],
    );
    const results = await Promise.allSettled(disposals);
    this.instances.clear();
    for (const result of results) {
      if (
        result.status === "fulfilled" &&
        result.value?.status === "unconfirmed"
      )
        throw new Error(result.value.errors.join("; "));
    }
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure) {
      throw failure.reason;
    }
  }
}
