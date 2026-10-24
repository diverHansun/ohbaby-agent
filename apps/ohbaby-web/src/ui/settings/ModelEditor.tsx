import { ArrowLeft } from "lucide-react";
import type { UiSettingsModel, UiSettingsModels } from "ohbaby-sdk";
import type { ReactElement } from "react";
import { useId, useMemo, useState } from "react";
import { isDaemonRequestError } from "../../api/daemon/http.js";
import type { SettingsLayer } from "../../runtime/settings-layer.js";
import { ConfirmDialog } from "../shared/ConfirmDialog.js";
import { IconButton } from "../shared/IconButton.js";
import { FieldRow, fieldErrorId, MoreOptions } from "./FieldRow.js";
import {
  createdModelId,
  EMPTY_MODEL_FORM,
  fieldErrorsFrom,
  modelCreateRequest,
  modelFormFrom,
  modelFormSavable,
  modelPatchRequest,
  PROTOCOLS,
  validateModelForm,
  type FieldErrors,
  type ModelField,
  type ModelForm,
} from "./model-form.js";
import { SecretField } from "./SecretField.js";

/** The More options fields; none has a clear protocol (06 §2.2). */
const UNCLEARABLE_FIELDS = [
  "apiKeyEnv",
  "contextWindowTokens",
  "maxOutputTokens",
  "promptCache",
] as const;
type UnclearableField = (typeof UNCLEARABLE_FIELDS)[number];

function isUnclearable(field: ModelField): field is UnclearableField {
  return (UNCLEARABLE_FIELDS as readonly string[]).includes(field);
}
import { errorText } from "./useSettingsResource.js";

/** What happened to the default after a save, for the list to show. */
export interface ModelSaveOutcome {
  /** D20 tried to make this entry the default and failed (04 §2.6). */
  readonly defaultError?: { readonly id: string; readonly message: string };
}

/**
 * The add and edit sub-page of Models (03 §4.7). Common fields are listed;
 * Key variable, Context window, Max output and Prompt cache sit under More
 * options. Only changed fields are sent; without a default model the saved
 * entry becomes the default right after (D20).
 */
export function ModelEditor(props: {
  readonly settings: SettingsLayer;
  /** Absent for Add model. */
  readonly entry?: UiSettingsModel;
  readonly models: UiSettingsModels;
  readonly onBack: () => void;
  readonly onSaved: (outcome: ModelSaveOutcome) => void;
  /** The entry was deleted elsewhere (`MODEL_NOT_FOUND`). */
  readonly onMissing: () => void;
}): ReactElement {
  const { entry, settings } = props;
  const baseId = useId();
  // The saved values follow the cache; the typed values never do (06 §3.7).
  const saved = useMemo(() => (entry ? modelFormFrom(entry) : null), [entry]);
  const [form, setForm] = useState<ModelForm>(() => saved ?? EMPTY_MODEL_FORM);
  const [touched, setTouched] = useState<ReadonlySet<ModelField>>(new Set());
  const [serverErrors, setServerErrors] = useState<FieldErrors>({});
  const [moreOpen, setMoreOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const needsSetup = entry?.configurationComplete === false;
  const isDefault = entry !== undefined && props.models.active?.id === entry.id;
  const localErrors = validateModelForm(form, saved);
  const savable = !saving && modelFormSavable(form, saved, needsSetup);
  const providers = useMemo(
    () => [...new Set(props.models.models.map((model) => model.provider))],
    [props.models.models],
  );

  // An emptied saved value blocks Save, so say why at once (06 §2.2).
  const cleared = (field: ModelField): boolean =>
    saved !== null &&
    isUnclearable(field) &&
    saved[field] !== "" &&
    form[field].trim() === "";
  const errorFor = (field: ModelField): string | undefined =>
    serverErrors[field] ??
    (touched.has(field) || cleared(field) ? localErrors[field] : undefined);
  const restore = (field: UnclearableField): ReactElement | undefined =>
    cleared(field) && saved ? (
      <button
        type="button"
        className="ohb-text-button"
        onClick={() => {
          set(field, saved[field]);
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
      let result: UiSettingsModels;
      let id: string | undefined;
      if (!entry || !saved) {
        result = await settings.createModel(modelCreateRequest(form));
        id = createdModelId(result);
      } else {
        result = await settings.updateModel(
          entry.id,
          modelPatchRequest(form, saved),
        );
        // A Needs setup entry that is now complete may become the default.
        id = needsSetup ? entry.id : undefined;
      }
      const target = result.models.find((model) => model.id === id);
      if (result.active === null && target?.configurationComplete) {
        try {
          await settings.selectModel(target.id);
        } catch (error) {
          props.onSaved({
            defaultError: { id: target.id, message: errorText(error) },
          });
          return;
        }
      }
      props.onSaved({});
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
      props.onSaved({});
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
    options: { readonly type?: string; readonly list?: string } = {},
  ): ReactElement => {
    const id = `${baseId}-${field}`;
    const error = errorFor(field);
    return (
      <input
        id={id}
        className="ohb-settings-input"
        type={options.type ?? "text"}
        inputMode={options.type === "number" ? "numeric" : undefined}
        list={options.list}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? fieldErrorId(id) : undefined}
        value={form[field]}
        onChange={(event) => {
          set(field, event.target.value);
        }}
        onBlur={() => {
          touch(field);
        }}
      />
    );
  };
  const id = (field: ModelField): string => `${baseId}-${field}`;
  const title = entry ? entry.model : "Add model";

  return (
    <div className="ohb-settings-editor">
      <div className="ohb-settings-editor-header">
        <IconButton label="Back to Models" onClick={props.onBack}>
          <ArrowLeft aria-hidden="true" size={15} />
        </IconButton>
        <h3>
          <button
            type="button"
            className="ohb-settings-crumb"
            onClick={props.onBack}
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
        <FieldRow id={id("apiKey")} label="API key" error={errorFor("apiKey")}>
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
          {input("label")}
        </FieldRow>
        <MoreOptions
          // It opens by itself while one of its fields has an error.
          open={
            moreOpen ||
            UNCLEARABLE_FIELDS.some((field) => errorFor(field) !== undefined)
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
            errorAction={restore("contextWindowTokens")}
          >
            {input("contextWindowTokens", { type: "number" })}
          </FieldRow>
          <FieldRow
            id={id("maxOutputTokens")}
            label="Max output"
            hint="tokens"
            error={errorFor("maxOutputTokens")}
            errorAction={restore("maxOutputTokens")}
          >
            {input("maxOutputTokens", { type: "number" })}
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
                if (isDefault) setConfirmDelete(true);
                else void remove();
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
      </form>
      {confirmDelete && entry ? (
        <ConfirmDialog
          title={`Delete ${entry.model}?`}
          description={
            props.models.models.some(
              (model) => model.id !== entry.id && model.configurationComplete,
            )
              ? "The next available model becomes the default."
              : "No model will be the default."
          }
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
