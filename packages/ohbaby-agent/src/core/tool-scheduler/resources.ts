import path from "node:path";
import { canonicalizeResourcePath } from "../../utils/path-canonicalize.js";

export type ResourceAccess =
  | {
      readonly kind: "file";
      readonly path: string;
      readonly scope: "file" | "tree";
      readonly mode: "read" | "write";
    }
  | {
      readonly kind: "scope";
      readonly key: string;
      readonly mode: "read" | "write";
    };

export interface ResourceLease {
  release(): void;
  /** The caller stopped waiting, but protected work has not confirmed settlement. */
  markUnconfirmed(): void;
}

export class ResourceUnavailableError extends Error {
  constructor() {
    super(
      "Resource remains owned by an operation whose cleanup is unconfirmed",
    );
    this.name = "ResourceUnavailableError";
  }
}

export interface ResourceOptions {
  readonly signal?: AbortSignal;
  readonly onWait?: (
    reason: "resource" | "capacity" | "source-cleanup",
  ) => void;
  /** Synchronous joint admission; return true only after reserving caller capacity. */
  readonly canAcquire?: () => boolean;
  /** Checked before resource conflicts and capacity, including already queued calls. */
  readonly admissionWait?: () => "source-cleanup" | undefined;
}

function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}

function overlaps(a: ResourceAccess, b: ResourceAccess): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "scope" && b.kind === "scope") return a.key === b.key;
  if (a.kind === "file" && b.kind === "file") {
    return (
      a.path === b.path ||
      (a.scope === "tree" && contains(a.path, b.path)) ||
      (b.scope === "tree" && contains(b.path, a.path))
    );
  }
  return false;
}

/** Inputs to this pure predicate must already use canonical file paths. */
export function resourcesConflict(
  a: readonly ResourceAccess[],
  b: readonly ResourceAccess[],
): boolean {
  return a.some((left) =>
    b.some(
      (right) =>
        (left.mode === "write" || right.mode === "write") &&
        overlaps(left, right),
    ),
  );
}

async function canonicalize(
  accesses: readonly ResourceAccess[],
): Promise<ResourceAccess[]> {
  return await Promise.all(
    accesses.map(async (input) => {
      const access = { ...input };
      if (access.kind === "scope") return access;
      const target = await canonicalizeResourcePath(access.path);
      return {
        ...access,
        path: target,
      };
    }),
  );
}

interface Holder {
  accesses: readonly ResourceAccess[];
  unconfirmed: boolean;
}
interface Waiter {
  readonly declared: readonly ResourceAccess[];
  accesses?: readonly ResourceAccess[];
  readonly resolve: (lease: ResourceLease) => void;
  readonly reject: (error: unknown) => void;
  readonly signal?: AbortSignal;
  readonly onWait?: (
    reason: "resource" | "capacity" | "source-cleanup",
  ) => void;
  readonly canAcquire?: () => boolean;
  /** Checked before resource conflicts and capacity, including already queued calls. */
  readonly admissionWait?: () => "source-cleanup" | undefined;
  abort: () => void;
  notified?: "resource" | "capacity" | "source-cleanup";
}
const holders = new Map<ResourceLease, Holder>();
const waiters: Waiter[] = [];

function remove(waiter: Waiter): void {
  const index = waiters.indexOf(waiter);
  if (index >= 0) waiters.splice(index, 1);
  waiter.signal?.removeEventListener("abort", waiter.abort);
}

function grant(accesses: readonly ResourceAccess[]): ResourceLease {
  const holder = { accesses, unconfirmed: false };
  const lease: ResourceLease = Object.freeze({
    release() {
      if (holders.delete(lease)) drain();
    },
    markUnconfirmed() {
      if (holders.has(lease)) {
        holder.unconfirmed = true;
        drain();
      }
    },
  });
  holders.set(lease, holder);
  return lease;
}

let draining = false;
let drainAgain = false;

/** Retry joint admission after a capacity owner releases its slot. */
export function wakeResourceWaiters(): void {
  drain();
}

function drain(): void {
  if (draining) {
    drainAgain = true;
    return;
  }
  draining = true;
  try {
    do {
      drainAgain = false;
      drainPass();
      // Callbacks in drainPass may synchronously request another pass.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    } while (drainAgain);
  } finally {
    draining = false;
  }
}

function waiterConflicts(
  previous: Waiter,
  accesses: readonly ResourceAccess[],
): boolean {
  if (previous.accesses) return resourcesConflict(previous.accesses, accesses);
  // Unknown aliases only require a file barrier when one side writes. Readers
  // are compatible regardless of identity; scope keys already have final values.
  return (
    previous.declared.some(
      (left) =>
        left.kind === "file" &&
        accesses.some(
          (right) =>
            right.kind === "file" &&
            (left.mode === "write" || right.mode === "write"),
        ),
    ) ||
    resourcesConflict(
      previous.declared.filter((access) => access.kind === "scope"),
      accesses,
    )
  );
}

function drainPass(): void {
  const earlier: Waiter[] = [];
  for (const waiter of [...waiters]) {
    if (!waiters.includes(waiter)) continue;
    if (waiter.signal?.aborted) {
      waiter.abort();
      continue;
    }
    // Reserve file order before resolving aliases, without blocking control or
    // known-independent scope work behind filesystem latency.
    if (!waiter.accesses) {
      earlier.push(waiter);
      continue;
    }
    const accesses = waiter.accesses;
    const conflicts = [...holders.values()].filter((holder) =>
      resourcesConflict(holder.accesses, accesses),
    );
    if (conflicts.some((holder) => holder.unconfirmed)) {
      remove(waiter);
      waiter.reject(new ResourceUnavailableError());
      continue;
    }
    let reason: "resource" | "capacity" | "source-cleanup" | undefined;
    try {
      reason = waiter.admissionWait?.();
    } catch (error) {
      remove(waiter);
      waiter.reject(error);
      continue;
    }
    if (
      !reason &&
      (conflicts.length ||
        earlier.some(
          (previous) =>
            waiters.includes(previous) && waiterConflicts(previous, accesses),
        ))
    ) {
      reason = "resource";
    } else if (!reason) {
      try {
        if (waiter.canAcquire && !waiter.canAcquire()) reason = "capacity";
      } catch (error) {
        remove(waiter);
        waiter.reject(error);
        continue;
      }
    }
    if (reason) {
      // A source restriction owns no file reservation: independent roots can pass.
      if (reason !== "source-cleanup") earlier.push(waiter);
      if (waiter.notified !== reason) {
        waiter.notified = reason;
        try {
          waiter.onWait?.(reason);
        } catch (error) {
          remove(waiter);
          waiter.reject(error);
          if (reason !== "source-cleanup") earlier.pop();
        }
      }
      continue;
    }
    remove(waiter);
    waiter.resolve(grant(accesses));
  }
}

function asError(reason: unknown): Error {
  return reason instanceof Error
    ? reason
    : new Error("Resource acquisition failed", { cause: reason });
}

/** Atomically owns the entire footprint; aborting a waiter never touches holders. */
export function acquireResources(
  accesses: readonly ResourceAccess[],
  options: ResourceOptions = {},
): Promise<ResourceLease> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) {
      reject(asError(options.signal.reason));
      return;
    }
    const abort = (): void => {
      remove(waiter);
      reject(asError(options.signal?.reason));
      drain();
    };
    const declared = accesses.map((access) => ({ ...access }));
    const waiter: Waiter = {
      declared,
      resolve,
      reject,
      signal: options.signal,
      onWait: options.onWait,
      canAcquire: options.canAcquire,
      admissionWait: options.admissionWait,
      abort,
    };
    waiters.push(waiter);
    options.signal?.addEventListener("abort", waiter.abort, { once: true });
    void canonicalize(declared).then(
      (normalized) => {
        if (!waiters.includes(waiter)) return;
        waiter.accesses = normalized;
        drain();
      },
      (error: unknown) => {
        remove(waiter);
        reject(asError(error));
        drain();
      },
    );
  });
}

function covers(held: ResourceAccess, requested: ResourceAccess): boolean {
  if (held.mode === "read" && requested.mode === "write") return false;
  if (held.kind === "scope" && requested.kind === "scope")
    return held.key === requested.key;
  if (held.kind === "file" && requested.kind === "file") {
    return held.scope === "tree"
      ? contains(held.path, requested.path)
      : requested.scope === "file" && held.path === requested.path;
  }
  return false;
}

/** Only a live lease object issued by this module can establish ownership. */
export async function leaseCoversResources(
  lease: ResourceLease,
  accesses: readonly ResourceAccess[],
): Promise<boolean> {
  const normalized = await canonicalize(accesses);
  const holder = holders.get(lease);
  return (
    !!holder &&
    normalized.every((access) =>
      holder.accesses.some((held) => covers(held, access)),
    )
  );
}

export async function withResources<T>(
  accesses: readonly ResourceAccess[],
  operation: (lease: ResourceLease) => Promise<T>,
  options: ResourceOptions & { readonly lease?: ResourceLease } = {},
): Promise<T> {
  options.signal?.throwIfAborted();
  if (options.lease) {
    if (!(await leaseCoversResources(options.lease, accesses)))
      throw new Error("Resource lease does not cover the requested resources");
    options.signal?.throwIfAborted();
    return await operation(options.lease);
  }
  const lease = await acquireResources(accesses, options);
  try {
    options.signal?.throwIfAborted();
    return await operation(lease);
  } finally {
    lease.release();
  }
}
