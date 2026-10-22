/** Explicit saved references only: absent model-entry fields never inherit a key. */
export function collectCredentialReferences(
  model: unknown,
  search: unknown,
): Set<string> {
  const references = new Set<string>();
  const record = (value: unknown): Record<string, unknown> =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const add = (value: unknown): void => {
    if (typeof value === "string" && value.trim()) references.add(value.trim());
  };
  const modelRecord = record(model);
  add(record(modelRecord.apiConfig).apiKeyEnv);
  if (Array.isArray(modelRecord.models))
    for (const entry of modelRecord.models) add(record(entry).apiKeyEnv);
  add(record(search).apiKeyEnv);
  return references;
}
