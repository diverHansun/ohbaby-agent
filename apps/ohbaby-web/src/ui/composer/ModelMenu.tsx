import {
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  LoaderCircle,
} from "lucide-react";
import type { UiSettingsModels } from "ohbaby-sdk";
import type { ReactElement } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SettingsLayer } from "../../runtime/settings-layer.js";
import { groupModels, modelTitle } from "../settings/model-form.js";
import { anchorBelow, Menu, type MenuAnchor } from "../shared/Menu.js";
import { MODEL_LIST_MAX_AGE_MS, resolveModelEntry } from "./model-choice.js";
import type { ReasoningState } from "./useReasoning.js";

/** Longer lists get the filter field (05 Menu). */
const FILTER_FROM = 9;

/** Why a chosen level is not sent yet, for titles and screen readers. */
function inactiveReasoningText(level: string): string {
  return `${level} isn't active until Reasoning Effort is detected; the service default is used`;
}

/**
 * The model button in the composer row (session-model 00 D17, D19): it lists
 * complete models by provider and chooses one for this chat only. The check
 * marks the model the next turn uses; the default carries a quiet `default`
 * tag. A long list scrolls inside the menu while `Manage models…` stays put.
 * A failed choice restores the previous label and reports through `onError`.
 *
 * Reasoning Effort lives here too (D37): the button reads "model Effort" with
 * the effort dimmed, and an Effort row above `Manage models…` opens the
 * levels in place. Detecting and unknown states only show on that row.
 */
export function ModelMenu(props: {
  readonly settings: SettingsLayer;
  /** The settings list, read and watched by the screen (`useSettingsModels`). */
  readonly models: UiSettingsModels | undefined;
  /** The chat's own choice (or the draft's), absent while it follows the default. */
  readonly selectedEntryId: string | undefined;
  readonly onSelect: (id: string) => Promise<void>;
  /** The connected instance's model, shown until the settings list loads. */
  readonly fallbackLabel: string;
  readonly missing: boolean;
  readonly disabled?: boolean;
  readonly onManage: () => void;
  readonly onError: (error: unknown) => void;
  /** The chat's Reasoning Effort, from `useReasoning` in the composer row. */
  readonly reasoning: ReasoningState;
}): ReactElement {
  const { settings, models, reasoning } = props;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const [level, setLevel] = useState<"models" | "effort">("models");
  // The choice in flight, then kept until the session event echoes it.
  const [pending, setPending] = useState<{
    readonly id: string;
    readonly saving: boolean;
  } | null>(null);
  const echoed = pending !== null && pending.id === props.selectedEntryId;
  const selectedId = pending && !echoed ? pending.id : props.selectedEntryId;
  useEffect(() => {
    if (echoed) setPending(null);
  }, [echoed]);

  const complete =
    models?.models.filter((model) => model.configurationComplete) ?? [];
  const shown = resolveModelEntry(models, selectedId);
  const defaultId = models?.active?.id;
  const label = shown
    ? shown.model
    : models || props.missing
      ? "Choose model"
      : props.fallbackLabel;
  const effortOption =
    reasoning.kind === "choice"
      ? reasoning.options.find((option) => option.value === reasoning.value)
      : undefined;
  const effort =
    reasoning.kind === "choice" && reasoning.value !== ""
      ? (effortOption?.label ?? reasoning.value)
      : undefined;
  const effortError = reasoning.kind === "choice" ? reasoning.error : undefined;

  // Open with the checked row centred, even deep in a long list. The popup
  // scrolls its list; the phone sheet scrolls as a whole. Never the page.
  useLayoutEffect(() => {
    const list = listRef.current;
    const row = list?.querySelector<HTMLElement>("[aria-current='true']");
    if (!anchor || !list || !row) return;
    const box =
      list.scrollHeight > list.clientHeight
        ? list
        : (list.closest<HTMLElement>(".ohb-menu") ?? list);
    const offset =
      row.getBoundingClientRect().top - box.getBoundingClientRect().top;
    box.scrollTop += offset - (box.clientHeight - row.offsetHeight) / 2;
  }, [anchor, level]);

  const select = async (id: string): Promise<void> => {
    // Following the default and picking it still pins the chat (P14).
    if (id === selectedId) return;
    setPending({ id, saving: true });
    try {
      await props.onSelect(id);
      setPending((current) =>
        current?.id === id ? { id, saving: false } : current,
      );
    } catch (error) {
      setPending(null);
      props.onError(
        new Error(
          `Couldn't switch the model. ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        ),
      );
    }
  };

  const close = (restoreFocus: boolean): void => {
    setAnchor(null);
    setLevel("models");
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  };

  const saving = pending?.saving === true;
  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="ohb-control-button ohb-model-button"
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        aria-busy={saving}
        disabled={props.disabled === true || saving}
        title={`Model and reasoning effort for this chat: ${label}${effort ? `, ${effort}` : ""}`}
        onClick={(event) => {
          if (anchor) {
            close(false);
            return;
          }
          void settings.load("models", { maxAge: MODEL_LIST_MAX_AGE_MS });
          setAnchor(anchorBelow(event.currentTarget));
        }}
      >
        <span>{label}</span>
        {effort ? (
          <span
            className={`ohb-model-button-effort${effortError ? " is-error" : ""}`}
          >
            {effort}
          </span>
        ) : null}
        {saving ? (
          <LoaderCircle
            aria-hidden="true"
            className="ohb-send-spinner"
            size={12}
          />
        ) : (
          <ChevronDown aria-hidden="true" size={12} />
        )}
      </button>
      {anchor && level === "effort" && reasoning.kind === "choice" ? (
        <Menu
          anchor={anchor}
          label="Reasoning effort"
          level="effort"
          className="ohb-model-menu"
          focusSelector="[aria-current='true']"
          onClose={close}
          onEscape={() => {
            setLevel("models");
          }}
        >
          <button
            type="button"
            role="menuitem"
            className="ohb-menu-back"
            onClick={() => {
              setLevel("models");
            }}
          >
            <ChevronLeft aria-hidden="true" size={13} />
            <span>Effort</span>
          </button>
          {reasoning.options.map((option) => {
            const current = option.value === reasoning.value;
            return (
              <button
                key={option.value}
                type="button"
                role="menuitem"
                aria-current={current ? "true" : undefined}
                onClick={() => {
                  reasoning.select(option.value);
                  close(true);
                }}
              >
                <span className="ohb-menu-item-text">{option.label}</span>
                {current ? (
                  <Check
                    aria-hidden="true"
                    size={14}
                    className="ohb-menu-check"
                  />
                ) : null}
              </button>
            );
          })}
        </Menu>
      ) : anchor ? (
        <Menu
          anchor={anchor}
          label="Model"
          level="models"
          className="ohb-model-menu"
          filterable={complete.length >= FILTER_FROM}
          focusSelector="[aria-current='true']"
          onClose={close}
        >
          <div ref={listRef} className="ohb-model-menu-list">
            {groupModels(complete).map((group) => (
              <div
                key={group.provider}
                role="group"
                aria-label={group.provider}
              >
                <div className="ohb-menu-group-label" aria-hidden="true">
                  {group.provider}
                </div>
                {group.models.map((model) => {
                  const active = model.id === shown?.id;
                  return (
                    <button
                      key={model.id}
                      type="button"
                      role="menuitem"
                      aria-current={active ? "true" : undefined}
                      onClick={() => {
                        close(true);
                        void select(model.id);
                      }}
                    >
                      <span className="ohb-menu-item-text">
                        {modelTitle(model)}
                      </span>
                      {model.id === defaultId ? (
                        <span className="ohb-model-default-tag">default</span>
                      ) : null}
                      {active ? (
                        <Check
                          aria-hidden="true"
                          size={14}
                          className="ohb-menu-check"
                        />
                      ) : null}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
          {complete.length > 0 ? (
            <div role="separator" className="ohb-menu-separator" />
          ) : null}
          {reasoning.kind !== "hidden" ? (
            <>
              <EffortRow
                state={reasoning}
                onOpen={(row) => {
                  // Keep the Effort level on the side the root opened on;
                  // being shorter, it would otherwise flip below the button.
                  const menu = row.closest(".ohb-menu");
                  if (
                    menu &&
                    menu.getBoundingClientRect().top < anchor.aboveY
                  ) {
                    setAnchor({ ...anchor, above: true });
                  }
                  setLevel("effort");
                }}
              />
              {effortError ? (
                <div className="ohb-model-effort-error" role="alert">
                  {effortError}
                </div>
              ) : null}
              <div role="separator" className="ohb-menu-separator" />
            </>
          ) : null}
          <button
            type="button"
            role="menuitem"
            data-menu-filter="false"
            onClick={() => {
              close(false);
              props.onManage();
            }}
          >
            Manage models…
          </button>
        </Menu>
      ) : null}
    </>
  );
}

/**
 * The Effort row of the model menu (A4): the current level and a chevron when
 * levels are known; a disabled row saying why while they are detected or
 * unknown. It never takes part in filtering.
 */
function EffortRow(props: {
  readonly state: Exclude<ReasoningState, { readonly kind: "hidden" }>;
  readonly onOpen: (row: HTMLElement) => void;
}): ReactElement {
  const { state } = props;
  if (state.kind === "choice") {
    const option = state.options.find((item) => item.value === state.value);
    const value = option?.label ?? state.value;
    return (
      <button
        type="button"
        role="menuitem"
        data-menu-filter="false"
        aria-label={`Effort, ${value}`}
        aria-invalid={state.error ? true : undefined}
        onClick={(event) => {
          props.onOpen(event.currentTarget);
        }}
      >
        <span className="ohb-menu-item-text">Effort</span>
        <span className="ohb-model-effort-value">{value}</span>
        <ChevronRight aria-hidden="true" size={14} className="ohb-menu-arrow" />
      </button>
    );
  }
  const status =
    state.inactive !== undefined
      ? `${state.inactive} · inactive`
      : state.kind === "detecting"
        ? "Detecting…"
        : "Unknown";
  const why =
    state.inactive !== undefined
      ? inactiveReasoningText(state.inactive)
      : state.reason;
  return (
    <button
      type="button"
      role="menuitem"
      data-menu-filter="false"
      className={`ohb-model-effort-row is-${state.kind}`}
      aria-label={`Effort, ${status}`}
      aria-busy={state.kind === "detecting" ? true : undefined}
      disabled
      title={why}
    >
      <span className="ohb-menu-item-text">Effort</span>
      <span className="ohb-model-effort-value">{status}</span>
    </button>
  );
}
