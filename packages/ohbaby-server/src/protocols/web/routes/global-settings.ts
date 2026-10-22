import type {
  UiSettingsAboutResponse,
  UiSettingsModelsResponse,
  UiSettingsModelProbeResponse,
  UiSettingsSearchResponse,
  UiSettingsGlobalMcpServersResponse,
  UiSettingsMcpServerUpdateResponse,
  UiSettingsMcpServerDeleteResponse,
} from "ohbaby-sdk";
import type { Hono, Context } from "hono";
import {
  readModelSettings,
  createModelEntry,
  updateModelEntry,
  selectModelEntry,
  probeModelEntry,
  startModelEntryDiscovery,
  deleteModelEntry,
  deleteModelProvider,
  ModelEntryCreateSchema,
  ModelEntryPatchSchema,
  ModelEntrySelectSchema,
  readSearchSettings,
  updateSearchSettings,
  SearchSettingsPatchSchema,
  readGlobalMcpServers,
  updateGlobalMcpServer,
  deleteGlobalMcpServer,
  globalMcpOverriddenIn,
  McpServerPatchSchema,
  resolveOhbabyHome,
  ensureDefaultWorkspaceDirectory,
  getAgentPackageVersion,
  type SettingsDomain,
} from "ohbaby-agent";
import { readJsonWithLimit, webErrorBody } from "../request-helpers.js";

interface GlobalSettingsRoutesContext {
  isAuthorized(header: string | undefined): boolean;
  loadedDirectories(): readonly string[];
  notify(domains: readonly SettingsDomain[]): Promise<void>;
  readonly packageVersion?: string;
  readonly diagnosticsFile?: string;
  readonly logDirectory?: string;
}
export function registerGlobalSettingsRoutes(
  app: Hono,
  ctx: GlobalSettingsRoutesContext,
): void {
  const handle =
    (work: (context: Context) => Promise<Response>) =>
    async (context: Context): Promise<Response> => {
      if (!ctx.isAuthorized(context.req.header("authorization")))
        return context.json(webErrorBody("Unauthorized"), 401);
      try {
        return await work(context);
      } catch (error) {
        const code =
          typeof error === "object" && error !== null && "code" in error
            ? error.code
            : undefined;
        if (code === "MODEL_NOT_FOUND")
          return context.json(
            {
              ok: false,
              error: {
                code: "MODEL_NOT_FOUND",
                message: "Model entry not found",
              },
            },
            404,
          );
        if (code === "MODEL_CONFIG_INCOMPLETE")
          return context.json(
            {
              ok: false,
              error: {
                code: "MODEL_CONFIG_INCOMPLETE",
                message: "Model configuration incomplete",
              },
            },
            400,
          );
        if (code === "MCP_SERVER_NOT_FOUND")
          return context.json(webErrorBody("Global MCP server not found"), 404);
        if (
          code === "VALIDATION_FAILED" ||
          (error instanceof Error && error.name === "ZodError")
        )
          return context.json(webErrorBody("Invalid settings"), 400);
        return context.json(webErrorBody("Unable to access settings"), 500);
      }
    };
  const modelOptions = {
    onDiscovery: (): Promise<void> => ctx.notify(["model"]),
  };
  app.get(
    "/v1/settings/models",
    handle(async (context) =>
      context.json({
        ok: true,
        ...(await readModelSettings()),
      } satisfies UiSettingsModelsResponse),
    ),
  );
  app.post(
    "/v1/settings/models/profiles",
    handle(async (context) => {
      const parsed = await readJsonWithLimit(context.req.raw);
      if (!parsed.ok)
        return context.json(
          webErrorBody(parsed.message),
          parsed.status as 400 | 413,
        );
      const result = await createModelEntry(
        ModelEntryCreateSchema.parse(parsed.value),
        modelOptions,
      );
      await ctx.notify(["model"]);
      return context.json({
        ok: true,
        ...result,
      } satisfies UiSettingsModelsResponse);
    }),
  );
  app.patch(
    "/v1/settings/models/profiles/:id",
    handle(async (context) => {
      const parsed = await readJsonWithLimit(context.req.raw);
      if (!parsed.ok)
        return context.json(
          webErrorBody(parsed.message),
          parsed.status as 400 | 413,
        );
      const result = await updateModelEntry(
        context.req.param("id") ?? "",
        ModelEntryPatchSchema.parse(parsed.value),
        modelOptions,
      );
      await ctx.notify(["model"]);
      return context.json({
        ok: true,
        ...result,
      } satisfies UiSettingsModelsResponse);
    }),
  );
  app.post(
    "/v1/settings/models/active",
    handle(async (context) => {
      const parsed = await readJsonWithLimit(context.req.raw);
      if (!parsed.ok)
        return context.json(
          webErrorBody(parsed.message),
          parsed.status as 400 | 413,
        );
      const { id } = ModelEntrySelectSchema.parse(parsed.value);
      const result = await selectModelEntry(id, modelOptions);
      void startModelEntryDiscovery(id, {
        ...modelOptions,
        allowActiveProbe: true,
      });
      await ctx.notify(["model"]);
      return context.json({
        ok: true,
        ...result,
      } satisfies UiSettingsModelsResponse);
    }),
  );
  app.post(
    "/v1/settings/models/probe",
    handle(async (context) => {
      const parsed = await readJsonWithLimit(context.req.raw);
      if (!parsed.ok)
        return context.json(
          webErrorBody(parsed.message),
          parsed.status as 400 | 413,
        );
      const { id } = ModelEntrySelectSchema.parse(parsed.value);
      return context.json({
        ok: true,
        reasoning: await probeModelEntry(id, modelOptions),
      } satisfies UiSettingsModelProbeResponse);
    }),
  );
  app.delete(
    "/v1/settings/models/profiles/:id",
    handle(async (context) => {
      const result = await deleteModelEntry(
        context.req.param("id") ?? "",
        modelOptions,
      );
      await ctx.notify(["model"]);
      return context.json({
        ok: true,
        ...result,
      } satisfies UiSettingsModelsResponse);
    }),
  );
  app.delete(
    "/v1/settings/models/providers/:providerId",
    handle(async (context) => {
      const result = await deleteModelProvider(
        context.req.param("providerId") ?? "",
        modelOptions,
      );
      await ctx.notify(["model"]);
      return context.json({
        ok: true,
        ...result,
      } satisfies UiSettingsModelsResponse);
    }),
  );
  app.get(
    "/v1/settings/about",
    handle(async (context) =>
      context.json({
        ok: true,
        version: ctx.packageVersion ?? getAgentPackageVersion(),
        ohbabyHome: resolveOhbabyHome(),
        defaultWorkspace: await ensureDefaultWorkspaceDirectory(),
        ...(ctx.diagnosticsFile
          ? { diagnosticsFile: ctx.diagnosticsFile }
          : {}),
        ...(ctx.logDirectory ? { logDirectory: ctx.logDirectory } : {}),
      } satisfies UiSettingsAboutResponse),
    ),
  );
  app.get(
    "/v1/settings/search",
    handle(async (context) =>
      context.json({
        ok: true,
        ...(await readSearchSettings()),
      } satisfies UiSettingsSearchResponse),
    ),
  );
  app.put(
    "/v1/settings/search",
    handle(async (context) => {
      const parsed = await readJsonWithLimit(context.req.raw);
      if (!parsed.ok)
        return context.json(
          webErrorBody(parsed.message),
          parsed.status as 400 | 413,
        );
      const patch = SearchSettingsPatchSchema.parse(parsed.value);
      const settings = await updateSearchSettings(patch);
      await ctx.notify(["search"]);
      return context.json({
        ok: true,
        ...settings,
      } satisfies UiSettingsSearchResponse);
    }),
  );
  app.get(
    "/v1/settings/mcp/servers",
    handle(async (context) =>
      context.json({
        ok: true,
        servers: await readGlobalMcpServers(),
      } satisfies UiSettingsGlobalMcpServersResponse),
    ),
  );
  app.put(
    "/v1/settings/mcp/servers/:name",
    handle(async (context) => {
      const parsed = await readJsonWithLimit(context.req.raw);
      if (!parsed.ok)
        return context.json(
          webErrorBody(parsed.message),
          parsed.status as 400 | 413,
        );
      const patch = McpServerPatchSchema.parse(parsed.value);
      const name = context.req.param("name") ?? "";
      const server = await updateGlobalMcpServer(name, patch);
      const overriddenIn = await globalMcpOverriddenIn(
        name,
        ctx.loadedDirectories(),
      );
      await ctx.notify(["mcp"]);
      return context.json({
        ok: true,
        ...server,
        overriddenIn,
      } satisfies UiSettingsMcpServerUpdateResponse);
    }),
  );
  app.delete(
    "/v1/settings/mcp/servers/:name",
    handle(async (context) => {
      await deleteGlobalMcpServer(context.req.param("name") ?? "");
      await ctx.notify(["mcp"]);
      return context.json({
        ok: true,
      } satisfies UiSettingsMcpServerDeleteResponse);
    }),
  );
}
