// Credentials come from model config. SDK custom-header env values are also
// excluded, without deleting the SDK's own authentication/protocol headers.

/** Both SDKs capture custom env headers during their synchronous constructor. */
export function withoutEnvCustomHeaders<T>(
  envName: "ANTHROPIC_CUSTOM_HEADERS" | "OPENAI_CUSTOM_HEADERS",
  createClient: () => T,
): T {
  const previous = process.env[envName];
  // No await: other work in this process cannot observe the temporary change.
  // Restore even if construction throws; never alter persisted shell settings.
  Reflect.deleteProperty(process.env, envName);
  try {
    return createClient();
  } finally {
    if (previous === undefined) Reflect.deleteProperty(process.env, envName);
    else process.env[envName] = previous;
  }
}

/** OpenAI options that would otherwise be read from OPENAI_* env vars. */
export function openAIClientIsolation(): {
  adminAPIKey: null;
  organization: null;
  project: null;
} {
  return { adminAPIKey: null, organization: null, project: null };
}
