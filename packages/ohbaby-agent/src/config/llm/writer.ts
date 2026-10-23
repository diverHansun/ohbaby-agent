import { LLMConfigManager } from "./manager.js";
import { startModelEntryDiscovery } from "./apply-active-model-config.js";
import * as fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { resolve, dirname, join } from "node:path";
import { z } from "zod";
import {
  capabilitiesFor,
  compatibleReasoningPreference,
  modelProfileRouteKey,
  normalizedEndpoint,
  validateReasoningConfig,
  type InterfaceProviderKind,
  type ModelJsonConfig,
  type PromptCachePolicy,
  type ReasoningConfig,
  type ReasoningCapabilities,
} from "ohbaby-llm";
import type {
  UiReasoningCapabilityView,
  UiSettingsModelCreate,
  UiSettingsModelPatch,
  UiSettingsModels,
} from "ohbaby-sdk";
import { DEFAULT_MAX_OUTPUT_TOKENS } from "../../services/llm-model/modelProfiles.js";
import { reasoningCapabilityView } from "../../services/llm-model/reasoning-view.js";
import {
  runtimeEnvValue,
  setManagedRuntimeEnv,
} from "../../utils/managed-runtime-env.js";
import {
  coordinateModelConfig,
  markModelConfigConsistent,
  markModelConfigInconsistent,
  readOptionalConfigFile,
} from "./config-coordination.js";
import { getModelJsonPath, loadEnvFile } from "./loaders.js";
import { writeFileAtomically } from "../secrets/atomic-file.js";
import { writeEnvSecret } from "../secrets/env-secrets.js";
import { collectCredentialReferences } from "../secrets/references.js";
import { redactSettingsUrl } from "../secrets/redaction.js";
import { getGlobalEnvPath } from "../../utils/project-env.js";
import { firstNonEmptyApiKey } from "./api-key.js";
import { loadSearchJson } from "../tools/search/loaders.js";
import { validateSearchJson } from "../tools/search/validation.js";
import {
  configurationComplete,
  DEFAULT_CONTEXT_WINDOW_TOKENS,
  normalizeModelDocument,
  readModelDocument,
  synchronizeModelSnapshot,
  type ModelDocument,
  type ModelEntry,
} from "./model-document.js";
const DEFAULT_INTERFACE_PROVIDER: InterfaceProviderKind = "openai-compatible";

export interface SetActiveLLMConfigInput {
  readonly provider: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKeyEnv?: string;
  readonly apiKey?: string;
  readonly interfaceProvider?: InterfaceProviderKind;
  readonly promptCache?: PromptCachePolicy;
  readonly temperature?: number;
  readonly clearTemperature?: boolean;
  readonly reasoning?: ReasoningConfig;
  readonly clearReasoning?: boolean;
  readonly discoveredReasoningCapabilities?: ReasoningCapabilities;
  readonly discoveredReasoningCapabilitySource?:
    | "model-metadata"
    | "active-probe";
  readonly clearDiscoveredReasoning?: boolean;
  readonly maxTokens?: number;
  readonly contextWindowTokens?: number;
  readonly clearContextWindowTokens?: boolean;
  readonly clearActiveModelProfile?: boolean;
  readonly maxOutputTokens?: number;
  readonly updateActiveModelProfile?: boolean;
  readonly modelJsonPath?: string;
  readonly envPath?: string;
}

export interface SetActiveLLMConfigResult {
  /** Internal identity captured in the same publication as the saved entry. */
  readonly profileId: string;
  readonly provider: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKeyEnv?: string;
  readonly interfaceProvider: InterfaceProviderKind;
  readonly promptCache: PromptCachePolicy;
  readonly modelJsonPath: string;
  readonly envPath?: string;
}

function buildLLMParams(
  input: SetActiveLLMConfigInput,
  existing: ModelDocument | undefined,
): ModelJsonConfig["llmParams"] {
  const existingParams = existing?.llmParams;
  const contextWindowTokens = input.clearContextWindowTokens
    ? undefined
    : (input.contextWindowTokens ?? existingParams?.contextWindowTokens);
  const temperature = input.clearTemperature
    ? undefined
    : (input.temperature ?? existingParams?.temperature);
  const reasoning = input.clearReasoning
    ? undefined
    : existingParams?.reasoning === undefined && input.reasoning === undefined
      ? undefined
      : {
          ...existingParams?.reasoning,
          ...Object.fromEntries(
            Object.entries(input.reasoning ?? {}).filter(
              ([, value]) => value !== undefined,
            ),
          ),
        };
  return {
    ...(temperature === undefined ? {} : { temperature }),
    ...(reasoning === undefined ? {} : { reasoning }),
    maxTokens:
      input.maxTokens ?? existingParams?.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
    ...(contextWindowTokens === undefined
      ? {}
      : {
          contextWindowTokens,
        }),
  };
}

export interface ModelSettingsOptions {
  readonly modelJsonPath?: string;
  readonly envPath?: string;
  readonly onDiscovery?: () => void | Promise<void>;
}
const fields = {
  provider: z.string().trim().min(1),
  model: z.string().trim().min(1),
  baseUrl: z
    .string()
    .trim()
    .url()
    .refine((value) => /^https?:/u.test(value)),
  interfaceProvider: z.enum([
    "openai-compatible",
    "openai-responses",
    "anthropic",
  ]),
  promptCache: z.enum(["auto", "enabled", "disabled"]).optional(),
  label: z.string().optional(),
  apiKeyEnv: z
    .string()
    .regex(/^[A-Za-z_][A-Za-z0-9_]*$/u)
    .nullable()
    .optional(),
  apiKey: z.string().optional(),
  contextWindowTokens: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
};
export const ModelEntryCreateSchema = z.object(fields).strict();
export const ModelEntryPatchSchema = z
  .object(fields)
  .partial()
  .extend({ label: z.string().nullable().optional() })
  .strict();
export const ModelEntrySelectSchema = z
  .object({ id: z.string().min(1) })
  .strict();
export class ModelSettingsError extends Error {
  constructor(readonly code: "MODEL_NOT_FOUND" | "MODEL_CONFIG_INCOMPLETE") {
    super(
      code === "MODEL_NOT_FOUND"
        ? "Model entry not found"
        : "Model configuration incomplete",
    );
  }
}
const generations = new Map<string, number>();
function generationKey(id: string, options: ModelSettingsOptions): string {
  return `${resolve(options.modelJsonPath ?? getModelJsonPath())}\0${id}`;
}
export function modelEntryGeneration(
  id: string,
  options: ModelSettingsOptions = {},
): number {
  return generations.get(generationKey(id, options)) ?? 0;
}
function bumpGeneration(id: string, options: ModelSettingsOptions): void {
  generations.set(
    generationKey(id, options),
    modelEntryGeneration(id, options) + 1,
  );
}
function requireEntry(document: ModelDocument, id: string): ModelEntry {
  const entry = document.models.find((e) => e.id === id);
  if (!entry) throw new ModelSettingsError("MODEL_NOT_FOUND");
  return entry;
}
function clearAutomaticCapabilities(entry: ModelEntry): void {
  if (
    entry.reasoningCapabilitySource === "model-metadata" ||
    entry.reasoningCapabilitySource === "active-probe"
  ) {
    delete entry.reasoningCapabilities;
    delete entry.reasoningCapabilitySource;
  }
}
function clearIncompatibleReasoningPreference(
  document: ModelDocument,
  entry: ModelEntry | undefined,
): void {
  if (!entry || !configurationComplete(entry)) return;
  const capability = capabilitiesFor({
    ...entry,
    maxTokens: document.llmParams.maxTokens,
    modelProfiles: [entry],
  }).capability;
  if (!compatibleReasoningPreference(document.llmParams.reasoning, capability))
    delete document.llmParams.reasoning;
}
async function projectSettings(
  document: ModelDocument,
  options: ModelSettingsOptions,
): Promise<UiSettingsModels> {
  const values = await loadEnvFile(options.envPath ?? getGlobalEnvPath());
  const active = document.models.find(
    (entry) => entry.id === document.activeProfileId,
  );
  // Only keys the entries actually reference; unrelated env values are not secrets here.
  const secrets = document.models.flatMap((entry) => {
    const value = entry.apiKeyEnv ? values[entry.apiKeyEnv] : undefined;
    return value ? [value] : [];
  });
  return {
    active: active
      ? { id: active.id, provider: active.provider, model: active.model }
      : null,
    params: document.llmParams,
    models: document.models.map((entry) => ({
      id: entry.id,
      provider: entry.provider,
      model: entry.model,
      ...(entry.label === undefined ? {} : { label: entry.label }),
      ...(entry.baseUrl === undefined
        ? {}
        : { baseUrl: redactSettingsUrl(entry.baseUrl, secrets) }),
      ...(entry.interfaceProvider === undefined
        ? {}
        : { interfaceProvider: entry.interfaceProvider }),
      ...(entry.promptCache === undefined
        ? {}
        : { promptCache: entry.promptCache }),
      ...(entry.apiKeyEnv === undefined ? {} : { apiKeyEnv: entry.apiKeyEnv }),
      apiKeyConfigured:
        entry.apiKeyEnv !== undefined &&
        firstNonEmptyApiKey(
          runtimeEnvValue(entry.apiKeyEnv, process.env),
          values[entry.apiKeyEnv],
        ) !== undefined,
      configurationComplete: configurationComplete(entry),
      contextWindowTokens: entry.contextWindowTokens,
      ...(entry.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: entry.maxOutputTokens }),
      reasoning: reasoningCapabilityView({
        ...entry,
        baseUrl: entry.baseUrl ?? "",
        interfaceProvider:
          entry.interfaceProvider ?? DEFAULT_INTERFACE_PROVIDER,
        maxTokens: document.llmParams.maxTokens,
        modelProfiles: [entry],
      }),
    })),
  };
}
export function readModelSettings(
  options: ModelSettingsOptions = {},
): Promise<UiSettingsModels> {
  return coordinateModelConfig(options.modelJsonPath, async () =>
    projectSettings(await readModelDocument(options), options),
  );
}
interface SecretWrite {
  apiKeyEnv: string;
  apiKey: string;
}
async function patchEntry(
  document: ModelDocument,
  entry: ModelEntry,
  patch: UiSettingsModelPatch,
  options: ModelSettingsOptions,
): Promise<SecretWrite | undefined> {
  const { apiKey, apiKeyEnv, label, ...ordinary } = patch;
  const updates: Record<string, unknown> = ordinary;
  Object.assign(
    entry,
    Object.fromEntries(
      Object.entries(updates).filter(([, value]) => value !== undefined),
    ),
  );
  if (label === null) delete entry.label;
  else if (label !== undefined) entry.label = label;
  if (apiKeyEnv === null || apiKey === "") delete entry.apiKeyEnv;
  else if (apiKeyEnv !== undefined) entry.apiKeyEnv = apiKeyEnv;
  let secret: SecretWrite | undefined;
  if (apiKey !== undefined && apiKey !== "") {
    const searchPath =
      options.envPath !== undefined &&
      resolve(options.envPath) !== resolve(getGlobalEnvPath())
        ? join(dirname(options.envPath), "tools", "search.json")
        : undefined;
    const search = validateSearchJson((await loadSearchJson(searchPath)) ?? {});
    const references = collectCredentialReferences(
      { models: document.models.filter((e) => e.id !== entry.id) },
      search,
    );
    let reference =
      entry.apiKeyEnv ??
      `OHBABY_MODEL_${entry.id.replace(/[^A-Za-z0-9]/gu, "_").toUpperCase()}_API_KEY`;
    if (references.has(reference)) {
      const base = `OHBABY_MODEL_${entry.id.replace(/[^A-Za-z0-9]/gu, "_").toUpperCase()}_API_KEY`;
      reference = base;
      let suffix = 2;
      const values: Partial<Record<string, string>> = await loadEnvFile(
        options.envPath ?? getGlobalEnvPath(),
      );
      while (
        references.has(reference) ||
        (values[reference] !== undefined && reference !== entry.apiKeyEnv)
      )
        reference = `${base}_${String(suffix++)}`;
    }
    entry.apiKeyEnv = reference;
    secret = { apiKeyEnv: reference, apiKey };
  }
  if (
    entry.needsConfiguration &&
    entry.baseUrl &&
    entry.interfaceProvider &&
    (apiKeyEnv !== undefined ||
      apiKey !== undefined ||
      entry.apiKeyEnv !== undefined)
  )
    delete entry.needsConfiguration;
  return secret;
}
async function persistDocument(
  document: ModelDocument,
  options: ModelSettingsOptions,
  secret?: SecretWrite,
): Promise<void> {
  synchronizeModelSnapshot(document);
  normalizeModelDocument(document);
  const modelJsonPath = options.modelJsonPath ?? getModelJsonPath();
  const envPath = options.envPath ?? getGlobalEnvPath();
  const originalModel = await readOptionalConfigFile(modelJsonPath);
  const originalEnv = secret
    ? await readOptionalConfigFile(envPath)
    : undefined;
  try {
    await writeFileAtomically(
      modelJsonPath,
      `${JSON.stringify(document, null, 2)}\n`,
    );
    if (secret) await writeEnvSecret(envPath, secret.apiKeyEnv, secret.apiKey);
  } catch (error) {
    try {
      if (originalModel === undefined)
        await fs.rm(modelJsonPath, { force: true });
      else await writeFileAtomically(modelJsonPath, originalModel);
      if (secret) {
        if (originalEnv === undefined) await fs.rm(envPath, { force: true });
        else await writeFileAtomically(envPath, originalEnv);
      }
    } catch (rollbackError) {
      markModelConfigInconsistent(modelJsonPath);
      throw new Error(
        "Model configuration partially saved; rollback failed and new runs are blocked until configuration is repaired.",
        { cause: rollbackError },
      );
    }
    throw error;
  }
  markModelConfigConsistent(modelJsonPath);
  LLMConfigManager.getInstance().invalidate();
  if (secret) setManagedRuntimeEnv(secret.apiKeyEnv, secret.apiKey);
}
export function createModelEntry(
  input: UiSettingsModelCreate,
  options: ModelSettingsOptions = {},
): Promise<UiSettingsModels> {
  return coordinateModelConfig(options.modelJsonPath, async () => {
    const patch = ModelEntryCreateSchema.parse(input);
    const document = await readModelDocument(options);
    const entry: ModelEntry = {
      id: `profile-${randomUUID()}`,
      provider: patch.provider,
      model: patch.model,
      contextWindowTokens:
        patch.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
    };
    document.models.push(entry);
    const secret = await patchEntry(document, entry, patch, options);
    await persistDocument(document, options, secret);
    bumpGeneration(entry.id, options);
    void startModelEntryDiscovery(entry.id, options);
    return projectSettings(document, options);
  });
}
export function updateModelEntry(
  id: string,
  input: UiSettingsModelPatch,
  options: ModelSettingsOptions = {},
): Promise<UiSettingsModels> {
  return coordinateModelConfig(options.modelJsonPath, async () => {
    const patch = ModelEntryPatchSchema.parse(input);
    const document = await readModelDocument(options);
    const entry = requireEntry(document, id);
    const connectionChanged = [
      "provider",
      "model",
      "baseUrl",
      "interfaceProvider",
      "apiKeyEnv",
      "apiKey",
      "promptCache",
    ].some((key) => Object.hasOwn(patch, key));
    const secret = await patchEntry(document, entry, patch, options);
    if (connectionChanged) clearAutomaticCapabilities(entry);
    if (document.activeProfileId === id)
      clearIncompatibleReasoningPreference(document, entry);
    await persistDocument(document, options, secret);
    if (connectionChanged) bumpGeneration(id, options);
    // Budget/label edits keep their value and must not replace a running task,
    // such as the active probe started when this entry was selected.
    if (connectionChanged && configurationComplete(entry))
      void startModelEntryDiscovery(id, options);
    return projectSettings(document, options);
  });
}
export function selectModelEntry(
  id: string,
  options: ModelSettingsOptions = {},
): Promise<UiSettingsModels> {
  return coordinateModelConfig(options.modelJsonPath, async () => {
    const document = await readModelDocument(options);
    const entry = requireEntry(document, id);
    if (!configurationComplete(entry))
      throw new ModelSettingsError("MODEL_CONFIG_INCOMPLETE");
    document.activeProfileId = id;
    clearIncompatibleReasoningPreference(document, entry);
    await persistDocument(document, options);
    return projectSettings(document, options);
  });
}
/** Refresh one saved entry without changing the active selection. */
export async function probeModelEntry(
  id: string,
  options: ModelSettingsOptions = {},
): Promise<UiReasoningCapabilityView> {
  await coordinateModelConfig(options.modelJsonPath, async () => {
    const entry = requireEntry(await readModelDocument(options), id);
    if (!configurationComplete(entry))
      throw new ModelSettingsError("MODEL_CONFIG_INCOMPLETE");
  });
  await startModelEntryDiscovery(id, { ...options, allowActiveProbe: true });
  const result = await readModelSettings(options);
  const entry = result.models.find((model) => model.id === id);
  if (!entry) throw new ModelSettingsError("MODEL_NOT_FOUND");
  return entry.reasoning;
}

async function deleteEntries(
  predicate: (entry: ModelEntry) => boolean,
  options: ModelSettingsOptions,
): Promise<UiSettingsModels> {
  return coordinateModelConfig(options.modelJsonPath, async () => {
    const document = await readModelDocument(options);
    const removed = document.models.filter(predicate);
    if (!removed.length) throw new ModelSettingsError("MODEL_NOT_FOUND");
    const activeRemoved = removed.some(
      (entry) => entry.id === document.activeProfileId,
    );
    if (activeRemoved) {
      const index = document.models.findIndex(
        (entry) => entry.id === document.activeProfileId,
      );
      const ordered = [
        ...document.models.slice(index + 1),
        ...document.models.slice(0, index),
      ];
      document.activeProfileId = ordered.find(
        (entry) => !predicate(entry) && configurationComplete(entry),
      )?.id;
    }
    document.models = document.models.filter((entry) => !predicate(entry));
    if (activeRemoved)
      clearIncompatibleReasoningPreference(
        document,
        document.models.find((entry) => entry.id === document.activeProfileId),
      );
    await persistDocument(document, options);
    for (const entry of removed) bumpGeneration(entry.id, options);
    return projectSettings(document, options);
  });
}
export function deleteModelEntry(
  id: string,
  options: ModelSettingsOptions = {},
): Promise<UiSettingsModels> {
  return deleteEntries((entry) => entry.id === id, options);
}
export function deleteModelProvider(
  provider: string,
  options: ModelSettingsOptions = {},
): Promise<UiSettingsModels> {
  return deleteEntries((entry) => entry.provider === provider, options);
}

export async function setActiveLLMConfig(
  input: SetActiveLLMConfigInput,
): Promise<SetActiveLLMConfigResult> {
  return coordinateModelConfig(input.modelJsonPath, async () => {
    validateReasoningConfig(input.reasoning);
    const document = await readModelDocument(input);
    let entry = document.models.find(
      (e) =>
        e.provider === input.provider &&
        e.model === input.model &&
        e.baseUrl !== undefined &&
        normalizedEndpoint(e.baseUrl) === normalizedEndpoint(input.baseUrl),
    );
    if (!entry) {
      entry = {
        id: `profile-${randomUUID()}`,
        provider: input.provider,
        model: input.model,
        contextWindowTokens:
          input.contextWindowTokens ?? DEFAULT_CONTEXT_WINDOW_TOKENS,
      };
      document.models.push(entry);
    }
    const patch: UiSettingsModelPatch = {
      provider: input.provider,
      model: input.model,
      baseUrl: input.baseUrl,
      interfaceProvider: input.interfaceProvider ?? DEFAULT_INTERFACE_PROVIDER,
      ...(input.apiKey === undefined ? {} : { apiKey: input.apiKey }),
      ...(input.apiKeyEnv === undefined ? {} : { apiKeyEnv: input.apiKeyEnv }),
      ...(input.promptCache === undefined
        ? {}
        : { promptCache: input.promptCache }),
      ...(input.contextWindowTokens === undefined
        ? {}
        : { contextWindowTokens: input.contextWindowTokens }),
      ...(input.maxOutputTokens === undefined
        ? {}
        : { maxOutputTokens: input.maxOutputTokens }),
    };
    ModelEntryPatchSchema.parse(patch);
    const previous = JSON.stringify([
      entry.provider,
      entry.model,
      entry.baseUrl,
      entry.interfaceProvider,
      entry.apiKeyEnv,
      entry.promptCache,
    ]);
    const secret = await patchEntry(document, entry, patch, input);
    delete entry.needsConfiguration;
    const changed =
      previous !==
        JSON.stringify([
          entry.provider,
          entry.model,
          entry.baseUrl,
          entry.interfaceProvider,
          entry.apiKeyEnv,
          entry.promptCache,
        ]) || input.apiKey !== undefined;
    if (changed || input.clearDiscoveredReasoning)
      clearAutomaticCapabilities(entry);
    if (input.clearContextWindowTokens || input.clearActiveModelProfile) {
      entry.contextWindowTokens = DEFAULT_CONTEXT_WINDOW_TOKENS;
      clearAutomaticCapabilities(entry);
    }
    if (
      input.discoveredReasoningCapabilities &&
      (!entry.reasoningCapabilities || entry.reasoningCapabilitySource)
    ) {
      entry.reasoningCapabilities = input.discoveredReasoningCapabilities;
      entry.reasoningCapabilitySource =
        input.discoveredReasoningCapabilitySource ?? "model-metadata";
    }
    document.activeProfileId = entry.id;
    document.llmParams = buildLLMParams(input, document);
    synchronizeModelSnapshot(document);
    if (!configurationComplete(entry))
      throw new ModelSettingsError("MODEL_CONFIG_INCOMPLETE");
    if (input.reasoning === undefined)
      clearIncompatibleReasoningPreference(document, entry);
    await persistDocument(document, input, secret);
    if (changed) bumpGeneration(entry.id, input);
    return {
      profileId: entry.id,
      provider: entry.provider,
      model: entry.model,
      baseUrl: entry.baseUrl,
      interfaceProvider: entry.interfaceProvider,
      promptCache: entry.promptCache ?? "auto",
      ...(entry.apiKeyEnv === undefined ? {} : { apiKeyEnv: entry.apiKeyEnv }),
      modelJsonPath: input.modelJsonPath ?? getModelJsonPath(),
      ...(input.envPath === undefined && !secret
        ? {}
        : { envPath: input.envPath ?? getGlobalEnvPath() }),
    };
  });
}

/** Conditional metadata writeback; never selects/recreates the target or changes other entries. */
export function writeModelEntryMetadata(
  id: string,
  expected: {
    generation: number;
    routeKey: string;
    contextWindowTokens: number;
  },
  metadata: {
    contextWindowTokens?: number;
    reasoningCapabilities?: ReasoningCapabilities;
    reasoningCapabilitySource?: "model-metadata" | "active-probe";
  },
  options: ModelSettingsOptions = {},
): Promise<boolean> {
  return coordinateModelConfig(options.modelJsonPath, async () => {
    const document = await readModelDocument(options);
    const entry = document.models.find((e) => e.id === id);
    if (
      !entry ||
      !configurationComplete(entry) ||
      modelEntryGeneration(id, options) !== expected.generation ||
      modelProfileRouteKey(entry, entry.provider) !== expected.routeKey
    )
      return false;
    // A later manual budget edit wins over this task's older snapshot, without
    // discarding the task's reasoning evidence or cancelling its active probe.
    if (
      metadata.contextWindowTokens !== undefined &&
      entry.contextWindowTokens === expected.contextWindowTokens
    )
      entry.contextWindowTokens = metadata.contextWindowTokens;
    if (
      metadata.reasoningCapabilities &&
      (!entry.reasoningCapabilities || entry.reasoningCapabilitySource)
    ) {
      entry.reasoningCapabilities = metadata.reasoningCapabilities;
      entry.reasoningCapabilitySource =
        metadata.reasoningCapabilitySource ?? "model-metadata";
    }
    if (document.activeProfileId === id)
      clearIncompatibleReasoningPreference(document, entry);
    await persistDocument(document, options);
    return true;
  });
}
