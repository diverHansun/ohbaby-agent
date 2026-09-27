import { CallDelivery, ToolDeliveryError } from "./delivery.js";
import {
  getSourceCleanupState,
  SourceCleanupUnavailableError,
} from "./source-cleanup.js";
import fs from "node:fs/promises";
import path from "node:path";
import {
  createPermissionState,
  evaluatePermission,
} from "../../permission/index.js";
import type {
  PreflightExternalPath,
  PreflightResult,
  PreflightSensitivePath,
} from "../../sandbox/index.js";
import { detectShellKind, Shell } from "../../shell/index.js";
import { canonicalizePathTarget } from "../../utils/path-canonicalize.js";
import {
  DEFAULT_TOOL_SCHEDULER_CONFIG,
  SUBAGENT_DISABLED_TOOLS,
} from "./constants.js";
import { ConcurrencyController, type CapacityLease } from "./concurrency.js";
import {
  acquireResources,
  ResourceUnavailableError,
  resourcesConflict,
  wakeResourceWaiters,
  type ResourceAccess,
  type ResourceLease,
} from "./resources.js";
import { trustedToolAdmission } from "./tool-admission.js";
import { ToolSchedulerEvent } from "./events.js";
import { createToolRegistry } from "./registry.js";
import type {
  AgentToolConfig,
  BatchToolCallRequest,
  FinalToolCallStatus,
  PermissionDecision,
  PermissionResponse,
  Tool,
  ToolCall,
  ToolCallError,
  ToolCallRequest,
  ToolCallResult,
  ToolCallStatus,
  ToolCategory,
  ToolDefinition,
  ToolExecutionEnvironment,
  ToolExecutionContext,
  ToolExecutionOwner,
  ToolExecutionFact,
  ToolExecutionResult,
  ToolExecutionObservation,
  ToolRegistry,
  ToolScheduler,
  ToolSchedulerConfig,
  ToolSchedulerOptions,
  TimeoutPolicy,
} from "./types.js";

interface ScheduledCall {
  readonly index: number;
  readonly request: ToolCallRequest;
  readonly category: ToolCategory;
}

interface PreparedCall extends ScheduledCall {
  readonly call: ToolCall;
  readonly tool: Tool;
  readonly controller: AbortController;
  readonly cleanup: () => void;
  permissionContext: ToolPermissionContext;
  owner: ToolExecutionOwner;
  permissionSnapshot?: PermissionAdmissionSnapshot;
}

interface PermissionAdmissionSnapshot {
  readonly level: string;
  readonly mode: string;
  readonly rules: readonly {
    readonly value: string;
    readonly decision: string;
  }[];
}

function permissionStillAuthorized(
  previous: PermissionAdmissionSnapshot | undefined,
  current: PermissionAdmissionSnapshot,
): boolean {
  return (
    previous?.level === current.level &&
    previous.mode === current.mode &&
    previous.rules.every(
      (rule, index) => rule.value === current.rules[index]?.value,
    ) &&
    current.rules
      .slice(previous.rules.length)
      .every((rule) => rule.decision === "allow")
  );
}

interface ToolPermissionContext {
  readonly accessIdentity?: string;
  readonly environment?: ToolExecutionEnvironment;
  readonly externalRead: boolean;
  readonly externalReadAskPattern?: string;
  readonly externalReadPath?: string;
  readonly externalWrite: boolean;
  readonly externalWritePath?: string;
  readonly preflight?: PreflightResult;
  readonly preflightError?: unknown;
  readonly requireExplicitApproval: boolean;
  readonly params: Record<string, unknown>;
}

class AdmissionChangedError extends Error {}

class SchedulerAbortError extends Error {
  constructor(readonly kind: "cancelled" | "timeout") {
    super(kind === "timeout" ? "Tool call timed out" : "Tool call cancelled");
  }
}

function mergeConfig(
  input: ToolSchedulerOptions["config"],
): ToolSchedulerConfig {
  return {
    concurrency: {
      ...DEFAULT_TOOL_SCHEDULER_CONFIG.concurrency,
      ...input?.concurrency,
    },
    timeout: {
      ...DEFAULT_TOOL_SCHEDULER_CONFIG.timeout,
      ...input?.timeout,
      // Merge per-tool overrides instead of replacing built-in tool budgets.
      byTool: {
        ...DEFAULT_TOOL_SCHEDULER_CONFIG.timeout.byTool,
        ...input?.timeout?.byTool,
      },
    },
  };
}

export function timeoutForTool(
  config: TimeoutPolicy,
  toolName: string,
): number {
  return config.byTool?.[toolName] ?? config.defaultTimeout;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeForBoundary(inputPath: string): string {
  const resolved = path.resolve(inputPath);
  const root = path.parse(resolved).root;
  const withoutTrailingSeparator =
    resolved.length > root.length ? resolved.replace(/[\\/]+$/u, "") : resolved;
  return process.platform === "win32"
    ? withoutTrailingSeparator.toLowerCase()
    : withoutTrailingSeparator;
}

function isOutsideWorkdir(workdir: string, resolvedPath: string): boolean {
  const normalizedRoot = normalizeForBoundary(workdir);
  const normalizedCandidate = normalizeForBoundary(resolvedPath);
  if (normalizedRoot === normalizedCandidate) {
    return false;
  }
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return isOutsideRelativePath(relative);
}

function isOutsideTrustedEnvironment(
  environment: ToolExecutionEnvironment,
  resolvedPath: string,
): boolean {
  if (environment.containsTrustedPath?.(resolvedPath) === true) {
    return false;
  }
  return isOutsideWorkdir(environment.workdir, resolvedPath);
}

function isWriteTrustedRootKind(kind: string): boolean {
  return (
    kind === "workspace" ||
    kind === "skill-output" ||
    kind === "external-write-approved"
  );
}

function containsWriteTrustedPath(
  environment: ToolExecutionEnvironment,
  resolvedPath: string,
): boolean {
  return (
    environment
      .trustedRoots?.()
      .some(
        (root) =>
          isWriteTrustedRootKind(root.kind) &&
          isSameOrInsidePath(resolvedPath, root.path),
      ) ?? false
  );
}

function isOutsideWriteTrustedEnvironment(
  environment: ToolExecutionEnvironment,
  resolvedPath: string,
): boolean {
  if (!isOutsideWorkdir(environment.workdir, resolvedPath)) {
    return false;
  }
  return !containsWriteTrustedPath(environment, resolvedPath);
}

function isSamePath(left: string, right: string): boolean {
  return normalizeForBoundary(left) === normalizeForBoundary(right);
}

function isOutsideRelativePath(relativePath: string): boolean {
  return (
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativePath)
  );
}

function isSameOrInsidePath(candidatePath: string, rootPath: string): boolean {
  const normalizedRoot = normalizeForBoundary(rootPath);
  const normalizedCandidate = normalizeForBoundary(candidatePath);
  if (normalizedRoot === normalizedCandidate) {
    return true;
  }
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  return !isOutsideRelativePath(relative);
}

function isRootPath(inputPath: string): boolean {
  const resolved = path.resolve(inputPath);
  return path.dirname(resolved) === resolved;
}

function resolveLexicalForEnvironment(
  environment: ToolExecutionEnvironment,
  inputPath: string,
): string {
  return path.isAbsolute(inputPath)
    ? path.resolve(inputPath)
    : path.resolve(environment.workdir, inputPath);
}

function getFilePathParam(params: Record<string, unknown>): string | undefined {
  for (const key of ["file_path", "filePath", "path"]) {
    const value = params[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }
  return undefined;
}

function paramsWithCanonicalPath(
  params: Record<string, unknown>,
  canonicalPath: string,
): Record<string, unknown> {
  const next = { ...params };
  for (const key of ["file_path", "filePath", "path"]) {
    if (typeof next[key] === "string") {
      next[key] = canonicalPath;
    }
  }
  return next;
}

function getSchemaType(schema: unknown): string | undefined {
  return isRecord(schema) && typeof schema.type === "string"
    ? schema.type
    : undefined;
}

function matchesJsonSchemaType(value: unknown, type: string): boolean {
  switch (type) {
    case "array":
      return Array.isArray(value);
    case "boolean":
      return typeof value === "boolean";
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "null":
      return value === null;
    case "number":
      return typeof value === "number" && Number.isFinite(value);
    case "object":
      return isRecord(value);
    case "string":
      return typeof value === "string";
    default:
      return true;
  }
}

function validateParameters(
  params: Record<string, unknown>,
  schema: Record<string, unknown>,
): string | null {
  const rootType = getSchemaType(schema);
  if (rootType && rootType !== "object") {
    return `Tool parameters schema must describe an object, got ${rootType}`;
  }
  const required = Array.isArray(schema.required)
    ? schema.required.filter((item): item is string => typeof item === "string")
    : [];
  for (const key of required) {
    if (!(key in params)) {
      return `Missing required tool parameter: ${key}`;
    }
  }
  const properties = isRecord(schema.properties) ? schema.properties : {};
  for (const [key, propertySchema] of Object.entries(properties)) {
    if (!(key in params)) {
      continue;
    }
    const type = getSchemaType(propertySchema);
    if (type && !matchesJsonSchemaType(params[key], type)) {
      return `Invalid type for tool parameter ${key}: expected ${type}`;
    }
  }

  return null;
}

function isPermissionRejectedError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name.includes("Rejected") ||
      error.constructor.name.includes("Rejected"))
  );
}

function isPermissionCancelledError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name.includes("Cancelled") ||
      error.constructor.name.includes("Cancelled") ||
      error.name.includes("Canceled") ||
      error.constructor.name.includes("Canceled"))
  );
}

function createError(
  type: ToolCallError["type"],
  message: string,
  details?: unknown,
): ToolCallError {
  return { type, message, details };
}

function isFinal(status: ToolCallStatus): status is FinalToolCallStatus {
  return (
    status === "success" ||
    status === "error" ||
    status === "rejected" ||
    status === "cancelled"
  );
}

function isCancelled(call: ToolCall): boolean {
  return call.status === "cancelled";
}

function isStopped(call: ToolCall, controller: AbortController): boolean {
  return isCancelled(call) || controller.signal.aborted;
}

function isSchedulerAbortError(error: unknown): error is SchedulerAbortError {
  return error instanceof SchedulerAbortError;
}

function isStructuredAgentToolsConfig(
  tools: AgentToolConfig | undefined,
): tools is {
  readonly include?: readonly string[];
  readonly exclude?: readonly string[];
} {
  return (
    tools !== undefined &&
    (Array.isArray((tools as { readonly include?: unknown }).include) ||
      Array.isArray((tools as { readonly exclude?: unknown }).exclude))
  );
}

function normalizeAgentToolsConfig(
  tools: AgentToolConfig | undefined,
): Record<string, boolean> | undefined {
  if (!tools) {
    return undefined;
  }
  if (!isStructuredAgentToolsConfig(tools)) {
    return tools;
  }
  const result: Record<string, boolean> = {};
  if (tools.include) {
    result["*"] = false;
    for (const toolName of tools.include) {
      result[toolName] = true;
    }
  }
  for (const toolName of tools.exclude ?? []) {
    result[toolName] = false;
  }
  return result;
}

async function canonicalizeLexicalPath(lexicalPath: string): Promise<string> {
  return canonicalizePathTarget(lexicalPath);
}

async function canonicalizeForPermission(
  environment: ToolExecutionEnvironment,
  inputPath: string,
): Promise<string> {
  const lexical = resolveLexicalForEnvironment(environment, inputPath);
  return canonicalizeLexicalPath(lexical);
}

async function externalPermissionAskPattern(
  absolutePath: string,
): Promise<string> {
  try {
    const stats = await fs.stat(absolutePath);
    if (stats.isDirectory()) {
      return path.join(absolutePath, "**");
    }
  } catch {
    // Missing or unreadable paths fall back to their parent directory.
  }

  return path.join(path.dirname(absolutePath), "**");
}

type ExternalAccessMode = "read" | "write";

function rejectUnapprovedExternalAccess(
  mode: ExternalAccessMode,
  inputPath: string,
): never {
  throw new Error(`External ${mode} path was not approved: ${inputPath}`);
}

function resolveApprovedAbsolutePath(
  environment: ToolExecutionEnvironment,
  inputPath: string,
  approvedPath: string,
  mode: ExternalAccessMode,
  input: { readonly allowDescendants?: boolean } = {},
): string | null {
  if (!path.isAbsolute(inputPath)) {
    return null;
  }
  const resolved = path.resolve(inputPath);
  if (isSamePath(resolved, approvedPath)) {
    return approvedPath;
  }
  if (input.allowDescendants && isSameOrInsidePath(resolved, approvedPath)) {
    return resolved;
  }
  const isOutsideEnvironment =
    mode === "write"
      ? isOutsideWriteTrustedEnvironment(environment, resolved)
      : isOutsideTrustedEnvironment(environment, resolved);
  if (isOutsideEnvironment) {
    rejectUnapprovedExternalAccess(mode, inputPath);
  }
  return null;
}

function createExternalReadEnvironment(
  environment: ToolExecutionEnvironment,
  externalReadPath: string,
): ToolExecutionEnvironment {
  const approvedPath = path.resolve(externalReadPath);

  return {
    ...environment,
    resolvePath(inputPath: string): string {
      const approved = resolveApprovedAbsolutePath(
        environment,
        inputPath,
        approvedPath,
        "read",
        { allowDescendants: true },
      );
      if (approved) {
        return approved;
      }
      return environment.resolvePath(inputPath);
    },
    async resolvePathForExisting(inputPath: string): Promise<string> {
      const target = resolveLexicalForEnvironment(environment, inputPath);
      const resolved = await fs.realpath(target);
      if (isSameOrInsidePath(resolved, approvedPath)) {
        return resolved;
      }
      if (isOutsideTrustedEnvironment(environment, resolved)) {
        rejectUnapprovedExternalAccess("read", inputPath);
      }
      return environment.resolvePathForExisting(inputPath);
    },
  };
}

function createExternalWriteEnvironment(
  environment: ToolExecutionEnvironment,
  externalWritePath: string,
): ToolExecutionEnvironment {
  const approvedPath = path.resolve(externalWritePath);

  return {
    ...environment,
    resolvePath(inputPath: string): string {
      const approved = resolveApprovedAbsolutePath(
        environment,
        inputPath,
        approvedPath,
        "write",
      );
      if (approved) {
        return approved;
      }
      return environment.resolvePath(inputPath);
    },
    async resolvePathForExisting(inputPath: string): Promise<string> {
      if (path.isAbsolute(inputPath)) {
        const resolved = await fs.realpath(path.resolve(inputPath));
        if (isSamePath(resolved, approvedPath)) {
          return resolved;
        }
        if (isOutsideWriteTrustedEnvironment(environment, resolved)) {
          rejectUnapprovedExternalAccess("write", inputPath);
        }
      }
      return environment.resolvePathForExisting(inputPath);
    },
    async resolvePathForWrite(inputPath: string): Promise<string> {
      if (path.isAbsolute(inputPath)) {
        const resolved = await canonicalizeLexicalPath(inputPath);
        if (!isRootPath(resolved) && isSamePath(resolved, approvedPath)) {
          return resolved;
        }
        if (isOutsideWriteTrustedEnvironment(environment, resolved)) {
          rejectUnapprovedExternalAccess("write", inputPath);
        }
      }
      return environment.resolvePathForWrite(inputPath);
    },
  };
}

function trustedRootFromExternalPath(pathFact: PreflightExternalPath): string {
  const globMatch = /^(.*[\\/])\*\*$/u.exec(pathFact.askPattern);
  if (!globMatch) {
    return path.resolve(path.dirname(pathFact.absolutePath));
  }
  const directory = globMatch[1];
  const root = path.parse(path.resolve(directory)).root;
  const withoutTrailingSeparator =
    directory.length > root.length
      ? directory.replace(/[\\/]+$/u, "")
      : directory;
  return path.resolve(withoutTrailingSeparator);
}

function isEnabledByAgentConfig(
  toolName: string,
  tools: Record<string, boolean> | undefined,
): boolean {
  if (!tools) {
    return true;
  }
  if (Object.prototype.hasOwnProperty.call(tools, toolName)) {
    return tools[toolName];
  }
  if (Object.prototype.hasOwnProperty.call(tools, "*")) {
    return tools["*"];
  }

  return true;
}

export function createToolScheduler(
  options: ToolSchedulerOptions,
): ToolScheduler {
  const bus = options.bus;
  const permissionState =
    options.permissionState ??
    options.permission?.state ??
    createPermissionState({ bus });
  const config = mergeConfig(options.config);
  const concurrency = new ConcurrencyController(config.concurrency);
  concurrency.subscribeAvailability(wakeResourceWaiters);
  const registry: ToolRegistry = createToolRegistry();
  const now = options.now ?? Date.now;
  const calls = new Map<string, ToolCall>();
  const controllers = new Map<string, AbortController>();
  const identity = (
    call: Pick<ToolCallRequest, "sessionId" | "runId" | "messageId" | "callId">,
  ): string =>
    JSON.stringify([call.sessionId, call.runId, call.messageId, call.callId]);
  const findCall = (callId: string): ToolCall | undefined =>
    Array.from(calls.values())
      .reverse()
      .find((call) => call.callId === callId);
  const deliveries = new WeakMap<ToolCall, CallDelivery>();
  const requestDeliveries = new WeakMap<ToolCallRequest, CallDelivery>();

  function factPublisher(
    owner: ToolExecutionOwner,
    delivery?: CallDelivery,
  ): (
    fact: Omit<ToolExecutionFact, "owner" | "timestamp"> & {
      readonly timestamp?: number;
    },
  ) => void {
    let pending = Promise.resolve();
    return (fact) => {
      const record = { ...fact, owner, timestamp: fact.timestamp ?? now() };
      if (fact.phase === "waiting")
        void delivery?.update({
          phase:
            fact.reason === "predecessor" ? "waiting-predecessor" : "queued",
          phaseStartedAt: record.timestamp,
          waitReason: fact.reason,
        });
      if (fact.phase === "started")
        void delivery?.update({
          phase: "executing",
          phaseStartedAt: record.timestamp,
          executionStartedAt: record.timestamp,
        });
      if (fact.phase === "cleanup" && fact.cleanup)
        void delivery?.update({ cleanup: fact.cleanup });
      pending = pending
        .then(() => options.onExecutionFact?.(record))
        .catch((error: unknown) => {
          options.onExecutionFactError?.(error, record);
        });
      void pending.catch(() => undefined);
    };
  }

  function transition(call: ToolCall, status: ToolCallStatus): void {
    if (call.status === status) {
      return;
    }
    if (isFinal(call.status)) {
      return;
    }
    const previousStatus = call.status;
    call.status = status;
    if (
      status === "awaiting_approval" ||
      status === "checking_permission" ||
      status === "queued"
    ) {
      void deliveries.get(call)?.update({
        phase:
          status === "awaiting_approval"
            ? "awaiting-approval"
            : status === "queued"
              ? "queued"
              : "preparing",
        phaseStartedAt: now(),
      });
    }
    if (isFinal(status)) {
      call.completedAt = now();
      if (call.startedAt !== undefined) {
        call.durationMs = call.completedAt - call.startedAt;
      }
    }
    bus.publish(ToolSchedulerEvent.StatusChanged, {
      callId: call.callId,
      toolName: call.toolName,
      previousStatus,
      currentStatus: status,
      timestamp: now(),
    });
  }

  function makeResult(
    call: ToolCall,
    status: FinalToolCallStatus,
    input: {
      readonly output?: string;
      readonly executionOutcome?: ToolExecutionObservation["outcome"];
      readonly metadata?: Record<string, unknown>;
      readonly error?: ToolCallError;
    } = {},
  ): ToolCallResult {
    const result = {
      callId: call.callId,
      status,
      output: input.output,
      ...(input.executionOutcome !== undefined
        ? { executionOutcome: input.executionOutcome }
        : {}),
      metadata: input.metadata,
      error: input.error,
      duration: call.durationMs,
    };
    call.result = result;
    call.error = input.error;
    return result;
  }

  function createCall(
    request: ToolCallRequest,
    category: ToolCategory,
  ): ToolCall {
    const call = {
      callId: request.callId,
      toolName: request.toolName,
      params: request.params,
      sessionId: request.sessionId,
      runId: request.runId,
      contextScopeId: request.contextScopeId,
      messageId: request.messageId,
      category,
      status: "pending",
      createdAt: now(),
    } satisfies ToolCall;
    const delivery = requestDeliveries.get(request);
    if (delivery) deliveries.set(call, delivery);
    calls.set(identity(call), call);
    return call;
  }

  function makeCancelledResult(
    call: ToolCall,
    message = "Tool call was cancelled",
  ): ToolCallResult {
    transition(call, "cancelled");
    return makeResult(call, "cancelled", {
      error: createError("CancelledError", message),
    });
  }

  function cancelCall(call: ToolCall): boolean {
    if (isFinal(call.status)) {
      return false;
    }
    concurrency.cancel(call.callId);
    controllers.get(identity(call))?.abort();
    transition(call, "cancelled");
    return true;
  }

  function bindRequestSignal(
    call: ToolCall,
    signal: AbortSignal | undefined,
  ): () => void {
    if (!signal) {
      return () => undefined;
    }
    const onAbort = (): void => {
      cancelCall(call);
    };
    if (signal.aborted) {
      onAbort();
      return () => undefined;
    }
    signal.addEventListener("abort", onAbort, { once: true });
    return () => {
      signal.removeEventListener("abort", onAbort);
    };
  }

  async function waitForAbortable<T>(
    work: () => Promise<T> | T,
    signal: AbortSignal,
  ): Promise<T> {
    if (signal.aborted) {
      throw new SchedulerAbortError("cancelled");
    }
    const workPromise = Promise.resolve().then(work);
    void workPromise.catch(() => undefined);
    let removeAbortListener = (): void => undefined;
    const abortPromise = new Promise<never>((_resolve, reject) => {
      const onAbort = (): void => {
        reject(new SchedulerAbortError("cancelled"));
      };
      removeAbortListener = (): void => {
        signal.removeEventListener("abort", onAbort);
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });

    try {
      return await Promise.race([workPromise, abortPromise]);
    } finally {
      removeAbortListener();
    }
  }

  async function executeToolWithTimeout(
    prepared: PreparedCall,
    environment: ToolExecutionEnvironment | undefined,
    params: Record<string, unknown>,
    resourceLease: ResourceLease,
    resources: readonly ResourceAccess[],
    publish: ReturnType<typeof factPublisher>,
    takeOwnership: () => void,
    checkAdmission: () => void,
  ): Promise<ToolExecutionResult> {
    const { call, tool, controller, owner } = prepared;
    controller.signal.throwIfAborted();
    const releaseEnvironment = environment?.retain?.();
    try {
      // Status observers and retain() can synchronously introduce protection.
      // Recheck after those callbacks, before taking ownership or recording start.
      controller.signal.throwIfAborted();
      checkAdmission();
    } catch (error) {
      if (error instanceof ToolDeliveryError) throw error;
      if (releaseEnvironment) {
        try {
          await releaseEnvironment();
        } catch (releaseError) {
          void Promise.resolve()
            .then(() =>
              options.onExecutionFactError?.(releaseError, {
                owner,
                phase: "cleanup",
                timestamp: now(),
              }),
            )
            .catch(() => undefined);
        }
      }
      throw error;
    }
    takeOwnership();
    let timedOut = false;
    let settled = false;
    let deadline: NodeJS.Timeout | undefined;
    let observation: NodeJS.Timeout | undefined;
    let cleaning = false;
    let startPublished = false;
    const earlyCleanup: ("in-progress" | "unconfirmed" | "confirmed")[] = [];
    let rejectAbort!: (reason: unknown) => void;
    const abortPromise = new Promise<never>((_resolve, reject) => {
      rejectAbort = reject;
    });
    const toolOwnsCleanup = trustedToolAdmission(tool)?.cleanupOwner === "tool";
    const onAbort = (): void => {
      if (!settled && !cleaning && !toolOwnsCleanup) {
        cleaning = true;
        // The original resource owner and scope reference already exist before
        // returning a logical result or making ordinary capacity available.
        if (startPublished)
          publish({ phase: "cleanup", cleanup: "in-progress" });
        observation = setTimeout(() => {
          if (settled) return;
          resourceLease.markUnconfirmed();
          publish({ phase: "cleanup", cleanup: "unconfirmed" });
        }, options.cleanupObservationMs ?? 1_000);
        observation.unref();
      }
      rejectAbort(new SchedulerAbortError(timedOut ? "timeout" : "cancelled"));
    };
    controller.signal.addEventListener("abort", onAbort, { once: true });
    if (tool.timeoutOwner !== "tool") {
      deadline = setTimeout(
        () => {
          timedOut = true;
          controller.abort();
        },
        timeoutForTool(config.timeout, tool.name),
      );
    }
    // No await, notification callback, or storage write between the timestamp
    // and invoking the actual tool. A cancelled preparation has no start fact.
    call.startedAt = now();
    let operation: Promise<ToolExecutionResult>;
    try {
      operation = Promise.resolve(
        tool.execute(params, {
          callId: call.callId,
          runId: call.runId,
          contextScopeId: call.contextScopeId,
          environment,
          messageId: call.messageId,
          sessionId: call.sessionId,
          signal: controller.signal,
          resourceLease,
          owner,
          reportCleanupError: toolOwnsCleanup
            ? (error): void => {
                const fact: ToolExecutionFact = {
                  owner,
                  phase: "cleanup",
                  timestamp: now(),
                };
                void Promise.resolve()
                  .then(() => options.onExecutionFactError?.(error, fact))
                  .catch(() => undefined);
              }
            : undefined,
          reportCleanup: toolOwnsCleanup
            ? (cleanup): void => {
                if (startPublished) publish({ phase: "cleanup", cleanup });
                else earlyCleanup.push(cleanup);
              }
            : undefined,
        }),
      );
    } catch (error) {
      if (error instanceof ToolDeliveryError) throw error;
      operation = Promise.reject(
        error instanceof Error
          ? error
          : new Error(errorMessage(error), { cause: error }),
      );
    }
    transition(call, "executing");
    publish({ phase: "started", timestamp: call.startedAt, resources });
    startPublished = true;
    for (const cleanup of earlyCleanup) publish({ phase: "cleanup", cleanup });
    // execute can synchronously trigger onAbort.
    // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
    if (cleaning) publish({ phase: "cleanup", cleanup: "in-progress" });
    bus.publish(ToolSchedulerEvent.ExecutionStarted, {
      callId: call.callId,
      toolName: call.toolName,
      params: call.params,
      timestamp: call.startedAt,
    });
    const finish = (): void => {
      settled = true;
      if (observation) clearTimeout(observation);
      resourceLease.release();
      if (releaseEnvironment)
        void Promise.resolve()
          .then(releaseEnvironment)
          .catch((error: unknown) => {
            options.onExecutionFactError?.(error, {
              owner,
              phase: "cleanup",
              timestamp: now(),
              cleanup: "unconfirmed",
            });
          });
      if (cleaning)
        publish({
          phase: "cleanup",
          cleanup:
            trustedToolAdmission(tool)?.settlementConfirmsCleanup === false
              ? "unconfirmed"
              : "confirmed",
        });
    };
    // Both branches observe the original operation, including rejection after
    // timeout. Cleanup observation failure never stands in for this settlement.
    const observed = operation.then(
      (value) => {
        finish();
        return value;
      },
      (error: unknown) => {
        finish();
        throw error;
      },
    );
    void observed.catch(() => undefined);
    try {
      return await Promise.race([observed, abortPromise]);
    } finally {
      if (deadline) clearTimeout(deadline);
      controller.signal.removeEventListener("abort", onAbort);
    }
  }

  async function askPermission(
    call: ToolCall,
    input: {
      readonly category?: ToolCategory;
      readonly metadata?: Record<string, unknown>;
      readonly params: Record<string, unknown>;
      readonly reason?: string;
      readonly rememberable?: boolean;
      readonly toolName?: string;
    },
  ): Promise<PermissionResponse> {
    if (!options.permission) {
      return "reject";
    }
    const controller = controllers.get(identity(call));
    if (!controller || controller.signal.aborted) {
      throw new SchedulerAbortError("cancelled");
    }
    if (!call.runId) {
      throw new Error("Interactive tool approval requires an actual runId");
    }
    await deliveries.get(call)?.flush();
    controller.signal.throwIfAborted();
    return options.permission.ask({
      runId: call.runId,
      contextScopeId: call.contextScopeId,
      signal: controller.signal,
      sessionId: call.sessionId,
      messageId: call.messageId,
      callId: call.callId,
      toolName: input.toolName ?? call.toolName,
      category: input.category ?? call.category,
      params: input.params,
      metadata: input.metadata,
      reason: input.reason,
      rememberable: input.rememberable,
    });
  }

  async function evaluatePermissionOnly(
    call: ToolCall,
    context: ToolPermissionContext,
  ): Promise<PermissionDecision | ToolCallResult> {
    transition(call, "checking_permission");
    const controller = controllers.get(identity(call));
    if (!controller) {
      return makeCancelledResult(call);
    }
    if (isCancelled(call) || controller.signal.aborted) {
      return makeCancelledResult(call);
    }
    let decision: PermissionDecision;
    try {
      decision = await waitForAbortable(
        () =>
          evaluatePermission(
            {
              callId: call.callId,
              toolName: call.toolName,
              category:
                call.category === "subagent-control"
                  ? "subagent"
                  : call.category,
              params: context.params,
              sessionId: call.sessionId,
              messageId: call.messageId,
            },
            permissionState.getState(),
          ),
        controller.signal,
      );
    } catch (error) {
      if (error instanceof ToolDeliveryError) throw error;
      if (isSchedulerAbortError(error)) {
        return makeCancelledResult(call);
      }
      transition(call, "error");
      return makeResult(call, "error", {
        error: createError("ExecutionError", errorMessage(error), error),
      });
    }
    if (isCancelled(call)) {
      return makeCancelledResult(call);
    }
    if (decision.type === "deny") {
      transition(call, "rejected");
      return makeResult(call, "rejected", {
        error: createError("PermissionDeniedError", decision.reason),
      });
    }
    return decision;
  }

  async function confirmPermission(
    call: ToolCall,
    decision: Extract<PermissionDecision, { readonly type: "ask" }>,
    params: Record<string, unknown>,
    input: {
      readonly category?: ToolCategory;
      readonly metadata?: Record<string, unknown>;
      readonly onResponse?: (response: PermissionResponse) => Promise<void>;
      readonly reason?: string;
      readonly toolName?: string;
    } = {},
  ): Promise<ToolCallResult | null> {
    const controller = controllers.get(identity(call));
    if (!controller) {
      return makeCancelledResult(call);
    }
    if (isCancelled(call) || controller.signal.aborted) {
      return makeCancelledResult(call);
    }
    transition(call, "awaiting_approval");
    let response: PermissionResponse;
    try {
      response = await waitForAbortable(
        () =>
          askPermission(call, {
            category: input.category,
            metadata: input.metadata,
            params,
            reason: input.reason ?? decision.reason,
            rememberable: decision.rememberable,
            toolName: input.toolName,
          }),
        controller.signal,
      );
    } catch (error) {
      if (error instanceof ToolDeliveryError) throw error;
      if (isSchedulerAbortError(error)) {
        return makeCancelledResult(call);
      }
      if (isPermissionRejectedError(error)) {
        transition(call, "rejected");
        return makeResult(call, "rejected", {
          error: createError(
            "PermissionRejectedError",
            `Tool rejected by user: ${call.toolName}`,
            error,
          ),
        });
      }
      if (isPermissionCancelledError(error)) {
        return makeCancelledResult(call, "Tool permission was cancelled");
      }
      transition(call, "error");
      return makeResult(call, "error", {
        error: createError("ExecutionError", errorMessage(error), error),
      });
    }
    if (isCancelled(call)) {
      return makeCancelledResult(call);
    }
    if (response === "cancel") {
      return makeCancelledResult(call, "Tool permission was cancelled");
    }
    if (response === "reject") {
      transition(call, "rejected");
      return makeResult(call, "rejected", {
        error: createError(
          "PermissionRejectedError",
          `Tool rejected by user: ${call.toolName}`,
        ),
      });
    }

    await input.onResponse?.(response);
    return null;
  }

  async function confirmExplicitApproval(
    call: ToolCall,
    context: ToolPermissionContext,
  ): Promise<ToolCallResult | null> {
    if (
      !context.requireExplicitApproval ||
      permissionState.getState().level === "full-access"
    ) {
      return null;
    }
    return confirmPermission(
      call,
      {
        reason: "explicit-approval-required",
        rememberable: false,
        type: "ask",
      },
      context.params,
    );
  }

  function denylistRejection(
    call: ToolCall,
    preflight: PreflightResult,
  ): ToolCallResult | null {
    if (preflight.denylistHits.length === 0) {
      return null;
    }
    const hit = preflight.denylistHits[0];
    transition(call, "rejected");
    return makeResult(call, "rejected", {
      error: createError(
        "PermissionDeniedError",
        `Denied: ${hit.absolutePath} (${hit.reason})`,
        hit,
      ),
    });
  }

  function uniqueExternalPaths(
    paths: readonly PreflightExternalPath[],
  ): readonly PreflightExternalPath[] {
    const seen = new Set<string>();
    const unique: PreflightExternalPath[] = [];
    for (const item of paths) {
      if (seen.has(item.askPattern)) {
        continue;
      }
      seen.add(item.askPattern);
      unique.push(item);
    }
    return unique;
  }

  function uniqueSensitivePaths(
    paths: readonly PreflightSensitivePath[],
  ): readonly PreflightSensitivePath[] {
    const seen = new Set<string>();
    const unique: PreflightSensitivePath[] = [];
    for (const item of paths) {
      if (seen.has(item.askPattern)) {
        continue;
      }
      seen.add(item.askPattern);
      unique.push(item);
    }
    return unique;
  }

  async function confirmExternalPreflightPermissions(
    call: ToolCall,
    context: ToolPermissionContext,
  ): Promise<ToolCallResult | null> {
    const preflight = context.preflight;
    if (!preflight) {
      return null;
    }
    const denied = denylistRejection(call, preflight);
    if (denied) {
      return denied;
    }

    const controller = controllers.get(identity(call));
    if (!controller) {
      return makeCancelledResult(call);
    }
    async function trustExternalPath(
      externalPath: PreflightExternalPath,
    ): Promise<void> {
      await context.environment?.trustPath?.({
        kind: "external-approved",
        path: trustedRootFromExternalPath(externalPath),
        source: "external_directory",
      });
    }

    for (const externalPath of uniqueExternalPaths(preflight.externalPaths)) {
      if (isCancelled(call) || controller.signal.aborted) {
        return makeCancelledResult(call);
      }
      const params = {
        path: externalPath.absolutePath,
        pattern: externalPath.askPattern,
      };
      const permissionSnapshot = permissionState.getState();
      let decision: PermissionDecision;
      try {
        decision = await waitForAbortable(
          () =>
            evaluatePermission(
              {
                callId: call.callId,
                category: "dangerous",
                messageId: call.messageId,
                params,
                sessionId: call.sessionId,
                toolName: "external_directory",
              },
              permissionSnapshot,
            ),
          controller.signal,
        );
      } catch (error) {
        if (error instanceof ToolDeliveryError) throw error;
        if (isSchedulerAbortError(error)) {
          return makeCancelledResult(call);
        }
        transition(call, "error");
        return makeResult(call, "error", {
          error: createError("ExecutionError", errorMessage(error), error),
        });
      }

      if (decision.type === "deny") {
        transition(call, "rejected");
        return makeResult(call, "rejected", {
          error: createError("PermissionDeniedError", decision.reason),
        });
      }
      if (decision.type === "allow") {
        // FullAccess authorizes this call without remembering directory trust.
        if (permissionSnapshot.level !== "full-access") {
          await trustExternalPath(externalPath);
        }
        continue;
      }

      const result = await confirmPermission(call, decision, params, {
        category: "dangerous",
        metadata: { preflight },
        onResponse: async (response) => {
          if (response === "always") {
            await trustExternalPath(externalPath);
          }
        },
        reason: `External path access requires confirmation: ${externalPath.absolutePath}`,
        toolName: "external_directory",
      });
      if (result) {
        return result;
      }
    }

    for (const sensitivePath of uniqueSensitivePaths(
      preflight.sensitivePaths,
    )) {
      if (isCancelled(call) || controller.signal.aborted) {
        return makeCancelledResult(call);
      }
      const params = {
        path: sensitivePath.absolutePath,
        pattern: sensitivePath.askPattern,
        reason: sensitivePath.reason,
      };
      let decision: PermissionDecision;
      try {
        decision = await waitForAbortable(
          () =>
            evaluatePermission(
              {
                callId: call.callId,
                category: "dangerous",
                messageId: call.messageId,
                params,
                sessionId: call.sessionId,
                toolName: "sensitive_path",
              },
              permissionState.getState(),
            ),
          controller.signal,
        );
      } catch (error) {
        if (error instanceof ToolDeliveryError) throw error;
        if (isSchedulerAbortError(error)) {
          return makeCancelledResult(call);
        }
        transition(call, "error");
        return makeResult(call, "error", {
          error: createError("ExecutionError", errorMessage(error), error),
        });
      }

      if (decision.type === "deny") {
        transition(call, "rejected");
        return makeResult(call, "rejected", {
          error: createError("PermissionDeniedError", decision.reason),
        });
      }
      if (decision.type === "allow") {
        continue;
      }

      const result = await confirmPermission(call, decision, params, {
        category: "dangerous",
        metadata: { preflight },
        reason: `Sensitive path access requires confirmation: ${sensitivePath.absolutePath}`,
        toolName: "sensitive_path",
      });
      if (result) {
        return result;
      }
    }

    return null;
  }

  async function confirmExternalReadPermission(
    call: ToolCall,
    context: ToolPermissionContext,
  ): Promise<ToolCallResult | null> {
    if (!context.externalRead || !context.externalReadPath) {
      return null;
    }
    const controller = controllers.get(identity(call));
    if (!controller) {
      return makeCancelledResult(call);
    }
    if (isCancelled(call) || controller.signal.aborted) {
      return makeCancelledResult(call);
    }

    const externalPath: PreflightExternalPath = {
      absolutePath: context.externalReadPath,
      askPattern:
        context.externalReadAskPattern ??
        (await externalPermissionAskPattern(context.externalReadPath)),
      original: context.externalReadPath,
    };
    const params = {
      path: externalPath.absolutePath,
      pattern: externalPath.askPattern,
    };

    async function trustExternalReadPath(): Promise<void> {
      await context.environment?.trustPath?.({
        kind: "external-write-approved",
        path: trustedRootFromExternalPath(externalPath),
        source: "external_directory",
      });
    }

    let decision: PermissionDecision;
    try {
      decision = await waitForAbortable(
        () =>
          evaluatePermission(
            {
              callId: call.callId,
              category: "dangerous",
              messageId: call.messageId,
              params,
              sessionId: call.sessionId,
              toolName: "external_directory",
            },
            permissionState.getState(),
          ),
        controller.signal,
      );
    } catch (error) {
      if (error instanceof ToolDeliveryError) throw error;
      if (isSchedulerAbortError(error)) {
        return makeCancelledResult(call);
      }
      transition(call, "error");
      return makeResult(call, "error", {
        error: createError("ExecutionError", errorMessage(error), error),
      });
    }

    if (decision.type === "deny") {
      transition(call, "rejected");
      return makeResult(call, "rejected", {
        error: createError("PermissionDeniedError", decision.reason),
      });
    }
    if (decision.type === "allow") {
      return null;
    }

    return confirmPermission(call, decision, params, {
      category: "dangerous",
      onResponse: async (response) => {
        if (response === "always") {
          await trustExternalReadPath();
        }
      },
      reason: `External path access requires confirmation: ${externalPath.absolutePath}`,
      toolName: "external_directory",
    });
  }

  async function confirmExternalWritePermission(
    call: ToolCall,
    context: ToolPermissionContext,
  ): Promise<ToolCallResult | null> {
    if (!context.externalWrite || !context.externalWritePath) {
      return null;
    }
    const controller = controllers.get(identity(call));
    if (!controller) {
      return makeCancelledResult(call);
    }
    if (isCancelled(call) || controller.signal.aborted) {
      return makeCancelledResult(call);
    }

    const externalPath: PreflightExternalPath = {
      absolutePath: context.externalWritePath,
      askPattern: await externalPermissionAskPattern(context.externalWritePath),
      original: context.externalWritePath,
    };
    const params = {
      path: externalPath.absolutePath,
      pattern: externalPath.askPattern,
    };

    async function trustExternalWritePath(): Promise<void> {
      await context.environment?.trustPath?.({
        kind: "external-approved",
        path: trustedRootFromExternalPath(externalPath),
        source: "external_directory",
      });
    }

    const permissionSnapshot = permissionState.getState();
    let decision: PermissionDecision;
    try {
      decision = await waitForAbortable(
        () =>
          evaluatePermission(
            {
              callId: call.callId,
              category: "dangerous",
              messageId: call.messageId,
              params,
              sessionId: call.sessionId,
              toolName: "external_directory",
            },
            permissionSnapshot,
          ),
        controller.signal,
      );
    } catch (error) {
      if (error instanceof ToolDeliveryError) throw error;
      if (isSchedulerAbortError(error)) {
        return makeCancelledResult(call);
      }
      transition(call, "error");
      return makeResult(call, "error", {
        error: createError("ExecutionError", errorMessage(error), error),
      });
    }

    if (decision.type === "deny") {
      transition(call, "rejected");
      return makeResult(call, "rejected", {
        error: createError("PermissionDeniedError", decision.reason),
      });
    }
    if (decision.type === "allow") {
      // FullAccess authorizes this call without remembering directory trust.
      if (permissionSnapshot.level !== "full-access") {
        await trustExternalWritePath();
      }
      return null;
    }

    return confirmPermission(call, decision, params, {
      category: "dangerous",
      onResponse: async (response) => {
        if (response === "always") {
          await trustExternalWritePath();
        }
      },
      reason: `External write path access requires confirmation: ${externalPath.absolutePath}`,
      toolName: "external_directory",
    });
  }

  function permissionSnapshot(sessionId: string): PermissionAdmissionSnapshot {
    const state = permissionState.getState();
    return {
      level: state.level,
      mode: state.mode,
      rules: (state.sessionRules.get(sessionId) ?? []).map((rule) => ({
        value: JSON.stringify(rule),
        decision: rule.decision,
      })),
    };
  }

  function contextFor(
    prepared: PreparedCall,
    environment = prepared.request.environment,
  ): ToolExecutionContext {
    return {
      callId: prepared.call.callId,
      runId: prepared.call.runId,
      sessionId: prepared.call.sessionId,
      messageId: prepared.call.messageId,
      contextScopeId: prepared.call.contextScopeId,
      signal: prepared.controller.signal,
      environment,
      owner: prepared.owner,
    };
  }

  async function runTool(
    prepared: PreparedCall,
    publish: ReturnType<typeof factPublisher>,
  ): Promise<ToolCallResult> {
    const { call, tool, controller } = prepared;
    let capacity: CapacityLease | undefined;
    let resourceLease: ResourceLease | undefined;
    let invoked = false;
    try {
      const environment = executionEnvironmentFor(prepared);
      let params = executionParamsFor(prepared);
      const admission = trustedToolAdmission(tool);
      const access = await waitForAbortable(
        () =>
          admission?.resolve?.(params, contextFor(prepared, environment)) ?? {
            resources: [],
          },
        controller.signal,
      );
      const plan = admission?.plan;
      const plannedResources = plan
        ? await waitForAbortable(
            () => plan(params, contextFor(prepared, environment)),
            controller.signal,
          )
        : undefined;
      const sourceSensitive =
        admission?.capacity !== "control" &&
        admission?.capacity !== "dispatch" &&
        (access.resources.some((resource) => resource.kind === "file") ||
          (plannedResources === undefined &&
            admission?.resolve === undefined) ||
          plannedResources?.some((resource) => resource.kind === "file"));
      const sourceWait = (): "source-cleanup" | undefined => {
        if (!sourceSensitive) return undefined;
        const state = getSourceCleanupState(prepared.owner);
        if (state === "unconfirmed") throw new SourceCleanupUnavailableError();
        return state === "in-progress" ? "source-cleanup" : undefined;
      };
      params = access.params ?? params;
      if (
        prepared.permissionContext.accessIdentity &&
        access.resources.some(
          (resource) =>
            resource.kind === "file" &&
            !isSamePath(
              resource.path,
              prepared.permissionContext.accessIdentity ?? resource.path,
            ),
        )
      )
        throw new AdmissionChangedError();
      transition(call, "queued");
      resourceLease = await acquireResources(access.resources, {
        signal: controller.signal,
        admissionWait: sourceWait,
        canAcquire: () => {
          if (isStopped(call, controller)) return false;
          capacity = concurrency.tryAcquire(
            admission?.capacity ?? "ordinary",
            call.sessionId,
          );
          return capacity !== undefined;
        },
        onWait: (reason) => {
          publish({ phase: "waiting", reason, resources: access.resources });
        },
      });
      if (isStopped(call, controller)) return makeCancelledResult(call);
      const decision = evaluatePermission(
        {
          callId: call.callId,
          toolName: call.toolName,
          category:
            call.category === "subagent-control" ? "subagent" : call.category,
          params: prepared.permissionContext.params,
          sessionId: call.sessionId,
          messageId: call.messageId,
        },
        permissionState.getState(),
      );
      if (decision.type === "deny") {
        transition(call, "rejected");
        return makeResult(call, "rejected", {
          error: createError("PermissionDeniedError", decision.reason),
        });
      }
      if (
        !permissionStillAuthorized(
          prepared.permissionSnapshot,
          permissionSnapshot(call.sessionId),
        )
      )
        throw new AdmissionChangedError();
      if (sourceWait()) throw new AdmissionChangedError();
      await deliveries.get(call)?.flush();
      if (isStopped(call, controller)) return makeCancelledResult(call);
      const output = await executeToolWithTimeout(
        prepared,
        environment,
        params,
        resourceLease,
        access.resources,
        publish,
        () => {
          invoked = true;
        },
        () => {
          if (
            sourceWait() ||
            !permissionStillAuthorized(
              prepared.permissionSnapshot,
              permissionSnapshot(call.sessionId),
            )
          )
            throw new AdmissionChangedError();
        },
      );
      if (isStopped(call, controller)) return makeCancelledResult(call);
      transition(call, "success");
      return makeResult(call, "success", output);
    } catch (error) {
      if (error instanceof ToolDeliveryError) throw error;
      if (error instanceof AdmissionChangedError) throw error;
      if (isSchedulerAbortError(error) && error.kind === "timeout") {
        transition(call, "error");
        return makeResult(call, "error", {
          error: createError(
            "TimeoutError",
            `Tool call timed out: ${call.toolName}`,
          ),
        });
      }
      if (
        isSchedulerAbortError(error) ||
        isCancelled(call) ||
        controller.signal.aborted
      )
        return makeCancelledResult(call);
      transition(call, "error");
      return makeResult(call, "error", {
        error: createError(
          "ExecutionError",
          error instanceof ResourceUnavailableError
            ? "Tool not executed: a previous operation has unconfirmed cleanup and related resources remain protected. Continue independent work; if blocked, explain the reason to the user; do not automatically retry, poll, or repeatedly kill."
            : errorMessage(error),
          error,
        ),
      });
    } finally {
      // Ownership can be transferred synchronously by the invocation callback.
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition
      if (!invoked) resourceLease?.release();
      capacity?.release();
    }
  }

  function makeImmediateErrorResult(
    request: ToolCallRequest,
    error: ToolCallError,
  ): ToolCallResult {
    return {
      callId: request.callId,
      error,
      status: "error",
    };
  }

  function validateBasicRequest(
    request: ToolCallRequest,
  ): ToolCallError | null {
    if (!request.callId.trim()) {
      return createError("ValidationError", "Tool callId must be non-empty");
    }
    if (calls.has(identity(request))) {
      return createError(
        "ValidationError",
        `Tool callId already exists: ${request.callId}`,
      );
    }
    if (!request.toolName.trim()) {
      return createError("ValidationError", "Tool name must be non-empty");
    }
    if (!request.sessionId.trim()) {
      return createError("ValidationError", "Tool sessionId must be non-empty");
    }
    if (!request.messageId.trim()) {
      return createError("ValidationError", "Tool messageId must be non-empty");
    }

    return null;
  }

  async function isToolAvailableForRequest(
    request: ToolCallRequest,
    tool: Tool,
  ): Promise<boolean> {
    const agentConfig = await options.agentTools?.getAgentConfig(
      request.agentName,
    );
    const tools = normalizeAgentToolsConfig(agentConfig?.tools);
    if (
      !isEnabledByAgentConfig(request.toolName, tools) &&
      !(tool.source === "mcp" && tools?.select_tools === true)
    ) {
      return false;
    }
    return (
      request.isSubagent !== true ||
      !SUBAGENT_DISABLED_TOOLS.has(request.toolName)
    );
  }

  async function createPermissionContext(
    request: ToolCallRequest,
    category: ToolCategory,
    tool: Tool,
  ): Promise<ToolPermissionContext> {
    const requireExplicitApproval = tool.requireExplicitApproval === true;
    if (tool.name === "bash" && request.environment?.preflight) {
      const command =
        typeof request.params.command === "string"
          ? request.params.command
          : "";
      try {
        const shellKind = detectShellKind(Shell.acceptable());
        const preflight = await request.environment.preflight(
          command,
          shellKind,
        );
        return {
          environment: request.environment,
          externalRead: false,
          externalWrite: false,
          preflight,
          requireExplicitApproval,
          params: request.params,
        };
      } catch (error) {
        if (error instanceof ToolDeliveryError) throw error;
        return {
          environment: request.environment,
          externalRead: false,
          externalWrite: false,
          preflightError: error,
          requireExplicitApproval,
          params: request.params,
        };
      }
    }

    if (!request.environment) {
      return {
        environment: request.environment,
        externalRead: false,
        externalWrite: false,
        requireExplicitApproval,
        params: request.params,
      };
    }

    if (category === "readonly") {
      const filePath = getFilePathParam(request.params);
      if (!filePath) {
        return {
          environment: request.environment,
          externalRead: false,
          externalWrite: false,
          requireExplicitApproval,
          params: request.params,
        };
      }
      const canonicalPath = await canonicalizeForPermission(
        request.environment,
        filePath,
      );
      const externalRead = isOutsideTrustedEnvironment(
        request.environment,
        canonicalPath,
      );
      return {
        environment: request.environment,
        externalRead,
        externalReadAskPattern: externalRead
          ? await externalPermissionAskPattern(canonicalPath)
          : undefined,
        externalReadPath: externalRead ? canonicalPath : undefined,
        externalWrite: false,
        requireExplicitApproval,
        accessIdentity: canonicalPath,
        params: externalRead
          ? paramsWithCanonicalPath(request.params, canonicalPath)
          : request.params,
      };
    }

    if (category !== "write") {
      return {
        environment: request.environment,
        externalRead: false,
        externalWrite: false,
        requireExplicitApproval,
        params: request.params,
      };
    }

    const filePath = getFilePathParam(request.params);
    if (!filePath) {
      return {
        environment: request.environment,
        externalRead: false,
        externalWrite: false,
        requireExplicitApproval,
        params: request.params,
      };
    }

    const canonicalPath = await canonicalizeForPermission(
      request.environment,
      filePath,
    );
    const externalWrite = isOutsideWriteTrustedEnvironment(
      request.environment,
      canonicalPath,
    );

    return {
      environment: request.environment,
      externalRead: false,
      externalWrite,
      externalWritePath: externalWrite ? canonicalPath : undefined,
      requireExplicitApproval,
      accessIdentity: canonicalPath,
      params: externalWrite
        ? paramsWithCanonicalPath(request.params, canonicalPath)
        : request.params,
    };
  }

  function executionEnvironmentFor(
    prepared: PreparedCall,
  ): ToolExecutionEnvironment | undefined {
    const environment = prepared.request.environment;
    const externalReadPath = prepared.permissionContext.externalReadPath;
    const externalWritePath = prepared.permissionContext.externalWritePath;
    if (
      environment &&
      prepared.permissionContext.externalWrite &&
      externalWritePath
    ) {
      return createExternalWriteEnvironment(environment, externalWritePath);
    }
    if (
      environment &&
      prepared.permissionContext.externalRead &&
      externalReadPath
    ) {
      return createExternalReadEnvironment(environment, externalReadPath);
    }
    return environment;
  }

  function executionParamsFor(prepared: PreparedCall): Record<string, unknown> {
    return prepared.permissionContext.externalWrite ||
      prepared.permissionContext.externalRead
      ? prepared.permissionContext.params
      : prepared.call.params;
  }

  async function prepareCall(
    request: ToolCallRequest,
    index: number,
  ): Promise<
    { readonly prepared: PreparedCall } | { readonly result: ToolCallResult }
  > {
    await requestDeliveries.get(request)?.update({ phase: "preparing" });
    const basicError = validateBasicRequest(request);
    if (basicError)
      return { result: makeImmediateErrorResult(request, basicError) };
    const tool = registry.get(request.toolName);
    const category = registry.getCategory(request.toolName) ?? "write";
    // Register identity and cancellation before any asynchronous policy lookup.
    const call = createCall(request, category);
    const controller = new AbortController();
    controllers.set(identity(call), controller);
    const unbind = bindRequestSignal(call, request.signal);
    const cleanup = (): void => {
      unbind();
      controllers.delete(identity(call));
    };
    let transferred = false;
    try {
      if (isStopped(call, controller))
        return { result: makeCancelledResult(call) };
      if (!tool) {
        transition(call, "error");
        return {
          result: makeResult(call, "error", {
            error: createError(
              "ToolNotFoundError",
              `Tool not found: ${request.toolName}`,
            ),
          }),
        };
      }
      const paramsError = validateParameters(
        request.params,
        tool.parametersJsonSchema,
      );
      if (paramsError) {
        transition(call, "error");
        return {
          result: makeResult(call, "error", {
            error: createError("ValidationError", paramsError),
          }),
        };
      }
      const available = await waitForAbortable(
        () => isToolAvailableForRequest(request, tool),
        controller.signal,
      );
      if (!available) {
        transition(call, "rejected");
        return {
          result: makeResult(call, "rejected", {
            error: createError(
              "PermissionDeniedError",
              `Tool not available for agent: ${request.toolName}`,
            ),
          }),
        };
      }
      const denied = await waitForAbortable(
        () => options.accessGuard?.({ request, tool }),
        controller.signal,
      );
      if (denied) {
        transition(call, "rejected");
        return {
          result: makeResult(call, "rejected", {
            error: createError("PermissionDeniedError", denied),
          }),
        };
      }
      transferred = true;
      return {
        prepared: {
          call,
          category,
          controller,
          cleanup,
          index,
          request,
          tool,
          permissionContext: {
            environment: request.environment,
            externalRead: false,
            externalWrite: false,
            requireExplicitApproval: tool.requireExplicitApproval === true,
            params: request.params,
          },
          owner: {
            sessionId: request.sessionId,
            runId: request.runId,
            messageId: request.messageId,
            callId: request.callId,
            contextScopeId: request.contextScopeId,
            scopeKey: request.environment?.scopeKey,
          },
        },
      };
    } catch (error) {
      if (error instanceof ToolDeliveryError) throw error;
      if (isStopped(call, controller) || isSchedulerAbortError(error))
        return { result: makeCancelledResult(call) };
      transition(call, "error");
      return {
        result: makeResult(call, "error", {
          error: createError("ExecutionError", errorMessage(error)),
        }),
      };
    } finally {
      if (!transferred) cleanup();
    }
  }

  async function preflightCall(
    prepared: PreparedCall,
  ): Promise<ToolCallResult | null> {
    if (isCancelled(prepared.call)) {
      return makeCancelledResult(prepared.call);
    }
    if (prepared.permissionContext.preflightError !== undefined) {
      transition(prepared.call, "error");
      return makeResult(prepared.call, "error", {
        error: createError(
          "ExecutionError",
          `Bash preflight failed: ${errorMessage(prepared.permissionContext.preflightError)}`,
          prepared.permissionContext.preflightError,
        ),
      });
    }
    const externalPermissionResult = await confirmExternalPreflightPermissions(
      prepared.call,
      prepared.permissionContext,
    );
    if (externalPermissionResult) {
      return externalPermissionResult;
    }
    const externalReadResult = await confirmExternalReadPermission(
      prepared.call,
      prepared.permissionContext,
    );
    if (externalReadResult) {
      return externalReadResult;
    }
    const permissionDecision = await evaluatePermissionOnly(
      prepared.call,
      prepared.permissionContext,
    );
    if ("status" in permissionDecision) {
      return permissionDecision;
    }
    if (permissionDecision.type === "allow") {
      const externalWriteResult = await confirmExternalWritePermission(
        prepared.call,
        prepared.permissionContext,
      );
      if (externalWriteResult) {
        return externalWriteResult;
      }
    }
    if (permissionDecision.type === "ask") {
      const permissionResult = await confirmPermission(
        prepared.call,
        permissionDecision,
        prepared.permissionContext.params,
      );
      if (permissionResult) {
        return permissionResult;
      }
    }

    return confirmExplicitApproval(prepared.call, prepared.permissionContext);
  }

  async function executePrepared(
    prepared: PreparedCall,
    predecessors: readonly Promise<unknown>[] = [],
  ): Promise<ToolCallResult> {
    let publish = factPublisher(prepared.owner, deliveries.get(prepared.call));
    try {
      const resolveOwner = options.resolveOwner;
      if (resolveOwner)
        prepared.owner = await waitForAbortable(
          () => resolveOwner(prepared.request),
          prepared.controller.signal,
        );
      publish = factPublisher(prepared.owner, deliveries.get(prepared.call));
      if (predecessors.length) {
        transition(prepared.call, "queued");
        publish({ phase: "waiting", reason: "predecessor" });
        await waitForAbortable(
          () => Promise.all(predecessors),
          prepared.controller.signal,
        );
      }
      if (isStopped(prepared.call, prepared.controller))
        return makeCancelledResult(prepared.call);
      for (;;) {
        // Capture the policy that this preparation authorizes before any await.
        // Only appended allow rules (such as this call's remembered approval)
        // preserve authorization; revocations and mode changes start a fresh pass.
        prepared.permissionSnapshot = permissionSnapshot(
          prepared.call.sessionId,
        );
        prepared.permissionContext = await waitForAbortable(
          () =>
            createPermissionContext(
              prepared.request,
              prepared.category,
              prepared.tool,
            ),
          prepared.controller.signal,
        );
        const preflightResult = await preflightCall(prepared);
        if (preflightResult) return preflightResult;
        if (prepared.permissionContext.accessIdentity !== undefined) {
          const current = await waitForAbortable(
            () =>
              createPermissionContext(
                prepared.request,
                prepared.category,
                prepared.tool,
              ),
            prepared.controller.signal,
          );
          if (
            current.accessIdentity !== prepared.permissionContext.accessIdentity
          )
            continue;
        }
        if (
          !permissionStillAuthorized(
            prepared.permissionSnapshot,
            permissionSnapshot(prepared.call.sessionId),
          )
        )
          continue;
        try {
          return await runTool(prepared, publish);
        } catch (error) {
          if (error instanceof ToolDeliveryError) throw error;
          if (!(error instanceof AdmissionChangedError)) throw error;
        }
        // Policy/target changed during admission. Locks and capacity have been
        // returned by runTool; permission preparation may safely ask again.
      }
    } catch (error) {
      if (error instanceof ToolDeliveryError) throw error;
      if (
        isStopped(prepared.call, prepared.controller) ||
        isSchedulerAbortError(error)
      )
        return makeCancelledResult(prepared.call);
      transition(prepared.call, "error");
      return makeResult(prepared.call, "error", {
        error: createError("ExecutionError", errorMessage(error)),
      });
    } finally {
      if (prepared.call.result) {
        publish({ phase: "settled", outcome: prepared.call.result });
        bus.publish(ToolSchedulerEvent.ExecutionCompleted, {
          callId: prepared.call.callId,
          toolName: prepared.call.toolName,
          result: prepared.call.result,
          timestamp: now(),
        });
      }
      prepared.cleanup();
    }
  }

  async function execute(request: ToolCallRequest): Promise<ToolCallResult> {
    const result = await prepareCall(request, 0);
    return "result" in result
      ? result.result
      : executePrepared(result.prepared);
  }

  function batchConflict(
    left: { tool?: Tool; resources?: readonly ResourceAccess[] },
    right: { tool?: Tool; resources?: readonly ResourceAccess[] },
  ): boolean {
    const a = left.resources;
    const b = right.resources;
    if (a && b) return resourcesConflict(a, b);
    // Unknown effects are a batch barrier, not a fictitious process-wide lock.
    // Explicit internal scopes/control/network operations can remain independent.
    if (a?.every((resource) => resource.kind !== "file")) return false;
    if (b?.every((resource) => resource.kind !== "file")) return false;
    const parallelRead = (item: typeof left): boolean =>
      item.tool?.source === "mcp" &&
      item.tool.isTrusted === true &&
      item.tool.annotations?.readOnlyHint === true;
    if (!a && !b && parallelRead(left) && parallelRead(right)) return false;
    return true;
  }

  async function executeBatch(
    request: BatchToolCallRequest,
  ): Promise<ToolCallResult[]> {
    const batchController = new AbortController();
    let fatal: ToolDeliveryError | undefined;
    let rejectFatal!: (error: ToolDeliveryError) => void;
    const fatalPromise = new Promise<never>((_resolve, reject) => {
      rejectFatal = reject;
    });
    void fatalPromise.catch(() => undefined);
    const fail = (error: ToolDeliveryError): void => {
      if (fatal) return;
      fatal = error;
      batchController.abort();
      rejectFatal(error);
    };
    const batchCalls = request.calls.map((call, index) => {
      const bound = {
        ...call,
        signal: call.signal
          ? AbortSignal.any([call.signal, batchController.signal])
          : batchController.signal,
      };
      if (request.observer)
        requestDeliveries.set(
          bound,
          new CallDelivery(
            call,
            index,
            request.observer,
            (error, state) => {
              fail(error);
              // Report the original failed fact even when the batch race has already
              // resolved. Never redirect a late failure to the session's newer run.
              bus.publish(ToolSchedulerEvent.DeliveryFailed, {
                sessionId: call.sessionId,
                runId: call.runId,
                messageId: call.messageId,
                callId: call.callId,
                timestamp: now(),
                phase: state.phase,
                cleanup: state.cleanup,
                message: error.message,
              });
              const fact: ToolExecutionFact = {
                owner: {
                  sessionId: call.sessionId,
                  runId: call.runId,
                  messageId: call.messageId,
                  callId: call.callId,
                  contextScopeId: call.contextScopeId,
                },
                phase: state.cleanup
                  ? "cleanup"
                  : state.phase === "ended"
                    ? "settled"
                    : state.phase === "executing"
                      ? "started"
                      : "waiting",
                timestamp: now(),
                cleanup: state.cleanup,
              };
              void Promise.resolve()
                .then(() => options.onExecutionFactError?.(error, fact))
                .catch(() => undefined);
              request.observer?.onDeliveryError?.(call, error, state);
            },
            now(),
          ),
        );
      return bound;
    });
    const preparations = batchCalls.map((call, index) =>
      prepareCall(call, index),
    );
    const plannedTools = batchCalls.map((call) => registry.get(call.toolName));
    const resolvedPlans: (
      | { tool?: Tool; resources?: readonly ResourceAccess[] }
      | undefined
    )[] = [];
    const plans = batchCalls.map(async (call, index) => {
      const tool = plannedTools[index];
      let resources: readonly ResourceAccess[] | undefined;
      const signal = controllers.get(identity(call))?.signal ?? call.signal;
      try {
        resources = await waitForAbortable(
          () =>
            tool
              ? trustedToolAdmission(tool)?.plan?.(call.params, {
                  callId: call.callId,
                  runId: call.runId,
                  sessionId: call.sessionId,
                  messageId: call.messageId,
                  contextScopeId: call.contextScopeId,
                  environment: call.environment,
                  signal,
                })
              : [],
          signal,
        );
      } catch {
        /* Actual preparation reports errors; unknown scope stays conservative. */
      }
      const plan = { tool, resources };
      resolvedPlans[index] = plan;
      return plan;
    });
    const running: Promise<ToolCallResult>[] = [];
    for (const [index, preparation] of preparations.entries()) {
      running.push(
        preparation.then(async (item) => {
          if ("result" in item) return item.result;
          const current = await plans[index];
          const predecessors = plans
            .slice(0, index)
            .flatMap((previousPlan, previousIndex) => {
              const known = resolvedPlans[previousIndex];
              const previousTool = plannedTools[previousIndex];
              // Empty access is explicitly independent. A scoped call must first
              // resolve an earlier declared plan that could name the same scope;
              // an undeclared unknown (such as Bash) keeps its existing semantics.
              const pendingScopePlan =
                known === undefined &&
                previousTool !== undefined &&
                trustedToolAdmission(previousTool)?.plan !== undefined &&
                current.resources?.some(
                  (resource) => resource.kind === "scope",
                );
              if (
                !pendingScopePlan &&
                !batchConflict(known ?? { tool: previousTool }, current)
              )
                return [];
              return [
                previousPlan.then((previous) =>
                  batchConflict(previous, current)
                    ? running[previousIndex]
                    : undefined,
                ),
              ];
            });
          return executePrepared(item.prepared, predecessors);
        }),
      );
    }
    const delivered = running.map(async (operation, index) => {
      const result = await operation;
      const delivery = requestDeliveries.get(batchCalls[index]);
      await delivery?.settle(
        result,
        calls.get(identity(batchCalls[index]))?.completedAt ?? now(),
      );
      return delivery ? { ...result, execution: delivery.state } : result;
    });
    return Promise.race([Promise.all(delivered), fatalPromise]);
  }

  return {
    register(tool: Tool): void {
      registry.register(tool);
    },

    unregister(toolName: string): void {
      registry.unregister(toolName);
    },

    registerCategory(toolName: string, category: ToolCategory): void {
      registry.registerCategory(toolName, category);
    },

    get(toolName: string): Tool | undefined {
      return registry.get(toolName);
    },

    getCategory(toolName: string): ToolCategory | undefined {
      return registry.getCategory(toolName);
    },

    async getAvailableTools(input = {}): Promise<ToolDefinition[]> {
      const agentConfig = await options.agentTools?.getAgentConfig(
        input.agentName,
      );
      return registry.getAvailableTools({
        tools: normalizeAgentToolsConfig(agentConfig?.tools),
        isSubagent: input.isSubagent,
      });
    },

    execute,
    executeBatch,

    cancel(callId: string): boolean {
      const call = findCall(callId);
      if (!call) {
        return false;
      }
      return cancelCall(call);
    },

    cancelAll(): void {
      concurrency.cancelAll();
      for (const call of calls.values()) {
        if (!isFinal(call.status)) {
          controllers.get(identity(call))?.abort();
          transition(call, "cancelled");
        }
      }
    },

    getStatus(callId: string): ToolCallStatus | null {
      return findCall(callId)?.status ?? null;
    },

    getPendingCalls(): ToolCall[] {
      return Array.from(calls.values()).filter((call) => !isFinal(call.status));
    },
  };
}
