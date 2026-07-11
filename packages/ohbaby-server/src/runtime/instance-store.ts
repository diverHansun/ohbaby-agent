import { resolveWorkspaceScope } from "./workspace-scope.js";

export interface DisposableWorkspaceInstance {
  dispose(): Promise<void> | void;
}

export interface InstanceStoreOptions<T extends DisposableWorkspaceInstance> {
  readonly create: (scopeKey: string) => Promise<T> | T;
  readonly resolveScope?: (directory: string) => Promise<string>;
}

export class InstanceStore<T extends DisposableWorkspaceInstance> {
  private readonly entries = new Map<string, Promise<T>>();
  private readonly resolveScope: (directory: string) => Promise<string>;

  constructor(private readonly options: InstanceStoreOptions<T>) {
    this.resolveScope = options.resolveScope ?? resolveWorkspaceScope;
  }

  async load(directory: string): Promise<T> {
    const scopeKey = await this.resolveScope(directory);
    return this.loadScope(scopeKey);
  }

  async loadScope(scopeKey: string): Promise<T> {
    const existing = this.entries.get(scopeKey);
    if (existing) {
      return existing;
    }

    const pending = Promise.resolve().then(() => this.options.create(scopeKey));
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

  async disposeAll(): Promise<void> {
    const entries = [...this.entries.values()];
    this.entries.clear();
    const instances = await Promise.allSettled(entries);
    const disposals = instances.flatMap((result) =>
      result.status === "fulfilled"
        ? [Promise.resolve().then(() => result.value.dispose())]
        : [],
    );
    const results = await Promise.allSettled(disposals);
    const failure = results.find(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failure) {
      throw failure.reason;
    }
  }
}
