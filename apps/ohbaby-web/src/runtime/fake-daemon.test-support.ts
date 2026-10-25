import type { UiGlobalSession, UiSnapshot } from "ohbaby-sdk";
import {
  recoveryBinding,
  sessionViewFromSnapshot,
} from "../api/daemon/session-recovery.test-utils.js";

export const DEFAULT = "/default";

type SettingsHandler = (
  method: string,
  path: string,
  directory: string | undefined,
  body: unknown,
) => Response | undefined | Promise<Response | undefined>;
const encoder = new TextEncoder();

export interface WorldSession {
  id: string;
  title: string;
  updatedAt: string;
  workspaceDirectory: string | null;
  workingDirectory: string;
  pendingWorkingDirectory?: string;
  archived?: boolean;
}

interface LoggedRequest {
  readonly method: string;
  readonly path: string;
  readonly directory: string | undefined;
  readonly clientId: string | undefined;
  readonly body: unknown;
}

/**
 * A daemon with global routes and one instance per directory. A session is
 * owned by its request directory; prompts and selections elsewhere are
 * refused the way the server refuses them.
 */
export function fakeDaemon(initial: readonly WorldSession[] = []): {
  readonly fetch: typeof fetch;
  readonly sessions: Map<string, WorldSession>;
  readonly requests: LoggedRequest[];
  readonly abortedStreams: string[];
  /** Overrides the directory a prompt for this session must move to. */
  movedTo: ((sessionId: string, directory: string) => string | null) | null;
  /** Paths answered with HTTP 500. */
  readonly failing: Set<string>;
  /** Directories whose instance cannot start (deleted or unreadable). */
  readonly unavailable: Set<string>;
  /** Sessions with a run in progress. */
  readonly running: Set<string>;
  /** When set, the next list response is computed, then held until it resolves. */
  holdNextList: Promise<void> | null;
  /** Pushes a `ui.event` to every open event stream of `directory`. */
  emit(directory: string, event: unknown, seqNum?: number): void;
  /** Answers `/v1/settings/*` routes; an undefined answer falls through. */
  settings: SettingsHandler | null;
} {
  const sessions = new Map(initial.map((session) => [session.id, session]));
  const requests: LoggedRequest[] = [];
  const abortedStreams: string[] = [];
  const clients = new Map<
    string,
    { directory: string; selected: string | null; generation: number }
  >();
  let created = 0;
  const streams = new Map<
    ReadableStreamDefaultController<Uint8Array>,
    string
  >();
  const hidden = new Set<string>();
  const owner = (session: WorldSession): string =>
    session.pendingWorkingDirectory ?? session.workingDirectory;
  const global = (session: WorldSession): UiGlobalSession => ({
    id: session.id,
    title: session.title,
    status: session.archived ? "archived" : "active",
    createdAt: session.updatedAt,
    updatedAt: session.updatedAt,
    messageCount: 1,
    workspaceDirectory: session.workspaceDirectory,
    workingDirectory: session.workingDirectory,
    ...(session.pendingWorkingDirectory === undefined
      ? {}
      : { pendingWorkingDirectory: session.pendingWorkingDirectory }),
  });
  const snapshot = (sessionId: string | null): UiSnapshot => ({
    activeSessionId: sessionId,
    sessions: sessionId
      ? [
          {
            id: sessionId,
            title: sessions.get(sessionId)?.title ?? sessionId,
            createdAt: "2026-10-01",
            updatedAt: "2026-10-01",
            messages: [],
          },
        ]
      : [],
    permission: { level: "default", mode: "auto", sessionRules: [] },
    permissions: [],
    runs: [],
    status: { kind: "idle" },
  });
  const daemon: ReturnType<typeof fakeDaemon> = {
    sessions,
    requests,
    abortedStreams,
    movedTo: null as
      | ((sessionId: string, directory: string) => string | null)
      | null,
    failing: new Set<string>(),
    unavailable: new Set<string>(),
    running: new Set<string>(),
    holdNextList: null as Promise<void> | null,
    settings: null,
    emit(directory: string, event: unknown, seqNum?: number): void {
      for (const [controller, streamDirectory] of streams)
        if (streamDirectory === directory)
          controller.enqueue(
            encoder.encode(
              `${seqNum === undefined ? "" : `id: ${String(seqNum)}\n`}data: ${JSON.stringify({ type: "ui.event", event })}\n\n`,
            ),
          );
    },
    fetch: async (input, init = {}) => {
      // Answer asynchronously, like the network.
      await Promise.resolve();
      const request = new Request(input, init);
      const url = new URL(request.url);
      const path = url.pathname;
      const rawDirectory = request.headers.get("x-ohbaby-directory");
      const directory =
        rawDirectory === null ? undefined : decodeURIComponent(rawDirectory);
      const clientId = request.headers.get("x-ohbaby-client-id") ?? undefined;
      const body: unknown =
        typeof init.body === "string" ? JSON.parse(init.body) : undefined;
      requests.push({
        method: request.method,
        path,
        directory,
        clientId,
        body,
      });
      if (path.startsWith("/v1/settings/") && daemon.settings) {
        const answer = await daemon.settings(
          request.method,
          path,
          directory,
          body,
        );
        if (answer) return answer;
      }
      if (daemon.failing.has(path))
        return Response.json(
          { ok: false, error: { message: "unavailable" } },
          { status: 500 },
        );
      const client = clientId ? clients.get(clientId) : undefined;
      const binding = (): ReturnType<typeof recoveryBinding> =>
        recoveryBinding(client?.selected ?? null, client?.generation ?? 1);

      if (path === "/v1/scopes")
        return Response.json({
          ok: true,
          defaultDirectory: { directory: DEFAULT },
          scopes: ["/a", "/b"]
            .filter((value) => !hidden.has(value))
            .map((value, position) => ({
              available: true,
              directory: value,
              lastOpenedAt: 0,
              loaded: false,
              position,
            })),
        });
      if (path === "/v1/sessions" && request.method === "GET") {
        // Archived chats are listed from hidden workspaces too (D9).
        const archived = url.searchParams.get("status") === "archived";
        const active = [...sessions.values()]
          .filter((session) =>
            archived
              ? session.archived === true
              : !session.archived &&
                !hidden.has(session.workspaceDirectory ?? ""),
          )
          .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
        const offset = Number(url.searchParams.get("cursor") ?? "0");
        const limit = Number(url.searchParams.get("limit") ?? "100");
        const page = active.slice(offset, offset + limit);
        const hold = daemon.holdNextList;
        if (hold) {
          daemon.holdNextList = null;
          await hold;
        }
        return Response.json({
          ok: true,
          sessions: page.map(global),
          ...(offset + limit < active.length
            ? { nextCursor: String(offset + limit) }
            : {}),
        });
      }
      if (path === "/v1/scopes/hide") {
        hidden.add((body as { directory: string }).directory);
        return Response.json({ ok: true });
      }
      if (path === "/v1/sessions/search") {
        const query = url.searchParams.get("q") ?? "";
        return Response.json({
          ok: true,
          results: [...sessions.values()]
            .filter((value) => value.title.includes(query))
            .map((value) => ({
              session: global(value),
              matchType: "title",
              snippet: value.title,
            })),
        });
      }
      const move = /^\/v1\/sessions\/([^/]+)\/workspace$/.exec(path);
      if (move?.[1]) {
        const value = sessions.get(decodeURIComponent(move[1]));
        if (!value) throw new Error("Missing session");
        const workspace = (body as { workspaceDirectory: string | null })
          .workspaceDirectory;
        value.workspaceDirectory = workspace;
        if (workspace === null) delete value.pendingWorkingDirectory;
        else value.pendingWorkingDirectory = workspace;
        return Response.json({ ok: true, session: global(value) });
      }
      if (directory && daemon.unavailable.has(directory))
        return Response.json(
          {
            ok: false,
            error: {
              message: "Directory is unavailable",
              code: "directory-unavailable",
            },
          },
          { status: 409 },
        );
      if (path === "/v1/clients" && clientId && directory) {
        clients.set(clientId, { directory, selected: null, generation: 1 });
        return Response.json({ ok: true, clientId, ...binding() });
      }
      if (path === "/v1/events" && client) {
        return new Response(
          new ReadableStream<Uint8Array>({
            start(controller): void {
              streams.set(controller, client.directory);
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({ type: "hello", clientId, ...binding() })}\n\n`,
                ),
              );
              request.signal.addEventListener(
                "abort",
                () => {
                  abortedStreams.push(client.directory);
                  streams.delete(controller);
                  controller.close();
                },
                { once: true },
              );
            },
          }),
          { headers: { "content-type": "text/event-stream" } },
        );
      }
      const select = /^\/v1\/sessions\/([^/]+)\/select$/.exec(path);
      if (select?.[1] && client) {
        const session = sessions.get(select[1]);
        if (!session || owner(session) !== client.directory)
          return Response.json(
            {
              ok: false,
              error: { message: "scope", code: "PERMISSION_SCOPE_CHANGED" },
            },
            { status: 409 },
          );
        client.selected = session.id;
        client.generation += 1;
        return Response.json({ ok: true, ...binding() });
      }
      if (path.endsWith("/view") && client)
        return Response.json({
          ok: true,
          seqNum: 0,
          view: sessionViewFromSnapshot(
            snapshot(client.selected),
            0,
            client.generation,
          ),
        });
      if (path.endsWith("/control") && client?.selected)
        return Response.json({
          ok: true,
          control: {
            sessionId: client.selected,
            rootSessionId: client.selected,
            runtimeEpoch: "epoch",
            bindingGeneration: client.generation,
            runId: daemon.running.has(client.selected) ? "run-1" : null,
            driver: "user",
          },
        });
      if (path === "/v1/model") return Response.json({ ok: true, model: null });
      if (path === "/v1/sessions/index" && client)
        return Response.json({
          ok: true,
          sessions: [...sessions.values()]
            .filter((session) => owner(session) === client.directory)
            .map((session) => ({
              id: session.id,
              title: session.title,
              createdAt: session.updatedAt,
              updatedAt: session.updatedAt,
            })),
        });
      if (path === "/v1/permissions")
        return Response.json({
          ok: true,
          snapshot: { ...binding(), permissionRevision: 0, requests: [] },
        });
      if (path === "/v1/prompts" && client) {
        const prompt = body as {
          clientRequestId: string;
          sessionId?: string;
          text: string;
        };
        let sessionId = prompt.sessionId;
        if (sessionId !== undefined) {
          const session = sessions.get(sessionId);
          const target =
            daemon.movedTo?.(sessionId, client.directory) ??
            (session && owner(session) !== client.directory
              ? owner(session)
              : null);
          if (target)
            return Response.json(
              {
                ok: false,
                error: {
                  message: "Session moved",
                  code: "SESSION_MOVED",
                  targetDirectory: target,
                },
              },
              { status: 409 },
            );
        } else {
          created += 1;
          sessionId = `created-${String(created)}`;
          sessions.set(sessionId, {
            id: sessionId,
            title: prompt.text,
            updatedAt: `2026-10-24T00:00:0${String(created)}.000Z`,
            workspaceDirectory:
              client.directory === DEFAULT ? null : client.directory,
            workingDirectory: client.directory,
          });
          client.selected = sessionId;
          client.generation += 1;
        }
        return Response.json({
          ok: true,
          ...binding(),
          promptId: `prompt-${prompt.clientRequestId}`,
          clientRequestId: prompt.clientRequestId,
          userMessageId: "message",
          sessionId,
          status: "accepted",
          createdAt: "2026-10-24T00:00:00.000Z",
        });
      }
      const archive = /^\/v1\/sessions\/([^/]+)\/archive$/.exec(path);
      if (archive?.[1] && request.method === "PATCH") {
        if (!client)
          return Response.json(
            { ok: false, error: { message: "client is not registered" } },
            { status: 409 },
          );
        if (daemon.running.has(archive[1]))
          return Response.json(
            {
              ok: false,
              error: { code: "SESSION_RUNNING", message: "Session is busy" },
            },
            { status: 409 },
          );
        const session = sessions.get(archive[1]);
        if (session) session.archived = true;
        return Response.json({ ok: true });
      }
      const unarchive = /^\/v1\/sessions\/([^/]+)\/unarchive$/.exec(path);
      const removed =
        request.method === "DELETE"
          ? /^\/v1\/sessions\/([^/]+)$/.exec(path)
          : null;
      const target = unarchive?.[1] ?? removed?.[1];
      if (target && (unarchive || removed)) {
        const session = sessions.get(target);
        if (!session)
          return Response.json(
            {
              ok: false,
              error: { code: "SESSION_NOT_FOUND", message: target },
            },
            { status: 404 },
          );
        if (!session.archived)
          return Response.json(
            {
              ok: false,
              error: { code: "SESSION_NOT_ARCHIVED", message: target },
            },
            { status: 409 },
          );
        if (removed) {
          sessions.delete(target);
          return Response.json({ ok: true, deletedSessionIds: [target] });
        }
        session.archived = false;
        session.updatedAt = new Date().toISOString();
        return Response.json({ ok: true, session: global(session) });
      }
      const exported = /^\/v1\/sessions\/([^/]+)\/export$/.exec(path);
      if (exported?.[1] && client)
        return Response.json({
          ok: true,
          export: {
            filename: `${exported[1]}.jsonl`,
            mimeType: "application/x-ndjson",
            content: "{}\n",
            messageCount: 0,
          },
        });
      throw new Error(`Unexpected request ${request.method} ${path}`);
    },
  };
  return daemon;
}

export function session(
  id: string,
  workspaceDirectory: string | null,
  workingDirectory: string,
  updatedAt = "2026-10-01T00:00:00.000Z",
): WorldSession {
  return { id, title: id, updatedAt, workspaceDirectory, workingDirectory };
}
