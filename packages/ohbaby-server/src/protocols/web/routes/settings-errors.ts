import type {
  UiSettingsErrorCode,
  UiSettingsErrorResponse,
  UiSettingsFieldError,
} from "ohbaby-sdk";

interface IssueLike {
  readonly code?: unknown;
  readonly path?: unknown;
  readonly validation?: unknown;
  readonly expected?: unknown;
  readonly received?: unknown;
  readonly type?: unknown;
  readonly minimum?: unknown;
  readonly maximum?: unknown;
  readonly inclusive?: unknown;
  readonly options?: unknown;
}

export function settingsErrorBody(
  code: UiSettingsErrorCode,
  message: string,
  fields?: readonly UiSettingsFieldError[],
): UiSettingsErrorResponse {
  return {
    ok: false,
    error: { code, message, ...(fields === undefined ? {} : { fields }) },
  };
}

/**
 * Field paths and fixed wording for a validation failure. Zod's own messages
 * can quote the submitted value (an enum's `received '…'`), so they are never
 * forwarded; only the path and a message chosen by issue kind leave the server.
 */
export function validationFields(error: unknown): UiSettingsFieldError[] {
  return validationIssues(error).map((issue) => ({
    path: Array.isArray(issue.path)
      ? issue.path.filter(
          (part): part is string | number =>
            typeof part === "string" || typeof part === "number",
        )
      : [],
    message: issueMessage(issue),
  }));
}

function validationIssues(error: unknown): IssueLike[] {
  if (typeof error !== "object" || error === null) return [];
  const direct = (error as { issues?: unknown }).issues;
  if (Array.isArray(direct)) return direct as IssueLike[];
  const context = (error as { context?: { issues?: unknown } }).context;
  return Array.isArray(context?.issues) ? (context.issues as IssueLike[]) : [];
}

function issueMessage(issue: IssueLike): string {
  switch (issue.code) {
    case "invalid_type":
      if (issue.received === "undefined") return "Required";
      if (issue.expected === "integer") return "Must be a whole number";
      return `Must be a ${typeName(issue.expected)}`;
    case "invalid_string":
      if (issue.validation === "url") return "Must be an http or https URL";
      return "Has an invalid format";
    case "invalid_enum_value":
      return Array.isArray(issue.options) && issue.options.length > 0
        ? `Must be one of: ${issue.options.map(String).join(", ")}`
        : "Is not an allowed value";
    case "too_small":
      if (issue.type === "string") return "Required";
      if (
        typeof issue.minimum === "number" ||
        typeof issue.minimum === "bigint"
      )
        return issue.inclusive === false
          ? `Must be greater than ${String(issue.minimum)}`
          : `Must be at least ${String(issue.minimum)}`;
      return "Is too small";
    case "too_big":
      if (
        typeof issue.maximum === "number" ||
        typeof issue.maximum === "bigint"
      )
        return issue.inclusive === false
          ? `Must be less than ${String(issue.maximum)}`
          : `Must be at most ${String(issue.maximum)}`;
      return "Is too large";
    case "unrecognized_keys":
      return "Contains unknown fields";
    default:
      // A refine on an address field, e.g. the model Base URL's scheme check.
      if (Array.isArray(issue.path) && /url$/iu.test(String(issue.path.at(-1))))
        return "Must be an http or https URL";
      return "Is not valid";
  }
}

function typeName(expected: unknown): string {
  if (expected === "string") return "text value";
  if (expected === "number") return "number";
  if (expected === "boolean") return "true or false value";
  if (expected === "array") return "list";
  if (expected === "object") return "group of fields";
  return "valid value";
}
