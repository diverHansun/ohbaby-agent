import { Hono } from "hono";

import { scheduleAfterResponse, unauthorizedBody } from "../request-helpers.js";

import type { DaemonRouteContext } from "./context.js";

export function registerSystemRoutes(app: Hono, ctx: DaemonRouteContext): void {
  app.get("/doc", (context) => {
    return context.json(ctx.createOpenApiDocument());
  });

  app.get("/api/health", (context) => {
    if (!ctx.isAuthorized(context.req.header("authorization"))) {
      return context.json(unauthorizedBody(), 401);
    }
    return context.json({
      ok: true,
      ...(ctx.options.packageVersion === undefined
        ? {}
        : { packageVersion: ctx.options.packageVersion }),
    });
  });

  app.post("/api/shutdown", (context) => {
    if (!ctx.isAuthorized(context.req.header("authorization"))) {
      return context.json(unauthorizedBody(), 401);
    }
    scheduleAfterResponse(ctx.options.onShutdown);
    return context.json({ ok: true });
  });
}
