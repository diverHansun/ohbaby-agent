import { Hono } from "hono";
import {
  permissionRouterSnapshotForClient,
  unauthorizedBody,
  webErrorBody,
} from "../request-helpers.js";
import type { DaemonRouteContext } from "./context.js";
import { randomUUID } from "node:crypto";
import { parseDaemonStartupIntent } from "../../../coordination/client-view.js";
import { initializePermissionClient } from "../../../coordination/permission-access.js";
import { sessionRecoveryCapability } from "../../../coordination/session-access.js";
import { CLIENT_ID_HEADER } from "../request-helpers.js";
import {
  asNonEmptyString,
  DEFAULT_WEB_STARTUP_INTENT,
  isRecord,
  readJsonWithLimit,
} from "../request-helpers.js";

export function registerLegacyEventRoutes(
  app: Hono,
  ctx: DaemonRouteContext,
): void {
  app.get("/api/events", (context) => {
    const clientId = context.req.query("clientId");
    if (!clientId) {
      return context.json(
        { error: { message: "clientId is required" }, ok: false },
        400,
      );
    }
    if (!ctx.isAuthorized(context.req.header("authorization"))) {
      return context.json(unauthorizedBody(), 401);
    }
    if (!ctx.clientViews.isRegistered(clientId))
      return context.json(webErrorBody("client is not registered"), 409);
    return ctx.createSseResponse(
      clientId,
      context.req.raw.signal,
      context.req.header("last-event-id"),
    );
  });
}

export function registerSnapshotRoutes(
  app: Hono,
  ctx: DaemonRouteContext,
): void {
  app.get("/v1/snapshot", async (context) => {
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

    const snapshot = await ctx.options.backend.getSnapshot();
    const seqNum = ctx.eventBus.latestSeqNum;
    return context.json({
      ok: true,
      seqNum,
      snapshot: permissionRouterSnapshotForClient(
        ctx.permissionRouter,
        ctx.clientViews.projectSnapshot(clientId, snapshot),
        ctx.clientViews.binding(clientId, ctx.permissionEpoch).rootSessionId,
      ),
    });
  });
}

export function registerEventRoutes(app: Hono, ctx: DaemonRouteContext): void {
  app.get("/v1/events", (context) => {
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
    if (!ctx.clientViews.isRegistered(clientId))
      return context.json(webErrorBody("client is not registered"), 409);
    return ctx.createSseResponse(
      clientId,
      context.req.raw.signal,
      context.req.header("last-event-id"),
    );
  });
}

export function registerClientRoutes(app: Hono, ctx: DaemonRouteContext): void {
  app.post("/v1/clients", async (context) => {
    if (!ctx.isAuthorized(context.req.header("authorization"))) {
      return context.json(webErrorBody("Unauthorized"), 401);
    }

    const parsed = await readJsonWithLimit(context.req.raw);
    if (!parsed.ok) {
      return context.json(
        webErrorBody(parsed.message),
        parsed.status as 400 | 413,
      );
    }
    const body = isRecord(parsed.value) ? parsed.value : {};
    const clientId =
      asNonEmptyString(body.clientId) ??
      asNonEmptyString(context.req.header(CLIENT_ID_HEADER)) ??
      randomUUID();
    const startupIntent = parseDaemonStartupIntent(
      body.startupIntent ?? DEFAULT_WEB_STARTUP_INTENT,
    );
    const binding = await initializePermissionClient(
      ctx.options.backend,
      ctx.clientViews,
      clientId,
      startupIntent,
      ctx.permissionEpoch,
    );
    ctx.knownClientIds.add(clientId);
    ctx.registeredWebClientIds.add(clientId);
    ctx.touchClientActivity(clientId);

    return context.json({
      clientId,
      ok: true,
      ...binding,
      ...sessionRecoveryCapability(ctx.options.backend, ctx.permissionEpoch),
    });
  });
}
