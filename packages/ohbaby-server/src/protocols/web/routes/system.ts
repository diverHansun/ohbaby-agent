import { Hono } from "hono";

import {
  readJsonWithLimit,
  scheduleAfterResponse,
  unauthorizedBody,
  webErrorBody,
} from "../request-helpers.js";

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

export function registerIdleShutdownRoute(
  app: Hono,
  options: {
    readonly pidToken: string;
    readonly isAuthorized: (header: string | undefined) => boolean;
    readonly checkIdle: (signal: AbortSignal) => Promise<readonly string[]>;
    readonly onShutdown: () => Promise<void> | void;
  },
): void {
  app.post("/api/shutdown/idle", async (context) => {
    if (!options.isAuthorized(context.req.header("authorization"))) {
      return context.json(unauthorizedBody(), 401);
    }
    const body = await readJsonWithLimit(context.req.raw);
    if (!body.ok)
      return context.json(
        webErrorBody(body.message),
        body.status === 413 ? 413 : 400,
      );
    const input = body.value;
    if (
      !input ||
      typeof input !== "object" ||
      !("pidToken" in input) ||
      input.pidToken !== options.pidToken
    ) {
      return context.json(
        { ok: false, reasons: ["The daemon identity changed. Try again."] },
        409,
      );
    }
    const reasons = await options.checkIdle(context.req.raw.signal);
    if (reasons.length) return context.json({ ok: false, reasons }, 409);
    scheduleAfterResponse(options.onShutdown);
    return context.json({ ok: true });
  });
}
