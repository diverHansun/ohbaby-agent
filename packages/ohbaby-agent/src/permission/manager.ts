import { Bus, type BusInstance } from "../bus/index.js";
import { PermissionEvent } from "./events.js";
import {
  generatePermissionPattern,
  inferPermissionType,
  matchPermissionPattern,
} from "./matcher.js";
import {
  PermissionRejectedError,
  PermissionRejectedWithSuggestionError,
} from "./types.js";
import type {
  PermissionAskInput,
  PermissionInfo,
  PermissionManager,
  PermissionResponse,
  SchedulerPermissionResponse,
} from "./types.js";

interface PendingRequest {
  readonly info: PermissionInfo;
  readonly resolve: (response: SchedulerPermissionResponse) => void;
  readonly reject: (error: Error) => void;
}

export interface PermissionManagerOptions {
  readonly bus?: BusInstance;
  readonly generateId?: () => string;
  readonly now?: () => number;
}

function defaultGenerateId(): string {
  return `permission_${String(Date.now())}_${Math.random().toString(36).slice(2, 8)}`;
}

function titleFor(input: PermissionAskInput): string {
  return input.reason ?? `Allow ${input.toolName}?`;
}

function createInfo(
  input: PermissionAskInput,
  id: string,
  now: () => number,
): PermissionInfo {
  const type = inferPermissionType(input.toolName, input.params);
  const name = type === "bash" && typeof input.params.command === "string"
    ? input.params.command.split(/\s+/)[0] ?? input.toolName
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
  const queue: PendingRequest[] = [];
  const approvals = new Map<string, Set<string>>();
  let current: PendingRequest | undefined;

  function approvedFor(sessionId: string): Set<string> {
    const existing = approvals.get(sessionId);
    if (existing) {
      return existing;
    }
    const created = new Set<string>();
    approvals.set(sessionId, created);
    return created;
  }

  function publishCurrent(): void {
    if (current) {
      bus.publish(PermissionEvent.Updated, { info: current.info });
    }
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
    if (current?.info.sessionId === sessionId && current.info.id === permissionId) {
      return current;
    }
    return queue.find(
      (request) =>
        request.info.sessionId === sessionId && request.info.id === permissionId,
    );
  }

  function autoApproveMatching(sessionId: string, pattern: string): void {
    for (let index = queue.length - 1; index >= 0; index -= 1) {
      const request = queue[index];
      if (request.info.sessionId !== sessionId) {
        continue;
      }
      if (!matchPermissionPattern(request.info.pattern, new Set([pattern]))) {
        continue;
      }
      queue.splice(index, 1);
      bus.publish(PermissionEvent.Replied, {
        sessionId,
        permissionId: request.info.id,
        response: { type: "auto_approved", pattern },
      });
      request.resolve("always");
    }
  }

  return {
    ask(input: PermissionAskInput): Promise<SchedulerPermissionResponse> {
      const info = createInfo(input, generateId(), now);
      if (matchPermissionPattern(info.pattern, approvedFor(info.sessionId))) {
        return Promise.resolve("always");
      }

      return new Promise((resolve, reject) => {
        const request = { info, reject, resolve } satisfies PendingRequest;
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

      bus.publish(PermissionEvent.Replied, {
        sessionId,
        permissionId,
        response,
      });

      if (response.type === "once") {
        request.resolve("once");
        completeCurrent();
        return;
      }

      if (response.type === "always") {
        approvedFor(sessionId).add(request.info.pattern);
        request.resolve("always");
        autoApproveMatching(sessionId, request.info.pattern);
        bus.publish(PermissionEvent.SwitchModeRequested, {
          sessionId,
          targetMode: "edit-automatically",
          trigger: {
            permissionId,
            pattern: request.info.pattern,
          },
        });
        completeCurrent();
        return;
      }

      if (response.type === "cancel") {
        request.resolve("cancel");
        completeCurrent();
        return;
      }

      if (response.type === "suggest") {
        request.reject(
          new PermissionRejectedWithSuggestionError(
            permissionId,
            response.suggestion,
          ),
        );
        completeCurrent();
        return;
      }

      request.reject(new PermissionRejectedError(permissionId));
      completeCurrent();
    },

    clearSession(sessionId: string): void {
      approvals.delete(sessionId);
      if (current?.info.sessionId === sessionId) {
        current.resolve("cancel");
        current = undefined;
      }
      for (let index = queue.length - 1; index >= 0; index -= 1) {
        const request = queue[index];
        if (request.info.sessionId === sessionId) {
          queue.splice(index, 1);
          request.resolve("cancel");
        }
      }
      advanceQueue();
    },
  };
}
