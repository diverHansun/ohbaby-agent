import { Bus, type BusInstance } from "../bus/index.js";
import { PermissionEvent } from "./events.js";
import {
  generatePermissionPattern,
  inferPermissionType,
  isRememberablePermissionPattern,
  matchesPermissionRule,
} from "./matcher.js";
import { evaluatePermission } from "./evaluator.js";
import { formatPermissionPattern, parsePermissionPattern } from "./rule.js";
import { createPermissionState } from "./state.js";
import {
  PermissionRejectedError,
  PermissionRejectedWithSuggestionError,
} from "./types.js";
import type {
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
}

export interface PermissionManagerOptions {
  readonly bus?: BusInstance;
  readonly generateId?: () => string;
  readonly now?: () => number;
  readonly state?: PermissionStateStore;
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
    sessionId: input.sessionId,
    messageId: input.messageId,
    callId: input.callId,
    type,
    name,
    title: titleFor(input),
    metadata: {
      category: input.category,
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

export function createPermissionManager(
  options: PermissionManagerOptions = {},
): PermissionManager {
  const bus = options.bus ?? Bus;
  const generateId = options.generateId ?? defaultGenerateId;
  const now = options.now ?? Date.now;
  const state = options.state ?? createPermissionState({ bus });
  const queue: PendingRequest[] = [];
  let current: PendingRequest | undefined;

  function publishCurrent(): void {
    if (current) {
      bus.publish(PermissionEvent.Updated, { info: current.info });
    }
  }

  function publishReply(
    request: PendingRequest,
    response: PermissionEventResponse,
  ): void {
    bus.publish(PermissionEvent.Replied, {
      callId: request.info.callId,
      sessionId: request.info.sessionId,
      permissionId: request.info.id,
      response,
    });
  }

  function advanceQueue(): void {
    if (current) {
      return;
    }
    current = queue.shift();
    publishCurrent();
  }

  function completeCurrent(): void {
    current = undefined;
    advanceQueue();
  }

  function findPending(
    sessionId: string,
    permissionId: string,
  ): PendingRequest | undefined {
    if (
      current?.info.sessionId === sessionId &&
      current.info.id === permissionId
    ) {
      return current;
    }
    return queue.find(
      (request) =>
        request.info.sessionId === sessionId &&
        request.info.id === permissionId,
    );
  }

  function toRule(input: PermissionInfo): PermissionRule {
    const parsed = parsePermissionPattern(input.pattern);
    return {
      decision: "allow",
      pattern: parsed.pattern,
      scope: "session",
      tool: parsed.tool,
    };
  }

  function matchingAllowRule(
    input: PermissionAskInput,
  ): PermissionRule | undefined {
    if (input.rememberable === false) {
      return undefined;
    }
    return state.getSessionRules(input.sessionId).find(
      (rule) =>
        rule.decision === "allow" &&
        matchesPermissionRule(
          {
            callId: input.callId,
            category: input.category,
            messageId: input.messageId,
            params: input.params,
            sessionId: input.sessionId,
            toolName: input.toolName,
          },
          rule,
        ),
    );
  }

  function autoApproveMatching(
    sessionId: string,
    rule: PermissionRule,
    pattern: string,
  ): void {
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      const request = queue[index];
      if (request.info.sessionId !== sessionId) {
        continue;
      }
      if (request.input.rememberable === false) {
        continue;
      }
      if (
        !matchesPermissionRule(
          {
            callId: request.input.callId,
            category: request.input.category,
            messageId: request.input.messageId,
            params: request.input.params,
            sessionId: request.input.sessionId,
            toolName: request.input.toolName,
          },
          rule,
        )
      ) {
        continue;
      }
      const decision = evaluatePermission(
        {
          callId: request.input.callId,
          category: request.input.category,
          messageId: request.input.messageId,
          params: request.input.params,
          sessionId: request.input.sessionId,
          toolName: request.input.toolName,
        },
        state.getState(),
      );
      if (decision.type !== "allow") {
        continue;
      }
      queue.splice(index, 1);
      publishReply(request, { type: "auto_approved", pattern });
      request.resolve("always");
    }
  }

  function cancelPending(sessionId: string): void {
    if (current?.info.sessionId === sessionId) {
      publishReply(current, { type: "cancel" });
      current.resolve("cancel");
      current = undefined;
    }
    const remainingQueue: PendingRequest[] = [];
    for (const request of queue) {
      if (request.info.sessionId !== sessionId) {
        remainingQueue.push(request);
      } else {
        publishReply(request, { type: "cancel" });
        request.resolve("cancel");
      }
    }
    queue.length = 0;
    queue.push(...remainingQueue);
    advanceQueue();
  }

  return {
    state,

    ask(input: PermissionAskInput): Promise<SchedulerPermissionResponse> {
      const info = createInfo(input, generateId(), now);
      const approvedRule = matchingAllowRule(input);
      if (approvedRule) {
        const approvedPattern = formatPermissionPattern(approvedRule);
        publishReply(
          {
            info,
            input,
            reject: () => undefined,
            resolve: () => undefined,
          },
          { type: "auto_approved", pattern: approvedPattern },
        );
        return Promise.resolve("always");
      }

      return new Promise((resolve, reject) => {
        const request = {
          info,
          input,
          reject,
          resolve,
        } satisfies PendingRequest;
        if (!current) {
          current = request;
          publishCurrent();
          return;
        }
        queue.push(request);
      });
    },

    respond(
      sessionId: string,
      permissionId: string,
      response: PermissionResponse,
    ): void {
      const request = findPending(sessionId, permissionId);
      if (!request || request !== current) {
        return;
      }

      if (response.type === "once") {
        publishReply(request, response);
        request.resolve("once");
        completeCurrent();
        return;
      }

      if (response.type === "always") {
        if (
          request.input.rememberable === false ||
          !isRememberablePermissionPattern(request.info.pattern)
        ) {
          publishReply(request, { type: "once" });
          request.resolve("once");
          completeCurrent();
          return;
        }
        const rule = toRule(request.info);
        state.addSessionRule(sessionId, rule);
        publishReply(request, {
          type: "always",
          pattern: request.info.pattern,
        });
        request.resolve("always");
        autoApproveMatching(sessionId, rule, request.info.pattern);
        completeCurrent();
        return;
      }

      if (response.type === "cancel") {
        publishReply(request, response);
        request.resolve("cancel");
        completeCurrent();
        return;
      }

      if (response.type === "suggest") {
        publishReply(request, response);
        request.reject(
          new PermissionRejectedWithSuggestionError(
            permissionId,
            response.suggestion,
          ),
        );
        completeCurrent();
        return;
      }

      publishReply(request, response);
      request.reject(new PermissionRejectedError(permissionId));
      completeCurrent();
    },

    cancelPending(sessionId: string): void {
      cancelPending(sessionId);
    },

    clearSession(sessionId: string): void {
      state.clearSession(sessionId);
      cancelPending(sessionId);
    },
  };
}
