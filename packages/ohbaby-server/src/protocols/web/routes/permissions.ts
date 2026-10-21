import { Hono } from "hono";
import {
  parsePermissionBinding,
  permissionSnapshotForClient,
  respondPermissionForClient,
} from "../../../coordination/permission-access.js";
import {
  isRecord,
  permissionResponseFromBody,
  readJsonWithLimit,
  webErrorBody,
} from "../request-helpers.js";
import type { DaemonRouteContext } from "./context.js";
import { type UiBackendClient } from "ohbaby-sdk";
import { respondInteractionForClient } from "../../../coordination/client-view.js";
import { isDaemonForbiddenError } from "../../jsonrpc/rpc-route.js";
import { errorMessage, mutationErrorStatus } from "../request-helpers.js";

export function registerPermissionRoutes(
  app: Hono,
  ctx: DaemonRouteContext,
): void {
  app.patch("/v1/permission", async (context) => {
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
    const mode = body.mode;
    const level = body.level;
    if (mode !== undefined && mode !== "auto" && mode !== "plan") {
      return context.json(webErrorBody("mode must be auto or plan"), 400);
    }
    if (level !== undefined && level !== "default" && level !== "full-access") {
      return context.json(
        webErrorBody("level must be default or full-access"),
        400,
      );
    }
    if (mode === undefined && level === undefined) {
      return context.json(webErrorBody("mode or level is required"), 400);
    }

    const permission = await ctx
      .commandBackend("server-rest", {
        clientId,
      })
      .setPermission({
        ...(level === undefined ? {} : { level }),
        ...(mode === undefined ? {} : { mode }),
      });
    return context.json({ ok: true, permission });
  });

  app.get("/v1/permissions", async (context) => {
    const authorization = ctx.authorizePromptMutation(context);
    if ("response" in authorization) return authorization.response;
    const rootSessionId = context.req.query("rootSessionId");
    const expected = parsePermissionBinding({
      rootSessionId: rootSessionId === "" ? null : (rootSessionId ?? null),
      permissionEpoch: context.req.query("permissionEpoch"),
      bindingGeneration: Number(context.req.query("bindingGeneration")),
    });
    const snapshot = await permissionSnapshotForClient(
      ctx.options.backend,
      ctx.clientViews,
      authorization.clientId,
      expected,
      ctx.permissionEpoch,
    );
    return context.json({ ok: true, snapshot });
  });

  app.post("/v1/permissions/:id", async (context) => {
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
    const requestId = context.req.param("id");
    const parsed = await readJsonWithLimit(context.req.raw);
    if (!parsed.ok) {
      return context.json(
        webErrorBody(parsed.message),
        parsed.status as 400 | 413,
      );
    }
    const body = isRecord(parsed.value) ? parsed.value : {};
    const responseValue = isRecord(body.response) ? body.response : body;
    const response = permissionResponseFromBody(responseValue);
    if (!response) {
      return context.json(webErrorBody("choiceId is required"), 400);
    }
    await respondPermissionForClient(
      ctx.commandBackend("server-rest", { clientId }),
      ctx.clientViews,
      clientId,
      requestId,
      response,
      parsePermissionBinding(body.context),
      ctx.permissionEpoch,
    );
    return context.json({ ok: true });
  });
}

export function registerInteractionRoutes(
  app: Hono,
  ctx: DaemonRouteContext,
): void {
  app.post("/v1/interactions/:id/respond", async (context) => {
    const authorization = ctx.authorizePromptMutation(context);
    if ("response" in authorization) {
      return authorization.response;
    }
    const parsed = await readJsonWithLimit(context.req.raw);
    if (!parsed.ok) {
      return context.json(
        webErrorBody(parsed.message),
        parsed.status as 400 | 413,
      );
    }
    const body = isRecord(parsed.value) ? parsed.value : {};
    if (!isRecord(body.response)) {
      return context.json(webErrorBody("response is required"), 400);
    }
    try {
      await respondInteractionForClient({
        backend: ctx.commandBackend("server-rest", {
          clientId: authorization.clientId,
        }),
        clientId: authorization.clientId,
        clientViews: ctx.clientViews,
        interactionId: context.req.param("id"),
        response: body.response as Parameters<
          UiBackendClient["respondInteraction"]
        >[1],
      });
      return context.json({ ok: true });
    } catch (error) {
      return context.json(
        webErrorBody(errorMessage(error)),
        isDaemonForbiddenError(error) ? 403 : mutationErrorStatus(error),
      );
    }
  });
}
