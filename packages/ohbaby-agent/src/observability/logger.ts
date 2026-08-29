import { createHash } from "node:crypto";
import path from "node:path";

export type LogLevel = "error" | "warn" | "info" | "debug" | "trace";

export type DiagnosticsComponent =
  | "diagnostics"
  | "llm"
  | "migration"
  | "server"
  | "session";

export interface DiagnosticRoots {
  readonly home?: string;
  readonly ohbabyHome?: string;
  readonly tmp?: string;
  readonly workspace?: string;
}

export interface SafeLogError {
  readonly name: string;
  readonly code?: string;
  readonly message: string;
  readonly stack?: string;
}

type EncodedScalar = boolean | number | string;
type EncodedValue = EncodedScalar | SafeLogError;

interface EncodingContext {
  readonly roots: DiagnosticRoots;
}

const fieldEncoderBrand: unique symbol = Symbol("DiagnosticFieldEncoder");

export interface DiagnosticFieldEncoder<Input> {
  readonly [fieldEncoderBrand]: Input;
}

interface InternalFieldEncoder<Input> extends DiagnosticFieldEncoder<Input> {
  readonly encode: (
    value: Input,
    context: EncodingContext,
  ) => EncodedValue | undefined;
  readonly optional: boolean;
}

type FieldMap = Readonly<Record<string, DiagnosticFieldEncoder<unknown>>>;
type FieldInput<Encoder> =
  Encoder extends DiagnosticFieldEncoder<infer Input> ? Input : never;
type InputForFields<Fields extends FieldMap> = {
  readonly [Key in keyof Fields]: FieldInput<Fields[Key]>;
};

type LiteralString<Value extends string> = string extends Value ? never : Value;

const diagnosticEventDefinitionBrand: unique symbol = Symbol(
  "DiagnosticEventDefinition",
);

export interface DiagnosticEventDefinition<Input> {
  readonly [diagnosticEventDefinitionBrand]: (input: Input) => Input;
}

interface InternalDiagnosticEventDefinition<
  Input,
> extends DiagnosticEventDefinition<Input> {
  readonly component: DiagnosticsComponent;
  readonly event: string;
  readonly fields: Readonly<Record<string, InternalFieldEncoder<unknown>>>;
  readonly level: LogLevel;
}

const definitions = new WeakSet<object>();
const encoders = new WeakSet<object>();
const EVENT_PATTERN = /^[a-z][a-z0-9]*(?:\.[a-z][a-z0-9_]*)+$/;
const COMPONENT_PATTERN = /^[a-z][a-z0-9-]{0,47}$/;
const CREDENTIAL_PATTERN =
  /(authorization|api[_-]?key|access[_-]?token|bearer|cookie|password|private[_-]?key)\s*[:=]\s*[^\s,;]+/gi;
const MAX_SAFE_STRING_BYTES = 512;

function truncateUtf8(value: string, maxBytes: number): string {
  if (Buffer.byteLength(value, "utf8") <= maxBytes) {
    return value;
  }
  let end = value.length;
  while (end > 0 && Buffer.byteLength(value.slice(0, end), "utf8") > maxBytes) {
    end -= 1;
  }
  return value.slice(0, end);
}

function cleanCredentialShapes(value: string): string {
  return value.replace(CREDENTIAL_PATTERN, "$1=<redacted>");
}

function shortHash(kind: string, value: string): string {
  return createHash("sha256")
    .update(`${kind}\0${value}`)
    .digest("hex")
    .slice(0, 12);
}

function createEncoder<Input>(
  encode: InternalFieldEncoder<Input>["encode"],
  optional = false,
): DiagnosticFieldEncoder<Input> {
  const encoder: InternalFieldEncoder<Input> = Object.freeze({
    [fieldEncoderBrand]: undefined as unknown as Input,
    encode,
    optional,
  });
  encoders.add(encoder);
  return encoder;
}

function assertFinite(value: number, label: string): number {
  if (!Number.isFinite(value)) {
    throw new TypeError(`${label} must be finite`);
  }
  return value;
}

function pathHasPrefix(value: string, root: string): boolean {
  const relative = path.relative(root, value);
  return (
    relative === "" ||
    (!relative.startsWith("..") && !path.isAbsolute(relative))
  );
}

function normalizeRelativePath(value: string): string {
  const normalized = path.normalize(value).replaceAll("\\", "/");
  if (
    normalized === ".." ||
    normalized.startsWith("../") ||
    path.isAbsolute(normalized)
  ) {
    return `<external>/${shortHash("path", value)}`;
  }
  return truncateUtf8(cleanCredentialShapes(normalized), MAX_SAFE_STRING_BYTES);
}

export function normalizeDiagnosticPath(
  value: string,
  roots: DiagnosticRoots,
): string {
  if (!path.isAbsolute(value)) {
    return normalizeRelativePath(value);
  }
  const absolute = path.resolve(value);
  const candidates: (readonly [string, string])[] = [];
  for (const [label, root] of [
    ["<workspace>", roots.workspace],
    ["<ohbaby-home>", roots.ohbabyHome],
    ["<home>", roots.home],
    ["<tmp>", roots.tmp],
  ] as const) {
    if (typeof root === "string" && path.isAbsolute(root)) {
      candidates.push([label, path.resolve(root)]);
    }
  }
  candidates.sort((left, right) => right[1].length - left[1].length);
  for (const [label, root] of candidates) {
    if (pathHasPrefix(absolute, root)) {
      const suffix = path.relative(root, absolute).replaceAll("\\", "/");
      if (suffix.length === 0) {
        return label;
      }
      return truncateUtf8(
        `${label}/${cleanCredentialShapes(suffix)}`,
        MAX_SAFE_STRING_BYTES,
      );
    }
  }
  return `<external>/${shortHash("path", absolute)}`;
}

export function normalizeDiagnosticUrl(value: string): string {
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      return `<invalid-url>/${shortHash("url", value)}`;
    }
    return `<origin>/${shortHash("url-origin", parsed.origin)}`;
  } catch {
    return `<invalid-url>/${shortHash("url", value)}`;
  }
}

const SAFE_ERROR_CODES = new Set([
  "ABORT_ERR",
  "EACCES",
  "EADDRINUSE",
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "EEXIST",
  "EHOSTUNREACH",
  "EISDIR",
  "EMFILE",
  "ENOENT",
  "ENOTDIR",
  "ENOTFOUND",
  "ENOSPC",
  "EPERM",
  "ETIMEDOUT",
]);
const SAFE_ERROR_NAMES = new Set([
  "AbortError",
  "AggregateError",
  "Error",
  "RangeError",
  "ReferenceError",
  "SyntaxError",
  "TypeError",
  "URIError",
]);

function safeErrorCode(error: Error): string | undefined {
  if (!("code" in error)) {
    return undefined;
  }
  const code = (error as Error & { readonly code?: unknown }).code;
  return typeof code === "string" && SAFE_ERROR_CODES.has(code)
    ? code
    : undefined;
}

export function safeError(value: unknown): SafeLogError {
  try {
    if (!(value instanceof Error)) {
      return { message: "An unknown error occurred", name: "UnknownError" };
    }
    return {
      ...(safeErrorCode(value) === undefined
        ? {}
        : { code: safeErrorCode(value) }),
      message: "An external operation failed",
      name: SAFE_ERROR_NAMES.has(value.name) ? value.name : "Error",
    };
  } catch {
    return { message: "An error could not be inspected", name: "UnknownError" };
  }
}

export const diagnosticField = Object.freeze({
  boolean(): DiagnosticFieldEncoder<boolean> {
    return createEncoder((value) => {
      if (typeof value !== "boolean") {
        throw new TypeError("diagnostic boolean field must be boolean");
      }
      return value;
    });
  },
  userEntityName(
    kind: "agent" | "mcp" | "skill",
  ): DiagnosticFieldEncoder<string> {
    return createEncoder((value) => `${kind}_${shortHash(kind, value)}`);
  },
  externalError(): DiagnosticFieldEncoder<unknown> {
    return createEncoder((value) => safeError(value));
  },
  externalId(kind: string): DiagnosticFieldEncoder<string> {
    return createEncoder((value) => `${kind}_${shortHash(kind, value)}`);
  },
  integer(): DiagnosticFieldEncoder<number> {
    return createEncoder((value) => {
      if (!Number.isInteger(value)) {
        throw new TypeError("diagnostic integer field must be an integer");
      }
      return value;
    });
  },
  number(): DiagnosticFieldEncoder<number> {
    return createEncoder((value) =>
      assertFinite(value, "diagnostic number field"),
    );
  },
  optional<Input>(
    encoder: DiagnosticFieldEncoder<Input>,
  ): DiagnosticFieldEncoder<Input | undefined> {
    if (!encoders.has(encoder)) {
      throw new TypeError("unknown diagnostic field encoder");
    }
    const internal = encoder as InternalFieldEncoder<Input>;
    return createEncoder(
      (value, context) =>
        value === undefined ? undefined : internal.encode(value, context),
      true,
    );
  },
  path(): DiagnosticFieldEncoder<string> {
    return createEncoder((value, context) =>
      normalizeDiagnosticPath(value, context.roots),
    );
  },
  stringEnum<const Values extends readonly [string, ...string[]]>(
    values: Values,
  ): DiagnosticFieldEncoder<Values[number]> {
    const allowed = new Set<string>(values);
    return createEncoder((value) => {
      if (!allowed.has(value)) {
        throw new TypeError("diagnostic enum field contains an unknown value");
      }
      return truncateUtf8(value, MAX_SAFE_STRING_BYTES);
    });
  },
  url(): DiagnosticFieldEncoder<string> {
    return createEncoder((value) => normalizeDiagnosticUrl(value));
  },
});

export function defineDiagnosticEvent<
  const Event extends string,
  const Component extends DiagnosticsComponent,
  const Fields extends FieldMap,
>(specification: {
  readonly component: LiteralString<Component>;
  readonly event: LiteralString<Event>;
  readonly fields: Fields;
  readonly level: LogLevel;
}): DiagnosticEventDefinition<InputForFields<Fields>> {
  if (
    !EVENT_PATTERN.test(specification.event) ||
    specification.event.length > 96
  ) {
    throw new TypeError("diagnostic event must be a stable dotted identifier");
  }
  if (!COMPONENT_PATTERN.test(specification.component)) {
    throw new TypeError("diagnostic component must be a stable identifier");
  }
  const entries = Object.entries(specification.fields);
  if (entries.length > 16 || entries.some(([key]) => key === "truncated")) {
    throw new TypeError("diagnostic event has invalid fields");
  }
  for (const [key, encoder] of entries) {
    if (!/^[a-z][A-Za-z0-9]{0,63}$/.test(key) || !encoders.has(encoder)) {
      throw new TypeError("diagnostic event contains an invalid field encoder");
    }
  }
  const internalFields = Object.freeze(
    Object.fromEntries(entries) as unknown as Record<
      string,
      InternalFieldEncoder<unknown>
    >,
  );
  const definition = Object.freeze({
    [diagnosticEventDefinitionBrand]: (
      input: InputForFields<Fields>,
    ): InputForFields<Fields> => input,
    component: specification.component,
    event: specification.event,
    fields: internalFields,
    level: specification.level,
  }) as unknown as InternalDiagnosticEventDefinition<InputForFields<Fields>>;
  definitions.add(definition);
  return definition;
}

export interface Logger {
  emit<Input>(
    definition: DiagnosticEventDefinition<Input>,
    input: NoInfer<Input>,
  ): void;
}

export const NOOP_LOGGER: Logger = Object.freeze({
  emit(): void {
    return;
  },
});

export interface EncodedDiagnosticEvent {
  readonly level: LogLevel;
  readonly optionalFieldNames: readonly string[];
  readonly record: Readonly<Record<string, unknown>>;
}

export function encodeDiagnosticEvent<Input>(
  definition: DiagnosticEventDefinition<Input>,
  input: NoInfer<Input>,
  context: EncodingContext,
  timestamp: string,
): EncodedDiagnosticEvent {
  if (!definitions.has(definition)) {
    throw new TypeError("unrecognized diagnostic event definition");
  }
  const internal = definition as InternalDiagnosticEventDefinition<Input>;
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("diagnostic event input must be an object");
  }
  const inputRecord = input as Record<string, unknown>;
  const fieldNames = Object.keys(internal.fields);
  if (Object.keys(inputRecord).some((key) => !fieldNames.includes(key))) {
    throw new TypeError("diagnostic event input contains an undeclared field");
  }
  const record: Record<string, unknown> = {
    component: internal.component,
    event: internal.event,
    level: internal.level,
    ts: timestamp,
  };
  for (const fieldName of fieldNames) {
    const encoded = internal.fields[fieldName].encode(
      inputRecord[fieldName],
      context,
    );
    if (encoded !== undefined) {
      record[fieldName] = encoded;
    }
  }
  return {
    level: internal.level,
    optionalFieldNames: fieldNames.filter(
      (fieldName) => internal.fields[fieldName].optional,
    ),
    record,
  };
}

export function emitDiagnostic<Input>(
  logger: Logger,
  definition: DiagnosticEventDefinition<Input>,
  input: NoInfer<Input>,
): void {
  try {
    logger.emit(definition, input);
  } catch {
    // Injected diagnostics must never change the product operation.
  }
}

export const LOG_LEVEL_PRIORITY: Readonly<Record<LogLevel, number>> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
  trace: 4,
};
