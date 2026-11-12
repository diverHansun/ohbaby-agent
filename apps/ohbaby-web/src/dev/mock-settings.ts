import type {
  UiReasoningCapabilityView,
  UiSettingsChangedEvent,
  UiSettingsGlobalMcpServer,
  UiSettingsMcpServer,
  UiSettingsModel,
  UiSettingsModelCreate,
  UiSettingsModelPatch,
  UiSettingsModels,
  UiSettingsSearch,
  UiSettingsSkill,
} from "ohbaby-sdk";
import type {
  SettingsAbout,
  SettingsApi,
} from "../api/daemon/settings-client.js";
import { DEFAULT_WORKSPACE } from "./mock-scenarios.js";

const reasoning: UiReasoningCapabilityView = {
  status: "unknown",
  efforts: [],
  reason: "Not probed in the mock",
};

/** What a successful detection reports; the mock's thinking models use it. */
const effortReasoning: UiReasoningCapabilityView = {
  status: "identified",
  mode: "effort",
  efforts: ["low", "medium", "high"],
  supportsDisabled: true,
  default: { enabled: true, effort: "medium" },
};

/**
 * Mock-only stand-ins for the server's runtime defaults and a detected
 * context. The page never computes these; it reads `effective*` fields.
 */
const MOCK_DEFAULT_CONTEXT = 300_000;
const MOCK_DEFAULT_MAX_OUTPUT = 32_768;
const MOCK_SAFETY_MARGIN = 1_024;
const MOCK_DETECTED_CONTEXT = 128_000;

/** The server's numeric projection: overrides, detection, effective values. */
function withLimits(model: UiSettingsModel): UiSettingsModel {
  const {
    tokenBudgetIssue: _issue,
    effectiveContextWindowTokens: _context,
    effectiveMaxOutputTokens: _max,
    ...rest
  } = model;
  const contextWindowTokens =
    model.contextWindowTokens ??
    model.detectedContextWindowTokens ??
    MOCK_DEFAULT_CONTEXT;
  const maxOutputTokens = model.maxOutputTokens ?? MOCK_DEFAULT_MAX_OUTPUT;
  return {
    ...rest,
    effectiveContextWindowTokens: contextWindowTokens,
    effectiveMaxOutputTokens: maxOutputTokens,
    ...(contextWindowTokens > maxOutputTokens + MOCK_SAFETY_MARGIN
      ? {}
      : {
          tokenBudgetIssue: {
            code: "MODEL_TOKEN_LIMITS_INCOMPATIBLE",
            contextWindowTokens,
            maxOutputTokens,
          },
        }),
  };
}

function entry(
  id: string,
  provider: string,
  model: string,
  extra: Partial<UiSettingsModel> = {},
): UiSettingsModel {
  return withLimits({
    id,
    provider,
    model,
    baseUrl: `https://api.${provider}.example/v1`,
    interfaceProvider: "openai-compatible",
    apiKeyEnv: `${provider.toUpperCase().replace(/\W/gu, "_")}_API_KEY`,
    apiKeyConfigured: true,
    configurationComplete: true,
    detectedContextWindowTokens: MOCK_DETECTED_CONTEXT,
    effectiveContextWindowTokens: MOCK_DETECTED_CONTEXT,
    effectiveMaxOutputTokens: MOCK_DEFAULT_MAX_OUTPUT,
    contextDiscovery: { status: "identified" },
    reasoning,
    ...extra,
  });
}

interface MockSettingsState {
  models: UiSettingsModel[];
  activeId: string | null;
  search: UiSettingsSearch;
  mcpServers: UiSettingsGlobalMcpServer[];
  mcpStatus: UiSettingsMcpServer[];
  skills: UiSettingsSkill[];
}

const DEFAULT_SEARCH: UiSettingsSearch = {
  provider: "tavily",
  apiKeyEnv: null,
  apiKeyConfigured: false,
  defaults: {
    searchDepth: "basic",
    maxResults: 5,
    topic: "general",
    timeout: 60,
  },
};

function fullState(): MockSettingsState {
  return {
    models: [
      entry("m1", "deepseek", "deepseek-v4.1-flash", { label: "Work" }),
      entry("m2", "deepseek", "deepseek-v4.1-pro", {
        reasoning: effortReasoning,
        reasoningDefault: { enabled: true, effort: "high" },
      }),
      entry("m3", "openai", "gpt-5.2", {
        interfaceProvider: "openai-responses",
        maxOutputTokens: 32_000,
      }),
      entry("m4", "openai", "gpt-4.1", {
        configurationComplete: false,
        apiKeyConfigured: false,
        baseUrl: undefined,
        interfaceProvider: undefined,
        apiKeyEnv: undefined,
      }),
      entry("m5", "anthropic", "claude-sonnet-5-5", {
        interfaceProvider: "anthropic",
        label: "Personal",
        promptCache: "auto",
        reasoning: effortReasoning,
      }),
      entry("m6", "anthropic", "claude-haiku-5-5", {
        interfaceProvider: "anthropic",
        reasoningNotice: "unsupported-anthropic-effort-cleared",
      }),
    ],
    activeId: "m1",
    search: {
      ...DEFAULT_SEARCH,
      apiKeyEnv: "TAVILY_API_KEY",
      apiKeyConfigured: true,
    },
    mcpServers: [
      {
        name: "github",
        transport: "stdio",
        enabled: true,
        trust: false,
        timeout: 10_000,
        command: "npx",
        args: ["-y", "@modelcontextprotocol/server-github"],
        envKeys: ["GITHUB_TOKEN"],
        headerKeys: [],
      },
      {
        name: "filesystem",
        transport: "stdio",
        enabled: true,
        trust: true,
        timeout: 10_000,
        command: "mcp-filesystem",
        args: ["--root", "/Users/demo"],
        cwd: "/Users/demo",
        excludeTools: ["delete_file"],
        envKeys: [],
        headerKeys: [],
      },
      {
        name: "docs-search",
        transport: "http_streamable",
        enabled: false,
        trust: false,
        timeout: 15_000,
        url: "https://mcp.example.com/•••",
        envKeys: [],
        headerKeys: ["Authorization"],
      },
    ],
    mcpStatus: [
      {
        name: "github",
        origin: "global",
        enabled: true,
        status: "connected",
        toolCount: 3,
        tools: [
          {
            name: "github__search_issues",
            mcpToolName: "search_issues",
            description: "Search issues and pull requests.",
          },
          {
            name: "github__get_file",
            mcpToolName: "get_file_contents",
            description: "Read a file from a repository.",
          },
          {
            name: "github__create_issue",
            mcpToolName: "create_issue",
            description: "Open a new issue.",
          },
        ],
      },
      {
        name: "filesystem",
        origin: "global",
        enabled: true,
        status: "failed",
        error: "spawn mcp-filesystem ENOENT",
        toolCount: 0,
        tools: [],
      },
    ],
    skills: [
      {
        name: "humanizer",
        description: "Rewrite replies in plain, natural language.",
        source: "user-native",
        scope: "user",
        location: "/Users/demo/.ohbaby/skills/humanizer/SKILL.md",
        userInvocable: true,
        modelInvocable: true,
      },
      {
        name: "code-review",
        description: "Review a diff against the repository conventions.",
        source: "claude-compatible",
        scope: "user",
        location: "/Users/demo/.claude/skills/code-review/SKILL.md",
        userInvocable: true,
        modelInvocable: true,
      },
      {
        name: "project-only",
        description: "Shown only in its project; filtered from Settings.",
        source: "project-native",
        scope: "project",
        location:
          "/Users/demo/Projects/ohbaby-agent/.ohbaby/skills/project-only/SKILL.md",
        userInvocable: true,
        modelInvocable: false,
      },
    ],
  };
}

/** Enough providers and models that the composer menu scrolls (04 T19c). */
function manyState(): MockSettingsState {
  const providers = ["deepseek", "openai", "anthropic", "zenmux", "moonshot"];
  return {
    ...fullState(),
    models: providers.flatMap((provider, p) =>
      ["mini", "standard", "pro", "max"].map((size, i) =>
        entry(
          `${provider}-${size}`,
          provider,
          `${provider}-${size}-${String(p + i)}`,
        ),
      ),
    ),
    activeId: "anthropic-pro",
  };
}

/** An old history entry with a URL and protocol but no key reference, and no default. */
function legacyState(): MockSettingsState {
  return {
    ...emptyState(),
    models: [
      entry("legacy", "zenmux", "anthropic/claude-sonnet-5", {
        interfaceProvider: "anthropic",
        apiKeyEnv: undefined,
        apiKeyConfigured: false,
        configurationComplete: false,
      }),
    ],
  };
}

function emptyState(): MockSettingsState {
  return {
    models: [],
    activeId: null,
    search: DEFAULT_SEARCH,
    mcpServers: [],
    mcpStatus: [],
    skills: [],
  };
}

const ABOUT: SettingsAbout = {
  version: "0.1.16",
  ohbabyHome: "/Users/demo/.ohbaby",
  defaultDirectory: DEFAULT_WORKSPACE,
  diagnosticsFile: "/Users/demo/.ohbaby/logs/daemon/log.jsonl",
  logDirectory: "/Users/demo/.ohbaby/logs/daemon",
};

function validationError(path: (string | number)[], message: string): Error {
  return Object.assign(new Error("Invalid settings"), {
    code: "VALIDATION_FAILED",
    status: 400,
    fields: [{ path, message }],
  });
}

function notFound(): Error {
  return Object.assign(new Error("Model entry not found"), {
    code: "MODEL_NOT_FOUND",
    status: 404,
  });
}

type NumericPatch = Pick<
  UiSettingsModelPatch,
  "contextWindowTokens" | "maxOutputTokens"
>;

/** A Patch number sets an override; `null` removes it (back to automatic). */
function applyOverrides(
  model: UiSettingsModel,
  patch: NumericPatch,
): UiSettingsModel {
  let next = model;
  for (const field of ["contextWindowTokens", "maxOutputTokens"] as const) {
    const value = patch[field];
    if (value === undefined) continue;
    const { [field]: _removed, ...rest } = next;
    next = value === null ? rest : { ...rest, [field]: value };
  }
  return next;
}

export interface MockSettingsEvents {
  /** Stands in for `settings.changed`, sent as background detection moves. */
  readonly notify?: (domains: UiSettingsChangedEvent["domains"]) => void;
  /** How long one background detection takes; defaults to `delay`. */
  readonly detection?: () => Promise<void>;
}

/**
 * In-memory settings for `?mock=settings`, `settings-empty` and
 * `settings-errors` (06 §5). The errors scenario rejects model and search
 * saves with field errors and fails the MCP status read. Like the server,
 * a save returns at once and detection finishes in the background; a newer
 * detection of the same entry replaces an older one.
 */
export function createMockSettingsApi(
  scenario: string,
  delay: () => Promise<void>,
  events: MockSettingsEvents = {},
): SettingsApi {
  const state =
    scenario === "settings-empty" || scenario === "fresh"
      ? emptyState()
      : scenario === "settings-legacy"
        ? legacyState()
        : scenario === "no-model"
          ? { ...fullState(), activeId: null, models: [] }
          : scenario === "models-many"
            ? manyState()
            : fullState();
  const failing = scenario === "settings-errors";
  let nextId = 100;
  const models = (): UiSettingsModels => ({
    active: ((): UiSettingsModels["active"] => {
      const active = state.models.find((model) => model.id === state.activeId);
      return active
        ? { id: active.id, provider: active.provider, model: active.model }
        : null;
    })(),

    models: state.models,
  });
  const find = (id: string): UiSettingsModel => {
    const model = state.models.find((candidate) => candidate.id === id);
    if (!model) throw notFound();
    return model;
  };
  const after = async <T>(work: () => T): Promise<T> => {
    await delay();
    return work();
  };
  const complete = (model: UiSettingsModel): UiSettingsModel => ({
    ...model,
    configurationComplete:
      model.baseUrl !== undefined && model.interfaceProvider !== undefined,
  });
  const nextDefault = (): void => {
    if (state.models.some((model) => model.id === state.activeId)) return;
    state.activeId =
      state.models.find((model) => model.configurationComplete)?.id ?? null;
  };
  const replace = (
    id: string,
    change: (model: UiSettingsModel) => UiSettingsModel,
  ): void => {
    state.models = state.models.map((model) =>
      model.id === id ? withLimits(change(model)) : model,
    );
  };
  const notify = events.notify ?? ((): void => undefined);
  const detection = events.detection ?? delay;
  const detections = new Map<string, number>();
  /** Marks both stages detecting, then settles them unless replaced. */
  const detect = async (id: string): Promise<void> => {
    const run = (detections.get(id) ?? 0) + 1;
    detections.set(id, run);
    replace(id, (model) => ({
      ...model,
      contextDiscovery: { status: "detecting" },
      // Levels already found stay usable while detection runs again.
      reasoning:
        model.reasoning.mode === undefined
          ? { status: "detecting", efforts: [] }
          : { ...model.reasoning, status: "detecting" },
    }));
    notify(["model"]);
    await detection();
    if (detections.get(id) !== run || !state.models.some((m) => m.id === id))
      return;
    replace(id, (model) => ({
      ...model,
      detectedContextWindowTokens: MOCK_DETECTED_CONTEXT,
      contextDiscovery: { status: "identified" },
      reasoning: effortReasoning,
    }));
    notify(["model"]);
  };
  return {
    getModels: () => after(models),
    createModel: (input: UiSettingsModelCreate) =>
      after(() => {
        if (failing || input.model.includes(" "))
          throw validationError(["model"], "Has an invalid format");
        const {
          apiKey,
          apiKeyEnv,
          reasoning: reasoningDefault,
          ...fields
        } = input;
        const id = `m${String(nextId++)}`;
        state.models = [
          ...state.models,
          withLimits(
            complete({
              ...fields,
              id,
              apiKeyConfigured: apiKey !== undefined && apiKey !== "",
              ...(apiKeyEnv ? { apiKeyEnv } : {}),
              configurationComplete: true,
              // As the server: no override and no detection yet.
              effectiveContextWindowTokens: MOCK_DEFAULT_CONTEXT,
              effectiveMaxOutputTokens: MOCK_DEFAULT_MAX_OUTPUT,
              contextDiscovery: { status: "unknown" },
              reasoning,
              ...(reasoningDefault === undefined ? {} : { reasoningDefault }),
            }),
          ),
        ];
        nextDefault();
        void detect(id);
        return models();
      }),
    updateModel: (id, patch) =>
      after(() => {
        if (failing)
          throw validationError(["baseUrl"], "Must be an http or https URL");
        const current = find(id);
        const {
          apiKey,
          label,
          apiKeyEnv,
          reasoning: reasoningDefault,
          contextWindowTokens,
          maxOutputTokens,
          ...fields
        } = patch;
        // A new route drops what was detected for the old one (02 §3.1).
        const routeChanged = (
          ["provider", "model", "baseUrl", "interfaceProvider"] as const
        ).some(
          (field) =>
            fields[field] !== undefined && fields[field] !== current[field],
        );
        const keyChanged = apiKey !== undefined || apiKeyEnv !== undefined;
        const { detectedContextWindowTokens: _detected, ...undetected } =
          current;
        const base: UiSettingsModel = routeChanged
          ? {
              ...undetected,
              contextDiscovery: { status: "unknown" },
              reasoning,
            }
          : keyChanged
            ? { ...current, reasoning }
            : current;
        const merged: UiSettingsModel = {
          ...applyOverrides(base, { contextWindowTokens, maxOutputTokens }),
          ...fields,
          ...(reasoningDefault === undefined
            ? {}
            : {
                reasoningDefault: reasoningDefault ?? undefined,
                reasoningNotice: undefined,
              }),
          ...(apiKeyEnv ? { apiKeyEnv } : {}),
          apiKeyConfigured:
            apiKey === undefined ? current.apiKeyConfigured : apiKey !== "",
        };
        // As the server: a legacy entry finishes setup only with an explicit
        // credential choice (a key, a variable, or apiKeyEnv: null).
        const next: UiSettingsModel = current.configurationComplete
          ? complete(merged)
          : {
              ...merged,
              configurationComplete:
                complete(merged).configurationComplete &&
                (apiKeyEnv !== undefined ||
                  apiKey !== undefined ||
                  current.apiKeyEnv !== undefined),
            };
        const { label: _label, ...unlabelled } = next;
        replace(id, () =>
          label === null
            ? unlabelled
            : label === undefined
              ? next
              : { ...next, label },
        );
        nextDefault();
        if (
          next.configurationComplete &&
          (routeChanged ||
            keyChanged ||
            next.contextDiscovery.status === "unknown" ||
            next.reasoning.status === "unknown")
        )
          void detect(id);
        return models();
      }),
    probeModel: async (id): Promise<UiReasoningCapabilityView> => {
      await delay();
      // As if the provider answered: the mock settles on effort levels.
      find(id);
      await detect(id);
      return find(id).reasoning;
    },
    selectModel: (id) =>
      after(() => {
        const model = find(id);
        if (!model.configurationComplete)
          throw Object.assign(new Error("Model configuration incomplete"), {
            code: "MODEL_CONFIG_INCOMPLETE",
            status: 400,
          });
        state.activeId = id;
        return models();
      }),
    deleteModel: (id) =>
      after(() => {
        find(id);
        state.models = state.models.filter((model) => model.id !== id);
        nextDefault();
        return models();
      }),
    deleteProvider: (provider) =>
      after(() => {
        state.models = state.models.filter(
          (model) => model.provider !== provider,
        );
        nextDefault();
        return models();
      }),
    getSearch: () => after(() => state.search),
    updateSearch: (patch) =>
      after(() => {
        if (failing)
          throw validationError(["defaults", "timeout"], "Must be at most 600");
        const { apiKey, baseUrl, defaults, ...fields } = patch;
        const { baseUrl: _baseUrl, ...rest } = state.search;
        state.search = {
          ...(baseUrl === null ? rest : state.search),
          ...fields,
          ...(typeof baseUrl === "string" ? { baseUrl } : {}),
          apiKeyEnv:
            apiKey === undefined || apiKey === ""
              ? apiKey === ""
                ? null
                : (fields.apiKeyEnv ?? state.search.apiKeyEnv)
              : (fields.apiKeyEnv ??
                state.search.apiKeyEnv ??
                "TAVILY_API_KEY"),
          apiKeyConfigured:
            apiKey === undefined
              ? state.search.apiKeyConfigured
              : apiKey !== "",
          defaults: { ...state.search.defaults, ...defaults },
        };
        return state.search;
      }),
    getMcpServers: () => after(() => state.mcpServers),
    getAbout: () => after(() => ABOUT),
    getMcpStatus: () =>
      after(() => {
        if (failing) throw new Error("Settings reads are unavailable");
        return state.mcpStatus;
      }),
    getSkills: () => after(() => state.skills),
  };
}
