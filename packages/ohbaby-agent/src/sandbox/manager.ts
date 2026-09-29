import path from "node:path";
import { canonicalizePathTarget } from "../utils/path-canonicalize.js";
import { SandboxAdapterError } from "./errors.js";
import {
  SandboxContextAlreadyExistsError,
  SandboxContextNotFoundError,
} from "./errors.js";
import {
  freezeCapabilities,
  type InternalSandboxContext,
  snapshotContext,
} from "./context.js";
import { createSandboxLease } from "./lease.js";
import { normalizeSandboxScope } from "./scope.js";
import { TrustedRootRegistry } from "./trusted-roots.js";
import type {
  CreateContextOptions,
  SandboxAcquireTarget,
  SandboxContext,
  SandboxLease,
  SandboxManagerPort,
  SandboxManagerOptions,
  SandboxScopeInput,
} from "./types.js";

const DEFAULT_ADAPTER_ID = "host-local";
const DEFAULT_DRAIN_TIMEOUT_MS = 1_000;

function randomId(prefix: string): string {
  const random = Math.random().toString(36).slice(2, 10);
  return `${prefix}_${Date.now().toString(36)}_${random}`;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class SandboxManager implements SandboxManagerPort {
  private readonly contexts = new Map<string, InternalSandboxContext>();
  private readonly leases = new Map<string, InternalSandboxContext>();
  private readonly retainedOperations = new Map<
    InternalSandboxContext,
    number
  >();
  private readonly deferredDestruction = new Set<InternalSandboxContext>();
  private readonly physicalDestruction = new WeakMap<
    InternalSandboxContext,
    Promise<void>
  >();
  private readonly pendingCreates = new Set<string>();
  private readonly pendingCreateSettlements = new Map<string, Promise<void>>();
  private readonly pendingDestroys = new Map<string, Promise<void>>();
  private readonly drainTimeoutMs: number;
  private readonly now: () => number;
  private readonly createContextId: () => string;
  private readonly createLeaseId: () => string;
  private disposed = false;
  private disposePromise: Promise<void> | undefined;

  constructor(private readonly options: SandboxManagerOptions) {
    this.drainTimeoutMs = options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.createContextId =
      options.createContextId ?? ((): string => randomId("sandbox_context"));
    this.createLeaseId =
      options.createLeaseId ?? ((): string => randomId("sandbox_lease"));
  }

  async createContext(
    input: SandboxScopeInput,
    options: CreateContextOptions,
  ): Promise<SandboxContext> {
    if (this.disposed) {
      throw new Error("Sandbox manager is disposed");
    }
    const scope = normalizeSandboxScope(input);
    if (
      this.contexts.has(scope.scopeKey) ||
      this.pendingCreates.has(scope.scopeKey)
    ) {
      throw new SandboxContextAlreadyExistsError(scope.scopeKey);
    }

    this.pendingCreates.add(scope.scopeKey);
    let settleCreate!: () => void;
    const createSettlement = new Promise<void>((resolve) => {
      settleCreate = resolve;
    });
    this.pendingCreateSettlements.set(scope.scopeKey, createSettlement);
    const adapterId = options.adapterId ?? DEFAULT_ADAPTER_ID;
    try {
      const adapter = this.options.adapterRegistry.get(adapterId);
      if (!adapter) {
        throw new SandboxAdapterError(
          `Sandbox adapter not found: ${adapterId}`,
          {
            adapterId,
          },
        );
      }
      const handle = await adapter.create({
        contextScopeId: scope.contextScopeId,
        scopeKey: scope.scopeKey,
        sessionId: scope.sessionId,
        workdir: path.resolve(options.workdir),
      });
      const workdir = await canonicalizePathTarget(handle.workdir);
      const capabilities = freezeCapabilities(adapter.getCapabilities(handle));
      const context: InternalSandboxContext = {
        adapter,
        adapterId,
        capabilities,
        contextId: this.createContextId(),
        contextScopeId: scope.contextScopeId,
        createdAt: this.now(),
        handle: { ...handle, workdir },
        leaseCount: 0,
        scopeKey: scope.scopeKey,
        sessionId: scope.sessionId,
        status: "active",
        trustedRoots: await TrustedRootRegistry.create(workdir),
        waiters: [],
        workdir,
      };
      this.contexts.set(scope.scopeKey, context);

      return snapshotContext(context);
    } finally {
      this.pendingCreates.delete(scope.scopeKey);
      if (
        this.pendingCreateSettlements.get(scope.scopeKey) === createSettlement
      ) {
        this.pendingCreateSettlements.delete(scope.scopeKey);
      }
      settleCreate();
    }
  }

  async ensureContext(
    input: SandboxScopeInput,
    options: CreateContextOptions,
  ): Promise<SandboxContext> {
    const scope = normalizeSandboxScope(input);
    const existing = this.contexts.get(scope.scopeKey);
    if (existing?.status === "active") {
      return snapshotContext(existing);
    }

    return this.createContext(scope, options);
  }

  acquire(input: SandboxAcquireTarget): Promise<SandboxLease> {
    if (this.disposed) {
      return Promise.reject(new Error("Sandbox manager is disposed"));
    }
    const scope = normalizeSandboxScope(input);
    const context = this.contexts.get(scope.scopeKey);
    if (context?.status !== "active") {
      return Promise.reject(new SandboxContextNotFoundError(scope.scopeKey));
    }

    context.leaseCount += 1;
    const leaseId = this.createLeaseId();
    this.leases.set(leaseId, context);

    return Promise.resolve(
      createSandboxLease({
        authorizeInternalRead: this.options.authorizeInternalRead,
        context,
        leaseId,
        release: (releasedLeaseId) => this.releaseById(releasedLeaseId),
        retain: () => this.retainOperation(context),
      }),
    );
  }

  async release(lease: SandboxLease): Promise<void> {
    await lease.release();
  }

  getContext(input: SandboxScopeInput): SandboxContext | undefined {
    const scope = normalizeSandboxScope(input);
    const context = this.contexts.get(scope.scopeKey);
    return context ? snapshotContext(context) : undefined;
  }

  destroyContext(input: SandboxScopeInput): Promise<void> {
    const scope = normalizeSandboxScope(input);
    const existing = this.pendingDestroys.get(scope.scopeKey);
    if (existing) {
      return existing;
    }
    // Closing admission is synchronous, before awaiting pending creation/drain.
    const context = this.contexts.get(scope.scopeKey);
    if (context?.status === "active") context.status = "destroying";
    const operation = this.destroyContextAfterCreate(scope);
    this.pendingDestroys.set(scope.scopeKey, operation);
    const clear = (): void => {
      if (this.pendingDestroys.get(scope.scopeKey) === operation) {
        this.pendingDestroys.delete(scope.scopeKey);
      }
    };
    void operation.then(clear, clear);
    return operation;
  }

  async destroySessionContexts(sessionId: string): Promise<void> {
    await Promise.all([...this.pendingCreateSettlements.values()]);
    await Promise.all(
      [...this.contexts.values()]
        .filter((context) => context.sessionId === sessionId)
        .map((context) =>
          this.destroyContext({
            contextScopeId: context.contextScopeId,
            sessionId: context.sessionId,
          }),
        ),
    );
  }

  dispose(): Promise<void> {
    if (this.disposePromise) {
      return this.disposePromise;
    }
    this.disposed = true;
    const operation = (async (): Promise<void> => {
      await Promise.all([...this.pendingCreateSettlements.values()]);
      await Promise.all(
        [...this.contexts.values()].map((context) =>
          this.destroyContext({
            contextScopeId: context.contextScopeId,
            sessionId: context.sessionId,
          }),
        ),
      );
    })();
    this.disposePromise = operation;
    return operation;
  }

  private async destroyContextAfterCreate(
    input: SandboxScopeInput,
  ): Promise<void> {
    const scope = normalizeSandboxScope(input);
    await this.pendingCreateSettlements.get(scope.scopeKey);
    const context = this.contexts.get(scope.scopeKey);
    if (!context) {
      return;
    }
    if (
      context.status === "destroyed" ||
      this.deferredDestruction.has(context)
    ) {
      return;
    }

    context.status = "destroying";
    await this.waitForDrain(context);
    if ((this.retainedOperations.get(context) ?? 0) > 0) {
      // Logical disposal is bounded; real operations keep the original adapter alive.
      this.deferredDestruction.add(context);
      return;
    }
    await this.destroyPhysicalContext(context);
  }

  private retainOperation(
    context: InternalSandboxContext,
  ): () => Promise<void> {
    if (context.status !== "active")
      throw new Error("Sandbox context is closing");
    this.retainedOperations.set(
      context,
      (this.retainedOperations.get(context) ?? 0) + 1,
    );
    let released = false;
    return async (): Promise<void> => {
      if (released) return;
      released = true;
      const remaining = (this.retainedOperations.get(context) ?? 1) - 1;
      if (remaining > 0) {
        this.retainedOperations.set(context, remaining);
        return;
      }
      this.retainedOperations.delete(context);
      if (this.deferredDestruction.has(context))
        await this.destroyPhysicalContext(context);
    };
  }

  private destroyPhysicalContext(
    context: InternalSandboxContext,
  ): Promise<void> {
    const existing = this.physicalDestruction.get(context);
    if (existing) return existing;
    this.deferredDestruction.delete(context);
    context.leaseCount = 0;
    context.status = "destroyed";
    for (const [leaseId, leaseContext] of this.leases.entries()) {
      if (leaseContext === context) {
        this.leases.delete(leaseId);
      }
    }
    if (this.contexts.get(context.scopeKey) === context)
      this.contexts.delete(context.scopeKey);
    const operation = Promise.resolve().then(() =>
      context.adapter.destroy(context.handle),
    );
    this.physicalDestruction.set(context, operation);
    return operation;
  }

  private releaseById(leaseId: string): Promise<void> {
    const context = this.leases.get(leaseId);
    if (!context) {
      return Promise.resolve();
    }
    this.leases.delete(leaseId);
    context.leaseCount = Math.max(0, context.leaseCount - 1);
    if (context.leaseCount === 0) {
      for (const waiter of context.waiters.splice(0)) {
        waiter();
      }
    }

    return Promise.resolve();
  }

  private async waitForDrain(context: InternalSandboxContext): Promise<void> {
    if (context.leaseCount === 0) {
      return;
    }

    await Promise.race([
      new Promise<void>((resolve) => {
        context.waiters.push(resolve);
      }),
      delay(this.drainTimeoutMs),
    ]);
  }
}
