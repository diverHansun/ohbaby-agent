/** Test-only evidence extraction: retain numeric usage, never message text or headers. */
function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function fields(
  source: Record<string, unknown>,
  names: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(
    names
      .filter((name) => Object.hasOwn(source, name))
      .map((name) => {
        const value = source[name];
        return [
          name,
          typeof value === "number" || value === null
            ? value
            : { invalidType: typeof value },
        ];
      }),
  );
}

function wireRecords(wire: string): Record<string, unknown>[] {
  const records: Record<string, unknown>[] = [];
  const dataFrames = wire.split(/\r?\n\r?\n/).map((frame) =>
    frame
      .split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n"),
  );
  for (const data of dataFrames.some(Boolean) ? dataFrames : [wire]) {
    if (!data || data === "[DONE]") continue;
    try {
      const event = record(JSON.parse(data));
      if (event) records.push(event);
    } catch {
      /* Invalid frames carry no evidence. */
    }
  }
  return records;
}

export function extractCacheErrorCode(
  wire: string,
): string | number | undefined {
  for (const event of wireRecords(wire)) {
    const error =
      record(event.error) ?? record(record(event.response)?.error) ?? event;
    const code = error.code;
    if (
      typeof code === "number" ||
      (typeof code === "string" && /^[a-zA-Z0-9_.-]{1,80}$/.test(code))
    )
      return code;
  }
  return undefined;
}

export function extractCacheUsageEvidence(
  wire: string,
): Record<string, unknown>[] {
  const evidence: Record<string, unknown>[] = [];
  for (const event of wireRecords(wire)) {
    const usage =
      record(event.usage) ??
      record(record(event.response)?.usage) ??
      record(record(event.message)?.usage);
    if (!usage) continue;
    const safe = fields(usage, [
      "input_tokens",
      "output_tokens",
      "total_tokens",
      "prompt_tokens",
      "completion_tokens",
      "prompt_cache_hit_tokens",
      "prompt_cache_miss_tokens",
      "cache_read_input_tokens",
      "cache_creation_input_tokens",
    ]);
    for (const name of ["input_tokens_details", "prompt_tokens_details"]) {
      const details = record(usage[name]);
      if (details)
        safe[name] = fields(details, ["cached_tokens", "cache_write_tokens"]);
    }
    evidence.push(safe);
  }
  return evidence;
}
