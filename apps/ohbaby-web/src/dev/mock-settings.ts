import type {
  UiReasoningCapabilityView,
  UiSettingsGlobalMcpServer,
  UiSettingsMcpServer,
  UiSettingsModel,
  UiSettingsModelCreate,
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

function entry(
  id: string,
  provider: string,
  model: string,
  extra: Partial<UiSettingsModel> = {},
): UiSettingsModel {
  return {
    id,
    provider,
    model,
    baseUrl: `https://api.${provider}.example/v1`,
    interfaceProvider: "openai-compatible",
    apiKeyEnv: `${provider.toUpperCase().replace(/\W/gu, "_")}_API_KEY`,
    apiKeyConfigured: true,
    configurationComplete: true,
    contextWindowTokens: 128_000,
    reasoning,
    ...extra,
  };
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
      entry("m2", "deepseek", "deepseek-v4.1-pro"),
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
      }),
      entry("m6", "anthropic", "claude-haiku-5-5", {
        interfaceProvider: "anthropic",
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
  defaultWorkspace: DEFAULT_WORKSPACE,
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

/**
 * In-memory settings for `?mock=settings`, `settings-empty` and
 * `settings-errors` (06 §5). The errors scenario rejects model and search
 * saves with field errors and fails the MCP status read.
 */
export function createMockSettingsApi(
  scenario: string,
  delay: () => Promise<void>,
): SettingsApi {
  const state =
    scenario === "settings-empty" || scenario === "fresh"
      ? emptyState()
      : scenario === "no-model"
        ? { ...fullState(), activeId: null, models: [] }
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
    params: { maxTokens: 8192 },
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
  return {
    getModels: () => after(models),
    createModel: (input: UiSettingsModelCreate) =>
      after(() => {
        if (failing || input.model.includes(" "))
          throw validationError(["model"], "Has an invalid format");
        const { apiKey, apiKeyEnv, ...fields } = input;
        state.models = [
          ...state.models,
          complete({
            ...fields,
            id: `m${String(nextId++)}`,
            apiKeyConfigured: apiKey !== undefined && apiKey !== "",
            ...(apiKeyEnv ? { apiKeyEnv } : {}),
            configurationComplete: true,
            contextWindowTokens: input.contextWindowTokens ?? 128_000,
            reasoning,
          }),
        ];
        return models();
      }),
    updateModel: (id, patch) =>
      after(() => {
        if (failing)
          throw validationError(["baseUrl"], "Must be an http or https URL");
        const current = find(id);
        const { apiKey, label, apiKeyEnv, ...fields } = patch;
        const next: UiSettingsModel = complete({
          ...current,
          ...fields,
          ...(apiKeyEnv ? { apiKeyEnv } : {}),
          apiKeyConfigured:
            apiKey === undefined ? current.apiKeyConfigured : apiKey !== "",
        });
        const { label: _label, ...unlabelled } = next;
        state.models = state.models.map((model) =>
          model.id === id
            ? label === null
              ? unlabelled
              : label === undefined
                ? next
                : { ...next, label }
            : model,
        );
        return models();
      }),
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
