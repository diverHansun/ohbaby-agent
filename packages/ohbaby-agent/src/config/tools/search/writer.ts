import type { UiSettingsSearch, UiSettingsSearchUpdate } from "ohbaby-sdk";
import { redactSettingsUrl } from "../../secrets/redaction.js";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { getGlobalEnvPath } from "../../../utils/project-env.js";
import {
  removeManagedRuntimeEnv,
  runtimeEnvValue,
  setManagedRuntimeEnv,
} from "../../../utils/managed-runtime-env.js";
import {
  resolveLegacyOhbabyHome,
  resolveOhbabyHome,
  resolveReadPathWithLegacy,
} from "../../../paths/index.js";
import {
  coordinateModelConfig,
  readOptionalConfigFile,
} from "../../llm/config-coordination.js";
import {
  parseEnvFile,
  removeEnvFileValue,
  setEnvFileValue,
} from "../../llm/env-file.js";
import { collectCredentialReferences } from "../../secrets/references.js";
import { writeFileAtomically } from "../../secrets/atomic-file.js";
import {
  getSearchJsonPath,
  loadSearchJson,
  resolveSearchJsonPath,
} from "./loaders.js";
import { SearchConfigManager } from "./manager.js";
import { validateSearchJson } from "./validation.js";
import {
  SearchDefaultsConfigSchema,
  SearchJsonConfigSchema,
  type SearchJsonConfig,
} from "./types.js";

export const SearchSettingsPatchSchema = SearchJsonConfigSchema.partial()
  .extend({
    apiKey: z.string().optional(),
    baseUrl: z.string().url().nullable().optional(),
    defaults: SearchDefaultsConfigSchema.partial().optional(),
  })
  .strict();
export type SearchSettingsPatch = UiSettingsSearchUpdate;
export interface SearchSettingsWriteOptions {
  readonly homeDirectory?: string;
  readonly searchJsonPath?: string;
}
export interface SetSearchApiKeyInput extends SearchSettingsWriteOptions {
  readonly apiKey?: string;
  readonly apiKeyEnv?: string;
  readonly provider?: SearchJsonConfig["provider"];
}
export interface SetSearchApiKeyResult {
  readonly apiKeyEnv: string;
  readonly provider: SearchJsonConfig["provider"];
  readonly envPath: string;
  readonly searchJsonPath: string;
}

export function readSearchSettings(
  options: SearchSettingsWriteOptions = {},
): Promise<UiSettingsSearch> {
  return coordinateModelConfig(undefined, async () => {
    const path = await resolveSearchJsonPath(
      options.searchJsonPath,
      options.homeDirectory,
    );
    const config = validateSearchJson((await loadSearchJson(path)) ?? {}, path);
    const values = parseEnvFile(
      (await readOptionalConfigFile(getGlobalEnvPath(options.homeDirectory))) ??
        "",
    );
    const value =
      config.apiKeyEnv === null
        ? undefined
        : (runtimeEnvValue(config.apiKeyEnv, process.env) ??
          values[config.apiKeyEnv]);
    return {
      ...config,
      ...(config.baseUrl === undefined
        ? {}
        : { baseUrl: redactSettingsUrl(config.baseUrl) }),
      apiKeyConfigured: Boolean(value?.trim()),
    };
  });
}

export function updateSearchSettings(
  input: SearchSettingsPatch,
  options: SearchSettingsWriteOptions = {},
): Promise<UiSettingsSearch> {
  return coordinateModelConfig(undefined, async () => {
    const patch = SearchSettingsPatchSchema.parse(input);
    const destination =
      options.searchJsonPath ?? getSearchJsonPath(options.homeDirectory);
    const readPath = await resolveSearchJsonPath(
      options.searchJsonPath,
      options.homeDirectory,
    );
    const raw = (await loadSearchJson(readPath)) ?? {};
    const existing = validateSearchJson(raw, readPath);
    const { apiKey, defaults, baseUrl, ...fields } = patch;
    const next: Record<string, unknown> & {
      provider: "tavily";
      apiKeyEnv: string | null;
    } = {
      ...(raw as Record<string, unknown>),
      provider: existing.provider,
      apiKeyEnv: existing.apiKeyEnv,
      ...fields,
    };
    if (defaults !== undefined)
      next.defaults = { ...(raw as SearchJsonConfig).defaults, ...defaults };
    if (baseUrl === null) delete next.baseUrl;
    else if (baseUrl !== undefined) next.baseUrl = baseUrl;
    const modelPath = await resolveReadPathWithLegacy(
      join(resolveOhbabyHome(options), "model.json"),
      [join(resolveLegacyOhbabyHome(options), "model.json")],
    );
    const modelContent = await readOptionalConfigFile(modelPath);
    const modelReferences = collectCredentialReferences(
      modelContent === undefined ? {} : JSON.parse(modelContent),
      {},
    );
    const envPath = getGlobalEnvPath(options.homeDirectory);
    const originalEnv = await readOptionalConfigFile(envPath);
    let envContent = originalEnv ?? "";
    let writtenReference: string | undefined;
    const removedReferences = new Set<string>();
    const remove = (name: string): void => {
      if (!modelReferences.has(name)) {
        envContent = removeEnvFileValue(envContent, name);
        removedReferences.add(name);
      }
    };
    if (apiKey !== undefined && apiKey !== "") {
      let reference = next.apiKeyEnv ?? "OHBABY_SEARCH_API_KEY";
      if (modelReferences.has(reference)) {
        reference = "OHBABY_SEARCH_API_KEY";
        let suffix = 2;
        const values: Partial<Record<string, string>> =
          parseEnvFile(envContent);
        while (
          modelReferences.has(reference) ||
          (values[reference] !== undefined && reference !== existing.apiKeyEnv)
        )
          reference = `OHBABY_SEARCH_API_KEY_${String(suffix++)}`;
      }
      next.apiKeyEnv = reference;
      envContent = setEnvFileValue(envContent, reference, apiKey);
      writtenReference = reference;
    } else if (apiKey === "" && next.apiKeyEnv !== null) {
      if (modelReferences.has(next.apiKeyEnv)) next.apiKeyEnv = null;
      else remove(next.apiKeyEnv);
    }
    if (existing.apiKeyEnv !== null && existing.apiKeyEnv !== next.apiKeyEnv)
      remove(existing.apiKeyEnv);
    validateSearchJson(next, destination);
    const originalSearch = await readOptionalConfigFile(destination);
    const envChanged = envContent !== (originalEnv ?? "");
    try {
      if (envChanged) await writeFileAtomically(envPath, envContent);
      await writeFileAtomically(
        destination,
        `${JSON.stringify(next, null, 2)}\n`,
      );
    } catch (error) {
      if (envChanged) {
        if (originalEnv === undefined) await rm(envPath, { force: true });
        else await writeFileAtomically(envPath, originalEnv);
      }
      if (originalSearch === undefined) await rm(destination, { force: true });
      else await writeFileAtomically(destination, originalSearch);
      throw error;
    }
    for (const name of removedReferences) removeManagedRuntimeEnv(name);
    if (writtenReference !== undefined && apiKey !== undefined)
      setManagedRuntimeEnv(writtenReference, apiKey);
    SearchConfigManager.getInstance().invalidate();
    return readSearchSettings({ ...options, searchJsonPath: destination });
  });
}

export async function setSearchApiKey(
  input: SetSearchApiKeyInput,
): Promise<SetSearchApiKeyResult> {
  const { homeDirectory, searchJsonPath, ...patch } = input;
  const result = await updateSearchSettings(patch, {
    homeDirectory,
    searchJsonPath,
  });
  return {
    apiKeyEnv: result.apiKeyEnv ?? input.apiKeyEnv ?? "TAVILY_API_KEY",
    provider: result.provider,
    envPath: getGlobalEnvPath(homeDirectory),
    searchJsonPath: searchJsonPath ?? getSearchJsonPath(homeDirectory),
  };
}
