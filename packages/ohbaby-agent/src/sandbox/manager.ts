import path from "node:path";
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
import type {
  CreateContextOptions,
  SandboxContext,
  SandboxLease,
  SandboxManagerOptions,
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

export class SandboxManager {
  private readonly contexts = new Map<string, InternalSandboxContext>();
  private readonly leases = new Map<string, InternalSandboxContext>();
  private readonly pendingCreates = new Set<string>();
  private readonly drainTimeoutMs: number;
  private readonly now: () => number;
  private readonly createContextId: () => string;
  private readonly createLeaseId: () => string;

  constructor(private readonly options: SandboxManagerOptions) {
    this.drainTimeoutMs =
      options.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.createContextId =
      options.createContextId ?? ((): string => randomId("sandbox_context"));
    this.createLeaseId =
      options.createLeaseId ?? ((): string => randomId("sandbox_lease"));
  }

  async createContext(
    sessionId: string,
    options: CreateContextOptions,
  ): Promise<SandboxContext> {
    if (this.contexts.has(sessionId) || this.pendingCreates.has(sessionId)) {
      throw new SandboxContextAlreadyExistsError(sessionId);
    }

    this.pendingCreates.add(sessionId);
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
        sessionId,
        workdir: path.resolve(options.workdir),
      });
      const capabilities = freezeCapabilities(adapter.getCapabilities(handle));
      const context: InternalSandboxContext = {
        adapter,
        adapterId,
        capabilities,
        contextId: this.createContextId(),
        createdAt: this.now(),
        handle,
        leaseCount: 0,
        sessionId,
        status: "active",
        waiters: [],
        workdir: path.resolve(handle.workdir),
      };
      this.contexts.set(sessionId, context);

      return snapshotContext(context);
    } finally {
      this.pendingCreates.delete(sessionId);
    }
  }

  async ensureContext(
    sessionId: string,
    options: CreateContextOptions,
  ): Promise<SandboxContext> {
    const existing = this.contexts.get(sessionId);
    if (existing?.status === "active") {
      return snapshotContext(existing);
    }

    return this.createContext(sessionId, options);
  }

  acquire(sessionId: string): Promise<SandboxLease> {
    const context = this.contexts.get(sessionId);
    if (context?.status !== "active") {
      return Promise.reject(new SandboxContextNotFoundError(sessionId));
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

  getContext(sessionId: string): SandboxContext | undefined {
    const context = this.contexts.get(sessionId);
    return context ? snapshotContext(context) : undefined;
  }

  async destroyContext(sessionId: string): Promise<void> {
    const context = this.contexts.get(sessionId);
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
    this.contexts.delete(sessionId);
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
