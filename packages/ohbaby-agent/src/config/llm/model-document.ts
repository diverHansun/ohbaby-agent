import { createHash } from "node:crypto";
import { inferConnectModelInterfaceProvider } from "ohbaby-sdk";
import {
  activeModelBudgetProfiles,
  capabilitiesFor,
  resolveRequestReasoning,
  type ReasoningConfig,
  ConfigError,
  validateModelJson,
  type InterfaceProviderKind,
  type ModelJsonConfig,
  type ModelJsonModelProfile,
  type PromptCachePolicy,
} from "ohbaby-llm";
import { loadModelJson } from "./loaders.js";

export const DEFAULT_CONTEXT_WINDOW_TOKENS = 128_000;
export interface ModelEntry extends ModelJsonModelProfile {
  id: string;
  provider: string;
  apiKeyEnv?: string;
  promptCache?: PromptCachePolicy;
  needsConfiguration?: boolean;
  reasoning?: ReasoningConfig;
  temperature?: number;
}
export interface ModelDocument {
  activeProfileId?: string;
  models: ModelEntry[];
}
export function configurationComplete(
  entry: ModelEntry,
): entry is ModelEntry & {
  baseUrl: string;
  interfaceProvider: InterfaceProviderKind;
} {
  return (
    !entry.needsConfiguration &&
    Boolean(entry.baseUrl && entry.interfaceProvider)
  );
}
export function projectModelDocument(
  document: ModelDocument,
  entryId?: string,
): ModelJsonConfig | null {
  const active = document.models.find(
    (entry) => entry.id === (entryId ?? document.activeProfileId),
  );
  if (!active || !configurationComplete(active)) return null;
  const {
    apiKeyEnv: _key,
    promptCache: _cache,
    needsConfiguration: _needs,
    ...profile
  } = active;
  const projected = {
    provider: active.provider,
    defaultModel: active.model,
    apiConfig: {
      baseUrl: active.baseUrl,
      interfaceProvider: active.interfaceProvider,
      ...(active.apiKeyEnv === undefined
        ? {}
        : { apiKeyEnv: active.apiKeyEnv }),
      ...(active.promptCache === undefined
        ? {}
        : { promptCache: active.promptCache }),
    },
    llmParams: {
      maxTokens: active.maxOutputTokens ?? 8192,
      ...(active.temperature === undefined
        ? {}
        : { temperature: active.temperature }),
      ...(active.reasoning === undefined
        ? {}
        : { reasoning: active.reasoning }),
      contextWindowTokens: active.contextWindowTokens,
    },
    models: [profile],
  };
  validateModelJson(projected);
  return projected;
}
/** Disk ownership stays in agent; LLM consumers see exactly one independent profile. */
export function normalizeModelDocument(raw: unknown): ModelDocument {
  if (!raw || typeof raw !== "object" || Array.isArray(raw))
    throw new ConfigError("Invalid model document", "INVALID_FIELD");
  const source = structuredClone(raw) as Partial<
    Omit<ModelDocument, "models">
  > & {
    provider?: string;
    defaultModel?: string;
    apiConfig?: ModelJsonConfig["apiConfig"];
    llmParams?: ModelJsonConfig["llmParams"];
    models?: (ModelJsonModelProfile & {
      apiKeyEnv?: string;
      promptCache?: PromptCachePolicy;
      needsConfiguration?: boolean;
      reasoning?: ReasoningConfig;
      temperature?: number;
    })[];
  };
  if (
    source.activeProfileId !== undefined &&
    (typeof source.activeProfileId !== "string" ||
      !source.activeProfileId.trim())
  )
    throw new ConfigError("Invalid active model id", "INVALID_FIELD");
  const legacy =
    !Object.hasOwn(source, "activeProfileId") &&
    source.provider !== undefined &&
    source.defaultModel !== undefined &&
    source.apiConfig !== undefined;
  if (
    legacy ||
    (!Object.hasOwn(source, "activeProfileId") && source.models === undefined)
  )
    validateModelJson(source);
  if (source.models !== undefined && !Array.isArray(source.models))
    throw new ConfigError("Invalid models", "INVALID_FIELD");
  const reserved = new Set(
    (source.models ?? [])
      .map((entry) => entry.id)
      .filter((id) => typeof id === "string" && id.trim() !== ""),
  );
  const used = new Set<string>();
  const models = (source.models ?? []).map((profile, index): ModelEntry => {
    if (typeof profile !== "object")
      throw new ConfigError("Invalid model entry", "INVALID_FIELD");
    let id = profile.id;
    if (typeof id !== "string" || !id.trim() || used.has(id)) {
      const digest = createHash("sha256")
        .update(
          JSON.stringify([
            index,
            profile.provider,
            profile.model,
            profile.baseUrl,
            profile.interfaceProvider,
          ]),
        )
        .digest("hex")
        .slice(0, 16);
      id = `profile-${digest}`;
      while (reserved.has(id) || used.has(id)) id += "-m";
    }
    used.add(id);
    const entry: ModelEntry = {
      ...profile,
      id,
      provider: profile.provider ?? source.provider ?? "custom",
    };
    if (
      legacy &&
      (profile.apiKeyEnv === undefined ||
        !profile.baseUrl ||
        !profile.interfaceProvider ||
        !profile.provider)
    )
      entry.needsConfiguration = true;
    validateEntry(entry);
    return entry;
  });
  const document: ModelDocument = {
    ...(source.activeProfileId === undefined
      ? {}
      : { activeProfileId: source.activeProfileId }),
    models,
  };
  if (legacy) {
    const api = source.apiConfig;
    if (
      !api ||
      source.provider === undefined ||
      source.defaultModel === undefined
    )
      throw new ConfigError(
        "Incomplete legacy model document",
        "MISSING_FIELD",
      );
    const options = {
      provider: source.provider,
      model: source.defaultModel,
      baseUrl: api.baseUrl,
      interfaceProvider:
        api.interfaceProvider ??
        inferConnectModelInterfaceProvider(api.baseUrl),
      maxTokens: source.llmParams?.maxTokens ?? 8192,
      modelProfiles: [
        ...(source.llmParams?.contextWindowTokens === undefined
          ? []
          : [
              {
                model: source.defaultModel,
                provider: source.provider,
                contextWindowTokens: source.llmParams.contextWindowTokens,
              },
            ]),
        ...(source.models ?? []).map((profile, index) => ({
          ...profile,
          id: models[index].id,
        })),
      ],
    };
    const budget = activeModelBudgetProfiles(options).at(0);
    const effective = capabilitiesFor(options);
    let active = models.find((entry) => entry.id === budget?.id);
    if (!active) {
      let id = `profile-${createHash("sha256")
        .update(
          JSON.stringify([
            options.provider,
            options.model,
            options.baseUrl,
            options.interfaceProvider,
          ]),
        )
        .digest("hex")
        .slice(0, 16)}`;
      while (used.has(id)) id += "-m";
      active = {
        id,
        provider: options.provider,
        model: options.model,
        contextWindowTokens:
          budget?.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
      };
      models.push(active);
    }
    Object.assign(active, {
      baseUrl: api.baseUrl,
      interfaceProvider: options.interfaceProvider,
      contextWindowTokens:
        budget?.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
    });
    if (api.apiKeyEnv !== undefined) active.apiKeyEnv = api.apiKeyEnv;
    else delete active.apiKeyEnv;
    if (api.promptCache !== undefined) active.promptCache = api.promptCache;
    delete active.needsConfiguration;
    if (effective.capability && !effective.source.startsWith("builtin:")) {
      active.reasoningCapabilities = effective.capability;
      if (
        effective.source === "model-metadata" ||
        effective.source === "active-probe"
      )
        active.reasoningCapabilitySource = effective.source;
      else delete active.reasoningCapabilitySource;
    }
    document.activeProfileId = active.id;
  }
  for (const entry of models) {
    if (
      entry.maxOutputTokens === undefined &&
      source.llmParams?.maxTokens !== undefined
    )
      entry.maxOutputTokens = source.llmParams.maxTokens;
    if (entry.id === document.activeProfileId) {
      entry.temperature ??= source.llmParams?.temperature;
      if (
        entry.reasoning === undefined &&
        source.llmParams?.reasoning !== undefined
      ) {
        const config = {
          ...entry,
          baseUrl: entry.baseUrl ?? "",
          interfaceProvider:
            entry.interfaceProvider ?? ("openai-compatible" as const),
          maxTokens: entry.maxOutputTokens ?? 8192,
          modelProfiles: [entry],
          reasoning: source.llmParams.reasoning,
        };
        try {
          // Existing entry limits win over the legacy global output ceiling.
          // Validate the migrated preference against that effective budget.
          resolveRequestReasoning(config);
          entry.reasoning = source.llmParams.reasoning;
        } catch (error) {
          if (!(error instanceof ConfigError)) throw error;
        }
      }
    }
    validateEntry(entry);
  }
  validateModelJson({
    provider: "document-validation",
    defaultModel: "document-validation",
    apiConfig: { baseUrl: "http://localhost" },
    llmParams: {
      ...source.llmParams,
      maxTokens: source.llmParams?.maxTokens ?? 8192,
    },
  });
  projectModelDocument(document);
  return document;
}
function validateEntry(entry: ModelEntry): void {
  if (
    entry.apiKeyEnv !== undefined &&
    (typeof entry.apiKeyEnv !== "string" ||
      !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(entry.apiKeyEnv))
  )
    throw new ConfigError("Invalid API key env", "INVALID_FIELD");
  if (
    entry.needsConfiguration !== undefined &&
    typeof entry.needsConfiguration !== "boolean"
  )
    throw new ConfigError("Invalid configuration marker", "INVALID_FIELD");
  // Reuse the upstream schema for fields it owns, including incomplete historical profiles.
  validateModelJson({
    provider: entry.provider,
    defaultModel: entry.model,
    apiConfig: {
      baseUrl: entry.baseUrl ?? "http://localhost",
      interfaceProvider: entry.interfaceProvider,
      promptCache: entry.promptCache,
    },
    llmParams: {
      maxTokens: entry.maxOutputTokens ?? 8192,
      temperature: entry.temperature,
      reasoning: entry.reasoning,
    },
    models: [entry],
  });
}
export async function readModelDocument(
  options: { modelJsonPath?: string } = {},
): Promise<ModelDocument> {
  try {
    return normalizeModelDocument(await loadModelJson(options));
  } catch (error) {
    if (error instanceof ConfigError && error.code === "FILE_NOT_FOUND")
      return { models: [] };
    throw error;
  }
}
export async function loadProjectedModelJson(
  options: { modelJsonPath?: string } = {},
  entryId?: string,
): Promise<ModelJsonConfig> {
  const projected = projectModelDocument(
    await readModelDocument(options),
    entryId,
  );
  if (!projected)
    throw new ConfigError("No active model configured", "FILE_NOT_FOUND");
  return projected;
}

export class ModelSettingsError extends Error {
  constructor(readonly code: "MODEL_NOT_FOUND" | "MODEL_CONFIG_INCOMPLETE") {
    super(
      code === "MODEL_NOT_FOUND"
        ? "Model entry not found"
        : "Model configuration incomplete",
    );
  }
}

/** Missing explicit entries fall back, but incomplete entries must be repaired. */
export function resolveModelEntry(
  document: ModelDocument,
  modelEntryId?: string,
): {
  entry: ModelEntry;
  source: "explicit" | "default";
  removedEntryId?: string;
} {
  const explicit =
    modelEntryId === undefined
      ? undefined
      : document.models.find((entry) => entry.id === modelEntryId);
  const entry =
    explicit ??
    document.models.find((entry) => entry.id === document.activeProfileId);
  if (!entry)
    throw new ConfigError("No active model configured", "FILE_NOT_FOUND");
  if (!configurationComplete(entry))
    throw new ModelSettingsError("MODEL_CONFIG_INCOMPLETE");
  return {
    entry,
    source: explicit ? "explicit" : "default",
    ...(modelEntryId !== undefined && !explicit
      ? { removedEntryId: modelEntryId }
      : {}),
  };
}
