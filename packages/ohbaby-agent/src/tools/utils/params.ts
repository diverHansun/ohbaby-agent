export class ToolParameterError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolParameterError";
  }
}

export function getStringParam(
  params: Record<string, unknown>,
  name: string,
  options: { readonly allowEmpty?: boolean; readonly defaultValue?: string } = {},
): string {
  const value = params[name] ?? options.defaultValue;
  if (typeof value !== "string") {
    throw new ToolParameterError(`Expected parameter "${name}" to be a string.`);
  }
  if (!options.allowEmpty && value.trim() === "") {
    throw new ToolParameterError(`Expected parameter "${name}" to be non-empty.`);
  }

  return value;
}

export function getOptionalStringParam(
  params: Record<string, unknown>,
  name: string,
): string | undefined {
  const value = params[name];
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ToolParameterError(`Expected parameter "${name}" to be a string.`);
  }

  return value;
}

export function getNumberParam(
  params: Record<string, unknown>,
  name: string,
  options: {
    readonly defaultValue: number;
    readonly integer?: boolean;
    readonly max?: number;
    readonly min?: number;
  },
): number {
  const value = params[name] ?? options.defaultValue;
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new ToolParameterError(`Expected parameter "${name}" to be a number.`);
  }
  if (options.integer === true && !Number.isInteger(value)) {
    throw new ToolParameterError(`Expected parameter "${name}" to be an integer.`);
  }
  if (options.min !== undefined && value < options.min) {
    throw new ToolParameterError(
      `Expected parameter "${name}" to be at least ${String(options.min)}.`,
    );
  }
  if (options.max !== undefined && value > options.max) {
    throw new ToolParameterError(
      `Expected parameter "${name}" to be at most ${String(options.max)}.`,
    );
  }

  return value;
}

export function getBooleanParam(
  params: Record<string, unknown>,
  name: string,
  defaultValue: boolean,
): boolean {
  const value = params[name] ?? defaultValue;
  if (typeof value !== "boolean") {
    throw new ToolParameterError(`Expected parameter "${name}" to be a boolean.`);
  }

  return value;
}

export function getStringArrayParam(
  params: Record<string, unknown>,
  name: string,
  defaultValue: readonly string[] = [],
): readonly string[] {
  const value = params[name] ?? defaultValue;
  if (!Array.isArray(value)) {
    throw new ToolParameterError(
      `Expected parameter "${name}" to be an array of strings.`,
    );
  }

  const strings: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      throw new ToolParameterError(
        `Expected parameter "${name}" to be an array of strings.`,
      );
    }
    strings.push(item);
  }

  return strings;
}
