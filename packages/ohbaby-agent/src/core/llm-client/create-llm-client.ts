/**
 * Agent configuration and diagnostics for LLM client creation.
 *
 * This module handles the instantiation of the configured provider client.
 *
 * Design Principles:
 * - SRP: Only responsible for creating and configuring the client
 * - Fail Fast: Configuration errors from config module propagate immediately
 * - KISS: Minimal logic, delegate configuration to config module
 *
 * Dependencies:
 * - config module: Provides validated LLM configuration
 */

import * as path from "node:path";
import { getLLMConfig } from "../../config/index.js";
import { createLLMClientFromConfig } from "./client.js";
import type { LLMClientInstance } from "./types.js";
import {
  NOOP_LOGGER,
  tokenUsageNormalization,
  type Logger,
} from "../../observability/index.js";
import { emitDiagnostic } from "../../observability/logger.js";

export interface CreateLLMClientOptions {
  readonly projectDirectory?: string;
  readonly modelJsonPath?: string;
  readonly envPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly logger?: Logger;
}

/**
 * Create and initialize an LLM client instance.
 *
 * Loads configuration from the config module (which reads from ~/.ohbaby/model.json
 * and environment variables). Configuration validation is handled by the config module.
 *
 * @returns Promise resolving to client instance with provider and configuration
 * @throws {ConfigError} If configuration is missing or invalid (from config module)
 *
 * @example
 * ```typescript
 * const llmClient = await createLLMClient();
 * // Use llmClient.provider.client for direct SDK calls
 * // Use llmClient.config for configuration values
 * ```
 */
export async function createLLMClient(
  options: CreateLLMClientOptions = {},
): Promise<LLMClientInstance> {
  // Load validated configuration from config module
  const projectDirectory = options.projectDirectory ?? process.cwd();
  const config = await getLLMConfig({
    ...options,
    projectDirectory,
    envPath: options.envPath ?? path.join(projectDirectory, ".env"),
  });

  return createLLMClientFromConfig(config, {
    tokenUsageReporter(diagnostic): void {
      emitDiagnostic(options.logger ?? NOOP_LOGGER, tokenUsageNormalization, {
        code: diagnostic.code,
        field: diagnostic.field,
        normalizedTotal: diagnostic.normalizedTotal,
        protocol: diagnostic.protocol,
        received: diagnostic.received,
        retained: diagnostic.retained,
      });
    },
  });
}
