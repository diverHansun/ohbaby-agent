import type {
  UiSettingsFieldError,
  UiSettingsModel,
  UiSettingsModelCreate,
  UiSettingsModelPatch,
  UiSettingsModels,
} from "ohbaby-sdk";
import { secretChanged, secretPatch, type SecretChange } from "./secret.js";

export type ModelProtocol = UiSettingsModelCreate["interfaceProvider"];
export type PromptCacheChoice = "" | "auto" | "enabled" | "disabled";

export const PROTOCOLS: readonly { value: ModelProtocol; label: string }[] = [
  { value: "openai-compatible", label: "OpenAI-compatible" },
  { value: "openai-responses", label: "OpenAI Responses" },
  { value: "anthropic", label: "Anthropic" },
];

/** Field values as typed; numbers stay text until submit (06 §2.2). */
export interface ModelForm {
  readonly provider: string;
  readonly model: string;
  readonly baseUrl: string;
  /** Empty only for a Needs setup entry saved without one. */
  readonly interfaceProvider: ModelProtocol | "";
  readonly label: string;
  readonly secret: SecretChange;
  readonly apiKeyEnv: string;
  readonly contextWindowTokens: string;
  readonly maxOutputTokens: string;
  readonly promptCache: PromptCacheChoice;
}

export type ModelField = Exclude<keyof ModelForm, "secret"> | "apiKey";
export type FieldErrors = Partial<Record<ModelField | "form", string>>;

export const EMPTY_MODEL_FORM: ModelForm = {
  provider: "",
  model: "",
  baseUrl: "",
  interfaceProvider: "openai-compatible",
  label: "",
  secret: "keep",
  apiKeyEnv: "",
  contextWindowTokens: "",
  maxOutputTokens: "",
  promptCache: "",
};

export function modelFormFrom(entry: UiSettingsModel): ModelForm {
  return {
    provider: entry.provider,
    model: entry.model,
    baseUrl: entry.baseUrl ?? "",
    interfaceProvider: entry.interfaceProvider ?? "",
    label: entry.label ?? "",
    secret: "keep",
    apiKeyEnv: entry.apiKeyEnv ?? "",
    contextWindowTokens: String(entry.contextWindowTokens),
    maxOutputTokens:
      entry.maxOutputTokens === undefined ? "" : String(entry.maxOutputTokens),
    promptCache: entry.promptCache ?? "",
  };
}

/** Fields with no clear protocol: an emptied saved value cannot be sent. */
const UNCLEARABLE = [
  "apiKeyEnv",
  "contextWindowTokens",
  "maxOutputTokens",
  "promptCache",
] as const satisfies readonly (keyof ModelForm)[];

const POSITIVE_INTEGER = /^[1-9]\d*$/u;

/**
 * Format checks only; the server validates the rest (D19). Returns the
 * errors that block Save, keyed by field.
 */
export function validateModelForm(
  form: ModelForm,
  saved: ModelForm | null,
): FieldErrors {
  const errors: FieldErrors = {};
  if (form.provider.trim() === "") errors.provider = "Required";
  if (form.model.trim() === "") errors.model = "Required";
  if (form.baseUrl.trim() === "") errors.baseUrl = "Required";
  else if (!/^https?:\/\//iu.test(form.baseUrl.trim()))
    errors.baseUrl = "Must be an http or https URL";
  else if (
    form.baseUrl.trim() !== saved?.baseUrl &&
    /\[REDACTED\]|%5BREDACTED%5D/iu.test(form.baseUrl)
  )
    errors.baseUrl =
      "Replace the entire URL; hidden credentials cannot be reused.";
  if (form.interfaceProvider === "") errors.interfaceProvider = "Required";
  for (const field of ["contextWindowTokens", "maxOutputTokens"] as const)
    if (form[field].trim() !== "" && !POSITIVE_INTEGER.test(form[field].trim()))
      errors[field] = "Must be a whole number greater than 0";
  if (
    form.apiKeyEnv.trim() !== "" &&
    !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(form.apiKeyEnv.trim())
  )
    errors.apiKeyEnv =
      "Letters, digits and underscores; not starting with a digit";
  if (saved)
    for (const field of UNCLEARABLE)
      if (saved[field] !== "" && form[field].trim() === "")
        errors[field] =
          "This can't be cleared. Restore the saved value to save.";
  return errors;
}

function text(value: string): string | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function count(value: string): number | undefined {
  const trimmed = value.trim();
  return trimmed === "" ? undefined : Number(trimmed);
}

/** A new entry: empty optional fields are left out, never sent as "". */
export function modelCreateRequest(form: ModelForm): UiSettingsModelCreate {
  const apiKey = secretPatch(form.secret);
  const label = text(form.label);
  const apiKeyEnv = text(form.apiKeyEnv);
  const contextWindowTokens = count(form.contextWindowTokens);
  const maxOutputTokens = count(form.maxOutputTokens);
  return {
    provider: form.provider.trim(),
    model: form.model.trim(),
    baseUrl: form.baseUrl.trim(),
    interfaceProvider:
      form.interfaceProvider === ""
        ? "openai-compatible"
        : form.interfaceProvider,
    ...(label === undefined ? {} : { label }),
    ...(apiKey ? { apiKey } : {}),
    ...(apiKeyEnv === undefined ? {} : { apiKeyEnv }),
    ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
    ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
    ...(form.promptCache === "" ? {} : { promptCache: form.promptCache }),
  };
}

/**
 * Only the fields that differ from `saved`. An emptied label is `null`; a
 * cleared key is `apiKey: ""`. Unclearable fields never reach here empty
 * because validation blocks them.
 */
export function modelPatchRequest(
  form: ModelForm,
  saved: ModelForm,
  needsSetup = false,
): UiSettingsModelPatch {
  const patch: {
    -readonly [K in keyof UiSettingsModelPatch]: UiSettingsModelPatch[K];
  } = {};
  for (const field of ["provider", "model", "baseUrl"] as const)
    if (form[field].trim() !== saved[field]) patch[field] = form[field].trim();
  if (
    form.interfaceProvider !== saved.interfaceProvider &&
    form.interfaceProvider !== ""
  )
    patch.interfaceProvider = form.interfaceProvider;
  if (form.label.trim() !== saved.label)
    patch.label = form.label.trim() === "" ? null : form.label.trim();
  if (secretChanged(form.secret)) patch.apiKey = secretPatch(form.secret);
  if (form.apiKeyEnv.trim() !== saved.apiKeyEnv && form.apiKeyEnv.trim() !== "")
    patch.apiKeyEnv = form.apiKeyEnv.trim();
  // Legacy entries require an explicit credential choice to finish setup.
  // Confirm keyless only when neither a saved reference nor a new key exists.
  if (
    needsSetup &&
    saved.apiKeyEnv === "" &&
    form.apiKeyEnv.trim() === "" &&
    !secretChanged(form.secret)
  )
    patch.apiKeyEnv = null;
  for (const field of ["contextWindowTokens", "maxOutputTokens"] as const)
    if (form[field].trim() !== saved[field] && form[field].trim() !== "")
      patch[field] = Number(form[field].trim());
  if (form.promptCache !== saved.promptCache && form.promptCache !== "")
    patch.promptCache = form.promptCache;
  return patch;
}

/**
 * Save is offered when something changed, or when a Needs setup entry now
 * has everything it was missing (04 §2.6).
 */
export function modelFormSavable(
  form: ModelForm,
  saved: ModelForm | null,
  needsSetup: boolean,
): boolean {
  if (Object.keys(validateModelForm(form, saved)).length > 0) return false;
  if (saved === null) return true;
  return (
    needsSetup ||
    Object.keys(modelPatchRequest(form, saved, needsSetup)).length > 0
  );
}

const FIELD_NAMES: ReadonlySet<string> = new Set<ModelField>([
  "provider",
  "model",
  "baseUrl",
  "interfaceProvider",
  "label",
  "apiKey",
  "apiKeyEnv",
  "contextWindowTokens",
  "maxOutputTokens",
  "promptCache",
]);

/** Server field errors under their inputs; anything else goes beside Save. */
export function fieldErrorsFrom(
  fields: readonly UiSettingsFieldError[] | undefined,
  fallback: string,
): FieldErrors {
  const errors: FieldErrors = {};
  for (const field of fields ?? []) {
    const name = field.path.map(String).join(".");
    if (FIELD_NAMES.has(name)) errors[name as ModelField] ??= field.message;
    else
      errors.form ??= name === "" ? field.message : `${name}: ${field.message}`;
  }
  if (Object.keys(errors).length === 0) errors.form = fallback;
  return errors;
}

/** The entry D20 makes default: the last one in this POST's own response. */
export function createdModelId(models: UiSettingsModels): string | undefined {
  return models.models.at(-1)?.id;
}

export interface SettingsModelGroup {
  readonly provider: string;
  readonly models: readonly UiSettingsModel[];
}

/** Provider groups in first-seen order; rows keep the server order (06 §2.2). */
export function groupModels(
  models: readonly UiSettingsModel[],
): SettingsModelGroup[] {
  const groups = new Map<string, UiSettingsModel[]>();
  for (const model of models) {
    const group = groups.get(model.provider);
    if (group) group.push(model);
    else groups.set(model.provider, [model]);
  }
  return [...groups].map(([provider, rows]) => ({ provider, models: rows }));
}

/** "model-x · Work", or the model name alone without a label. */
export function modelTitle(model: UiSettingsModel): string {
  return model.label ? `${model.model} · ${model.label}` : model.model;
}
