import {
  isRecord,
  readJsonWithLimit,
  webErrorBody,
} from "../request-helpers.js";
import { Hono } from "hono";
import { shellJobForClient } from "../../../coordination/session-access.js";
import type { DaemonRouteContext } from "./context.js";

export function registerShellJobRoutes(
  app: Hono,
  ctx: DaemonRouteContext,
): void {
  for (const [method, path] of [
    ["listShellJobs", "/v1/sessions/:id/shell-jobs"],
    ["getShellJobOutput", "/v1/sessions/:id/shell-jobs/:jobId/output"],
    ["readShellJobLog", "/v1/sessions/:id/shell-jobs/:jobId/log"],
  ] as const) {
    app.get(path, async (context) => {
      const authorization = ctx.authorizePromptMutation(context);
      if ("response" in authorization) return authorization.response;
      const raw: Record<string, string | undefined> = context.req.query();
      const owner =
        raw.owner === undefined
          ? undefined
          : raw.owner === "subagent"
            ? { kind: raw.owner, subagentId: raw.subagentId }
            : { kind: raw.owner };
      const result = await shellJobForClient({
        backend: ctx.options.backend,
        views: ctx.clientViews,
        clientId: authorization.clientId,
        epoch: ctx.permissionEpoch,
        method,
        query: {
          rootSessionId: context.req.param("id"),
          jobId: context.req.param("jobId"),
          runtimeEpoch: raw.runtimeEpoch,
          bindingGeneration: Number(raw.bindingGeneration),
          owner,
          statuses: raw.statuses?.split(","),
          mode: raw.mode,
          cursor: raw.cursor,
          limit: raw.limit === undefined ? undefined : Number(raw.limit),
          offset: raw.offset === undefined ? undefined : Number(raw.offset),
          maxBytes:
            raw.maxBytes === undefined ? undefined : Number(raw.maxBytes),
          signal: context.req.raw.signal,
        } as import("ohbaby-sdk").UiShellJobQuery,
      });
      return context.json({ ok: true, result });
    });
  }
  for (const [method, action] of [
    ["stopShellJob", "stop"],
    ["abandonShellJob", "abandon"],
  ] as const) {
    app.post(
      `/v1/sessions/:id/shell-jobs/:jobId/${action}`,
      async (context) => {
        const authorization = ctx.authorizePromptMutation(context);
        if ("response" in authorization) return authorization.response;
        const parsed = await readJsonWithLimit(context.req.raw);
        if (!parsed.ok)
          return context.json(
            webErrorBody(parsed.message),
            parsed.status as 400 | 413,
          );
        if (!isRecord(parsed.value))
          return context.json(
            webErrorBody("Request body must be an object"),
            400,
          );
        const raw = parsed.value;
        const result = await shellJobForClient({
          backend: ctx.options.backend,
          views: ctx.clientViews,
          clientId: authorization.clientId,
          epoch: ctx.permissionEpoch,
          method,
          query: {
            rootSessionId: context.req.param("id"),
            jobId: context.req.param("jobId"),
            runtimeEpoch: raw.runtimeEpoch,
            bindingGeneration: raw.bindingGeneration,
            confirm: raw.confirm,
            signal: context.req.raw.signal,
          } as import("ohbaby-sdk").UiShellJobQuery,
        });
        return context.json({ ok: true, result });
      },
    );
  }
}
