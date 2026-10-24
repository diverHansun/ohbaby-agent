import type { UiSettingsSearch } from "ohbaby-sdk";
import type { ReactElement } from "react";
import { useId, useState } from "react";
import { isDaemonRequestError } from "../../api/daemon/http.js";
import type { SettingsLayer } from "../../runtime/settings-layer.js";
import { FieldRow, fieldErrorId, MoreOptions } from "./FieldRow.js";
import {
  searchErrorsFrom,
  searchFormFrom,
  searchUpdateRequest,
  validateSearchForm,
  type SearchErrors,
  type SearchField,
  type SearchForm,
} from "./search-form.js";
import { SecretField } from "./SecretField.js";
import { SectionHeader, SectionStatus } from "./SectionFrame.js";
import { errorText, useSettingsResource } from "./useSettingsResource.js";

/**
 * Web search: one form (03 §4.7). The API key shows Configured or Not set;
 * More options holds the key variable, Base URL and search defaults. Only
 * changed fields are sent, and Save goes back to disabled on success.
 */
export function SearchSection(props: {
  readonly settings: SettingsLayer;
  readonly visible: boolean;
}): ReactElement {
  const resource = useSettingsResource(props.settings, "search", props.visible);
  return (
    <section className="ohb-settings-section" aria-label="Web search">
      <SectionHeader title="Web search" />
      <SectionStatus resource={resource} />
      {resource.data ? (
        <SearchFormView settings={props.settings} saved={resource.data} />
      ) : null}
    </section>
  );
}

function SearchFormView(props: {
  readonly settings: SettingsLayer;
  readonly saved: UiSettingsSearch;
}): ReactElement {
  const baseId = useId();
  const saved = searchFormFrom(props.saved);
  // Null while untouched: rereads then show the newest saved values; typed
  // values are never replaced by a reread (06 §3.7).
  const [draft, setDraft] = useState<SearchForm | null>(null);
  const [serverErrors, setServerErrors] = useState<SearchErrors>({});
  const [moreOpen, setMoreOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const form = draft ?? saved;
  const localErrors = validateSearchForm(form, saved);
  const patch = searchUpdateRequest(form, saved);
  const savable =
    !saving &&
    Object.keys(localErrors).length === 0 &&
    Object.keys(patch).length > 0;
  const errorFor = (field: SearchField): string | undefined =>
    serverErrors[field] ?? (draft ? localErrors[field] : undefined);
  const id = (field: SearchField): string => `${baseId}-${field}`;
  const set = <F extends keyof SearchForm>(
    field: F,
    value: SearchForm[F],
  ): void => {
    setDraft({ ...form, [field]: value });
    setServerErrors({});
  };

  const save = async (): Promise<void> => {
    if (!savable) return;
    setSaving(true);
    setServerErrors({});
    try {
      await props.settings.updateSearch(patch);
      setDraft(null);
    } catch (error) {
      setServerErrors(
        isDaemonRequestError(error) && error.code === "VALIDATION_FAILED"
          ? searchErrorsFrom(error.fields, "Check the highlighted fields.")
          : { form: errorText(error) },
      );
    } finally {
      setSaving(false);
    }
  };

  const text = (
    field: "apiKeyEnv" | "baseUrl" | "maxResults" | "timeout",
    type = "text",
  ): ReactElement => {
    const error = errorFor(field);
    return (
      <input
        id={id(field)}
        className="ohb-settings-input"
        type={type}
        inputMode={type === "number" ? "numeric" : undefined}
        autoComplete="off"
        spellCheck={false}
        aria-invalid={error ? true : undefined}
        aria-describedby={error ? fieldErrorId(id(field)) : undefined}
        value={form[field]}
        onChange={(event) => {
          set(field, event.target.value);
        }}
      />
    );
  };

  return (
    <form
      className="ohb-settings-form"
      noValidate
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <FieldRow id={id("apiKey")} label="API key" error={errorFor("apiKey")}>
        <SecretField
          id={id("apiKey")}
          configured={props.saved.apiKeyConfigured}
          value={form.secret}
          onChange={(next) => {
            set("secret", next);
          }}
        />
      </FieldRow>
      <MoreOptions
        open={
          moreOpen ||
          (
            [
              "apiKeyEnv",
              "baseUrl",
              "searchDepth",
              "maxResults",
              "topic",
              "timeout",
            ] as const
          ).some((field) => errorFor(field) !== undefined)
        }
        onToggle={() => {
          setMoreOpen((open) => !open);
        }}
      >
        <FieldRow
          id={id("apiKeyEnv")}
          label="Key variable"
          error={errorFor("apiKeyEnv")}
        >
          {text("apiKeyEnv")}
        </FieldRow>
        <FieldRow
          id={id("baseUrl")}
          label="Base URL"
          error={errorFor("baseUrl")}
        >
          {text("baseUrl", "url")}
        </FieldRow>
        <FieldRow
          id={id("searchDepth")}
          label="Search depth"
          error={errorFor("searchDepth")}
        >
          <select
            id={id("searchDepth")}
            className="ohb-settings-select"
            value={form.searchDepth}
            onChange={(event) => {
              set(
                "searchDepth",
                event.target.value as SearchForm["searchDepth"],
              );
            }}
          >
            <option value="basic">Basic</option>
            <option value="advanced">Advanced</option>
          </select>
        </FieldRow>
        <FieldRow
          id={id("maxResults")}
          label="Max results"
          hint="1–20"
          error={errorFor("maxResults")}
        >
          {text("maxResults", "number")}
        </FieldRow>
        <FieldRow id={id("topic")} label="Topic" error={errorFor("topic")}>
          <select
            id={id("topic")}
            className="ohb-settings-select"
            value={form.topic}
            onChange={(event) => {
              set("topic", event.target.value as SearchForm["topic"]);
            }}
          >
            <option value="general">General</option>
            <option value="news">News</option>
            <option value="finance">Finance</option>
          </select>
        </FieldRow>
        <FieldRow
          id={id("timeout")}
          label="Timeout"
          hint="seconds"
          error={errorFor("timeout")}
        >
          {text("timeout", "number")}
        </FieldRow>
      </MoreOptions>
      <div className="ohb-settings-form-footer">
        <span className="ohb-settings-form-status" role="alert">
          {serverErrors.form}
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
  );
}
