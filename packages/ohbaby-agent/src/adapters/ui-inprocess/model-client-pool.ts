import { emitDiagnostic } from "../../observability/logger.js";
import { createHash } from "node:crypto";
import {
  createLLMClientFromConfig,
  type LLMClientInstance,
  type LLMConfig,
} from "ohbaby-llm";
import { coordinateModelConfig } from "../../config/llm/config-coordination.js";
import { loadModelEntryConfig } from "../../config/llm/manager.js";
import {
  readModelDocument,
  resolveModelEntry,
  type ModelEntry,
} from "../../config/llm/model-document.js";
import {
  tokenUsageNormalization,
  NOOP_LOGGER,
  type Logger,
} from "../../observability/index.js";

export interface ResolvedModelConfig {
  readonly config: LLMConfig;
  readonly entry: ModelEntry;
  readonly source: "explicit" | "default";
  readonly removedEntryId?: string;
}

export interface ResolvedModelClient {
  readonly client: LLMClientInstance;
  readonly entry: ModelEntry;
  readonly source: "explicit" | "default";
  readonly removedEntryId?: string;
}

/** A content-keyed pool leaves in-flight clients intact when configuration changes. */
export function createModelClientPool(options: {
  readonly llmClient?: LLMClientInstance;
  readonly createLLMClient?: (config: LLMConfig) => Promise<LLMClientInstance>;
  readonly logger?: Logger;
}): {
  resolve(
    projectDirectory: string,
    modelEntryId?: string,
  ): Promise<ResolvedModelClient>;
  read(
    projectDirectory: string,
    modelEntryId?: string,
  ): Promise<ResolvedModelConfig>;
} {
  const clients = new Map<string, Promise<LLMClientInstance>>();
  async function read(
    projectDirectory: string,
    modelEntryId?: string,
  ): Promise<ResolvedModelConfig> {
    return coordinateModelConfig(undefined, async () => {
      const document = await readModelDocument();
      if (options.llmClient && document.models.length === 0) {
        const config = options.llmClient.config;
        document.models.push({
          ...config.modelProfiles?.[0],
          id: "injected",
          provider: config.provider,
          model: config.model,
          baseUrl: config.baseUrl,
          interfaceProvider: config.interfaceProvider,
          contextWindowTokens: config.contextWindowTokens ?? 128_000,
          maxOutputTokens: config.maxTokens,
          reasoning: config.reasoning,
        });
        document.activeProfileId = "injected";
      }
      const resolved = resolveModelEntry(document, modelEntryId);
      const config = options.llmClient
        ? {
            ...options.llmClient.config,
            apiKey: "injected-client",
            promptCache: options.llmClient.config.promptCache ?? "auto",
          }
        : await loadModelEntryConfig({ projectDirectory }, resolved.entry.id);
      return { ...resolved, config };
    });
  }
  return {
    read,
    async resolve(
      projectDirectory,
      modelEntryId,
    ): Promise<ResolvedModelClient> {
      const resolved = await read(projectDirectory, modelEntryId);
      if (options.llmClient) return { ...resolved, client: options.llmClient };
      const config = resolved.config;
      const key = createHash("sha256")
        .update(JSON.stringify([projectDirectory, config]))
        .digest("hex");
      let client = clients.get(key);
      if (!client) {
        client = options.createLLMClient
          ? options.createLLMClient(config)
          : Promise.resolve(
              createLLMClientFromConfig(config, {
                tokenUsageReporter(diagnostic): void {
                  emitDiagnostic(
                    options.logger ?? NOOP_LOGGER,
                    tokenUsageNormalization,
                    {
                      code: diagnostic.code,
                      field: diagnostic.field,
                      normalizedTotal: diagnostic.normalizedTotal,
                      protocol: diagnostic.protocol,
                      received: diagnostic.received,
                      retained: diagnostic.retained,
                    },
                  );
                },
              }),
            );
        clients.set(key, client);
        // Only the current configuration needs a pool reference; running turns
        // retain their own clients. Bound retention when users edit repeatedly.
        if (clients.size > 64) {
          const oldest = clients.keys().next().value;
          if (oldest !== undefined) clients.delete(oldest);
        }
        void client.catch(() => {
          if (clients.get(key) === client) clients.delete(key);
        });
      }
      return { ...resolved, client: await client };
    },
  };
}
