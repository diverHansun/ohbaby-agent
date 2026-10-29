import { Hono } from "hono";
import {
  subagentConversationReadForClient,
  subagentReadForClient,
  subagentInstancesForClient,
  stopSubagentForClient,
  unwatchSubagentConversationForClient,
  watchSubagentConversationForClient,
} from "../../../coordination/session-access.js";

import type { DaemonRouteContext } from "./context.js";

export function registerSubagentRoutes(
  app: Hono,
  ctx: DaemonRouteContext,
): void {
  app.get("/v1/sessions/:id/subagent-instances", async (context) => {
    const authorization = ctx.authorizePromptMutation(context);
    if ("response" in authorization) return authorization.response;
    const raw = context.req.query();
    const result = await subagentInstancesForClient({
      backend: ctx.options.backend,
      views: ctx.clientViews,
      clientId: authorization.clientId,
      epoch: ctx.permissionEpoch,
      query: {
        rootSessionId: context.req.param("id"),
        runtimeEpoch: raw.runtimeEpoch,
        bindingGeneration: Number(raw.bindingGeneration),
        signal: context.req.raw.signal,
      },
    });
    return context.json({ ok: true, result });
  });
  app.post("/v1/sessions/:id/subagents/:subagentId/stop", async (context) => {
    const authorization = ctx.authorizePromptMutation(context);
    if ("response" in authorization) return authorization.response;
    const raw: Record<string, unknown> = await context.req.json();
    const result = await stopSubagentForClient({
      backend: ctx.options.backend,
      views: ctx.clientViews,
      clientId: authorization.clientId,
      epoch: ctx.permissionEpoch,
      query: {
        rootSessionId: context.req.param("id"),
        subagentId: context.req.param("subagentId"),
        expectedExecutionId: raw.expectedExecutionId as string,
        runtimeEpoch: raw.runtimeEpoch as string,
        bindingGeneration: raw.bindingGeneration as number,
        signal: context.req.raw.signal,
      },
    });
    return context.json({ ok: true, result });
  });
  for (const route of [
    "/v1/sessions/:id/subagents",
    "/v1/sessions/:id/subagents/:executionId",
  ] as const) {
    app.get(route, async (context) => {
      const authorization = ctx.authorizePromptMutation(context);
      if ("response" in authorization) return authorization.response;
      const raw: Record<string, string | undefined> = context.req.query();
      const result = await subagentReadForClient({
        backend: ctx.options.backend,
        views: ctx.clientViews,
        clientId: authorization.clientId,
        epoch: ctx.permissionEpoch,
        query: {
          rootSessionId: context.req.param("id"),
          executionId: context.req.param("executionId"),
          runtimeEpoch: raw.runtimeEpoch,
          bindingGeneration: Number(raw.bindingGeneration),
          before: raw.before,
          limit: raw.limit === undefined ? undefined : Number(raw.limit),
          signal: context.req.raw.signal,
        },
      });
      return context.json({ ok: true, result });
    });
  }
  app.get(
    "/v1/sessions/:id/subagents/:subagentId/conversation",
    async (context) => {
      const authorization = ctx.authorizePromptMutation(context);
      if ("response" in authorization) return authorization.response;
      const raw: Record<string, string | undefined> = context.req.query();
      const result = await subagentConversationReadForClient({
        backend: ctx.options.backend,
        views: ctx.clientViews,
        clientId: authorization.clientId,
        epoch: ctx.permissionEpoch,
        query: {
          rootSessionId: context.req.param("id"),
          subagentId: context.req.param("subagentId"),
          runtimeEpoch: raw.runtimeEpoch,
          bindingGeneration: Number(raw.bindingGeneration),
          before: raw.before,
          after: raw.after,
          anchorExecutionId: raw.anchorExecutionId,
          limit: raw.limit === undefined ? undefined : Number(raw.limit),
          signal: context.req.raw.signal,
        },
      });
      return context.json({ ok: true, result });
    },
  );
  app.post(
    "/v1/sessions/:id/subagents/:subagentId/conversation/watch",
    async (context) => {
      const authorization = ctx.authorizePromptMutation(context);
      if ("response" in authorization) return authorization.response;
      const raw: Record<string, unknown> = await context.req.json();
      const result = await watchSubagentConversationForClient({
        backend: ctx.options.backend,
        views: ctx.clientViews,
        clientId: authorization.clientId,
        epoch: ctx.permissionEpoch,
        signal: context.req.raw.signal,
        query: {
          rootSessionId: context.req.param("id"),
          subagentId: context.req.param("subagentId"),
          runtimeEpoch: raw.runtimeEpoch as string,
          bindingGeneration: raw.bindingGeneration as number,
          watchId: raw.watchId as string | undefined,
          watchSequence: raw.watchSequence as number | undefined,
        },
      });
      return context.json({ ok: true, result });
    },
  );
  app.delete(
    "/v1/sessions/:id/subagents/:subagentId/conversation/watch",
    (context) => {
      const authorization = ctx.authorizePromptMutation(context);
      if ("response" in authorization) return authorization.response;
      const raw: Record<string, string | undefined> = context.req.query();
      unwatchSubagentConversationForClient({
        backend: ctx.options.backend,
        views: ctx.clientViews,
        clientId: authorization.clientId,
        epoch: ctx.permissionEpoch,
        query: {
          rootSessionId: context.req.param("id"),
          subagentId: context.req.param("subagentId"),
          runtimeEpoch: raw.runtimeEpoch,
          bindingGeneration: Number(raw.bindingGeneration),
          watchId: raw.watchId ?? "",
        },
      });
      return context.json({ ok: true });
    },
  );
}
