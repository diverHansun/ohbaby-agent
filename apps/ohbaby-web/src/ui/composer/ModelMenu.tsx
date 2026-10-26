import { Check, ChevronDown, LoaderCircle } from "lucide-react";
import type { UiSettingsModels } from "ohbaby-sdk";
import type { ReactElement } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { SettingsLayer } from "../../runtime/settings-layer.js";
import { groupModels, modelTitle } from "../settings/model-form.js";
import { anchorBelow, Menu, type MenuAnchor } from "../shared/Menu.js";
import { MODEL_LIST_MAX_AGE_MS, resolveModelEntry } from "./model-choice.js";

/** Longer lists get the filter field (05 Menu). */
const FILTER_FROM = 9;

/**
 * The model button in the composer row (session-model 00 D17, D19): it lists
 * complete models by provider and chooses one for this chat only. The check
 * marks the model the next turn uses; the default carries a quiet `default`
 * tag. A long list scrolls inside the menu while `Manage models…` stays put.
 * A failed choice restores the previous label and reports through `onError`.
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
}): ReactElement {
  const { settings, models } = props;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
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
  }, [anchor]);

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
        title="Model for this chat"
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
      {anchor ? (
        <Menu
          anchor={anchor}
          label="Model"
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
