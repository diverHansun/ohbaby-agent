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

  const ref = (name: string): Record<string, unknown> => ({
    $ref: `#/components/schemas/${name}`,
  });
  const string = { type: "string" };
  const strings = { type: "array", items: string };
  const positiveInteger = { type: "integer", minimum: 1 };
  const keyEnv = {
    type: ["string", "null"],
    pattern: "^[A-Za-z_][A-Za-z0-9_]*$",
    description:
      "Omitted preserves the reference; null detaches this entry from credentials.",
  };
  const apiKey = {
    type: "string",
    writeOnly: true,
    description:
      "Omitted keeps the saved key; empty detaches target usage; a nonempty value replaces it with shared-reference isolation. Never returned.",
  };
  const modelFields = {
    provider: {
      type: "string",
      minLength: 1,
      description:
        "Free-text grouping label; never selects a protocol or capability rule.",
    },
    model: { type: "string", minLength: 1 },
    baseUrl: { type: "string", format: "uri", pattern: "^https?://" },
    interfaceProvider: {
      enum: ["openai-compatible", "openai-responses", "anthropic"],
    },
    promptCache: { enum: ["auto", "enabled", "disabled"] },
    label: string,
    apiKeyEnv: keyEnv,
    apiKey,
    contextWindowTokens: positiveInteger,
    maxOutputTokens: positiveInteger,
  };
  const searchDefaults = {
    searchDepth: { enum: ["basic", "advanced"] },
    maxResults: { type: "integer", minimum: 1, maximum: 20 },
    topic: { enum: ["general", "news", "finance"] },
    timeout: {
      type: "integer",
      minimum: 1,
      maximum: 600,
      description: "Seconds",
    },
  };
  const mcpFields = {
    transport: { enum: ["stdio", "http", "http_streamable", "sse"] },
    enabled: { type: "boolean" },
    trust: { type: "boolean" },
    timeout: positiveInteger,
    includeTools: strings,
    excludeTools: strings,
    command: string,
    args: strings,
    cwd: string,
    url: { type: "string", format: "uri" },
  };
  const settingsSchemas = {
    SettingsError: {
      type: "object",
      required: ["ok", "error"],
      properties: {
        ok: { const: false },
        error: {
          type: "object",
          required: ["message"],
          properties: { message: string, code: string },
        },
      },
    },
    SettingsOk: {
      type: "object",
      required: ["ok"],
      properties: { ok: { const: true } },
    },
    SettingsModelCreate: {
      type: "object",
      additionalProperties: false,
      required: ["provider", "model", "baseUrl", "interfaceProvider"],
      properties: modelFields,
    },
    SettingsModelPatch: {
      type: "object",
      additionalProperties: false,
      properties: {
        ...modelFields,
        label: {
          type: ["string", "null"],
          description: "null clears the label; omission preserves it.",
        },
      },
    },
    SettingsModelTarget: {
      type: "object",
      additionalProperties: false,
      required: ["id"],
      properties: { id: { type: "string", minLength: 1 } },
    },
    SettingsModel: {
      type: "object",
      required: [
        "id",
        "provider",
        "model",
        "apiKeyConfigured",
        "configurationComplete",
        "contextWindowTokens",
        "reasoning",
      ],
      description:
        "Saved connection in original order. Incomplete historical entries may omit connection fields. URLs are redacted; no raw keys or fingerprints are returned.",
      properties: {
        id: string,
        provider: string,
        model: string,
        label: string,
        baseUrl: string,
        interfaceProvider: modelFields.interfaceProvider,
        promptCache: modelFields.promptCache,
        apiKeyEnv: string,
        apiKeyConfigured: { type: "boolean" },
        configurationComplete: { type: "boolean" },
        contextWindowTokens: positiveInteger,
        maxOutputTokens: positiveInteger,
        reasoning: ref("ReasoningCapabilityView"),
      },
    },
    SettingsModelsResponse: {
      type: "object",
      required: ["ok", "active", "params", "models"],
      properties: {
        ok: { const: true },
        active: {
          anyOf: [
            { type: "null" },
            {
              type: "object",
              required: ["id", "provider", "model"],
              properties: { id: string, provider: string, model: string },
            },
          ],
        },
        params: {
          type: "object",
          required: ["maxTokens"],
          properties: {
            maxTokens: positiveInteger,
            temperature: { type: "number" },
            contextWindowTokens: positiveInteger,
            reasoning: ref("ReasoningConfig"),
          },
        },
        models: { type: "array", items: ref("SettingsModel") },
      },
    },
    SettingsModelProbeResponse: {
      type: "object",
      required: ["ok", "reasoning"],
      properties: {
        ok: { const: true },
        reasoning: ref("ReasoningCapabilityView"),
      },
    },
    SettingsSearchUpdate: {
      type: "object",
      additionalProperties: false,
      properties: {
        provider: { const: "tavily" },
        apiKeyEnv: keyEnv,
        apiKey,
        baseUrl: {
          type: ["string", "null"],
          format: "uri",
          description: "null removes the override.",
        },
        defaults: {
          type: "object",
          additionalProperties: false,
          properties: searchDefaults,
        },
      },
    },
    SettingsSearchResponse: {
      type: "object",
      required: ["ok", "provider", "apiKeyEnv", "apiKeyConfigured", "defaults"],
      properties: {
        ok: { const: true },
        provider: { const: "tavily" },
        apiKeyEnv: { type: ["string", "null"] },
        apiKeyConfigured: { type: "boolean" },
        baseUrl: string,
        defaults: {
          type: "object",
          required: Object.keys(searchDefaults),
          properties: searchDefaults,
        },
      },
    },
    SettingsSecretPatch: {
      type: "object",
      additionalProperties: false,
      description:
        "Unmentioned names are retained. Unset wins when a name also appears in set. Values are write-only.",
      properties: {
        set: { type: "object", writeOnly: true, additionalProperties: string },
        unset: strings,
      },
    },
    SettingsMcpServerUpdate: {
      type: "object",
      additionalProperties: false,
      description:
        "Partial update; new servers default to stdio and require a command, HTTP transports require a URL. Save does not reconnect loaded instances.",
      properties: {
        ...mcpFields,
        env: ref("SettingsSecretPatch"),
        headers: ref("SettingsSecretPatch"),
      },
    },
    SettingsGlobalMcpServer: {
      type: "object",
      required: [
        "name",
        "transport",
        "enabled",
        "trust",
        "timeout",
        "envKeys",
        "headerKeys",
      ],
      properties: {
        name: string,
        ...mcpFields,
        envKeys: strings,
        headerKeys: strings,
      },
      description:
        "Global server configuration with redacted URL and only secret names, never env/header values.",
    },
    SettingsGlobalMcpServersResponse: {
      type: "object",
      required: ["ok", "servers"],
      properties: {
        ok: { const: true },
        servers: { type: "array", items: ref("SettingsGlobalMcpServer") },
      },
    },
    SettingsMcpServerUpdateResponse: {
      allOf: [
        ref("SettingsGlobalMcpServer"),
        {
          type: "object",
          required: ["ok", "overriddenIn"],
          properties: { ok: { const: true }, overriddenIn: strings },
        },
      ],
    },
    SettingsMcpStatusResponse: {
      type: "object",
      required: ["ok", "servers"],
      properties: {
        ok: { const: true },
        servers: {
          type: "array",
          items: {
            type: "object",
            required: [
              "name",
              "origin",
              "enabled",
              "status",
              "toolCount",
              "tools",
            ],
            properties: {
              name: string,
              origin: { enum: ["global", "project", "plugin"] },
              enabled: { type: "boolean" },
              status: {
                enum: ["connected", "failed", "disconnected", "disabled"],
              },
              error: string,
              toolCount: { type: "integer", minimum: 0 },
              tools: {
                type: "array",
                items: {
                  type: "object",
                  required: ["name", "description", "mcpToolName"],
                  properties: {
                    name: string,
                    description: string,
                    mcpToolName: string,
                  },
                },
              },
            },
          },
        },
      },
    },
    SettingsSkillsResponse: {
      type: "object",
      required: ["ok", "skills"],
      properties: {
        ok: { const: true },
        skills: {
          type: "array",
          items: {
            type: "object",
            required: [
              "name",
              "description",
              "source",
              "scope",
              "location",
              "userInvocable",
              "modelInvocable",
            ],
            properties: {
              name: string,
              description: string,
              source: {
                enum: [
                  "project-native",
                  "user-native",
                  "claude-compatible",
                  "agents-compatible",
                  "codex-home",
                  "plugin",
                ],
              },
              scope: { enum: ["user", "project"] },
              location: string,
              userInvocable: { type: "boolean" },
              modelInvocable: { type: "boolean" },
            },
          },
        },
      },
    },
    SettingsAgentsResponse: {
      type: "object",
      required: ["ok", "agents"],
      properties: {
        ok: { const: true },
        agents: {
          type: "array",
          items: {
            type: "object",
            required: ["name", "description", "mode", "hidden", "origin"],
            properties: {
              name: string,
              description: string,
              mode: { enum: ["primary", "subagent", "all"] },
              hidden: { type: "boolean" },
              origin: { enum: ["builtin", "global", "project"] },
            },
          },
        },
      },
    },
    SettingsAboutResponse: {
      type: "object",
      required: ["ok", "version", "ohbabyHome", "defaultWorkspace"],
      properties: {
        ok: { const: true },
        version: string,
        ohbabyHome: string,
        defaultWorkspace: string,
        diagnosticsFile: string,
        logDirectory: string,
      },
    },
  };
  const directoryParameter = {
    name: "x-ohbaby-directory",
    in: "header",
    required: true,
    schema: { type: "string", minLength: 1 },
    description:
      "Workspace directory; percent-encode UTF-8 characters when needed for HTTP headers.",
  };
  const pathParameter = (
    name: string,
    description: string,
  ): Record<string, unknown> => ({
    name,
    in: "path",
    required: true,
    schema: { type: "string", minLength: 1 },
    description,
  });
  const settingsOperation = (
    summary: string,
    response: string,
    options: {
      request?: string;
      instance?: boolean;
      parameter?: Record<string, unknown>;
      errors?: Record<string, string>;
    } = {},
  ): Record<string, unknown> => ({
    summary,
    description: options.instance
      ? "Instance-scoped; bearer authentication and workspace directory header are required."
      : "Global settings; bearer authentication is required, no workspace directory header is required.",
    security: [{ daemonBearer: [] }],
    parameters: [
      ...(options.parameter ? [options.parameter] : []),
      ...(options.instance ? [directoryParameter] : []),
    ],
    ...(options.request
      ? {
          requestBody: {
            required: true,
            content: { "application/json": { schema: ref(options.request) } },
          },
        }
      : {}),
    responses: {
      "200": {
        description: "Successful settings result",
        content: { "application/json": { schema: ref(response) } },
      },
      ...Object.fromEntries(
        Object.entries({
          "401": "Unauthorized bearer token",
          "500": "Settings read or write failed; error text is redacted",
          ...(options.instance
            ? {
                "400": "Missing or invalid workspace directory",
                "503": "Instance settings capability unavailable",
              }
            : {}),
          ...(options.request
            ? {
                "400": "Invalid JSON or settings",
                "413": "Request exceeds 1 MiB body limit",
              }
            : {}),
          ...options.errors,
        }).map(([status, description]) => [
          status,
          {
            description,
            content: { "application/json": { schema: ref("SettingsError") } },
          },
        ]),
      ),
    },
  });
  const targetErrors = {
    "400":
      "Invalid input or MODEL_CONFIG_INCOMPLETE for a saved entry missing connection fields",
    "404": "MODEL_NOT_FOUND",
  };
  const idParameter = pathParameter("id", "Stable saved entry ID.");
  const nameParameter = pathParameter(
    "name",
    "URL-encoded nonempty global server name.",
  );
  const settingsPaths = {
    "/v1/settings/about": {
      get: settingsOperation(
        "Read daemon version and configuration locations",
        "SettingsAboutResponse",
      ),
    },
    "/v1/settings/search": {
      get: settingsOperation(
        "Read redacted global search settings",
        "SettingsSearchResponse",
      ),
      put: settingsOperation(
        "Save search settings; next rounds use the new values",
        "SettingsSearchResponse",
        { request: "SettingsSearchUpdate" },
      ),
    },
    "/v1/settings/mcp/servers": {
      get: settingsOperation(
        "Read global MCP configuration without connecting servers",
        "SettingsGlobalMcpServersResponse",
      ),
    },
    "/v1/settings/mcp/servers/{name}": {
      put: settingsOperation(
        "Create or patch a global MCP server without reconnecting",
        "SettingsMcpServerUpdateResponse",
        { request: "SettingsMcpServerUpdate", parameter: nameParameter },
      ),
      delete: settingsOperation(
        "Delete a global MCP server without reconnecting",
        "SettingsOk",
        {
          parameter: nameParameter,
          errors: { "404": "Global MCP server not found" },
        },
      ),
    },
    "/v1/settings/models": {
      get: settingsOperation(
        "Read ordered saved models and nullable active selection; no network discovery",
        "SettingsModelsResponse",
      ),
    },
    "/v1/settings/models/profiles": {
      post: settingsOperation(
        "Append an independent model entry without selecting or deduplicating; return after local save, then fetch metadata only",
        "SettingsModelsResponse",
        { request: "SettingsModelCreate" },
      ),
    },
    "/v1/settings/models/profiles/{id}": {
      patch: settingsOperation(
        "Patch an entry without changing its ID/order; connection or key changes invalidate automatic capabilities and schedule metadata refresh",
        "SettingsModelsResponse",
        {
          request: "SettingsModelPatch",
          parameter: idParameter,
          errors: { "404": "MODEL_NOT_FOUND" },
        },
      ),
      delete: settingsOperation(
        "Delete an entry, retain its key and choose the next complete saved entry if active",
        "SettingsModelsResponse",
        { parameter: idParameter, errors: { "404": "MODEL_NOT_FOUND" } },
      ),
    },
    "/v1/settings/models/providers/{providerId}": {
      delete: settingsOperation(
        "Delete all entries with this provider label in one write; retain keys and advance selection if needed",
        "SettingsModelsResponse",
        {
          parameter: pathParameter(
            "providerId",
            "URL-encoded free-text provider label, including any slash. Compared against normalized saved labels.",
          ),
          errors: { "404": "MODEL_NOT_FOUND: no matching entries" },
        },
      ),
    },
    "/v1/settings/models/active": {
      post: settingsOperation(
        "Select a complete saved entry without network validation; next round uses it and background discovery may actively probe",
        "SettingsModelsResponse",
        { request: "SettingsModelTarget", errors: targetErrors },
      ),
    },
    "/v1/settings/models/probe": {
      post: settingsOperation(
        "Refresh the targeted saved entry without selecting it: builtin rules, then metadata, then active fallback; persist context/capability results, preserve explicit overrides; unknown is successful",
        "SettingsModelProbeResponse",
        { request: "SettingsModelTarget", errors: targetErrors },
      ),
    },
    "/v1/settings/mcp/status": {
      get: settingsOperation(
        "Read effective MCP status and tools for this instance",
        "SettingsMcpStatusResponse",
        { instance: true },
      ),
    },
    "/v1/settings/mcp/reconnect": {
      post: settingsOperation(
        "Reconnect this instance MCP servers and return refreshed tools; no request body",
        "SettingsMcpStatusResponse",
        {
          instance: true,
          errors: { "409": "INSTANCE_BUSY: instance has active work" },
        },
      ),
    },
    "/v1/settings/skills": {
      get: settingsOperation(
        "Read skills for this instance",
        "SettingsSkillsResponse",
        { instance: true },
      ),
    },
    "/v1/settings/agents": {
      get: settingsOperation(
        "Read available agents for this instance",
        "SettingsAgentsResponse",
        { instance: true },
      ),
    },
  };

  return {
    info: {
      title: "ohbaby local daemon API",
      version: packageVersion ?? "0.1.12-dev",
    },
    openapi: "3.1.0",
    components: {
      securitySchemes: { daemonBearer: { type: "http", scheme: "bearer" } },
      schemas: {
        ...settingsSchemas,
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
      ...settingsPaths,
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
          summary: "Probe model context window",
          description:
            "An input matching the current connection uses existing discovery and guarded writeback, including active reasoning fallback. A draft or non-current connection only reads metadata and does not save or select it.",
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
