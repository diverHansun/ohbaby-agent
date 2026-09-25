import type { BusInstance } from "../bus/index.js";
import { PermissionEvent } from "./events.js";
import {
  generatePermissionPattern,
  inferPermissionType,
  isRememberablePermissionPattern,
  matchesPermissionRule,
} from "./matcher.js";
import { evaluatePermission } from "./evaluator.js";
import { parsePermissionPattern } from "./rule.js";
import { createPermissionState } from "./state.js";
import {
  InvalidPermissionChoiceError,
  PermissionUnavailableError,
  PermissionRejectedError,
  PermissionRejectedWithSuggestionError,
} from "./types.js";
import type {
  PermissionCommit,
  PermissionTerminal,
  PermissionRespondResult,
  PermissionAskInput,
  PermissionInfo,
  PermissionManager,
  PermissionEventResponse,
  PermissionResponse,
  PermissionRule,
  PermissionStateStore,
  SchedulerPermissionResponse,
} from "./types.js";

interface PendingRequest {
  readonly info: PermissionInfo;
  readonly input: PermissionAskInput;
  readonly resolve: (response: SchedulerPermissionResponse) => void;
  readonly reject: (error: Error) => void;
  readonly onAbort: () => void;
}

export interface PermissionManagerOptions {
  readonly bus: BusInstance;
  readonly generateId?: () => string;
  readonly now?: () => number;
  readonly state?: PermissionStateStore;
  readonly criticalCommit?: (event: PermissionCommit) => void;
  readonly onCommitted?: (event: PermissionCommit) => void;
  readonly onUnavailable?: (
    rootSessionId: string | undefined,
    error: Error,
  ) => void;
  readonly terminalLimit?: number;
}

function defaultGenerateId(): string {
  return `permission_${String(Date.now())}_${Math.random().toString(36).slice(2, 8)}`;
}

function titleFor(input: PermissionAskInput): string {
  return input.reason ?? `Allow ${input.toolName}?`;
}

function requestedSkillName(
  params: Record<string, unknown>,
): string | undefined {
  const value = params.name;
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : undefined;
}

function createInfo(
  input: PermissionAskInput,
  id: string,
  now: () => number,
): PermissionInfo {
  const type =
    input.category === "skill"
      ? "skill"
      : inferPermissionType(input.toolName, input.params);
  const name =
    type === "skill"
      ? (requestedSkillName(input.params) ?? input.toolName)
      : type === "bash" && typeof input.params.command === "string"
        ? (input.params.command.split(/\s+/)[0] ?? input.toolName)
        : input.toolName;
  const pattern = generatePermissionPattern({
    name,
    params: input.params,
    type,
  });
  return {
    id,
    runId: input.runId,
    rootSessionId: input.source.rootSessionId,
    ancestorSessionIds: Object.freeze([...input.source.ancestorSessionIds]),
    sourceLabel: input.source.sourceLabel,
    contextScopeId: input.contextScopeId,
    sessionId: input.sessionId,
    messageId: input.messageId,
    callId: input.callId,
    type,
    name,
    title: titleFor(input),
    metadata: {
      category: input.category,
      ...(input.metadata ?? {}),
      params: input.params,
      reason: input.reason,
      rememberable: input.rememberable,
      toolName: input.toolName,
    },
    pattern,
    time: {
      created: now(),
    },
  };
}

function validContext(input: Partial<PermissionAskInput>): boolean {
  return Boolean(
    input.runId?.trim() &&
    input.sessionId?.trim() &&
    input.callId?.trim() &&
    input.messageId?.trim() &&
    input.source?.rootSessionId.trim() &&
    input.signal &&
    Array.isArray(input.source.ancestorSessionIds),
  );
}

function isAborted(signal: AbortSignal): boolean {
  return signal.aborted;
}

export function createPermissionManager(
  options: PermissionManagerOptions,
): PermissionManager {
  const { bus } = options;
  const generateId = options.generateId ?? defaultGenerateId;
  const now = options.now ?? Date.now;
  const state = options.state ?? createPermissionState({ bus });
  const pending = new Map<string, PendingRequest>();
  const terminals = new Map<string, PermissionTerminal>();
  const terminalLimit = Math.max(0, options.terminalLimit ?? 1024);
  const failedRoots = new Map<string, PermissionUnavailableError>();
  const revocationScopes = new Set<(input: PermissionAskInput) => boolean>();
  let runtimeFailure: PermissionUnavailableError | undefined;
  let disposed = false;

  function isRevoking(input: PermissionAskInput): boolean {
    return [...revocationScopes].some((matches) => matches(input));
  }

  function healthError(root: string): PermissionUnavailableError | undefined {
    return (
      runtimeFailure ??
      failedRoots.get(root) ??
      (disposed ? new PermissionUnavailableError(root) : undefined)
    );
  }

  function terminalFor(
    request: PendingRequest,
    status: PermissionTerminal["status"],
    reason: string,
  ): PermissionTerminal {
    const {
      id,
      sessionId,
      runId,
      callId,
      messageId,
      contextScopeId,
      rootSessionId,
      ancestorSessionIds,
      sourceLabel,
    } = request.info;
    return Object.freeze({
      id,
      sessionId,
      runId,
      callId,
      messageId,
      contextScopeId,
      rootSessionId,
      ancestorSessionIds,
      sourceLabel,
      status,
      reason,
    });
  }

  function remember(terminal: PermissionTerminal): void {
    terminals.set(terminal.id, terminal);
    while (terminals.size > terminalLimit) {
      const oldest = terminals.keys().next();
      if (oldest.done) break;
      terminals.delete(oldest.value);
    }
  }

  function claim(request: PendingRequest): boolean {
    if (pending.get(request.info.id) !== request) return false;
    pending.delete(request.info.id);
    request.input.signal.removeEventListener("abort", request.onAbort);
    return true;
  }

  // Ordinary observers never control a decision that has already committed.
  function notify(action: () => void): void {
    try {
      action();
    } catch {
      /* The transport owns notification recovery. */
    }
  }

  function freeze(
    root: string | undefined,
    cause: Error,
  ): PermissionUnavailableError {
    const failure = new PermissionUnavailableError(root, { cause });
    if (root === undefined) runtimeFailure = failure;
    else failedRoots.set(root, failure);
    for (const request of [...pending.values()]) {
      if (root !== undefined && request.info.rootSessionId !== root) continue;
      if (!claim(request)) continue;
      remember(terminalFor(request, "revoked", "unavailable"));
      request.reject(failure);
    }
    notify(() => options.onUnavailable?.(root, failure));
    return failure;
  }

  function existingResult(
    id: string,
    sessionId?: string,
  ): PermissionRespondResult {
    const terminal = terminals.get(id);
    if (
      !terminal ||
      (sessionId !== undefined && terminal.sessionId !== sessionId)
    )
      return "not-pending";
    return terminal.status === "revoked" ? "revoked" : "already-resolved";
  }

  function validateResponse(
    request: PendingRequest,
    response: PermissionResponse | undefined,
  ): void {
    if (
      !response ||
      !["once", "always", "reject", "suggest"].includes(response.type)
    )
      throw new InvalidPermissionChoiceError();
    if (
      response.type === "suggest" &&
      (typeof response.suggestion !== "string" || !response.suggestion.trim())
    )
      throw new InvalidPermissionChoiceError();
    if (
      response.type === "always" &&
      (request.input.rememberable === false ||
        !isRememberablePermissionPattern(request.info.pattern) ||
        (response.pattern !== undefined &&
          response.pattern !== request.info.pattern))
    )
      throw new InvalidPermissionChoiceError();
  }

  function settle(
    request: PendingRequest,
    response: PermissionEventResponse,
    reason: string,
    revoked = false,
  ): PermissionRespondResult {
    if (!revoked && isRevoking(request.input)) return "revoked";
    if (!claim(request)) return existingResult(request.info.id);
    let rule: PermissionRule | undefined;
    let terminal = terminalFor(
      request,
      revoked ? "revoked" : "resolved",
      reason,
    );
    try {
      if (response.type === "always") {
        const parsed = parsePermissionPattern(request.info.pattern);
        rule = {
          tool: parsed.tool,
          pattern: parsed.pattern,
          decision: "allow",
          scope: "session",
        };
        state.addSessionRule(request.info.sessionId, rule, { silent: true });
      }
      options.criticalCommit?.({
        type: "resolved",
        identity: terminal,
        response,
      });
      remember(terminal);
    } catch (cause) {
      terminal = terminalFor(request, "revoked", "unavailable");
      remember(terminal);
      const failure = freeze(
        request.info.rootSessionId,
        cause instanceof Error ? cause : new Error(String(cause)),
      );
      request.reject(failure);
      throw failure;
    }
    if (response.type === "reject")
      request.reject(new PermissionRejectedError(request.info.id));
    else if (response.type === "suggest")
      request.reject(
        new PermissionRejectedWithSuggestionError(
          request.info.id,
          response.suggestion,
        ),
      );
    else
      request.resolve(
        response.type === "auto_approved" ? "always" : response.type,
      );

    notify(() =>
      options.onCommitted?.({ type: "resolved", identity: terminal, response }),
    );
    if (rule)
      notify(() => {
        bus.publish(PermissionEvent.RuleAdded, {
          sessionId: request.info.sessionId,
          rule,
        });
      });
    notify(() => {
      bus.publish(PermissionEvent.Replied, {
        permissionId: request.info.id,
        sessionId: request.info.sessionId,
        callId: request.info.callId,
        runId: request.info.runId,
        rootSessionId: request.info.rootSessionId,
        reason,
        response,
      });
    });
    if (rule)
      autoApproveMatching(request.info.sessionId, rule, request.info.pattern);
    return "accepted";
  }

  function revoke(id: string, reason: string): PermissionRespondResult {
    const request = pending.get(id);
    return request
      ? settle(request, { type: "cancel" }, reason, true)
      : existingResult(id);
  }

  function revokeMatching(
    matches: (input: PermissionAskInput) => boolean,
    reason: string,
  ): void {
    // Observers may synchronously answer or ask again while a batch settles.
    // Protect the entire scope before the first commit or notification.
    revocationScopes.add(matches);
    try {
      for (const request of [...pending.values()]) {
        if (!matches(request.input)) continue;
        // A failed commit already freezes and settles its whole root. Continue
        // cleanup for other roots without requiring the broken projection.
        try {
          revoke(request.info.id, reason);
        } catch {
          /* Waits are already ended. */
        }
      }
    } finally {
      revocationScopes.delete(matches);
    }
  }

  function autoApproveMatching(
    sessionId: string,
    rule: PermissionRule,
    pattern: string,
  ): void {
    for (const request of [...pending.values()]) {
      if (
        request.info.sessionId !== sessionId ||
        request.input.rememberable === false ||
        healthError(request.info.rootSessionId)
      )
        continue;
      if (request.input.signal.aborted) {
        revokeMatching((candidate) => candidate === request.input, "aborted");
        continue;
      }
      if (
        !matchesPermissionRule(request.input, rule) ||
        evaluatePermission(request.input, state.getState()).type !== "allow"
      )
        continue;
      try {
        settle(request, { type: "auto_approved", pattern }, "auto_approved");
      } catch {
        /* A failed root is now frozen. */
      }
    }
  }

  return {
    state,
    listPending: () => [...pending.values()].map((request) => request.info),
    getPending: (id) => pending.get(id)?.info,
    getTerminal: (id) => terminals.get(id),
    isHealthy: (root) => !healthError(root),
    freezeRoot: (root, error): void => {
      freeze(root, error);
    },
    freezeRuntime: (error): void => {
      freeze(undefined, error);
    },
    ask(input): Promise<SchedulerPermissionResponse> {
      if (!validContext(input)) {
        return Promise.reject(
          new Error(
            "PERMISSION_INVALID_CONTEXT: A real run, call, session, source and signal are required.",
          ),
        );
      }
      const failure = healthError(input.source.rootSessionId);
      if (failure) return Promise.reject(failure);
      if (isRevoking(input)) return Promise.resolve("cancel");
      if (isAborted(input.signal)) return Promise.resolve("cancel");
      const decision = evaluatePermission(input, state.getState());
      if (decision.type === "deny")
        return Promise.reject(new PermissionRejectedError(input.callId));
      const allowRule =
        input.rememberable !== false &&
        state
          .getSessionRules(input.sessionId)
          .some(
            (rule) =>
              rule.decision === "allow" && matchesPermissionRule(input, rule),
          );
      if (state.getLevel() === "full-access") return Promise.resolve("once");
      if (allowRule && decision.type === "allow")
        return Promise.resolve("always");
      const info = Object.freeze(createInfo(input, generateId(), now));
      if (pending.has(info.id) || terminals.has(info.id))
        return Promise.reject(
          freeze(
            info.rootSessionId,
            new Error("Conflicting permission identity."),
          ),
        );
      const frozenInput = Object.freeze({
        ...input,
        source: Object.freeze({
          rootSessionId: info.rootSessionId,
          ancestorSessionIds: info.ancestorSessionIds,
          sourceLabel: info.sourceLabel,
        }),
      });
      return new Promise((resolve, reject) => {
        const request: PendingRequest = {
          info,
          input: frozenInput,
          resolve,
          reject,
          onAbort: () => {
            revokeMatching(
              (candidate) => candidate === request.input,
              "aborted",
            );
          },
        };
        if (isAborted(input.signal)) {
          resolve("cancel");
          return;
        }
        pending.set(info.id, request);
        input.signal.addEventListener("abort", request.onAbort, { once: true });
        try {
          options.criticalCommit?.({ type: "requested", info });
        } catch (cause) {
          freeze(
            info.rootSessionId,
            cause instanceof Error ? cause : new Error(String(cause)),
          );
          return;
        }
        notify(() => options.onCommitted?.({ type: "requested", info }));
        if (isAborted(input.signal)) {
          request.onAbort();
          return;
        }
        if (pending.get(info.id) === request)
          notify(() => {
            bus.publish(PermissionEvent.Updated, { info });
          });
      });
    },
    respond(sessionId, id, response): PermissionRespondResult {
      const request = pending.get(id);
      if (request?.info.sessionId !== sessionId) {
        const terminal = terminals.get(id);
        if (terminal?.sessionId === sessionId) {
          const failure = healthError(terminal.rootSessionId);
          if (failure) throw failure;
        }
        return existingResult(id, sessionId);
      }
      const failure = healthError(request.info.rootSessionId);
      if (failure) throw failure;
      if (isRevoking(request.input)) return "revoked";
      validateResponse(request, response);
      if (request.input.signal.aborted) {
        revoke(id, "aborted");
        return "revoked";
      }
      if (
        (response.type === "once" || response.type === "always") &&
        evaluatePermission(request.input, state.getState()).type === "deny"
      ) {
        return settle(request, { type: "reject" }, "policy_denied");
      }
      return settle(
        request,
        response.type === "always"
          ? { type: "always", pattern: request.info.pattern }
          : response,
        response.type,
      );
    },
    revoke,
    revokeByRun: (runId, reason): void => {
      revokeMatching((input) => input.runId === runId, reason);
    },
    revokeBySession: (sessionId, reason): void => {
      revokeMatching(
        (input) =>
          input.sessionId === sessionId ||
          input.source.rootSessionId === sessionId ||
          input.source.ancestorSessionIds.includes(sessionId),
        reason,
      );
    },
    cancelPending: (sessionId): void => {
      revokeMatching((input) => input.sessionId === sessionId, "cancelled");
    },
    clearSession(sessionId): void {
      state.clearSession(sessionId);
      revokeMatching(
        (input) =>
          input.sessionId === sessionId ||
          input.source.rootSessionId === sessionId ||
          input.source.ancestorSessionIds.includes(sessionId),
        "session_deleted",
      );
    },
    dispose(): void {
      disposed = true;
      revokeMatching(() => true, "disposed");
    },
  };
}
