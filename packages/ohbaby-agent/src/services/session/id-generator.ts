export interface SessionIdGeneratorOptions {
  readonly now?: () => number;
  readonly random?: () => number;
}

export function createSessionIdGenerator(
  options: SessionIdGeneratorOptions = {},
): () => string {
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  let counter = 0;

  return () => {
    counter += 1;
    const randomPart = random().toString(36).slice(2, 8) || "0";
    return `session_${String(now())}_${randomPart}${counter.toString(36)}`;
  };
}
