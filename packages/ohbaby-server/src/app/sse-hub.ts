import {
  interactionCleanupFailure,
  NOOP_LOGGER,
  type Logger,
} from "ohbaby-agent";
import { type UiBackendClient, type UiEvent } from "ohbaby-sdk";
import { type EventEnvelope } from "../coordination/event-bus.js";
import { sessionRecoveryCapability } from "../coordination/session-access.js";
import { emitDiagnosticSafely } from "../observability/emit.js";
import { type DaemonSseEvent } from "../protocols/jsonrpc/protocol.js";

import { isRecord } from "../protocols/web/request-helpers.js";

import type { DaemonRouteContext } from "../protocols/web/routes/context.js";

const encoder = new TextEncoder();
const DEFAULT_CLIENT_DISCONNECT_RETENTION_MS = 5_000;

interface SseClient {
  readonly clientId: string;
  close(): void;
  write(event: DaemonSseEvent, id?: number): void;
}

function reportInteractionCleanupFailure(logger: Logger, error: unknown): void {
  emitDiagnosticSafely(logger, interactionCleanupFailure, {
    error,
    operation: "disconnect",
  });
}

function writeSseFrame(event: DaemonSseEvent, id?: number): Uint8Array {
  const idLine = id === undefined ? "" : `id: ${String(id)}\n`;
  return encoder.encode(
    `${idLine}event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
  );
}

function normalizeClientDisconnectRetentionMs(
  value: number | undefined,
): number {
  if (value === undefined) {
    return DEFAULT_CLIENT_DISCONNECT_RETENTION_MS;
  }
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(
      "clientDisconnectRetentionMs must be a non-negative finite number",
    );
  }
  return value;
}

type LastEventIdParseResult =
  | {
      readonly kind: "absent";
    }
  | {
      readonly kind: "invalid";
    }
  | {
      readonly kind: "ok";
      readonly seqNum: number;
    };

function parseLastEventId(value: string | undefined): LastEventIdParseResult {
  if (value === undefined || value.trim().length === 0) {
    return { kind: "absent" };
  }
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    return { kind: "invalid" };
  }
  return { kind: "ok", seqNum: parsed };
}

interface DaemonSseHubOptions {
  readonly backend: UiBackendClient;
  readonly logger?: Logger;
  readonly onClientConnected?: (clientId: string) => void;
  readonly onClientDisconnected?: (clientId: string) => void;
}

export class DaemonSseHub {
  private readonly clients = new Set<SseClient>();
  private readonly disconnectCleanupTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private readonly expiredClientIds = new Set<string>();
  private readonly replayEventsBySeqNum = new Map<
    number,
    Map<string, UiEvent>
  >();
  private readonly clientDisconnectRetentionMs: number;

  constructor(
    private readonly context: Pick<
      DaemonRouteContext,
      | "clientViews"
      | "eventBus"
      | "knownClientIds"
      | "permissionRouter"
      | "permissionEpoch"
      | "registeredWebClientIds"
    >,
    private readonly options: DaemonSseHubOptions,
    clientDisconnectRetentionMs: number | undefined,
  ) {
    this.clientDisconnectRetentionMs = normalizeClientDisconnectRetentionMs(
      clientDisconnectRetentionMs,
    );
  }

  // Shutdown closes streams directly; it must not schedule disconnect cleanup.
  dispose(): void {
    for (const client of Array.from(this.clients)) {
      client.close();
    }
    this.clients.clear();
    for (const timer of this.disconnectCleanupTimers.values()) {
      clearTimeout(timer);
    }
    this.disconnectCleanupTimers.clear();
    this.expiredClientIds.clear();
    this.context.knownClientIds.clear();
    this.context.registeredWebClientIds.clear();
    this.context.clientViews.resetRuntimeState();
    this.replayEventsBySeqNum.clear();
  }

  disconnectClients(): void {
    for (const client of [...this.clients]) this.disconnectClient(client);
  }

  createSseResponse(
    clientId: string,
    signal: AbortSignal,
    lastEventId: string | undefined,
  ): Response {
    let client: SseClient | undefined;
    const stream = new ReadableStream<Uint8Array>({
      cancel: (_reason: unknown): void => {
        if (client) {
          this.disconnectClient(client);
        }
      },
      start: (controller): void => {
        let closed = false;
        client = {
          clientId,
          close: (): void => {
            if (closed) {
              return;
            }
            closed = true;
            try {
              controller.close();
            } catch {
              // The reader may already have cancelled the stream.
            }
          },
          write: (event, id): void => {
            if (closed) {
              return;
            }
            controller.enqueue(writeSseFrame(event, id));
          },
        };
        this.clients.add(client);
        this.context.clientViews.setClientSessionOccupancy(clientId, true);
        this.cancelClientRoutingCleanup(clientId);
        this.context.knownClientIds.add(clientId);
        this.options.onClientConnected?.(clientId);
        client.write({
          clientId,
          type: "hello",
          ...this.context.clientViews.binding(
            clientId,
            this.context.permissionEpoch,
          ),
          ...sessionRecoveryCapability(
            this.options.backend,
            this.context.permissionEpoch,
          ),
        });
        this.replayMissedEvents(client, lastEventId);
        signal.addEventListener(
          "abort",
          (): void => {
            if (client) {
              this.disconnectClient(client);
            }
          },
          { once: true },
        );
      },
    });

    return new Response(stream, {
      headers: {
        "cache-control": "no-cache",
        connection: "keep-alive",
        "content-type": "text/event-stream; charset=utf-8",
        "x-accel-buffering": "no",
      },
      status: 200,
    });
  }

  private disconnectClient(client: SseClient): void {
    if (!this.clients.delete(client)) {
      return;
    }
    client.close();
    if (!this.hasConnectedClient(client.clientId)) {
      this.context.clientViews.setClientSessionOccupancy(
        client.clientId,
        false,
      );
      this.scheduleClientRoutingCleanup(client.clientId);
    }
    this.options.onClientDisconnected?.(client.clientId);
  }

  private hasConnectedClient(clientId: string): boolean {
    for (const client of this.clients) {
      if (client.clientId === clientId) {
        return true;
      }
    }
    return false;
  }

  private cancelClientRoutingCleanup(clientId: string): void {
    const timer = this.disconnectCleanupTimers.get(clientId);
    if (timer === undefined) {
      return;
    }
    clearTimeout(timer);
    this.disconnectCleanupTimers.delete(clientId);
  }

  touchClientActivity(clientId: string): void {
    this.context.knownClientIds.add(clientId);
    this.context.clientViews.setClientSessionOccupancy(clientId, true);
    if (!this.hasConnectedClient(clientId))
      this.scheduleClientRoutingCleanup(clientId);
  }

  private scheduleClientRoutingCleanup(clientId: string): void {
    this.cancelClientRoutingCleanup(clientId);
    const timer = setTimeout(() => {
      if (this.disconnectCleanupTimers.get(clientId) !== timer) return;
      this.disconnectCleanupTimers.delete(clientId);
      if (this.hasConnectedClient(clientId)) return;
      this.context.clientViews.setClientSessionOccupancy(clientId, false);
      if (this.context.clientViews.hasPendingSessionOperation(clientId)) {
        this.scheduleClientRoutingCleanup(clientId);
        return;
      }
      const interactionIds =
        this.context.clientViews.disconnectClient(clientId);
      this.context.knownClientIds.delete(clientId);
      this.expiredClientIds.add(clientId);
      this.cancelRemovedClientInteractions(interactionIds);
    }, this.clientDisconnectRetentionMs);
    this.disconnectCleanupTimers.set(clientId, timer);
  }

  private cancelRemovedClientInteractions(
    interactionIds: readonly string[],
  ): void {
    for (const interactionId of interactionIds) {
      void this.options.backend
        .respondInteraction(interactionId, {
          kind: "cancelled",
          reason: "client-disconnected",
        })
        .catch((error: unknown) => {
          if (!isRecord(error) || error.code !== "INTERACTION_NOT_FOUND") {
            reportInteractionCleanupFailure(
              this.options.logger ?? NOOP_LOGGER,
              error,
            );
          }
        });
    }
  }

  private replayMissedEvents(
    client: SseClient,
    lastEventId: string | undefined,
  ): void {
    const parsed = parseLastEventId(lastEventId);
    if (parsed.kind === "absent") {
      this.expiredClientIds.delete(client.clientId);
      return;
    }
    if (this.expiredClientIds.has(client.clientId)) {
      this.writeResyncRequired(client);
      this.expiredClientIds.delete(client.clientId);
      return;
    }
    if (parsed.kind === "invalid") {
      this.writeResyncRequired(client);
      return;
    }

    const replay = this.context.eventBus.replayAfter(parsed.seqNum);
    if (replay.kind === "resync-required") {
      this.writeResyncRequired(client);
      return;
    }

    for (const envelope of replay.envelopes) {
      this.writeReplayEnvelopeToClient(envelope, client);
    }
  }

  private writeResyncRequired(client: SseClient): void {
    client.write({
      maxSeqNum: this.context.eventBus.latestSeqNum,
      minSeqNum: this.context.eventBus.minSeqNum ?? 0,
      type: "resync-required",
    });
  }

  notifyBinding(clientId: string): void {
    for (const client of [...this.clients]) {
      if (client.clientId !== clientId) continue;
      try {
        client.write({
          type: "hello",
          clientId,
          ...this.context.clientViews.binding(
            clientId,
            this.context.permissionEpoch,
          ),
          ...sessionRecoveryCapability(
            this.options.backend,
            this.context.permissionEpoch,
          ),
        });
      } catch {
        this.disconnectClient(client);
      }
    }
  }

  broadcastPermission(event: UiEvent): void {
    for (const client of [...this.clients]) {
      try {
        const binding = this.context.clientViews.binding(
          client.clientId,
          this.context.permissionEpoch,
        );
        const routed = this.context.permissionRouter.filterEventForClient(
          event,
          binding.rootSessionId,
        );
        if (routed)
          client.write({
            type: "ui.event",
            event: {
              ...routed,
              bindingGeneration: binding.bindingGeneration,
            } as UiEvent,
          });
      } catch {
        this.disconnectClient(client);
      }
    }
  }

  private async reconcileSessionBindings(): Promise<void> {
    const previous = [...this.context.knownClientIds]
      .filter((id) => this.context.clientViews.isRegistered(id))
      .map((id) => ({
        id,
        binding: this.context.clientViews.binding(
          id,
          this.context.permissionEpoch,
        ),
      }));
    const index = await this.options.backend.getSessionIndex();
    const roots = new Set(
      index
        .filter((session) => !session.parentId && !session.isSubagent)
        .map((session) => session.id),
    );
    for (const { id, binding } of previous) {
      if (!binding.rootSessionId || roots.has(binding.rootSessionId)) continue;
      try {
        this.context.clientViews.assertBinding(
          id,
          binding,
          this.context.permissionEpoch,
        );
        this.context.clientViews.selectSession(
          id,
          null,
          binding.bindingGeneration,
        );
        this.notifyBinding(id);
      } catch {
        /* A newer client selection owns the binding. */
      }
    }
  }

  broadcast(envelope: EventEnvelope): void {
    const event = envelope.event;
    const previousBindings =
      event.type === "command.result.delivered" &&
      event.action?.kind === "session.selected"
        ? new Map(
            [...this.context.knownClientIds]
              .filter((id) => this.context.clientViews.isRegistered(id))
              .map((id) => [
                id,
                this.context.clientViews.binding(
                  id,
                  this.context.permissionEpoch,
                ).bindingGeneration,
              ]),
          )
        : undefined;
    this.context.clientViews.observeEvent(event);
    const replayEvents = this.routeEnvelopeForKnownClients(envelope);
    this.replayEventsBySeqNum.set(envelope.seqNum, replayEvents);
    for (const client of Array.from(this.clients)) {
      const routed = replayEvents.get(client.clientId);
      if (routed) {
        try {
          client.write({ event: routed, type: "ui.event" }, envelope.seqNum);
        } catch {
          this.disconnectClient(client);
        }
      }
    }
    this.context.clientViews.afterEventBroadcast(event);
    if (event.type === "session.index.invalidated")
      void this.reconcileSessionBindings().catch(() => undefined);
    if (
      event.type === "command.result.delivered" &&
      event.action?.kind === "session.selected"
    ) {
      for (const [clientId, generation] of previousBindings ?? []) {
        if (
          this.context.clientViews.binding(
            clientId,
            this.context.permissionEpoch,
          ).bindingGeneration !== generation
        )
          this.notifyBinding(clientId);
      }
    }
    this.pruneReplayEvents();
  }

  private routeEnvelopeForKnownClients(
    envelope: EventEnvelope,
  ): Map<string, UiEvent> {
    const replayEvents = new Map<string, UiEvent>();
    for (const clientId of this.context.knownClientIds) {
      const routed = this.routeEnvelopeForClient(envelope, clientId);
      if (routed) {
        replayEvents.set(clientId, routed);
      }
    }
    return replayEvents;
  }

  private routeEnvelopeForClient(
    envelope: EventEnvelope,
    clientId: string,
  ): UiEvent | undefined {
    const routed = this.context.clientViews.routeEventForClient(
      envelope.event,
      clientId,
    );
    if (!routed) {
      return undefined;
    }
    const filtered = this.context.permissionRouter.filterEventForClient(
      routed,
      this.context.clientViews.binding(clientId, this.context.permissionEpoch)
        .rootSessionId,
    );
    if (!filtered || filtered.type === "snapshot.replaced") return undefined;
    if (
      filtered.type === "subagent.conversation.changed" ||
      filtered.type === "subagent.conversation.unavailable"
    ) {
      const bindingGeneration = this.context.clientViews.binding(
        clientId,
        this.context.permissionEpoch,
      ).bindingGeneration;
      return filtered.type === "subagent.conversation.changed"
        ? {
            ...filtered,
            change: { ...filtered.change, bindingGeneration },
          }
        : {
            ...filtered,
            unavailable: { ...filtered.unavailable, bindingGeneration },
          };
    }
    if (
      filtered.type === "session.changed" ||
      filtered.type === "session.unavailable"
    ) {
      return {
        ...filtered,
        bindingGeneration: this.context.clientViews.binding(
          clientId,
          this.context.permissionEpoch,
        ).bindingGeneration,
      };
    }
    return this.projectSelectionForBinding(filtered, clientId, false);
  }

  private projectSelectionForBinding(
    event: UiEvent,
    clientId: string,
    replay: boolean,
  ): UiEvent {
    const selected = this.context.clientViews.binding(
      clientId,
      this.context.permissionEpoch,
    ).rootSessionId;
    if (event.type === "session.index.invalidated")
      return { ...event, selectedSessionId: selected };
    if (
      event.type === "command.result.delivered" &&
      event.action?.kind === "session.selected" &&
      (replay ||
        !isRecord(event.action.data) ||
        event.action.data.choiceId !== selected)
    ) {
      // hello owns reconnect selection; historical command results remain visible
      // but their one-shot selection action must never execute again.
      const { action: _action, ...result } = event;
      return result;
    }
    return event;
  }

  private writeReplayEnvelopeToClient(
    envelope: EventEnvelope,
    client: SseClient,
  ): void {
    const routed = this.replayEventsBySeqNum
      .get(envelope.seqNum)
      ?.get(client.clientId);
    if (
      (routed?.type === "subagent.conversation.changed" ||
        routed?.type === "subagent.conversation.unavailable") &&
      routed.watchId !==
        this.context.clientViews.currentSubagentWatchId(client.clientId)
    )
      return;
    if (routed) {
      client.write(
        {
          event: this.projectSelectionForBinding(routed, client.clientId, true),
          type: "ui.event",
        },
        envelope.seqNum,
      );
    }
  }

  private pruneReplayEvents(): void {
    const minSeqNum = this.context.eventBus.minSeqNum;
    if (minSeqNum === undefined) {
      this.replayEventsBySeqNum.clear();
      return;
    }
    for (const seqNum of this.replayEventsBySeqNum.keys()) {
      if (seqNum < minSeqNum) {
        this.replayEventsBySeqNum.delete(seqNum);
      }
    }
  }
}
