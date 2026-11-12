import { ArrowLeft } from "lucide-react";
import type {
  UiReasoningConfig,
  UiSettingsModel,
  UiSettingsModels,
} from "ohbaby-sdk";
import type { ReactElement } from "react";
import { useId, useMemo, useRef, useState } from "react";
import { isDaemonRequestError } from "../../api/daemon/http.js";
import type { SettingsLayer } from "../../runtime/settings-layer.js";
import { ConfirmDialog } from "../shared/ConfirmDialog.js";
import { IconButton } from "../shared/IconButton.js";
import { Spinner } from "../shared/Spinner.js";
import { FieldRow, fieldErrorId, MoreOptions } from "./FieldRow.js";
import {
  EMPTY_MODEL_FORM,
  fieldErrorsFrom,
  modelCreateRequest,
  modelFormFrom,
  modelFormSavable,
  modelDeleteDescription,
  modelPatchRequest,
  PROTOCOLS,
  UNCLEARABLE,
  TOKEN_FIELDS,
  validateModelForm,
  type FieldErrors,
  type ModelField,
  type ModelForm,
} from "./model-form.js";
import { SecretField } from "./SecretField.js";
import { errorText } from "./useSettingsResource.js";

/** The More options fields. */
const MORE_OPTIONS_FIELDS = [
  "apiKeyEnv",
  "contextWindowTokens",
  "maxOutputTokens",
  "promptCache",
] as const;
type UnclearableField = (typeof UNCLEARABLE)[number];

function isUnclearable(field: ModelField): field is UnclearableField {
  return (UNCLEARABLE as readonly string[]).includes(field);
}

function tokens(value: number): string {
  return `${value.toLocaleString("en-US")} tokens`;
}

/**
 * What an empty Context window uses: the detected value, read-only. The
 * runtime fallback is not a detection result, so it is never shown here.
 */
function AutoContextNote(props: {
  readonly entry: UiSettingsModel;
}): ReactElement {
  const { contextDiscovery: discovery, detectedContextWindowTokens: detected } =
    props.entry;
  const detecting = discovery.status === "detecting";
  const failure = detectionFailure(discovery.reason);
  const text =
    detected !== undefined
      ? `Detected: ${tokens(detected)}`
      : detecting
        ? "Detecting…"
        : "Not detected";
  return (
    <p className="ohb-field-note">
      {detecting ? (
        <Spinner size={12} label="Detecting context window" />
      ) : null}
      {text}
      {!detecting && discovery.reason
        ? detected !== undefined
          ? " · Couldn’t refresh. Using previous value."
          : failure
            ? ` · ${failure}`
            : null
        : null}
    </p>
  );
}

function detectionFailure(reason: string | undefined): string | undefined {
  if (
    !reason ||
    [
      "missing-fields",
      "model-not-found",
      "ignored-reasoning",
      "unsupported-efforts",
    ].includes(reason)
  )
    return undefined;
  if (reason === "authentication" || reason === "missing-credential")
    return "Check API key.";
  if (reason === "rate-limit") return "Rate limited. Try again.";
  return "Detection failed. Try again.";
}

/** Repairable problems with this entry; Settings stays usable. */
function ModelWarnings(props: {
  readonly entry: UiSettingsModel;
}): ReactElement {
  const { reasoningNotice, tokenBudgetIssue: issue } = props.entry;
  return (
    <>
      {reasoningNotice ? (
        <p className="ohb-settings-warning" role="status">
          {REASONING_NOTICE[reasoningNotice]}
        </p>
      ) : null}
      {issue ? (
        <p className="ohb-settings-warning" role="status">
          Max output ({tokens(issue.maxOutputTokens)}) doesn&apos;t fit the
          context window ({tokens(issue.contextWindowTokens)}). Lower Max output
          or correct Context window.
        </p>
      ) : null}
    </>
  );
}

const REASONING_NOTICE: Record<
  NonNullable<UiSettingsModel["reasoningNotice"]>,
  string
> = {
  "unsupported-anthropic-effort-cleared":
    "Unsupported minimal effort was cleared. Using model default.",
};

/** `""` keeps the model's own default; the rest map to a saved preference. */
function reasoningValue(reasoning: UiReasoningConfig | undefined): string {
  if (!reasoning) return "";
  if (reasoning.enabled === false) return "off";
  return reasoning.effort ?? "on";
}

/**
 * The levels a capability offers, or `null` while there is nothing to pick.
 * Levels already found stay usable while detection runs again.
 */
function thinkingOptions(
  view: UiSettingsModel["reasoning"],
): readonly { readonly value: string; readonly label: string }[] | null {
  if (
    view.status === "unknown" ||
    view.mode === undefined ||
    view.mode === "none"
  )
    return null;
  return [
    ...(view.supportsDisabled ? [{ value: "off", label: "Off" }] : []),
    ...(view.mode === "binary"
      ? [{ value: "on", label: "On" }]
      : view.efforts.map((effort) => ({ value: effort, label: effort }))),
  ];
}

function reasoningFrom(value: string): UiReasoningConfig | null {
  if (value === "") return null;
  if (value === "off") return { enabled: false };
  if (value === "on") return { enabled: true };
  return { enabled: true, effort: value };
}

/**
 * The add and edit sub-page of Models (03 §4.7). Common fields are listed;
 * Key variable, Context window, Max output and Prompt cache sit under More
 * options. Only changed fields are sent. The server makes the first complete
 * entry the default when there is none (session-model 02 P16). Editing a
 * complete entry also shows its Reasoning Effort levels, with Detect again
 * and the level its chats start from (D13). The two token fields hold the
 * user's overrides only; detection results are shown beside them read-only
 * and never enter the form.
 */
export function ModelEditor(props: {
  readonly settings: SettingsLayer;
  /** Absent for Add model. */
  readonly entry?: UiSettingsModel;
  readonly models: UiSettingsModels;
  readonly onBack: () => void;
  readonly onSaved: () => void;
  /** The entry was deleted elsewhere (`MODEL_NOT_FOUND`). */
  readonly onMissing: () => void;
}): ReactElement {
  const { entry, settings } = props;
  const baseId = useId();
  // Keep the edit's baseline: a reread must not turn untouched old values
  // into changes that overwrite another window's settings.
  const [baseline] = useState(() => (entry ? modelFormFrom(entry) : null));
  const [form, setForm] = useState<ModelForm>(
    () => baseline ?? EMPTY_MODEL_FORM,
  );
  const [touched, setTouched] = useState<ReadonlySet<ModelField>>(new Set());
  const [serverErrors, setServerErrors] = useState<FieldErrors>({});
  const [moreOpen, setMoreOpen] = useState(
    () => entry?.tokenBudgetIssue !== undefined,
  );
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [baselineReasoning] = useState(() =>
    reasoningValue(entry?.reasoningDefault),
  );
  const [picked, setReasoning] = useState(baselineReasoning);
  // Display compatibility does not change the user's draft or its baseline.
  const offered = entry ? thinkingOptions(entry.reasoning) : null;
  const reasoningChanged = picked !== baselineReasoning;
  const unavailablePick =
    entry?.reasoning.status === "identified" &&
    picked !== "" &&
    !offered?.some((option) => option.value === picked);
  const invalidReasoningDraft = reasoningChanged && unavailablePick;
  const reasoning = unavailablePick && !reasoningChanged ? "" : picked;
  const [probing, setProbing] = useState(false);
  const [probeError, setProbeError] = useState<string | null>(null);
  // Detect again may be pressed again; the server cancels the older task,
  // and only the latest press settles this page.
  const probeRun = useRef(0);
  const needsSetup = entry?.configurationComplete === false;
  const busy = saving || deleting;
  const localErrors = validateModelForm(form, baseline);
  const savable =
    !busy &&
    !invalidReasoningDraft &&
    (modelFormSavable(form, baseline, needsSetup) ||
      (reasoningChanged && Object.keys(localErrors).length === 0));
  const providers = useMemo(
    () => [...new Set(props.models.models.map((model) => model.provider))],
    [props.models.models],
  );

  // An emptied saved value blocks Save, so say why at once (06 §2.2).
  const cleared = (field: ModelField): boolean =>
    baseline !== null &&
    isUnclearable(field) &&
    baseline[field] !== "" &&
    form[field].trim() === "";
  const errorFor = (field: ModelField): string | undefined =>
    serverErrors[field] ??
    (touched.has(field) || cleared(field) ? localErrors[field] : undefined);
  const restore = (field: UnclearableField): ReactElement | undefined =>
    cleared(field) && baseline ? (
      <button
        type="button"
        className="ohb-text-button"
        onClick={() => {
          set(field, baseline[field]);
        }}
      >
        Restore
      </button>
    ) : undefined;
  const set = <F extends keyof ModelForm>(
    field: F,
    value: ModelForm[F],
  ): void => {
    setForm((current) => ({ ...current, [field]: value }));
    setServerErrors((current) => {
      const key = field === "secret" ? "apiKey" : field;
      if (!(key in current) && !current.form) return current;
      const { [key]: _removed, form: _form, ...rest } = current;
      return rest;
    });
  };
  const touch = (field: ModelField): void => {
    setTouched((current) => new Set(current).add(field));
  };

  const save = async (): Promise<void> => {
    if (!savable) return;
    setSaving(true);
    setServerErrors({});
    try {
      if (!entry || !baseline) {
        await settings.createModel(modelCreateRequest(form));
      } else {
        await settings.updateModel(entry.id, {
          ...modelPatchRequest(
            form,
            baseline,
            // A refresh may have supplied a key reference during this edit.
            needsSetup && entry.apiKeyEnv === undefined,
          ),
          ...(reasoningChanged ? { reasoning: reasoningFrom(picked) } : {}),
        });
      }
      props.onSaved();
    } catch (error) {
      setSaving(false);
      if (isDaemonRequestError(error) && error.code === "MODEL_NOT_FOUND") {
        props.onMissing();
        return;
      }
      setServerErrors(
        isDaemonRequestError(error) && error.code === "VALIDATION_FAILED"
          ? fieldErrorsFrom(error.fields, "Check the highlighted fields.")
          : { form: errorText(error) },
      );
    }
  };

  const remove = async (): Promise<void> => {
    if (!entry) return;
    setDeleting(true);
    setDeleteError(null);
    try {
      await settings.deleteModel(entry.id);
      props.onSaved();
    } catch (error) {
      setDeleting(false);
      if (isDaemonRequestError(error) && error.code === "MODEL_NOT_FOUND") {
        props.onMissing();
        return;
      }
      setDeleteError(errorText(error));
    }
  };

  const input = (
    field: Exclude<ModelField, "apiKey" | "interfaceProvider" | "promptCache">,
    options: {
      readonly type?: string;
      readonly list?: string;
      readonly placeholder?: string;
    } = {},
  ): ReactElement => {
    const id = `${baseId}-${field}`;
    const error = errorFor(field);
    const tokenField = TOKEN_FIELDS.some((token) => token === field);
    return (
      <input
        id={id}
        className="ohb-settings-input"
        type={tokenField ? "text" : (options.type ?? "text")}
        inputMode={tokenField ? "numeric" : undefined}
        pattern={tokenField ? "[1-9][0-9]*" : undefined}
        list={options.list}
        placeholder={options.placeholder}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? fieldErrorId(id) : undefined}
        value={form[field]}
        onChange={(event) => {
          set(field, event.target.value);
          if (tokenField) touch(field);
        }}
        onBlur={() => {
          touch(field);
        }}
      />
    );
  };
  const probe = async (): Promise<void> => {
    if (!entry) return;
    const run = ++probeRun.current;
    setProbing(true);
    setProbeError(null);
    try {
      await settings.probeModel(entry.id);
    } catch (error) {
      if (run === probeRun.current) setProbeError(errorText(error));
    } finally {
      if (run === probeRun.current) setProbing(false);
    }
  };
  const id = (field: ModelField): string => `${baseId}-${field}`;
  const title = entry ? entry.model : "Add model";

  return (
    <div className="ohb-settings-editor">
      <div className="ohb-settings-editor-header">
        <IconButton
          label="Back to Models"
          onClick={props.onBack}
          disabled={busy}
        >
          <ArrowLeft aria-hidden="true" size={15} />
        </IconButton>
        <h3>
          <button
            type="button"
            className="ohb-settings-crumb"
            onClick={props.onBack}
            disabled={busy}
          >
            Models
          </button>
          <span aria-hidden="true">/</span>
          <span className="ohb-settings-crumb-current">{title}</span>
        </h3>
      </div>
      <form
        className="ohb-settings-form"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <fieldset className="ohb-settings-form-fields" disabled={busy}>
          <FieldRow
            id={id("provider")}
            label="Provider"
            error={errorFor("provider")}
          >
            {input("provider", { list: `${baseId}-providers` })}
            <datalist id={`${baseId}-providers`}>
              {providers.map((provider) => (
                <option key={provider} value={provider} />
              ))}
            </datalist>
          </FieldRow>
          <FieldRow id={id("model")} label="Model" error={errorFor("model")}>
            {input("model")}
          </FieldRow>
          <FieldRow
            id={id("baseUrl")}
            label="Base URL"
            error={errorFor("baseUrl")}
          >
            {input("baseUrl", { type: "url" })}
          </FieldRow>
          <FieldRow
            id={id("interfaceProvider")}
            label="Protocol"
            error={errorFor("interfaceProvider")}
          >
            <select
              id={id("interfaceProvider")}
              className="ohb-settings-select"
              value={form.interfaceProvider}
              onChange={(event) => {
                set(
                  "interfaceProvider",
                  event.target.value as ModelForm["interfaceProvider"],
                );
              }}
            >
              {form.interfaceProvider === "" ? (
                <option value="" disabled>
                  Choose a protocol
                </option>
              ) : null}
              {PROTOCOLS.map((protocol) => (
                <option key={protocol.value} value={protocol.value}>
                  {protocol.label}
                </option>
              ))}
            </select>
          </FieldRow>
          <FieldRow
            id={id("apiKey")}
            label="API key"
            error={errorFor("apiKey")}
          >
            <SecretField
              id={id("apiKey")}
              configured={entry?.apiKeyConfigured ?? false}
              startEditing={!entry}
              value={form.secret}
              invalid={errorFor("apiKey") !== undefined}
              describedBy={
                errorFor("apiKey") ? fieldErrorId(id("apiKey")) : undefined
              }
              onChange={(next) => {
                set("secret", next);
              }}
            />
          </FieldRow>
          <FieldRow id={id("label")} label="Label" error={errorFor("label")}>
            {input("label", { placeholder: "Optional" })}
          </FieldRow>
          {entry?.configurationComplete ? (
            <ReasoningEffortRow
              id={`${baseId}-reasoning`}
              entry={entry}
              value={reasoning}
              onChange={setReasoning}
              probing={probing}
              error={
                invalidReasoningDraft
                  ? "Choose an available effort."
                  : probeError
              }
              onProbe={() => {
                void probe();
              }}
            />
          ) : null}
          {entry ? <ModelWarnings entry={entry} /> : null}
          <MoreOptions
            // It opens by itself while one of its fields has an error.
            open={
              moreOpen ||
              MORE_OPTIONS_FIELDS.some((field) => errorFor(field) !== undefined)
            }
            onToggle={() => {
              setMoreOpen((open) => !open);
            }}
          >
            <FieldRow
              id={id("apiKeyEnv")}
              label="Key variable"
              error={errorFor("apiKeyEnv")}
              errorAction={restore("apiKeyEnv")}
            >
              {input("apiKeyEnv")}
            </FieldRow>
            <FieldRow
              id={id("contextWindowTokens")}
              label="Context window"
              hint="tokens"
              error={errorFor("contextWindowTokens")}
            >
              {input("contextWindowTokens", {
                type: "number",
                // Empty still means automatic; the note says what it uses.
                placeholder: "Optional",
              })}
              {entry ? <AutoContextNote entry={entry} /> : null}
            </FieldRow>
            <FieldRow
              id={id("maxOutputTokens")}
              label="Max output"
              hint="tokens per request"
              error={errorFor("maxOutputTokens")}
            >
              {input("maxOutputTokens", {
                type: "number",
                placeholder: "Optional",
              })}
            </FieldRow>
            <FieldRow
              id={id("promptCache")}
              label="Prompt cache"
              error={errorFor("promptCache")}
              errorAction={restore("promptCache")}
            >
              <select
                id={id("promptCache")}
                className="ohb-settings-select"
                value={form.promptCache}
                onChange={(event) => {
                  set(
                    "promptCache",
                    event.target.value as ModelForm["promptCache"],
                  );
                  touch("promptCache");
                }}
              >
                <option value="">Default</option>
                <option value="auto">Auto</option>
                <option value="enabled">Enabled</option>
                <option value="disabled">Disabled</option>
              </select>
            </FieldRow>
          </MoreOptions>
          <div className="ohb-settings-form-footer">
            {entry ? (
              <button
                type="button"
                className="ohb-text-button is-danger"
                disabled={saving || deleting}
                onClick={() => {
                  setConfirmDelete(true);
                }}
              >
                Delete
              </button>
            ) : null}
            <span className="ohb-settings-form-status" role="alert">
              {serverErrors.form ?? (confirmDelete ? null : deleteError)}
            </span>
            <button
              type="submit"
              className="ohb-primary-button"
              aria-busy={saving}
              disabled={!savable}
            >
              {saving ? "Saving…" : "Save"}
            </button>
          </div>
        </fieldset>
      </form>
      {confirmDelete && entry ? (
        <ConfirmDialog
          title={`Delete ${entry.model}?`}
          description={modelDeleteDescription(
            entry,
            props.models.models,
            props.models.active?.id,
          )}
          confirmLabel="Delete"
          danger
          busy={deleting}
          error={deleteError}
          onCancel={() => {
            setConfirmDelete(false);
            setDeleteError(null);
          }}
          onConfirm={() => {
            void remove();
          }}
        />
      ) : null}
    </div>
  );
}

/**
 * Reasoning Effort for a complete entry: what detection found, Detect again,
 * and, once levels are known, the level its chats start from. Known levels
 * stay usable while detection runs again.
 */
function ReasoningEffortRow(props: {
  readonly id: string;
  readonly entry: UiSettingsModel;
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly probing: boolean;
  readonly error: string | null;
  readonly onProbe: () => void;
}): ReactElement {
  const view = props.entry.reasoning;
  const detecting = props.probing || view.status === "detecting";
  const options = thinkingOptions(view);
  const modelDefault = options ? reasoningValue(view.default) : "";
  const unavailable =
    view.status === "identified" &&
    props.value !== "" &&
    !options?.some((option) => option.value === props.value);
  // Without known levels a saved level is kept but not sent (D3).
  const saved = reasoningValue(props.entry.reasoningDefault);
  const status = detecting
    ? "Detecting…"
    : view.status === "identified"
      ? view.mode === "none"
        ? "Not supported"
        : null
      : (detectionFailure(view.reason) ?? "Not detected");
  const note =
    !options && saved !== ""
      ? `Saved ${saved} is inactive.`
      : options && view.reason && !detecting
        ? "Couldn’t refresh. Using previous levels."
        : null;
  return (
    <FieldRow
      id={props.id}
      label="Reasoning Effort"
      error={props.error ?? undefined}
    >
      <div className="ohb-thinking-row">
        {options || unavailable ? (
          <select
            id={props.id}
            className="ohb-settings-select"
            aria-describedby={props.error ? fieldErrorId(props.id) : undefined}
            value={props.value}
            onChange={(event) => {
              props.onChange(event.target.value);
            }}
          >
            <option value="">
              {modelDefault
                ? `Model default (${modelDefault})`
                : "Model default"}
            </option>
            {unavailable ? (
              <option value={props.value} disabled>
                {props.value} (unavailable)
              </option>
            ) : null}
            {options?.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        ) : (
          <span id={props.id} className="ohb-thinking-status" role="status">
            {status}
          </span>
        )}
        {detecting ? (
          <Spinner size={12} label="Detecting Reasoning Effort" />
        ) : null}
        <button
          type="button"
          className="ohb-text-button"
          onClick={props.onProbe}
        >
          Detect again
        </button>
      </div>
      {note ? <p className="ohb-field-note">{note}</p> : null}
    </FieldRow>
  );
}
