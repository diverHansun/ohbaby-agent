import { UI_REASONING_STATUSES } from "ohbaby-sdk";

export function createOpenApiDocument(
  packageVersion: string | undefined,
): unknown {
  const recoveryParameters = [
    {
      name: "x-ohbaby-client-id",
      in: "header",
      required: true,
      schema: { type: "string", minLength: 1 },
    },
    {
      name: "runtimeEpoch",
      in: "query",
      required: true,
      schema: { type: "string", minLength: 1 },
    },
    {
      name: "bindingGeneration",
      in: "query",
      required: true,
      schema: { type: "integer", minimum: 1 },
    },
  ];
  const recoveryResponses = {
    "200": {
      description:
        "Source-owned data with its original session version and current binding",
    },
    "400": { description: "Invalid query or cursor" },
    "409": { description: "Session binding changed or scope is unavailable" },
    "426": { description: "Session recovery capability is unsupported" },
    "503": { description: "Source projection or control is unavailable" },
  };

  return {
    info: {
      title: "ohbaby local daemon API",
      version: packageVersion ?? "0.1.12-dev",
    },
    openapi: "3.1.0",
    components: {
      schemas: {
        CommandCompletion: {
          type: "object",
          required: [
            "ok",
            "status",
            "commandRunId",
            "clientInvocationId",
            "outputCount",
            "eventCount",
          ],
          properties: {
            ok: { const: true },
            status: { enum: ["completed", "failed"] },
            commandRunId: { type: "string" },
            clientInvocationId: { type: "string" },
            sessionId: { type: "string" },
            outputCount: { type: "integer", minimum: 0 },
            eventCount: {
              type: "integer",
              minimum: 0,
              description:
                "Result and failure events, including actions; excludes started",
            },
            error: {
              type: "object",
              required: ["code", "message"],
              properties: {
                code: { type: "string" },
                message: { type: "string" },
              },
            },
            promptReceipt: {
              type: "object",
              description:
                "Existing UiPromptReceipt with the submitted clientRequestId; only accepted skill commands",
            },
          },
        },
        SessionVersion: {
          type: "object",
          required: [
            "runtimeEpoch",
            "sessionId",
            "viewGeneration",
            "sessionRevision",
          ],
          properties: {
            runtimeEpoch: { type: "string" },
            sessionId: { type: "string" },
            viewGeneration: { type: "string" },
            sessionRevision: { type: "integer", minimum: 0 },
          },
        },
        RecoveryBinding: {
          type: "object",
          required: [
            "runtimeEpoch",
            "permissionEpoch",
            "bindingGeneration",
            "rootSessionId",
            "sessionRecoveryVersion",
          ],
          properties: {
            runtimeEpoch: {
              type: "string",
              description: "Identical to permissionEpoch in this runtime",
            },
            permissionEpoch: { type: "string" },
            bindingGeneration: { type: "integer", minimum: 1 },
            rootSessionId: { type: ["string", "null"] },
            sessionRecoveryVersion: { type: "integer", enum: [0, 1] },
          },
        },

        ReasoningConfig: {
          type: "object",
          additionalProperties: false,
          properties: {
            enabled: { type: "boolean" },
            effort: { type: "string", minLength: 1 },
          },
        },
        ReasoningCapabilityView: {
          type: "object",
          required: ["status", "efforts"],
          properties: {
            status: { type: "string", enum: UI_REASONING_STATUSES },
            mode: { type: "string", enum: ["none", "binary", "effort"] },
            supportsDisabled: { type: "boolean" },
            efforts: { type: "array", items: { type: "string" } },
            default: { $ref: "#/components/schemas/ReasoningConfig" },
            source: { type: "string" },
            reason: { type: "string" },
            stale: { type: "boolean" },
          },
        },
      },
    },
    paths: {
      ...Object.fromEntries(
        ["view", "history", "control"].map((kind) => [
          `/v1/sessions/{id}/${kind}`,
          {
            get: {
              summary: `Read source session ${kind}`,
              parameters: [
                {
                  name: "id",
                  in: "path",
                  required: true,
                  schema: { type: "string" },
                },
                ...recoveryParameters,
                ...(kind === "history"
                  ? [
                      {
                        name: "before",
                        in: "query",
                        schema: { type: "string", maxLength: 4096 },
                      },
                      {
                        name: "limit",
                        in: "query",
                        schema: {
                          type: "integer",
                          minimum: 1,
                          maximum: 200,
                          default: 50,
                        },
                      },
                    ]
                  : []),
              ],
              responses: recoveryResponses,
            },
          },
        ]),
      ),
      "/v1/prompts/receipt": {
        get: {
          summary: "Recover the original prompt receipt without resubmitting",
          parameters: [
            ...recoveryParameters,
            {
              name: "clientRequestId",
              in: "query",
              required: true,
              schema: { type: "string", minLength: 1 },
            },
            { name: "sessionId", in: "query", schema: { type: "string" } },
          ],
          responses: recoveryResponses,
        },
      },

      "/v1/sessions/{id}/reasoning": {
        patch: {
          summary: "Save session reasoning preference",
          requestBody: {
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["reasoning"],
                  properties: {
                    reasoning: {
                      anyOf: [
                        { $ref: "#/components/schemas/ReasoningConfig" },
                        { type: "null" },
                      ],
                    },
                  },
                },
              },
            },
          },
          responses: {
            "200": { description: "Session preference saved" },
            "400": { description: "Invalid preference" },
          },
        },
      },
      "/v1/clients": {
        post: {
          responses: {
            "200": {
              description: "Registered browser client",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/RecoveryBinding" },
                },
              },
            },
          },
          summary: "Register a browser client view",
        },
      },
      "/v1/events": {
        get: {
          responses: {
            "200": {
              description:
                "SSE hello includes RecoveryBinding; session.changed carries the unchanged SessionVersion. Every revision for the selected root is delivered, including history-only invalidations. Transport sequence numbers are replay positions only.",
            },
          },
          summary: "Subscribe to replayable event stream",
        },
      },
      "/v1/commands": {
        get: {
          responses: {
            "200": {
              description: "Slash command catalog",
            },
          },
          summary: "List slash commands for a browser client",
        },
        post: {
          responses: {
            "200": {
              description:
                "Handler completion; HTTP 200 may contain status failed. Prompt receipt is present only for accepted skill submissions. Transport failure leaves completion unknown; do not replay commands.",
              content: {
                "application/json": {
                  schema: { $ref: "#/components/schemas/CommandCompletion" },
                },
              },
            },
          },
          summary: "Execute a slash command invocation",
        },
      },
      "/v1/model": {
        get: {
          responses: {
            "200": {
              description: "Current model config without secret values",
            },
          },
          summary: "Get current model config",
        },
        post: {
          responses: {
            "200": {
              description: "Model config saved",
            },
            "409": {
              description: "Prompt run is active",
            },
          },
          summary: "Save current model config",
        },
      },
      "/v1/model/context-window-probe": {
        post: {
          responses: {
            "200": {
              description: "Context window probe result",
            },
          },
          summary: "Probe model context window without saving config",
        },
      },
      "/v1/prompts/{id}/steer": {
        post: {
          summary:
            "Convert a queued prompt into input for the expected active run",
          responses: {
            "200": { description: "Durable Steer receipt" },
            "400": { description: "Invalid run or request identity" },
            "403": { description: "Prompt belongs to another session" },
            "409": {
              description: "Prompt or target run is no longer eligible",
            },
          },
        },
      },
      "/v1/permissions/{id}": {
        post: {
          responses: {
            "200": {
              description: "Permission response accepted",
            },
            "403": {
              description: "Permission belongs to another client",
            },
          },
          summary: "Respond to a permission request",
        },
      },
      "/v1/permission": {
        patch: {
          responses: {
            "200": {
              description: "Permission state updated",
            },
          },
          summary: "Update daemon permission state",
        },
      },
      "/v1/prompts": {
        post: {
          responses: {
            "202": {
              description: "Prompt accepted for asynchronous execution",
            },
          },
          summary: "Submit a prompt",
        },
      },
      "/v1/prompts/{id}": {
        delete: {
          responses: {
            "200": { description: "Queued prompt cancelled" },
            "409": { description: "Prompt is no longer queued" },
          },
          summary: "Cancel a queued prompt",
        },
        patch: {
          responses: {
            "200": { description: "Queued prompt edited" },
            "409": { description: "Prompt is no longer queued" },
          },
          summary: "Edit a queued prompt",
        },
      },
      "/v1/prompts/{id}/completion": {
        get: {
          responses: {
            "200": { description: "Prompt terminal completion" },
            "403": { description: "Prompt is unavailable to this client" },
          },
          summary: "Wait for a prompt to reach a terminal state",
        },
      },
      "/v1/interactions/{id}/respond": {
        post: {
          responses: {
            "200": { description: "Interaction response accepted" },
            "403": {
              description: "Interaction is unavailable to this client",
            },
          },
          summary: "Respond to an interaction owned by a browser client",
        },
      },
      "/v1/sessions": {
        post: {
          responses: {
            "200": {
              description: "Session creation command accepted",
            },
          },
          summary: "Create a new session",
        },
      },
      "/v1/settings/search-api-key": {
        post: {
          responses: {
            "200": {
              description: "Search API key settings saved",
            },
            "409": {
              description: "Prompt run is active",
            },
          },
          summary: "Save search API key settings",
        },
      },
      "/v1/sessions/{id}/abort": {
        post: {
          responses: {
            "200": {
              description: "Abort request accepted",
            },
          },
          summary:
            "Abort the exact active run from independent session control",
          requestBody: {
            required: true,
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  required: ["runId", "runtimeEpoch", "bindingGeneration"],
                  properties: {
                    runId: { type: "string", minLength: 1 },
                    runtimeEpoch: { type: "string" },
                    bindingGeneration: { type: "integer", minimum: 1 },
                  },
                },
              },
            },
          },
        },
      },
      "/v1/sessions/{id}/compact": {
        post: {
          responses: {
            "200": {
              description: "Session compact result",
            },
          },
          summary: "Compact a session",
        },
      },
      "/v1/sessions/{id}/select": {
        patch: {
          responses: {
            "200": {
              description: "Session selection command accepted",
            },
          },
          summary: "Select a session",
        },
      },
      "/v1/sessions/{id}/archive": {
        patch: {
          responses: {
            "200": {
              description: "Session archived",
            },
            "404": {
              description: "Session not found",
            },
          },
          summary: "Archive a session",
        },
      },
      "/v1/sessions/{id}/export": {
        get: {
          summary: "Export a session without changing its selection",
          parameters: [
            {
              in: "path",
              name: "id",
              required: true,
              schema: { type: "string" },
            },
            {
              in: "header",
              name: "x-ohbaby-client-id",
              required: true,
              schema: { type: "string" },
            },
            {
              in: "query",
              name: "format",
              required: true,
              schema: { type: "string", enum: ["html", "jsonl"] },
            },
          ],
          responses: {
            "200": {
              description: "Session export content",
              content: {
                "application/json": {
                  schema: {
                    type: "object",
                    required: ["ok", "export"],
                    properties: {
                      ok: { const: true },
                      export: {
                        type: "object",
                        required: [
                          "filename",
                          "mimeType",
                          "content",
                          "messageCount",
                        ],
                        properties: {
                          filename: { type: "string" },
                          mimeType: { type: "string" },
                          content: { type: "string" },
                          messageCount: { type: "integer" },
                        },
                      },
                    },
                  },
                },
              },
            },
            "400": {
              description:
                "Invalid format, invalid session argument, empty session, or subagent session",
            },
            "401": { description: "Invalid daemon token" },
            "404": { description: "Session not found" },
            "409": { description: "Client is not registered" },
            "500": { description: "Export failed" },
          },
        },
      },
      "/v1/sessions/{id}/context-window": {
        get: {
          responses: {
            "200": {
              description: "Session context window usage",
            },
          },
          summary: "Get session context window usage",
        },
      },
      "/v1/snapshot": {
        get: {
          responses: {
            "200": {
              description: "Client snapshot with event sequence baseline",
            },
          },
          summary: "Get current projected snapshot",
        },
      },
    },
  };
}
