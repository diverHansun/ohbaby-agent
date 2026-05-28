import fs from "node:fs/promises";
import path from "node:path";
import {
  createPermissionState,
  evaluatePermission,
} from "../../permission/index.js";
import type {
  PreflightExternalPath,
  PreflightResult,
} from "../../sandbox/index.js";
import { detectShellKind, Shell } from "../../shell/index.js";
import {
  DEFAULT_TOOL_SCHEDULER_CONFIG,
  SUBAGENT_DISABLED_TOOLS,
} from "./constants.js";
import { ConcurrencyController } from "./concurrency.js";
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
  ToolExecutionResult,
  ToolRegistry,
  ToolScheduler,
  ToolSchedulerConfig,
  ToolSchedulerOptions,
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
  readonly permissionContext: ToolPermissionContext;
}

interface ToolPermissionContext {
  readonly externalWrite: boolean;
  readonly preflight?: PreflightResult;
  readonly preflightError?: unknown;
  readonly untrustedMcp: boolean;
  readonly params: Record<string, unknown>;
}

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
    },
  };
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
  return relative.startsWith("..") || path.isAbsolute(relative);
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

function isParallelWaveCategory(category: ToolCategory): boolean {
  return (
    category === "readonly" || category === "network" || category === "skill"
  );
}

function splitIntoWaves<T extends ScheduledCall>(calls: readonly T[]): T[][] {
  const waves: T[][] = [];
  let currentWave: T[] = [];

  for (const call of calls) {
    if (call.category === "memory" || call.category === "subagent") {
      continue;
    }
    if (isParallelWaveCategory(call.category)) {
      if (
        currentWave.length > 0 &&
        !isParallelWaveCategory(currentWave[0].category)
      ) {
        waves.push(currentWave);
        currentWave = [];
      }
      currentWave.push(call);
    } else {
      if (currentWave.length > 0) {
        waves.push(currentWave);
        currentWave = [];
      }
      waves.push([call]);
    }
  }

  if (currentWave.length > 0) {
    waves.push(currentWave);
  }

  return waves;
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

async function realpathIfExists(
  inputPath: string,
): Promise<string | undefined> {
  try {
    return await fs.realpath(inputPath);
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return undefined;
    }
    throw error;
  }
}

async function canonicalizeForPermission(
  environment: ToolExecutionEnvironment,
  inputPath: string,
): Promise<string> {
  const lexical = environment.resolvePath(inputPath);
  const existing = await realpathIfExists(lexical);
  if (existing) {
    return existing;
  }

  const missingSegments: string[] = [];
  let current = path.dirname(lexical);
  for (;;) {
    const realParent = await realpathIfExists(current);
    if (realParent) {
      return path.join(
        realParent,
        ...missingSegments.reverse(),
        path.basename(lexical),
      );
    }

    const parent = path.dirname(current);
    if (parent === current) {
      return lexical;
    }
    missingSegments.push(path.basename(current));
    current = parent;
  }
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
  const registry: ToolRegistry = createToolRegistry();
  const now = options.now ?? Date.now;
  const calls = new Map<string, ToolCall>();
  const controllers = new Map<string, AbortController>();

  function transition(call: ToolCall, status: ToolCallStatus): void {
    if (call.status === status) {
      return;
    }
    if (isFinal(call.status)) {
      return;
    }
    const previousStatus = call.status;
    call.status = status;
    if (status === "executing") {
      call.startedAt = now();
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
      readonly metadata?: Record<string, unknown>;
      readonly error?: ToolCallError;
    } = {},
  ): ToolCallResult {
    const result = {
      callId: call.callId,
      status,
      output: input.output,
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
      messageId: request.messageId,
      category,
      status: "pending",
      createdAt: now(),
    } satisfies ToolCall;
    calls.set(call.callId, call);
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
    controllers.get(call.callId)?.abort();
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
    call: ToolCall,
    tool: Tool,
    controller: AbortController,
    environment: ToolExecutionEnvironment | undefined,
  ): Promise<ToolExecutionResult> {
    if (controller.signal.aborted) {
      throw new SchedulerAbortError("cancelled");
    }
    let timedOut = false;
    let timeout: NodeJS.Timeout | undefined;
    let removeAbortListener = (): void => undefined;
    const toolPromise = Promise.resolve(
      tool.execute(call.params, {
        callId: call.callId,
        environment,
        messageId: call.messageId,
        sessionId: call.sessionId,
        signal: controller.signal,
      }),
    );
    void toolPromise.catch(() => undefined);
    const abortPromise = new Promise<never>((_resolve, reject) => {
      const onAbort = (): void => {
        reject(new SchedulerAbortError(timedOut ? "timeout" : "cancelled"));
      };
      removeAbortListener = (): void => {
        controller.signal.removeEventListener("abort", onAbort);
      };
      controller.signal.addEventListener("abort", onAbort, { once: true });
      timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, config.timeout.defaultTimeout);
    });

    try {
      return await Promise.race([toolPromise, abortPromise]);
    } finally {
      if (timeout) {
        clearTimeout(timeout);
      }
      removeAbortListener();
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
    return options.permission.ask({
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
    const controller = controllers.get(call.callId);
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
              category: call.category,
              params: context.params,
              sessionId: call.sessionId,
              messageId: call.messageId,
            },
            permissionState.getState(),
          ),
        controller.signal,
      );
    } catch (error) {
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
    if (decision.type === "allow" && context.externalWrite) {
      return {
        reason: `External path write requires confirmation: ${call.toolName}`,
        rememberable: false,
        type: "ask",
      };
    }
    if (decision.type === "allow" && context.untrustedMcp) {
      return {
        reason: "untrusted-mcp-tool",
        rememberable: false,
        type: "ask",
      };
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
      readonly reason?: string;
      readonly toolName?: string;
    } = {},
  ): Promise<ToolCallResult | null> {
    const controller = controllers.get(call.callId);
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

    return null;
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

    const controller = controllers.get(call.callId);
    if (!controller) {
      return makeCancelledResult(call);
    }
    for (const externalPath of uniqueExternalPaths(preflight.externalPaths)) {
      if (isCancelled(call) || controller.signal.aborted) {
        return makeCancelledResult(call);
      }
      const params = {
        path: externalPath.absolutePath,
        pattern: externalPath.askPattern,
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
                toolName: "external_directory",
              },
              permissionState.getState(),
            ),
          controller.signal,
        );
      } catch (error) {
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
        reason: `External path access requires confirmation: ${externalPath.absolutePath}`,
        toolName: "external_directory",
      });
      if (result) {
        return result;
      }
    }

    return null;
  }

  async function runTool(
    call: ToolCall,
    tool: Tool,
    controller: AbortController,
    environment: ToolExecutionEnvironment | undefined,
  ): Promise<ToolCallResult> {
    transition(call, "queued");
    const acquired = await concurrency.waitForSlot(call.callId, call.category);
    if (!acquired) {
      return makeCancelledResult(call);
    }

    try {
      if (isStopped(call, controller)) {
        return makeCancelledResult(call);
      }
      transition(call, "executing");
      if (isStopped(call, controller)) {
        return makeCancelledResult(call);
      }
      bus.publish(ToolSchedulerEvent.ExecutionStarted, {
        callId: call.callId,
        toolName: call.toolName,
        params: call.params,
        timestamp: now(),
      });
      if (isStopped(call, controller)) {
        return makeCancelledResult(call);
      }
      const output = await executeToolWithTimeout(
        call,
        tool,
        controller,
        environment,
      );
      if (isStopped(call, controller)) {
        return makeCancelledResult(call);
      }
      transition(call, "success");
      return makeResult(call, "success", output);
    } catch (error) {
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
      ) {
        return makeCancelledResult(call);
      }
      transition(call, "error");
      return makeResult(call, "error", {
        error: createError("ExecutionError", errorMessage(error), error),
      });
    } finally {
      concurrency.release(call.category);
      if (call.result) {
        bus.publish(ToolSchedulerEvent.ExecutionCompleted, {
          callId: call.callId,
          toolName: call.toolName,
          result: call.result,
          timestamp: now(),
        });
      }
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
    if (calls.has(request.callId)) {
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
  ): Promise<boolean> {
    const agentConfig = await options.agentTools?.getAgentConfig(
      request.agentName,
    );
    const tools = normalizeAgentToolsConfig(agentConfig?.tools);
    if (!isEnabledByAgentConfig(request.toolName, tools)) {
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
          externalWrite: false,
          preflight,
          untrustedMcp: tool.source === "mcp" && tool.isTrusted !== true,
          params: request.params,
        };
      } catch (error) {
        return {
          externalWrite: false,
          preflightError: error,
          untrustedMcp: tool.source === "mcp" && tool.isTrusted !== true,
          params: request.params,
        };
      }
    }

    if (category !== "write" || !request.environment) {
      return {
        externalWrite: false,
        untrustedMcp: tool.source === "mcp" && tool.isTrusted !== true,
        params: request.params,
      };
    }

    const filePath = getFilePathParam(request.params);
    if (!filePath || !path.isAbsolute(filePath)) {
      return {
        externalWrite: false,
        untrustedMcp: tool.source === "mcp" && tool.isTrusted !== true,
        params: request.params,
      };
    }

    const canonicalPath = await canonicalizeForPermission(
      request.environment,
      filePath,
    );
    const params = { ...request.params };
    for (const key of ["file_path", "filePath", "path"]) {
      if (typeof params[key] === "string") {
        params[key] = canonicalPath;
      }
    }

    return {
      externalWrite: isOutsideWorkdir(
        request.environment.workdir,
        canonicalPath,
      ),
      untrustedMcp: tool.source === "mcp" && tool.isTrusted !== true,
      params,
    };
  }

  async function prepareCall(
    request: ToolCallRequest,
    index: number,
  ): Promise<
    { readonly prepared: PreparedCall } | { readonly result: ToolCallResult }
  > {
    const basicError = validateBasicRequest(request);
    if (basicError) {
      return { result: makeImmediateErrorResult(request, basicError) };
    }
    const tool = registry.get(request.toolName);
    const category = registry.getCategory(request.toolName);
    if (!tool || !category) {
      const call = createCall(request, "write");
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
    if (!(await isToolAvailableForRequest(request))) {
      const call = createCall(request, category);
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
    const paramsError = validateParameters(
      request.params,
      tool.parametersJsonSchema,
    );
    if (paramsError) {
      const call = createCall(request, category);
      transition(call, "error");
      return {
        result: makeResult(call, "error", {
          error: createError("ValidationError", paramsError),
        }),
      };
    }
    const call = createCall(request, category);
    const controller = new AbortController();
    controllers.set(call.callId, controller);
    const unbindRequestSignal = bindRequestSignal(call, request.signal);
    const permissionContext = await createPermissionContext(
      request,
      category,
      tool,
    );
    return {
      prepared: {
        call,
        category,
        cleanup: (): void => {
          unbindRequestSignal();
          controllers.delete(call.callId);
        },
        controller,
        index,
        permissionContext,
        request,
        tool,
      },
    };
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
    const permissionDecision = await evaluatePermissionOnly(
      prepared.call,
      prepared.permissionContext,
    );
    if ("status" in permissionDecision) {
      return permissionDecision;
    }
    if (permissionDecision.type === "ask") {
      return confirmPermission(
        prepared.call,
        permissionDecision,
        prepared.permissionContext.params,
      );
    }

    return null;
  }

  async function execute(request: ToolCallRequest): Promise<ToolCallResult> {
    const preparedResult = await prepareCall(request, 0);
    if ("result" in preparedResult) {
      return preparedResult.result;
    }
    const { prepared } = preparedResult;
    try {
      const preflightResult = await preflightCall(prepared);
      if (preflightResult) {
        return preflightResult;
      }

      return await runTool(
        prepared.call,
        prepared.tool,
        prepared.controller,
        prepared.request.environment,
      );
    } finally {
      prepared.cleanup();
    }
  }

  async function executeBatch(
    request: BatchToolCallRequest,
  ): Promise<ToolCallResult[]> {
    const results: (ToolCallResult | undefined)[] = [];
    const prepared: PreparedCall[] = [];
    for (const [index, call] of request.calls.entries()) {
      const preparedResult = await prepareCall(call, index);
      if ("result" in preparedResult) {
        results[index] = preparedResult.result;
      } else {
        prepared.push(preparedResult.prepared);
      }
    }

    try {
      const runnable: PreparedCall[] = [];
      for (const item of prepared) {
        const result = await preflightCall(item);
        if (result) {
          results[item.index] = result;
        } else {
          runnable.push(item);
        }
      }

      const detached = runnable.filter(
        (call) => call.category === "memory" || call.category === "subagent",
      );
      const waves = splitIntoWaves(runnable);
      const detachedPromise = Promise.all(
        detached.map(async (call) => ({
          index: call.index,
          result: await runTool(
            call.call,
            call.tool,
            call.controller,
            call.request.environment,
          ),
        })),
      ).then(
        (items) => ({ items, status: "fulfilled" as const }),
        (error: unknown) => ({ error, status: "rejected" as const }),
      );

      for (const wave of waves) {
        const waveResults = await Promise.all(
          wave.map(async (call) => ({
            index: call.index,
            result: await runTool(
              call.call,
              call.tool,
              call.controller,
              call.request.environment,
            ),
          })),
        );
        for (const item of waveResults) {
          results[item.index] = item.result;
        }
      }

      const detachedOutcome = await detachedPromise;
      if (detachedOutcome.status === "rejected") {
        throw detachedOutcome.error;
      }
      for (const item of detachedOutcome.items) {
        results[item.index] = item.result;
      }

      return results.map((result, index) => {
        if (result) {
          return result;
        }
        return makeImmediateErrorResult(request.calls[index], {
          message: "Tool call did not produce a result",
          type: "ExecutionError",
        });
      });
    } finally {
      for (const item of prepared) {
        item.cleanup();
      }
    }
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
      const call = calls.get(callId);
      if (!call) {
        return false;
      }
      return cancelCall(call);
    },

    cancelAll(): void {
      concurrency.cancelAll();
      for (const call of calls.values()) {
        if (!isFinal(call.status)) {
          controllers.get(call.callId)?.abort();
          transition(call, "cancelled");
        }
      }
    },

    getStatus(callId: string): ToolCallStatus | null {
      return calls.get(callId)?.status ?? null;
    },

    getPendingCalls(): ToolCall[] {
      return Array.from(calls.values()).filter((call) => !isFinal(call.status));
    },
  };
}
