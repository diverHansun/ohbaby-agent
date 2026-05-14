import { describe, expect, it, vi } from "vitest";
import {
  AdapterRegistry,
  SandboxContextAlreadyExistsError,
  SandboxContextNotFoundError,
  SandboxManager,
  type SandboxAdapter,
  type SandboxAdapterHandle,
  type SandboxCreateOptions,
} from "./index.js";

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((innerResolve, innerReject) => {
    resolve = innerResolve;
    reject = innerReject;
  });

  return { promise, reject, resolve };
}

const CAPABILITIES = {
  canExecCommands: true,
  isolation: "none",
  readOnly: false,
  supportsGit: false,
} as const;

class FakeAdapter implements SandboxAdapter {
  readonly id = "fake";
  readonly created: SandboxCreateOptions[] = [];
  readonly destroyed: SandboxAdapterHandle[] = [];

  getCapabilities(): typeof CAPABILITIES {
    return CAPABILITIES;
  }

  create(options: SandboxCreateOptions): Promise<SandboxAdapterHandle> {
    this.created.push(options);
    return Promise.resolve({
      metadata: { sessionId: options.sessionId },
      workdir: options.workdir,
    });
  }

  destroy(handle: SandboxAdapterHandle): Promise<void> {
    this.destroyed.push(handle);
    return Promise.resolve();
  }
}

class BlockingCreateAdapter extends FakeAdapter {
  readonly createGate = createDeferred<SandboxAdapterHandle>();

  override create(options: SandboxCreateOptions): Promise<SandboxAdapterHandle> {
    this.created.push(options);
    return this.createGate.promise;
  }
}

function createManager(options: { readonly drainTimeoutMs?: number } = {}): {
  readonly adapter: FakeAdapter;
  readonly manager: SandboxManager;
} {
  const registry = new AdapterRegistry();
  const adapter = new FakeAdapter();
  registry.register(adapter);
  const manager = new SandboxManager({
    adapterRegistry: registry,
    drainTimeoutMs: options.drainTimeoutMs,
  });

  return { adapter, manager };
}

describe("SandboxManager", () => {
  it("creates contexts, rejects duplicates, and exposes context state", async () => {
    const { adapter, manager } = createManager();

    const context = await manager.createContext("session_1", {
      adapterId: "fake",
      workdir: "D:/repo",
    });

    expect(context).toMatchObject({
      adapterId: "fake",
      capabilities: CAPABILITIES,
      leaseCount: 0,
      sessionId: "session_1",
      status: "active",
    });
    expect(adapter.created).toHaveLength(1);
    expect(manager.getContext("session_1")).toMatchObject({
      contextId: context.contextId,
    });
    await expect(
      manager.createContext("session_1", {
        adapterId: "fake",
        workdir: "D:/repo",
      }),
    ).rejects.toBeInstanceOf(SandboxContextAlreadyExistsError);
  });

  it("rejects duplicate createContext calls while adapter creation is in flight", async () => {
    const registry = new AdapterRegistry();
    const adapter = new BlockingCreateAdapter();
    registry.register(adapter);
    const manager = new SandboxManager({ adapterRegistry: registry });

    const firstCreate = manager.createContext("session_1", {
      adapterId: "fake",
      workdir: "D:/repo",
    });
    const secondCreate = manager.createContext("session_1", {
      adapterId: "fake",
      workdir: "D:/repo",
    });

    try {
      const secondOutcome = await Promise.race([
        secondCreate.then(
          () => "resolved" as const,
          (error: unknown) =>
            error instanceof SandboxContextAlreadyExistsError
              ? ("duplicate-rejected" as const)
              : ("other-rejected" as const),
        ),
        new Promise<"pending">((resolve) => {
          setTimeout(() => {
            resolve("pending");
          }, 20);
        }),
      ]);

      expect(secondOutcome).toBe("duplicate-rejected");
      expect(adapter.created).toHaveLength(1);
    } finally {
      adapter.createGate.resolve({
        metadata: { sessionId: "session_1" },
        workdir: "D:/repo",
      });
      await Promise.allSettled([firstCreate, secondCreate]);
    }
  });

  it("ensureContext returns an existing context without creating another adapter handle", async () => {
    const { adapter, manager } = createManager();

    const first = await manager.ensureContext("session_1", {
      adapterId: "fake",
      workdir: "D:/repo",
    });
    const second = await manager.ensureContext("session_1", {
      adapterId: "fake",
      workdir: "D:/other",
    });

    expect(second).toEqual(first);
    expect(adapter.created).toHaveLength(1);
  });

  it("fails fast when acquiring a missing context", async () => {
    const { manager } = createManager();

    await expect(manager.acquire("missing")).rejects.toBeInstanceOf(
      SandboxContextNotFoundError,
    );
  });

  it("tracks independent leases and releases by lease or by manager", async () => {
    const { manager } = createManager();
    await manager.createContext("session_1", {
      adapterId: "fake",
      workdir: "D:/repo",
    });

    const first = await manager.acquire("session_1");
    const second = await manager.acquire("session_1");

    expect(manager.getContext("session_1")?.leaseCount).toBe(2);
    await first.release();
    expect(manager.getContext("session_1")?.leaseCount).toBe(1);
    await manager.release(second);
    await manager.release(second);
    expect(manager.getContext("session_1")?.leaseCount).toBe(0);
  });

  it("waits for active leases before destroying adapter state", async () => {
    const { adapter, manager } = createManager({ drainTimeoutMs: 1_000 });
    await manager.createContext("session_1", {
      adapterId: "fake",
      workdir: "D:/repo",
    });
    const lease = await manager.acquire("session_1");
    const destroyPromise = manager.destroyContext("session_1");
    await vi.waitFor(() => {
      expect(manager.getContext("session_1")?.status).toBe("destroying");
    });

    expect(adapter.destroyed).toHaveLength(0);
    await expect(manager.acquire("session_1")).rejects.toBeInstanceOf(
      SandboxContextNotFoundError,
    );
    await lease.release();
    await destroyPromise;

    expect(adapter.destroyed).toHaveLength(1);
    expect(manager.getContext("session_1")).toBeUndefined();
  });

  it("force drains leaked leases and keeps late releases idempotent", async () => {
    const { adapter, manager } = createManager({ drainTimeoutMs: 5 });
    await manager.createContext("session_1", {
      adapterId: "fake",
      workdir: "D:/repo",
    });
    const lease = await manager.acquire("session_1");

    await manager.destroyContext("session_1");
    await lease.release();

    expect(adapter.destroyed).toHaveLength(1);
    expect(manager.getContext("session_1")).toBeUndefined();
  });

  it("destroyContext is idempotent for missing sessions", async () => {
    const { adapter, manager } = createManager();

    await manager.destroyContext("missing");

    expect(adapter.destroyed).toHaveLength(0);
  });
});
