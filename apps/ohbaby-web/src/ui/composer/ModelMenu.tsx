import { Check, ChevronDown, LoaderCircle } from "lucide-react";
import type { ReactElement } from "react";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import type { SettingsLayer } from "../../runtime/settings-layer.js";
import { selectSettings } from "../../store/settings-cache.js";
import { groupModels, modelTitle } from "../settings/model-form.js";
import { anchorBelow, Menu, type MenuAnchor } from "../shared/Menu.js";

/** The menu rereads the list when its copy is older than this (06 §3.7). */
const MAX_AGE_MS = 30_000;
/** Longer lists get the filter field (05 Menu). */
const FILTER_FROM = 9;

/**
 * The model button in the composer row (D15, D22): it lists complete models
 * by provider and makes the chosen one the global default. No explanation is
 * shown. `Manage models…` opens Settings › Models. A failed switch restores
 * the previous label and reports through `onError`.
 */
export function ModelMenu(props: {
  readonly settings: SettingsLayer;
  /** The connected instance's model, shown until the settings list loads. */
  readonly fallbackLabel: string;
  readonly missing: boolean;
  readonly disabled?: boolean;
  readonly onManage: () => void;
  readonly onError: (error: unknown) => void;
}): ReactElement {
  const { settings } = props;
  const triggerRef = useRef<HTMLButtonElement>(null);
  const [anchor, setAnchor] = useState<MenuAnchor | null>(null);
  const [selecting, setSelecting] = useState<string | null>(null);
  const snapshot = useSyncExternalStore(
    useCallback((listener) => settings.cache.subscribe(listener), [settings]),
    () => settings.cache.getSnapshot(),
  );
  const models = selectSettings(snapshot, "models").data;
  useEffect(() => {
    void settings.load("models", { maxAge: MAX_AGE_MS });
    // The button remains visible even when its menu is closed.
    return settings.watch("models");
  }, [settings]);

  const complete =
    models?.models.filter((model) => model.configurationComplete) ?? [];
  const shownId = selecting ?? models?.active?.id ?? null;
  const shown = models?.models.find((model) => model.id === shownId);
  const label = shown
    ? shown.model
    : models
      ? "Choose model"
      : props.missing
        ? "Choose model"
        : props.fallbackLabel;

  const select = async (id: string): Promise<void> => {
    if (id === models?.active?.id) return;
    setSelecting(id);
    try {
      await settings.selectModel(id);
    } catch (error) {
      props.onError(
        new Error(
          `Couldn't switch the model. ${error instanceof Error ? error.message : String(error)}`,
          { cause: error },
        ),
      );
    } finally {
      setSelecting(null);
    }
  };

  const close = (restoreFocus: boolean): void => {
    setAnchor(null);
    if (restoreFocus) triggerRef.current?.focus({ preventScroll: true });
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="ohb-control-button ohb-model-button"
        aria-haspopup="menu"
        aria-expanded={anchor !== null}
        aria-busy={selecting !== null}
        disabled={props.disabled === true || selecting !== null}
        title="Model"
        onClick={(event) => {
          if (anchor) {
            close(false);
            return;
          }
          void settings.load("models", { maxAge: MAX_AGE_MS });
          setAnchor(anchorBelow(event.currentTarget));
        }}
      >
        <span>{label}</span>
        {selecting ? (
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
          {groupModels(complete).map((group) => (
            <div key={group.provider} role="group" aria-label={group.provider}>
              <div className="ohb-menu-group-label" aria-hidden="true">
                {group.provider}
              </div>
              {group.models.map((model) => {
                const active = model.id === shownId;
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
