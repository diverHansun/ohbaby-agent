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
  private readonly pendingCreates = new Set<string>();
  private readonly pendingCreateSettlements = new Map<string, Promise<void>>();
  private readonly pendingDestroys = new Map<string, Promise<void>>();
  private readonly drainTimeoutMs: number;
  private readonly now: () => number;
  private readonly createContextId: () => string;
  private readonly createLeaseId: () => string;

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
        context,
        leaseId,
        release: (releasedLeaseId) => this.releaseById(releasedLeaseId),
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

  private async destroyContextAfterCreate(
    input: SandboxScopeInput,
  ): Promise<void> {
    const scope = normalizeSandboxScope(input);
    await this.pendingCreateSettlements.get(scope.scopeKey);
    const context = this.contexts.get(scope.scopeKey);
    if (!context) {
      return;
    }
    if (context.status === "destroyed") {
      return;
    }

    context.status = "destroying";
    await this.waitForDrain(context);
    context.leaseCount = 0;
    context.status = "destroyed";
    for (const [leaseId, leaseContext] of this.leases.entries()) {
      if (leaseContext === context) {
        this.leases.delete(leaseId);
      }
    }
    this.contexts.delete(scope.scopeKey);
    await context.adapter.destroy(context.handle);
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
