import type { UiSettingsModels } from "ohbaby-sdk";
import type { ReactElement } from "react";
import { useId, useState } from "react";
import { isDaemonRequestError } from "../../api/daemon/http.js";
import type { SettingsLayer } from "../../runtime/settings-layer.js";
import { SettingsRow } from "../shared/SettingsRow.js";
import { Spinner } from "../shared/Spinner.js";
import {
  modelTitle,
  reasoningFrom,
  reasoningValue,
  thinkingOptions,
} from "./model-form.js";
import { errorText } from "./useSettingsResource.js";

/** `""` is Follow chat for the model and Model default for the level. */
interface Choice {
  readonly id: string;
  readonly level: string;
}

/**
 * The one global subagent model (subagent-model 00 D3, D5): Follow chat or any
 * complete entry, then a Reasoning Effort level once the entry's levels are
 * identified. Each change saves at once, like Set as default.
 */
export function SubagentModelRow(props: {
  readonly settings: SettingsLayer;
  readonly models: UiSettingsModels;
  readonly onSetup: (id: string) => void;
  readonly onMissing: () => void;
}): ReactElement {
  const { models } = props;
  const baseId = useId();
  const saved: Choice = {
    id: models.subagent?.id ?? "",
    level: reasoningValue(models.subagent?.reasoning),
  };
  const [pending, setPending] = useState<Choice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const shown = pending ?? saved;
  const subagent = models.subagent;
  const needsSetup = subagent !== null && !subagent.configurationComplete;
  const entry = models.models.find(
    (model) => model.id === shown.id && model.configurationComplete,
  );
  // Known levels stay usable while detection runs again, as in the editor.
  const levels = entry ? thinkingOptions(entry.reasoning) : null;
  const levelUnavailable =
    levels !== null &&
    shown.level !== "" &&
    !levels.some((option) => option.value === shown.level);
  const modelDefault =
    entry && levels
      ? reasoningValue({
          ...entry.reasoning.default,
          ...entry.reasoningDefault,
        })
      : "";

  const save = async (next: Choice): Promise<void> => {
    setPending(next);
    setError(null);
    const reasoning = reasoningFrom(next.level);
    try {
      await props.settings.selectSubagentModel({
        id: next.id === "" ? null : next.id,
        ...(reasoning ? { reasoning } : {}),
      });
    } catch (failure) {
      if (isDaemonRequestError(failure)) {
        if (failure.code === "MODEL_CONFIG_INCOMPLETE") {
          props.onSetup(next.id);
          return;
        }
        if (failure.code === "MODEL_NOT_FOUND") {
          props.onMissing();
          return;
        }
      }
      setError(`Couldn't change the subagent model. ${errorText(failure)}`);
    } finally {
      setPending(null);
    }
  };

  const busy = pending !== null;
  return (
    <div className="ohb-settings-row-wrap ohb-subagent-model">
      <SettingsRow
        label="Subagent model"
        description="Subagents use this model. Follow chat uses the parent chat's model."
        className="ohb-subagent-model-row"
        control={
          <>
            {busy ? <Spinner size={12} label="Saving subagent model" /> : null}
            {needsSetup && !busy ? (
              <button
                type="button"
                className="ohb-text-button"
                onClick={() => {
                  props.onSetup(subagent.id);
                }}
              >
                Needs setup
              </button>
            ) : null}
            <select
              id={`${baseId}-model`}
              className="ohb-settings-select"
              aria-label="Subagent model"
              disabled={busy}
              value={shown.id}
              onChange={(event) => {
                void save({ id: event.target.value, level: "" });
              }}
            >
              <option value="">Follow chat</option>
              {needsSetup ? (
                <option value={subagent.id} disabled>
                  {modelTitle(subagent)} (needs setup)
                </option>
              ) : null}
              {models.models
                .filter((model) => model.configurationComplete)
                .map((model) => (
                  <option key={model.id} value={model.id}>
                    {modelTitle(model)}
                  </option>
                ))}
            </select>
            {levels ? (
              <select
                id={`${baseId}-level`}
                className="ohb-settings-select"
                aria-label="Subagent Reasoning Effort"
                disabled={busy}
                value={shown.level}
                onChange={(event) => {
                  void save({ id: shown.id, level: event.target.value });
                }}
              >
                <option value="">
                  {modelDefault
                    ? `Model default (${modelDefault})`
                    : "Model default"}
                </option>
                {levelUnavailable ? (
                  <option value={shown.level} disabled>
                    {shown.level} (unavailable)
                  </option>
                ) : null}
                {levels.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            ) : null}
          </>
        }
      />
      {error ? (
        <p className="ohb-settings-row-error" role="alert">
          {error}
        </p>
      ) : null}
    </div>
  );
}
