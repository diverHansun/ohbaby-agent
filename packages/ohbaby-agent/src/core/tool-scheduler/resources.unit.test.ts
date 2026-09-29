import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  acquireResources,
  wakeResourceWaiters,
  leaseCoversResources,
  resourcesConflict,
  ResourceUnavailableError,
  withResources,
  type ResourceAccess,
  type ResourceLease,
} from "./resources.js";
import { withFileLock } from "../../tools/utils/file-locks.js";
const scope = (
  key: string,
  mode: "read" | "write" = "write",
): ResourceAccess => ({ kind: "scope", key, mode });
const file = (
  target: string,
  mode: "read" | "write" = "write",
  scope: "file" | "tree" = "file",
): ResourceAccess => ({ kind: "file", path: target, scope, mode });
const tick = (): Promise<void> =>
  new Promise<void>((resolve) => setImmediate(resolve));

describe("shared resource protection", () => {
  it("serializes missing case aliases on the actual case-insensitive volume", async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "c2-case-alias-"));
    let first: ResourceLease | undefined;
    let second: Promise<ResourceLease> | undefined;
    try {
      await fs.writeFile(path.join(root, "Probe"), "case-insensitive");
      const insensitive = await fs
        .readFile(path.join(root, "pROBE"), "utf8")
        .catch(() => "");
      if (insensitive !== "case-insensitive") return;
      first = await acquireResources([file(path.join(root, "Missing.txt"))]);
      let waiting!: () => void;
      const wait = new Promise<"waiting">((resolve) => {
        waiting = (): void => {
          resolve("waiting");
        };
      });
      second = acquireResources([file(path.join(root, "missing.txt"))], {
        onWait: waiting,
      });
      expect(await Promise.race([wait, second.then(() => "acquired")])).toBe(
        "waiting",
      );
      expect(
        await leaseCoversResources(first, [
          file(path.join(root, "missing.txt")),
        ]),
      ).toBe(true);
      await fs.writeFile(path.join(root, "Missing.txt"), "created while held");
      expect(
        await leaseCoversResources(first, [
          file(path.join(root, "missing.txt")),
        ]),
      ).toBe(true);
      first.markUnconfirmed();
      await expect(second).rejects.toBeInstanceOf(ResourceUnavailableError);
      second = undefined;
      await expect(
        acquireResources([file(path.join(root, "missing.txt"))]),
      ).rejects.toBeInstanceOf(ResourceUnavailableError);
    } finally {
      first?.release();
      (await second)?.release();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("rejects missing case aliases while their original owner is unconfirmed", async () => {
    const root = await fs.mkdtemp(
      path.join(os.tmpdir(), "c2-case-unconfirmed-"),
    );
    let first: ResourceLease | undefined;
    try {
      await fs.writeFile(path.join(root, "Probe"), "case-insensitive");
      if (
        (await fs
          .readFile(path.join(root, "pROBE"), "utf8")
          .catch(() => "")) !== "case-insensitive"
      )
        return;
      first = await acquireResources([file(path.join(root, "Missing.txt"))]);
      first.markUnconfirmed();
      const result = await acquireResources([
        file(path.join(root, "missing.txt")),
      ]).then(
        (lease) => {
          lease.release();
          return "acquired";
        },
        (error: unknown) => error,
      );
      expect(result).toBeInstanceOf(ResourceUnavailableError);
    } finally {
      first?.release();
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it("does not let unresolved file identity block control or independent scopes, while retaining mixed-scope fairness", async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "c2-canonical-gate-")),
    );
    const slow = path.join(root, "slow.txt");
    const fast = path.join(root, "fast.txt");
    await fs.writeFile(slow, "");
    await fs.writeFile(fast, "");
    let release = (): void => {
      throw new Error("Uninitialized gate");
    };
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    const realpath = fs.realpath.bind(fs);
    const spy = vi.spyOn(fs, "realpath").mockImplementation(async (...args) => {
      if (String(args[0]) === slow) {
        entered = true;
        await gate;
      }
      return await realpath(...args);
    });
    const held: ResourceLease[] = [];
    const pending: Promise<void>[] = [];
    const order: string[] = [];
    const acquire = (
      name: string,
      accesses: readonly ResourceAccess[],
    ): void => {
      pending.push(
        acquireResources(accesses).then((lease) => {
          held.push(lease);
          order.push(name);
        }),
      );
    };
    try {
      acquire("slow", [file(slow), scope("mixed-scope")]);
      await expect.poll(() => entered).toBe(true);
      acquire("control", []);
      acquire("independent", [scope("independent-scope")]);
      acquire("same-scope", [scope("mixed-scope")]);
      acquire("later-file", [file(fast)]);
      await expect.poll(() => order).toEqual(["control", "independent"]);
      release();
      await expect
        .poll(() => order)
        .toEqual(["control", "independent", "slow", "later-file"]);
      for (const lease of held) lease.release();
      await Promise.all(pending);
      expect(order).toEqual([
        "control",
        "independent",
        "slow",
        "later-file",
        "same-scope",
      ]);
    } finally {
      release();
      // Every acquisition gets its own release observer, including requests still queued.
      const cleanup = Promise.all(
        pending.map(async (promise) => {
          await promise;
          for (const lease of held) lease.release();
        }),
      );
      for (const lease of held) lease.release();
      await cleanup;
      spy.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("allows read-only files past pending alias resolution but preserves the writer barrier", async () => {
    const root = await fs.realpath(
      await fs.mkdtemp(path.join(os.tmpdir(), "c2-read-alias-")),
    );
    const target = path.join(root, "target.txt");
    const alias = path.join(root, "alias.txt");
    await fs.writeFile(target, "");
    await fs.symlink(target, alias);
    let release = (): void => {
      throw new Error("Uninitialized gate");
    };
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    const realpath = fs.realpath.bind(fs);
    const spy = vi.spyOn(fs, "realpath").mockImplementation(async (...args) => {
      if (String(args[0]) === alias) {
        entered = true;
        await gate;
      }
      return await realpath(...args);
    });
    const held: ResourceLease[] = [];
    const pending: Promise<void>[] = [];
    const order: string[] = [];
    const acquire = (
      name: string,
      accesses: readonly ResourceAccess[],
    ): void => {
      pending.push(
        acquireResources(accesses).then((lease) => {
          held.push(lease);
          order.push(name);
        }),
      );
    };
    try {
      acquire("alias-reader", [
        file(alias, "read"),
        scope("unrelated-scope-write"),
      ]);
      await expect.poll(() => entered).toBe(true);
      acquire("target-reader", [file(target, "read")]);
      acquire("target-writer", [file(target)]);
      await expect.poll(() => order).toEqual(["target-reader"]);
      release();
      await expect.poll(() => order).toEqual(["target-reader", "alias-reader"]);
      for (const lease of held) lease.release();
      await Promise.all(pending);
      expect(order).toEqual(["target-reader", "alias-reader", "target-writer"]);
    } finally {
      release();
      const cleanup = Promise.all(
        pending.map(async (promise) => {
          await promise;
          for (const lease of held) lease.release();
        }),
      );
      for (const lease of held) lease.release();
      await cleanup;
      spy.mockRestore();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
  it("waits for joint admission without holding resources or blocking unrelated capacity", async () => {
    let capacity = false;
    const reasons: string[] = [];
    const first = acquireResources([scope("joint")], {
      canAcquire: () => capacity,
      onWait: (reason) => reasons.push(reason),
    });
    const independent = await acquireResources([scope("independent")]);
    independent.release();
    expect(reasons).toEqual(["capacity"]);
    capacity = true;
    wakeResourceWaiters();
    (await first).release();
  });
  it("can cancel synchronously from wait notification without granting or leaking", async () => {
    const holder = await acquireResources([scope("callback-abort")]);
    const controller = new AbortController();
    const waiting = acquireResources([scope("callback-abort")], {
      signal: controller.signal,
      onWait: () => {
        controller.abort(new Error("callback aborted"));
      },
    });
    await expect(waiting).rejects.toThrow("callback aborted");
    holder.release();
    (await acquireResources([scope("callback-abort")])).release();
  });
  it("snapshots declarations before async canonicalization", async () => {
    const access = {
      kind: "file" as const,
      path: "/tmp/resource-snapshot",
      scope: "file" as const,
      mode: "write" as "read" | "write",
    };
    const pending = acquireResources([access]);
    access.mode = "read";
    const lease = await pending;
    try {
      expect(
        await leaseCoversResources(lease, [file("/tmp/resource-snapshot")]),
      ).toBe(true);
    } finally {
      lease.release();
    }
  });
  it("matches tree descendants on path boundaries and permits concurrent reads", () => {
    expect(
      resourcesConflict([file("/a", "write", "tree")], [file("/a/b", "read")]),
    ).toBe(true);
    expect(
      resourcesConflict([file("/a", "write", "tree")], [file("/ab", "read")]),
    ).toBe(false);
    expect(
      resourcesConflict([file("/a", "read", "tree")], [file("/a/b", "read")]),
    ).toBe(false);
    expect(resourcesConflict([scope("a")], [scope("b")])).toBe(false);
  });
  it("grants readers together and keeps a queued writer ahead of later readers while unrelated work proceeds", async () => {
    const first = await acquireResources([scope("fair", "read")]);
    const second = await acquireResources([scope("fair", "read")]);
    const order: string[] = [];
    const writer = acquireResources([scope("fair")]).then((l) => {
      order.push("write");
      return l;
    });
    const reader = acquireResources([scope("fair", "read")]).then((l) => {
      order.push("read");
      return l;
    });
    const other = await acquireResources([scope("other")]);
    other.release();
    expect(order).toEqual([]);
    first.release();
    second.release();
    const writeLease = await writer;
    expect(order).toEqual(["write"]);
    writeLease.release();
    (await reader).release();
    expect(order).toEqual(["write", "read"]);
  });
  it("acquires arrays atomically and canceled waiters do not release a holder", async () => {
    const holder = await acquireResources([scope("b")]);
    const controller = new AbortController();
    const waiting = acquireResources([scope("a"), scope("b")], {
      signal: controller.signal,
    }).catch((e: unknown) => e);
    await tick();
    controller.abort(new Error("canceled"));
    expect(await waiting).toEqual(new Error("canceled"));
    const a = await acquireResources([scope("a")]);
    a.release();
    let granted = false;
    const b = acquireResources([scope("b")]).then((l) => {
      granted = true;
      return l;
    });
    await tick();
    expect(granted).toBe(false);
    holder.release();
    holder.release();
    (await b).release();
  });
  it("rejects conflicts with unconfirmed holders until actual release", async () => {
    const holder = await acquireResources([scope("stale")]);
    const waiting = acquireResources([scope("stale")]).catch((e: unknown) => e);
    holder.markUnconfirmed();
    expect(await waiting).toBeInstanceOf(ResourceUnavailableError);
    await expect(acquireResources([scope("stale")])).rejects.toBeInstanceOf(
      ResourceUnavailableError,
    );
    (await acquireResources([scope("healthy")])).release();
    holder.release();
    (await acquireResources([scope("stale")])).release();
  });
  it("authenticates lease identity and coverage, including tree descendants", async () => {
    const lease = await acquireResources([
      file("/tmp/resource-coverage", "write", "tree"),
    ]);
    expect(
      await leaseCoversResources(lease, [
        file("/tmp/resource-coverage/a", "read"),
      ]),
    ).toBe(true);
    expect(
      await leaseCoversResources({ ...lease }, [
        file("/tmp/resource-coverage/a"),
      ]),
    ).toBe(false);
    expect(await leaseCoversResources(lease, [file("/tmp/elsewhere")])).toBe(
      false,
    );
    await expect(
      withResources(
        [file("/tmp/resource-coverage/a")],
        () => Promise.resolve(42),
        {
          lease,
        },
      ),
    ).resolves.toBe(42);
    lease.release();
    expect(
      await leaseCoversResources(lease, [file("/tmp/resource-coverage")]),
    ).toBe(false);
  });
  it("reuses a valid direct file lease and rejects forged or insufficient ownership", async () => {
    const lease = await acquireResources([file("/tmp/direct-lease")]);
    try {
      await expect(
        withFileLock("/tmp/direct-lease", () => Promise.resolve("nested"), {
          lease,
        }),
      ).resolves.toBe("nested");
      let invoked = false;
      await expect(
        withResources(
          [file("/tmp/direct-lease")],
          () => {
            invoked = true;
            return Promise.resolve();
          },
          { lease: { ...lease } },
        ),
      ).rejects.toThrow("does not cover");
      expect(invoked).toBe(false);
    } finally {
      lease.release();
    }
    const read = await acquireResources([file("/tmp/direct-lease", "read")]);
    try {
      await expect(
        withFileLock("/tmp/direct-lease", () => Promise.resolve(), {
          lease: read,
        }),
      ).rejects.toThrow("does not cover");
    } finally {
      read.release();
    }
  });
  it("canonicalizes symlink aliases and shares ownership with direct file locks", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "resources-"));
    try {
      await fs.mkdir(path.join(dir, "real"));
      await fs.symlink(path.join(dir, "real"), path.join(dir, "alias"));
      const lease = await acquireResources([
        file(path.join(dir, "real", "new")),
      ]);
      let entered = false;
      const direct = withFileLock(path.join(dir, "alias", "new"), () => {
        entered = true;
        return Promise.resolve();
      });
      await tick();
      expect(entered).toBe(false);
      lease.release();
      await direct;
      expect(entered).toBe(true);
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
