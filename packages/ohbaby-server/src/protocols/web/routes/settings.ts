import type { Hono } from "hono";
import { WORKSPACE_DIRECTORY_HEADER } from "ohbaby-sdk";
import { webErrorBody } from "../request-helpers.js";
import type { DaemonRouteContext } from "./context.js";

export function registerSettingsRoutes(
  app: Hono,
  ctx: DaemonRouteContext,
): void {
  app.post("/v1/settings/mcp/reconnect", async (context) => {
    if (!ctx.isAuthorized(context.req.header("authorization")))
      return context.json(webErrorBody("Unauthorized"), 401);
    if (!context.req.header(WORKSPACE_DIRECTORY_HEADER)?.trim())
      return context.json(webErrorBody("x-ohbaby-directory is required"), 400);
    const reconnect = ctx.options.backend.reconnectSettingsMcp;
    if (!reconnect)
      return context.json(
        webErrorBody("Settings reconnect is unavailable"),
        503,
      );
    try {
      return context.json({
        ok: true,
        servers: await reconnect.call(ctx.options.backend),
      });
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        "code" in error &&
        error.code === "INSTANCE_BUSY"
      )
        return context.json(
          {
            ok: false,
            error: {
              code: "INSTANCE_BUSY",
              message: "Instance has active work",
            },
          },
          409,
        );
      return context.json(webErrorBody("Unable to reconnect MCP"), 500);
    }
  });
  const reads = [
    ["/v1/settings/mcp/status", "getSettingsMcpStatus", "servers"],
    ["/v1/settings/skills", "getSettingsSkills", "skills"],
    ["/v1/settings/agents", "getSettingsAgents", "agents"],
  ] as const;
  for (const [route, method, key] of reads) {
    app.get(route, async (context) => {
      if (!ctx.isAuthorized(context.req.header("authorization"))) {
        return context.json(webErrorBody("Unauthorized"), 401);
      }
      if (!context.req.header(WORKSPACE_DIRECTORY_HEADER)?.trim()) {
        return context.json(
          webErrorBody("x-ohbaby-directory is required"),
          400,
        );
      }
      const read: (() => Promise<unknown>) | undefined =
        ctx.options.backend[method];
      if (!read)
        return context.json(
          webErrorBody("Settings reads are unavailable"),
          503,
        );
      try {
        return context.json({
          ok: true,
          [key]: await read.call(ctx.options.backend),
        });
      } catch {
        return context.json(
          webErrorBody("Unable to read instance settings"),
          500,
        );
      }
    });
  }
}
