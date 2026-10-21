import { Hono } from "hono";
import {
  isUiPromptNamingSource,
  isUiReasoningConfig,
  type UiCancelQueuedPromptInput,
  type UiEditQueuedPromptInput,
} from "ohbaby-sdk";
import {
  acceptDaemonPrompt,
  cancelQueuedPromptForClient,
  editQueuedPromptForClient,
  resendSteerInputForClient,
  resubmitRetainedPromptForClient,
  steerQueuedPromptForClient,
} from "../../../coordination/prompt-backend.js";
import {
  parseSessionQuery,
  receiptForClient,
  sessionRecoveryCapability,
} from "../../../coordination/session-access.js";
import {
  asNonEmptyString,
  isRecord,
  promptAdmissionStatus,
  promptErrorBody,
  promptMutationStatus,
  promptRejectionBody,
  readJsonWithLimit,
  webErrorBody,
} from "../request-helpers.js";
import type { DaemonRouteContext } from "./context.js";
import { type UiReleasePromptEditLeaseInput } from "ohbaby-sdk";
import {
  acquirePromptEditLeaseForClient,
  releasePromptEditLeaseForClient,
  renewPromptEditLeaseForClient,
} from "../../../coordination/prompt-backend.js";

export function registerPromptReceiptRoutes(
  app: Hono,
  ctx: DaemonRouteContext,
): void {
  app.get("/v1/prompts/receipt", async (context) => {
    const authorization = ctx.authorizePromptMutation(context);
    if ("response" in authorization) return authorization.response;
    const raw: Record<string, string | undefined> = context.req.query();
    const query = parseSessionQuery(
      { ...raw, bindingGeneration: Number(raw.bindingGeneration) },
      true,
    );
    const result = await receiptForClient({
      backend: ctx.options.backend,
      views: ctx.clientViews,
      clientId: authorization.clientId,
      epoch: ctx.permissionEpoch,
      query: { ...query, signal: context.req.raw.signal },
    });
    return context.json({ ok: true, result });
  });
}

export function registerPromptMutationRoutes(
  app: Hono,
  ctx: DaemonRouteContext,
): void {
  app.post("/v1/prompts", async (context) => {
    if (!ctx.isAuthorized(context.req.header("authorization"))) {
      return context.json(promptRejectionBody("Unauthorized"), 401);
    }
    const clientId = ctx.clientIdFromRequest(context);
    if (!clientId) {
      return context.json(promptRejectionBody("clientId is required"), 400);
    }
    if (!ctx.isRegisteredWebClient(clientId)) {
      return context.json(promptRejectionBody("client is not registered"), 409);
    }

    const parsed = await readJsonWithLimit(context.req.raw);
    if (!parsed.ok) {
      return context.json(
        promptRejectionBody(parsed.message),
        parsed.status as 400 | 413,
      );
    }
    const body = isRecord(parsed.value) ? parsed.value : {};
    if (body.reasoning !== undefined && !isUiReasoningConfig(body.reasoning))
      return context.json(
        promptRejectionBody("Invalid reasoning preference"),
        400,
      );
    if (
      body.namingSource !== undefined &&
      !isUiPromptNamingSource(body.namingSource)
    )
      return context.json(promptRejectionBody("Invalid naming source"), 400);
    const text = asNonEmptyString(body.text);
    if (!text) {
      return context.json(promptRejectionBody("text is required"), 400);
    }
    const sessionId = asNonEmptyString(body.sessionId);
    const clientRequestId = asNonEmptyString(body.clientRequestId);
    if (!clientRequestId || clientRequestId.startsWith("legacy:")) {
      return context.json(
        {
          error: {
            code: "INVALID_CLIENT_REQUEST_ID",
            message:
              "clientRequestId is required and must not use the reserved legacy: prefix",
          },
          ok: false,
        },
        400,
      );
    }
    const commandBackend = ctx.commandBackend("server-rest", { clientId });
    const priorGeneration = ctx.clientViews.binding(
      clientId,
      ctx.permissionEpoch,
    ).bindingGeneration;
    try {
      const accepted = await acceptDaemonPrompt({
        backend: commandBackend,
        clientId,
        clientViews: ctx.clientViews,
        createSessionId: ctx.createSessionId,
        options: {
          clientRequestId,
          ...(body.namingSource === undefined
            ? {}
            : { namingSource: body.namingSource }),
          ...(body.reasoning === undefined
            ? {}
            : { reasoning: body.reasoning }),
          ...(sessionId === undefined ? {} : { sessionId }),
        },
        permissionRouter: ctx.permissionRouter,
        text,
      });
      return context.json(
        {
          ok: true,
          ...accepted.receipt,
          ...ctx.clientViews.binding(clientId, ctx.permissionEpoch),
          ...sessionRecoveryCapability(
            ctx.options.backend,
            ctx.permissionEpoch,
          ),
        },
        202,
      );
    } catch (error) {
      return context.json(promptErrorBody(error), promptAdmissionStatus(error));
    } finally {
      if (
        !ctx.clientViews.isPromptBindingProvisional(clientId) &&
        ctx.clientViews.binding(clientId, ctx.permissionEpoch)
          .bindingGeneration !== priorGeneration
      )
        ctx.notifyBinding(clientId);
    }
  });

  app.patch("/v1/prompts/:id", async (context) => {
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
    const text = asNonEmptyString(body.text);
    const editLeaseId = asNonEmptyString(body.editLeaseId);
    if (!text || !editLeaseId) {
      return context.json(
        webErrorBody("text and editLeaseId are required"),
        400,
      );
    }
    try {
      if (
        !ctx.clientViews.canAccessPrompt(
          authorization.clientId,
          await ctx.options.backend.getSnapshot(),
          context.req.param("id"),
        )
      ) {
        return context.json(
          webErrorBody("Prompt belongs to another session"),
          403,
        );
      }
      const prompt = await editQueuedPromptForClient(
        ctx.commandBackend("server-rest", {
          clientId: authorization.clientId,
        }),
        {
          editLeaseId,
          promptId: context.req.param("id"),
          text,
        } satisfies UiEditQueuedPromptInput,
        authorization.clientId,
      );
      return context.json({ ok: true, prompt });
    } catch (error) {
      return context.json(promptErrorBody(error), promptMutationStatus(error));
    }
  });

  app.get("/v1/prompts/:id/completion", async (context) => {
    const authorization = ctx.authorizePromptMutation(context);
    if ("response" in authorization) {
      return authorization.response;
    }
    const promptId = context.req.param("id");
    try {
      if (
        !ctx.clientViews.canAccessPrompt(
          authorization.clientId,
          await ctx.options.backend.getSnapshot(),
          promptId,
        )
      ) {
        return context.json(
          webErrorBody("Prompt is unavailable to this client"),
          403,
        );
      }
      const completion = await ctx.waitForPrompt(
        ctx.options.backend,
        promptId,
        context.req.raw.signal,
      );
      return context.json({ completion, ok: true });
    } catch (error) {
      return context.json(promptErrorBody(error), promptMutationStatus(error));
    }
  });

  app.post("/v1/prompts/:id/resubmit", async (context) => {
    const authorization = ctx.authorizePromptMutation(context);
    if ("response" in authorization) return authorization.response;
    const parsed = await readJsonWithLimit(context.req.raw);
    if (!parsed.ok)
      return context.json(
        webErrorBody(parsed.message),
        parsed.status as 400 | 413,
      );
    const body = isRecord(parsed.value) ? parsed.value : {};
    const text = asNonEmptyString(body.text);
    const editLeaseId = asNonEmptyString(body.editLeaseId);
    const operationId = asNonEmptyString(body.operationId);
    if (!text || !editLeaseId || !operationId)
      return context.json(
        webErrorBody("text, editLeaseId and operationId are required"),
        400,
      );
    try {
      if (
        !ctx.clientViews.canAccessPrompt(
          authorization.clientId,
          await ctx.options.backend.getSnapshot(),
          context.req.param("id"),
        )
      ) {
        return context.json(
          webErrorBody("Prompt belongs to another session"),
          403,
        );
      }
      const receipt = await resubmitRetainedPromptForClient(
        ctx.commandBackend("server-rest", {
          clientId: authorization.clientId,
        }),
        { promptId: context.req.param("id"), text, editLeaseId, operationId },
        authorization.clientId,
        ctx.clientViews,
      );
      return context.json({ ok: true, receipt });
    } catch (error) {
      return context.json(promptErrorBody(error), promptMutationStatus(error));
    }
  });

  app.post("/v1/steer-inputs/:id/resend", async (context) => {
    const authorization = ctx.authorizePromptMutation(context);
    if ("response" in authorization) return authorization.response;
    const parsed = await readJsonWithLimit(context.req.raw);
    if (!parsed.ok)
      return context.json(
        webErrorBody(parsed.message),
        parsed.status as 400 | 413,
      );
    const operationId = isRecord(parsed.value)
      ? asNonEmptyString(parsed.value.operationId)
      : undefined;
    if (!operationId)
      return context.json(webErrorBody("operationId is required"), 400);
    try {
      const receipt = await resendSteerInputForClient(
        ctx.commandBackend("server-rest", {
          clientId: authorization.clientId,
        }),
        { inputId: context.req.param("id"), operationId },
        authorization.clientId,
        ctx.clientViews,
      );
      return context.json({ ok: true, receipt });
    } catch (error) {
      return context.json(promptErrorBody(error), promptMutationStatus(error));
    }
  });

  app.post("/v1/prompts/:id/steer", async (context) => {
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
    const expectedRunId = asNonEmptyString(body.expectedRunId);
    const clientRequestId = asNonEmptyString(body.clientRequestId);
    if (!expectedRunId || !clientRequestId)
      return context.json(
        webErrorBody("expectedRunId and clientRequestId are required"),
        400,
      );
    try {
      if (
        !ctx.clientViews.canAccessPrompt(
          authorization.clientId,
          await ctx.options.backend.getSnapshot(),
          context.req.param("id"),
        )
      ) {
        return context.json(
          webErrorBody("Prompt belongs to another session"),
          403,
        );
      }
      const result = await steerQueuedPromptForClient(
        ctx.commandBackend("server-rest", {
          clientId: authorization.clientId,
        }),
        {
          expectedRunId,
          clientRequestId,
          promptId: context.req.param("id"),
        },
        authorization.clientId,
      );
      return context.json({ ok: true, result });
    } catch (error) {
      return context.json(promptErrorBody(error), promptMutationStatus(error));
    }
  });

  app.delete("/v1/prompts/:id", async (context) => {
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
    const editLeaseId = asNonEmptyString(body.editLeaseId);
    try {
      if (
        !ctx.clientViews.canAccessPrompt(
          authorization.clientId,
          await ctx.options.backend.getSnapshot(),
          context.req.param("id"),
        )
      ) {
        return context.json(
          webErrorBody("Prompt belongs to another session"),
          403,
        );
      }
      const prompt = await cancelQueuedPromptForClient(
        ctx.commandBackend("server-rest", {
          clientId: authorization.clientId,
        }),
        {
          ...(editLeaseId === undefined ? {} : { editLeaseId }),
          promptId: context.req.param("id"),
        } satisfies UiCancelQueuedPromptInput,
        authorization.clientId,
      );
      return context.json({ ok: true, prompt });
    } catch (error) {
      return context.json(promptErrorBody(error), promptMutationStatus(error));
    }
  });
}

export function registerPromptLeaseRoutes(
  app: Hono,
  ctx: DaemonRouteContext,
): void {
  app.post("/v1/prompts/:id/edit-lease", async (context) => {
    const authorization = ctx.authorizePromptMutation(context);
    if ("response" in authorization) return authorization.response;
    try {
      if (
        !ctx.clientViews.canAccessPrompt(
          authorization.clientId,
          await ctx.options.backend.getSnapshot(),
          context.req.param("id"),
        )
      ) {
        return context.json(
          webErrorBody("Prompt belongs to another session"),
          403,
        );
      }
      const lease = await acquirePromptEditLeaseForClient(
        ctx.commandBackend("server-rest", {
          clientId: authorization.clientId,
        }),
        { promptId: context.req.param("id") },
        authorization.clientId,
      );
      return context.json({ lease, ok: true });
    } catch (error) {
      return context.json(promptErrorBody(error), promptMutationStatus(error));
    }
  });

  app.patch("/v1/prompts/:id/edit-lease", async (context) => {
    const authorization = ctx.authorizePromptMutation(context);
    if ("response" in authorization) return authorization.response;
    const parsed = await readJsonWithLimit(context.req.raw);
    if (!parsed.ok) {
      return context.json(
        webErrorBody(parsed.message),
        parsed.status as 400 | 413,
      );
    }
    const body = isRecord(parsed.value) ? parsed.value : {};
    const editLeaseId = asNonEmptyString(body.editLeaseId);
    if (!editLeaseId) {
      return context.json(webErrorBody("editLeaseId is required"), 400);
    }
    try {
      const lease = await renewPromptEditLeaseForClient(
        ctx.commandBackend("server-rest", {
          clientId: authorization.clientId,
        }),
        { editLeaseId, promptId: context.req.param("id") },
        authorization.clientId,
      );
      return context.json({ lease, ok: true });
    } catch (error) {
      return context.json(promptErrorBody(error), promptMutationStatus(error));
    }
  });

  app.delete("/v1/prompts/:id/edit-lease", async (context) => {
    const authorization = ctx.authorizePromptMutation(context);
    if ("response" in authorization) return authorization.response;
    const parsed = await readJsonWithLimit(context.req.raw);
    if (!parsed.ok) {
      return context.json(
        webErrorBody(parsed.message),
        parsed.status as 400 | 413,
      );
    }
    const body = isRecord(parsed.value) ? parsed.value : {};
    const editLeaseId = asNonEmptyString(body.editLeaseId);
    if (!editLeaseId) {
      return context.json(webErrorBody("editLeaseId is required"), 400);
    }
    try {
      const prompt = await releasePromptEditLeaseForClient(
        ctx.commandBackend("server-rest", {
          clientId: authorization.clientId,
        }),
        {
          editLeaseId,
          promptId: context.req.param("id"),
        } satisfies UiReleasePromptEditLeaseInput,
        authorization.clientId,
      );
      return context.json({ ok: true, prompt });
    } catch (error) {
      return context.json(promptErrorBody(error), promptMutationStatus(error));
    }
  });
}
