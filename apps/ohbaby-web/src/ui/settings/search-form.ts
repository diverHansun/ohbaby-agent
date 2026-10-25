import type {
  UiSettingsFieldError,
  UiSettingsSearch,
  UiSettingsSearchDefaults,
  UiSettingsSearchUpdate,
} from "ohbaby-sdk";
import { secretChanged, secretPatch, type SecretChange } from "./secret.js";

export interface SearchForm {
  readonly secret: SecretChange;
  readonly apiKeyEnv: string;
  readonly baseUrl: string;
  readonly searchDepth: UiSettingsSearchDefaults["searchDepth"];
  readonly maxResults: string;
  readonly topic: UiSettingsSearchDefaults["topic"];
  readonly timeout: string;
}

export type SearchField = Exclude<keyof SearchForm, "secret"> | "apiKey";
export type SearchErrors = Partial<Record<SearchField | "form", string>>;

export function searchFormFrom(settings: UiSettingsSearch): SearchForm {
  return {
    secret: "keep",
    apiKeyEnv: settings.apiKeyEnv ?? "",
    baseUrl: settings.baseUrl ?? "",
    searchDepth: settings.defaults.searchDepth,
    maxResults: String(settings.defaults.maxResults),
    topic: settings.defaults.topic,
    timeout: String(settings.defaults.timeout),
  };
}

function inRange(value: string, min: number, max: number): boolean {
  if (!/^\d+$/u.test(value.trim())) return false;
  const number = Number(value.trim());
  return number >= min && number <= max;
}

/** Ranges follow the server: 1–20 results, 1–600 seconds (06 §2.2). */
export function validateSearchForm(
  form: SearchForm,
  saved: SearchForm,
): SearchErrors {
  const errors: SearchErrors = {};
  if (!inRange(form.maxResults, 1, 20))
    errors.maxResults = "Must be a whole number from 1 to 20";
  if (!inRange(form.timeout, 1, 600))
    errors.timeout = "Must be a whole number from 1 to 600";
  if (form.baseUrl.trim() !== "" && !/^https?:\/\//iu.test(form.baseUrl.trim()))
    errors.baseUrl = "Must be an http or https URL";
  else if (
    form.baseUrl.trim() !== saved.baseUrl &&
    /\[REDACTED\]|%5BREDACTED%5D/iu.test(form.baseUrl)
  )
    errors.baseUrl =
      "Replace the entire URL; hidden credentials cannot be reused.";
  if (
    form.apiKeyEnv.trim() !== "" &&
    !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(form.apiKeyEnv.trim())
  )
    errors.apiKeyEnv =
      "Letters, digits and underscores; not starting with a digit";
  // Clearing the variable name would detach the key; Clear does that instead.
  if (saved.apiKeyEnv !== "" && form.apiKeyEnv.trim() === "")
    errors.apiKeyEnv = "Use Clear on the API key to remove it.";
  return errors;
}

/** Only changed fields; an emptied Base URL is `null` (06 §2.2). */
export function searchUpdateRequest(
  form: SearchForm,
  saved: SearchForm,
): UiSettingsSearchUpdate {
  const defaults: Partial<UiSettingsSearchDefaults> = {
    ...(form.searchDepth === saved.searchDepth
      ? {}
      : { searchDepth: form.searchDepth }),
    ...(form.topic === saved.topic ? {} : { topic: form.topic }),
    ...(form.maxResults.trim() === saved.maxResults
      ? {}
      : { maxResults: Number(form.maxResults.trim()) }),
    ...(form.timeout.trim() === saved.timeout
      ? {}
      : { timeout: Number(form.timeout.trim()) }),
  };
  const baseUrl = form.baseUrl.trim();
  const apiKeyEnv = form.apiKeyEnv.trim();
  return {
    ...(secretChanged(form.secret) ? { apiKey: secretPatch(form.secret) } : {}),
    ...(apiKeyEnv !== saved.apiKeyEnv && apiKeyEnv !== "" ? { apiKeyEnv } : {}),
    ...(baseUrl === saved.baseUrl
      ? {}
      : { baseUrl: baseUrl === "" ? null : baseUrl }),
    ...(Object.keys(defaults).length === 0 ? {} : { defaults }),
  };
}

const FIELDS: ReadonlyMap<string, SearchField> = new Map([
  ["apiKey", "apiKey"],
  ["apiKeyEnv", "apiKeyEnv"],
  ["baseUrl", "baseUrl"],
  ["defaults.searchDepth", "searchDepth"],
  ["defaults.maxResults", "maxResults"],
  ["defaults.topic", "topic"],
  ["defaults.timeout", "timeout"],
]);

export function searchErrorsFrom(
  fields: readonly UiSettingsFieldError[] | undefined,
  fallback: string,
): SearchErrors {
  const errors: SearchErrors = {};
  for (const field of fields ?? []) {
    const name = field.path.map(String).join(".");
    const target = FIELDS.get(name);
    if (target) errors[target] ??= field.message;
    else
      errors.form ??= name === "" ? field.message : `${name}: ${field.message}`;
  }
  if (Object.keys(errors).length === 0) errors.form = fallback;
  return errors;
}
