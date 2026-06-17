import { getGlobalEnvPath } from "../../../utils/project-env.js";
import { writeFileAtomically } from "../../secrets/atomic-file.js";
import { writeGlobalEnvSecret } from "../../secrets/env-secrets.js";
import { getSearchJsonPath, loadSearchJson } from "./loaders.js";
import { validateSearchJson } from "./validation.js";
import type { SearchJsonConfig } from "./types.js";

export interface SetSearchApiKeyInput {
  readonly apiKey?: string;
  readonly apiKeyEnv?: string;
  readonly provider?: SearchJsonConfig["provider"];
  readonly homeDirectory?: string;
  readonly searchJsonPath?: string;
}

export interface SetSearchApiKeyResult {
  readonly apiKeyEnv: string;
  readonly provider: SearchJsonConfig["provider"];
  readonly envPath: string;
  readonly searchJsonPath: string;
}

export async function setSearchApiKey(
  input: SetSearchApiKeyInput,
): Promise<SetSearchApiKeyResult> {
  const searchJsonPath =
    input.searchJsonPath ?? getSearchJsonPath(input.homeDirectory);
  const existingRaw = await loadSearchJson(searchJsonPath);
  if (existingRaw !== null) {
    validateSearchJson(existingRaw, searchJsonPath);
  }

  const existingRecord = isRecord(existingRaw) ? existingRaw : {};
  const apiKeyEnv =
    input.apiKeyEnv?.trim() ??
    (typeof existingRecord.apiKeyEnv === "string"
      ? existingRecord.apiKeyEnv.trim()
      : "TAVILY_API_KEY");
  const provider =
    input.provider ??
    (existingRecord.provider === "tavily" ? existingRecord.provider : "tavily");
  const nextConfig = {
    apiKeyEnv,
    provider,
  };
  validateSearchJson(nextConfig, searchJsonPath);

  const envPath =
    input.apiKey === undefined
      ? getGlobalEnvPath(input.homeDirectory)
      : await writeGlobalEnvSecret(apiKeyEnv, input.apiKey, {
          homeDirectory: input.homeDirectory,
        });
  await writeFileAtomically(
    searchJsonPath,
    `${JSON.stringify(nextConfig, null, 2)}\n`,
  );
  if (input.apiKey !== undefined) {
    process.env[apiKeyEnv] = input.apiKey;
  }

  return {
    apiKeyEnv,
    envPath,
    provider,
    searchJsonPath,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
