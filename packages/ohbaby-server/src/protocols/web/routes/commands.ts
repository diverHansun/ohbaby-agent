import { Hono } from "hono";
import {
  filterWebCommandCatalog,
  filterWebPassthroughCommandCatalog,
  supportsWebOverlayCommandInvocation,
  supportsWebPassthroughCommandInvocation,
  supportsWebSkillCommandInvocation,
} from "ohbaby-sdk";
import { executeCommandForClient } from "../../../coordination/prompt-backend.js";

import {
  asNonEmptyString,
  isRecord,
  readJsonWithLimit,
  slashCommandInvocationFromBody,
  webErrorBody,
} from "../request-helpers.js";

import type { DaemonRouteContext } from "./context.js";

export function registerCommandRoutes(
  app: Hono,
  ctx: DaemonRouteContext,
): void {
  app.get("/v1/commands", async (context) => {
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

    const surface = asNonEmptyString(context.req.query("surface")) ?? "tui";
    const backendSurface = surface === "web" ? "tui" : surface;
    const backendCatalog = await ctx.options.backend.listCommands({
      surface: backendSurface,
    });
    const catalog =
      surface === "web"
        ? filterWebCommandCatalog(backendCatalog, { surface: backendSurface })
        : filterWebPassthroughCommandCatalog(backendCatalog, {
            surface: backendSurface,
          });
    return context.json({ catalog, ok: true });
  });

  app.post("/v1/commands", async (context) => {
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
    const invocation = slashCommandInvocationFromBody(body);
    if (invocation === undefined) {
      return context.json(webErrorBody("command invocation is invalid"), 400);
    }
    const catalog = await ctx.options.backend.listCommands({
      surface: invocation.surface,
    });
    if (
      !supportsWebPassthroughCommandInvocation(catalog, invocation) &&
      !supportsWebOverlayCommandInvocation(catalog, invocation) &&
      !supportsWebSkillCommandInvocation(catalog, invocation)
    ) {
      return context.json(
        webErrorBody("command is not supported by web passthrough"),
        400,
      );
    }

    const priorGeneration = ctx.clientViews.binding(
      clientId,
      ctx.permissionEpoch,
    ).bindingGeneration;
    try {
      const completion = await executeCommandForClient({
        backend: ctx.commandBackend("server-rest", { clientId }),
        clientId,
        clientViews: ctx.clientViews,
        createSessionId: ctx.createSessionId,
        permissionRouter: ctx.permissionRouter,
        invocation: ctx.clientViews.prepareCommandInvocation(
          clientId,
          invocation,
        ),
        signal: context.req.raw.signal,
      });
      return context.json({
        ok: true,
        ...completion,
        ...(completion.promptReceipt
          ? ctx.clientViews.binding(clientId, ctx.permissionEpoch)
          : {}),
      });
    } finally {
      ctx.clientViews.completeCommandInvocation(invocation.clientInvocationId);
      if (
        !ctx.clientViews.isPromptBindingProvisional(clientId) &&
        ctx.clientViews.binding(clientId, ctx.permissionEpoch)
          .bindingGeneration !== priorGeneration
      )
        ctx.notifyBinding(clientId);
    }
  });
}
