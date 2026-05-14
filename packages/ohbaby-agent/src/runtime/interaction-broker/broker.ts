import type { UiInteractionRequest, UiInteractionResponse } from "ohbaby-sdk";
import { InteractionEvent } from "./events.js";
import { PendingInteractionRegistry } from "./pending-registry.js";
import {
  InteractionBrokerError,
  type InteractionBroker,
  type InteractionBrokerOptions,
  type InteractionRequestContext,
  type InteractionRequestInput,
  type PendingInteraction,
} from "./types.js";

function createDefaultInteractionId(): () => string {
  let next = 1;
  return () => {
    const id = `interaction_${String(next)}`;
    next += 1;
    return id;
  };
}

function validateResponse(
  request: UiInteractionRequest,
  response: UiInteractionResponse,
): void {
  if (response.kind === "cancelled") {
    return;
  }

  if (request.kind === "select-one" && !response.choiceId) {
    throw new InteractionBrokerError(
      "INVALID_INTERACTION_RESPONSE",
      "select-one interactions require choiceId",
    );
  }
  if (request.kind === "select-many" && !response.choiceIds) {
    throw new InteractionBrokerError(
      "INVALID_INTERACTION_RESPONSE",
      "select-many interactions require choiceIds",
    );
  }
  if (request.kind === "confirm" && typeof response.value !== "boolean") {
    throw new InteractionBrokerError(
      "INVALID_INTERACTION_RESPONSE",
      "confirm interactions require boolean value",
    );
  }
  if (request.kind === "text-input" && typeof response.value !== "string") {
    throw new InteractionBrokerError(
      "INVALID_INTERACTION_RESPONSE",
      "text-input interactions require string value",
    );
  }
}

export function createInteractionBroker(
  options: InteractionBrokerOptions,
): InteractionBroker {
  const registry = new PendingInteractionRegistry();
  const createInteractionId =
    options.createInteractionId ?? createDefaultInteractionId();
  const now = options.now ?? Date.now;

  function publishResolved(
    entry: PendingInteraction,
    response: UiInteractionResponse,
  ): void {
    options.bus.publish(InteractionEvent.Resolved, {
      interactionId: entry.interactionId,
      commandRunId: entry.commandRunId,
      clientInvocationId: entry.clientInvocationId,
      response,
      timestamp: now(),
    });
  }

  return {
    request(
      request: InteractionRequestInput,
      context: InteractionRequestContext,
    ): Promise<UiInteractionResponse> {
      const createdAt = now();
      const interactionId = createInteractionId();
      const fullRequest: UiInteractionRequest = {
        ...request,
        interactionId,
        commandRunId: context.commandRunId,
        clientInvocationId: context.clientInvocationId,
        sessionId: context.sessionId,
      };

      const promise = new Promise<UiInteractionResponse>((resolve) => {
        registry.add({
          interactionId,
          commandRunId: context.commandRunId,
          clientInvocationId: context.clientInvocationId,
          sessionId: context.sessionId,
          createdAt,
          request: fullRequest,
          resolve,
        });
      });

      options.bus.publish(InteractionEvent.Requested, {
        request: fullRequest,
        timestamp: createdAt,
      });

      return promise;
    },

    respond(
      interactionId: string,
      response: UiInteractionResponse,
    ): Promise<void> {
      const entry = registry.take(interactionId);
      if (!entry) {
        return Promise.reject(
          new InteractionBrokerError(
            "INTERACTION_NOT_FOUND",
            `Interaction not found: ${interactionId}`,
          ),
        );
      }

      try {
        validateResponse(entry.request, response);
      } catch (error) {
        registry.add(entry);
        return Promise.reject(
          error instanceof Error ? error : new Error(String(error)),
        );
      }

      entry.resolve(response);
      publishResolved(entry, response);
      return Promise.resolve();
    },

    abortByCommandRun(commandRunId: string, reason: string): number {
      const entries = registry.takeByCommandRun(commandRunId);
      for (const entry of entries) {
        const response: UiInteractionResponse = {
          kind: "cancelled",
          reason,
        };
        entry.resolve(response);
        publishResolved(entry, response);
      }
      return entries.length;
    },

    abortAll(reason: string): number {
      const entries = registry.takeAll();
      for (const entry of entries) {
        const response: UiInteractionResponse = {
          kind: "cancelled",
          reason,
        };
        entry.resolve(response);
        publishResolved(entry, response);
      }
      return entries.length;
    },

    listPending(): ReturnType<InteractionBroker["listPending"]> {
      return registry.list();
    },
  };
}
