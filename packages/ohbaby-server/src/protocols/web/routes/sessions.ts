import { Hono } from "hono";
import { isUiReasoningConfig, type UiBackendClient } from "ohbaby-sdk";
import { selectPermissionSession } from "../../../coordination/permission-access.js";
import {
  abortForClient,
  createOrReuseClientSession,
  parseSessionCreationOptions,
  parseSessionQuery,
  sessionReadForClient,
  sessionRecoveryCapability,
} from "../../../coordination/session-access.js";
import { createDaemonRpcFailure } from "../../jsonrpc/protocol.js";
import {
  parseSessionExportInput,
  sessionExportErrorStatus,
} from "../../session-export.js";
import { CLIENT_ID_HEADER } from "../request-helpers.js";

import {
  asNonEmptyString,
  errorMessage,
  isRecord,
  mutationErrorStatus,
  readJsonWithLimit,
  webErrorBody,
} from "../request-helpers.js";

import type { DaemonRouteContext } from "./context.js";

export function registerSessionReadRoutes(
  app: Hono,
  ctx: DaemonRouteContext,
): void {
  app.get("/v1/sessions/index", async (context) => {
    const authorization = ctx.authorizePromptMutation(context);
    if ("response" in authorization) return authorization.response;
    return context.json({
      ok: true,
      sessions: await ctx.options.backend.getSessionIndex(),
    });
  });

  app.get("/v1/sessions/:id/export", async (context) => {
    if (!ctx.isAuthorized(context.req.header("authorization"))) {
      return context.json(webErrorBody("Unauthorized"), 401);
    }
    const clientId = asNonEmptyString(context.req.header(CLIENT_ID_HEADER));
    if (!clientId) {
      return context.json(webErrorBody("clientId is required"), 400);
    }
    if (!ctx.clientViews.isRegistered(clientId)) {
      return context.json(webErrorBody("client is not registered"), 409);
    }
    try {
      const input = parseSessionExportInput({
        sessionId: context.req.param("id"),
        format: context.req.query("format"),
      });
      const artifact = await ctx.options.backend.exportSession(input);
      return context.json({ ok: true, export: artifact });
    } catch (error) {
      const failure = createDaemonRpcFailure("http", error);
      if (failure.ok) throw new Error("Expected export failure");
      return context.json(
        { ok: false, error: failure.error },
        sessionExportErrorStatus(error),
      );
    }
  });

  for (const [suffix, kind, field] of [
    ["view", "getSessionView", "view"],
    ["history", "getSessionHistory", "history"],
    ["control", "getSessionControl", "control"],
  ] as const) {
    app.get(`/v1/sessions/:id/${suffix}`, async (context) => {
      const authorization = ctx.authorizePromptMutation(context);
      if ("response" in authorization) return authorization.response;
      const raw: Record<string, string | undefined> = context.req.query();
      const query = parseSessionQuery({
        ...raw,
        sessionId: context.req.param("id"),
        bindingGeneration: Number(raw.bindingGeneration),
        ...(raw.limit === undefined ? {} : { limit: Number(raw.limit) }),
      });
      const result = await sessionReadForClient({
        backend: ctx.options.backend,
        views: ctx.clientViews,
        clientId: authorization.clientId,
        epoch: ctx.permissionEpoch,
        kind,
        query: { ...query, signal: context.req.raw.signal },
      });
      return context.json({ ok: true, [field]: result });
    });
  }
}

export function registerSessionMutationRoutes(
  app: Hono,
  ctx: DaemonRouteContext,
): void {
  app.patch("/v1/sessions/:id/reasoning", async (context) => {
    if (!ctx.isAuthorized(context.req.header("authorization")))
      return context.json(webErrorBody("Unauthorized"), 401);
    const clientId = ctx.clientIdFromRequest(context);
    if (!clientId)
      return context.json(webErrorBody("clientId is required"), 400);
    if (!ctx.isRegisteredWebClient(clientId))
      return context.json(webErrorBody("client is not registered"), 409);
    const parsed = await readJsonWithLimit(context.req.raw);
    if (!parsed.ok)
      return context.json(
        webErrorBody(parsed.message),
        parsed.status as 400 | 413,
      );
    const body = isRecord(parsed.value) ? parsed.value : {};
    if (body.reasoning !== null && !isUiReasoningConfig(body.reasoning))
      return context.json(webErrorBody("Invalid reasoning preference"), 400);
    try {
      const session = await ctx
        .commandBackend("server-rest", {
          clientId,
        })
        .updateSessionReasoning({
          sessionId: context.req.param("id"),
          reasoning: body.reasoning,
        });
      return context.json({ ok: true, session });
    } catch (error) {
      return context.json(webErrorBody(errorMessage(error)), 400);
    }
  });

  app.post("/v1/sessions", async (context) => {
    if (!ctx.isAuthorized(context.req.header("authorization"))) {
      return context.json(webErrorBody("Unauthorized"), 401);
    }
    const clientId = ctx.clientIdFromRequest(context);
    if (!clientId) {
      return context.json(webErrorBody("clientId is required"), 400);
    }
    if (!ctx.isRegisteredWebClient(clientId)) {
      return context.json(webErrorBody("client is not registered"), 409);
    }

    const parsed = await readJsonWithLimit(context.req.raw);
    if (!parsed.ok)
      return context.json(
        webErrorBody(parsed.message),
        parsed.status as 400 | 413,
      );
    const body = parsed.value;
    if (
      !isRecord(body) ||
      (body.reuseEmpty !== undefined && typeof body.reuseEmpty !== "boolean")
    )
      return context.json(webErrorBody("reuseEmpty must be a boolean"), 400);
    if (body.options !== undefined && body.reuseEmpty !== undefined)
      return context.json(
        webErrorBody("Use either options or reuseEmpty, not both"),
        400,
      );
    let options: Parameters<UiBackendClient["createSession"]>[0];
    try {
      options =
        body.options !== undefined
          ? parseSessionCreationOptions(body.options)
          : body.reuseEmpty === true
            ? { reuseInactiveEmpty: { excludeSessionIds: [] } }
            : undefined;
    } catch {
      return context.json(
        webErrorBody("Invalid session creation options"),
        400,
      );
    }
    const { session, binding, changed, created } =
      await createOrReuseClientSession(
        ctx.options.backend,
        ctx.clientViews,
        clientId,
        ctx.permissionEpoch,
        options,
      );
    if (changed) ctx.notifyBinding(clientId);
    ctx.clientViews.assertBinding(clientId, binding, ctx.permissionEpoch);
    return context.json({
      ok: true,
      session,
      created,
      ...binding,
      ...sessionRecoveryCapability(ctx.options.backend, ctx.permissionEpoch),
    });
  });

  app.patch("/v1/sessions/:id/select", async (context) => {
    if (!ctx.isAuthorized(context.req.header("authorization"))) {
      return context.json(webErrorBody("Unauthorized"), 401);
    }
    const clientId = ctx.clientIdFromRequest(context);
    if (!clientId) {
      return context.json(webErrorBody("clientId is required"), 400);
    }
    if (!ctx.isRegisteredWebClient(clientId)) {
      return context.json(webErrorBody("client is not registered"), 409);
    }
    const sessionId = asNonEmptyString(context.req.param("id"));
    if (!sessionId) {
      return context.json(webErrorBody("sessionId is required"), 400);
    }

    const binding = await selectPermissionSession(
      ctx.options.backend,
      ctx.clientViews,
      clientId,
      sessionId,
      ctx.permissionEpoch,
    );
    ctx.notifyBinding(clientId);
    return context.json({
      ok: true,
      ...binding,
      ...sessionRecoveryCapability(ctx.options.backend, ctx.permissionEpoch),
    });
  });

  app.patch("/v1/sessions/:id/archive", async (context) => {
    if (!ctx.isAuthorized(context.req.header("authorization"))) {
      return context.json(webErrorBody("Unauthorized"), 401);
    }
    const clientId = ctx.clientIdFromRequest(context);
    if (!clientId) {
      return context.json(webErrorBody("clientId is required"), 400);
    }
    if (!ctx.isRegisteredWebClient(clientId)) {
      return context.json(webErrorBody("client is not registered"), 409);
    }
    const sessionId = asNonEmptyString(context.req.param("id"));
    if (!sessionId) {
      return context.json(webErrorBody("sessionId is required"), 400);
    }

    try {
      await ctx.commandBackend("server-rest", { clientId }).archiveSession({
        sessionId,
      });
      return context.json({ ok: true });
    } catch (error) {
      return context.json(
        webErrorBody(errorMessage(error)),
        mutationErrorStatus(error),
      );
    }
  });

  app.get("/v1/sessions/:id/context-window", async (context) => {
    if (!ctx.isAuthorized(context.req.header("authorization"))) {
      return context.json(webErrorBody("Unauthorized"), 401);
    }
    const clientId = ctx.clientIdFromRequest(context);
    if (!clientId) {
      return context.json(webErrorBody("clientId is required"), 400);
    }
    if (!ctx.isRegisteredWebClient(clientId)) {
      return context.json(webErrorBody("client is not registered"), 409);
    }

    const usage = await ctx.options.backend.getContextWindowUsage({
      sessionId: context.req.param("id"),
    });
    return context.json({ ok: true, usage });
  });

  app.post("/v1/sessions/:id/compact", async (context) => {
    if (!ctx.isAuthorized(context.req.header("authorization"))) {
      return context.json(webErrorBody("Unauthorized"), 401);
    }
    const clientId = ctx.clientIdFromRequest(context);
    if (!clientId) {
      return context.json(webErrorBody("clientId is required"), 400);
    }
    if (!ctx.isRegisteredWebClient(clientId)) {
      return context.json(webErrorBody("client is not registered"), 409);
    }

    const parsed = await readJsonWithLimit(context.req.raw);
    if (!parsed.ok) {
      return context.json(
        webErrorBody(parsed.message),
        parsed.status as 400 | 413,
      );
    }
    const body = isRecord(parsed.value) ? parsed.value : {};
    const force = typeof body.force === "boolean" ? body.force : undefined;
    try {
      const compact = await ctx
        .commandBackend("server-rest", {
          clientId,
        })
        .compactSession({
          ...(force === undefined ? {} : { force }),
          signal: context.req.raw.signal,
          sessionId: context.req.param("id"),
        });
      return context.json({ compact, ok: true });
    } catch (error) {
      return context.json(webErrorBody(errorMessage(error)), 400);
    }
  });
}

export function registerSessionAbortRoutes(
  app: Hono,
  ctx: DaemonRouteContext,
): void {
  app.post("/v1/sessions/:id/abort", async (context) => {
    if (!ctx.isAuthorized(context.req.header("authorization"))) {
      return context.json(webErrorBody("Unauthorized"), 401);
    }
    const clientId = ctx.clientIdFromRequest(context);
    if (!clientId) {
      return context.json(webErrorBody("clientId is required"), 400);
    }
    if (!ctx.isRegisteredWebClient(clientId)) {
      return context.json(webErrorBody("client is not registered"), 409);
    }
    const parsed = await readJsonWithLimit(context.req.raw);
    if (!parsed.ok) {
      return context.json(
        webErrorBody(parsed.message),
        parsed.status as 400 | 413,
      );
    }
    if (!isRecord(parsed.value)) {
      return context.json(webErrorBody("request body must be an object"), 400);
    }
    const body = parsed.value;
    const hasRunId = Object.hasOwn(body, "runId");
    const requestedRunId = asNonEmptyString(body.runId);
    if (hasRunId && requestedRunId === undefined) {
      return context.json(
        webErrorBody("runId must be a non-empty string"),
        400,
      );
    }
    if (!requestedRunId)
      return context.json(webErrorBody("An exact runId is required"), 400);
    await abortForClient({
      backend: ctx.commandBackend("server-rest", { clientId }),
      views: ctx.clientViews,
      clientId,
      epoch: ctx.permissionEpoch,
      query: parseSessionQuery({
        ...body,
        sessionId: context.req.param("id"),
      }),
      runId: requestedRunId,
    });
    return context.json({ ok: true });
  });
}
