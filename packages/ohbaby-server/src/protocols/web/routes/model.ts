import { Hono } from "hono";

import {
  errorMessage,
  isRecord,
  modelConnectInputFromBody,
  mutationErrorStatus,
  readJsonWithLimit,
  searchApiKeyInputFromBody,
  webErrorBody,
} from "../request-helpers.js";

import type { DaemonRouteContext } from "./context.js";

export function registerModelRoutes(app: Hono, ctx: DaemonRouteContext): void {
  app.get("/v1/model", async (context) => {
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

    const model = await ctx.options.backend.getCurrentModel();
    return context.json({ model, ok: true });
  });

  app.post("/v1/model/context-window-probe", async (context) => {
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
    const input = modelConnectInputFromBody(body);
    if (input === undefined) {
      return context.json(
        webErrorBody("model connection body is invalid"),
        400,
      );
    }
    try {
      const probe = await ctx.options.backend.probeModelContextWindow(input);
      return context.json({ ok: true, probe });
    } catch (error) {
      return context.json(webErrorBody(errorMessage(error)), 400);
    }
  });

  app.post("/v1/model", async (context) => {
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
    const input = modelConnectInputFromBody(body);
    if (input === undefined) {
      return context.json(
        webErrorBody("model connection body is invalid"),
        400,
      );
    }
    try {
      const model = await ctx
        .commandBackend("server-rest", {
          clientId,
        })
        .connectModel(input);
      return context.json({ model, ok: true });
    } catch (error) {
      return context.json(
        webErrorBody(errorMessage(error)),
        mutationErrorStatus(error),
      );
    }
  });

  app.post("/v1/settings/search-api-key", async (context) => {
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
    const input = searchApiKeyInputFromBody(body);
    if (input === undefined) {
      return context.json(webErrorBody("search api key body is invalid"), 400);
    }
    try {
      const search = await ctx
        .commandBackend("server-rest", {
          clientId,
        })
        .setSearchApiKey(input);
      return context.json({ ok: true, search });
    } catch (error) {
      return context.json(
        webErrorBody(errorMessage(error)),
        mutationErrorStatus(error),
      );
    }
  });
}
