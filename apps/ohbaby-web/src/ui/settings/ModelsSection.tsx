import { MoreHorizontal } from "lucide-react";
import type { UiSettingsModel, UiSettingsModels } from "ohbaby-sdk";
import type { ReactElement } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { isDaemonRequestError } from "../../api/daemon/http.js";
import type { SettingsLayer } from "../../runtime/settings-layer.js";
import { ConfirmDialog } from "../shared/ConfirmDialog.js";
import { IconButton } from "../shared/IconButton.js";
import { anchorBelow, Menu, type MenuAnchor } from "../shared/Menu.js";
import { SettingsRow } from "../shared/SettingsRow.js";
import { Spinner } from "../shared/Spinner.js";
import { ModelEditor } from "./ModelEditor.js";
import { groupModels, modelDeleteDescription } from "./model-form.js";
import { SectionHeader, SectionStatus } from "./SectionFrame.js";
import { errorText, useSettingsResource } from "./useSettingsResource.js";

type View =
  | { readonly kind: "list" }
  | { readonly kind: "new" }
  | { readonly kind: "edit"; readonly id: string };

type MenuTarget =
  | {
      readonly kind: "model";
      readonly model: UiSettingsModel;
      readonly anchor: MenuAnchor;
    }
  | {
      readonly kind: "provider";
      readonly provider: string;
      readonly anchor: MenuAnchor;
    };

type Confirm =
  | { readonly kind: "model"; readonly model: UiSettingsModel }
  | { readonly kind: "provider"; readonly provider: string };

interface RowState {
  readonly busy?: "select";
  readonly error?: string;
}

/**
 * Models: provider groups in server order, the default marked `Default`,
 * incomplete entries `Needs setup` (04 §2.6). Rows open the editor; row and
 * provider menus set the default or delete. Every delete asks first, since
 * chats that chose the model switch to the default (session-model D13).
 */
export function ModelsSection(props: {
  readonly settings: SettingsLayer;
  readonly visible: boolean;
}): ReactElement {
  const { settings } = props;
  const resource = useSettingsResource(settings, "models", props.visible);
  const models = resource.data;
  const [view, setView] = useState<View>({ kind: "list" });
  // Back from the editor, focus lands on the row that was edited.
  const sectionRef = useRef<HTMLElement>(null);
  const returnTo = useRef<string | null>(null);
  const toList = (): void => {
    returnTo.current = view.kind === "edit" ? view.id : "new";
    setView({ kind: "list" });
  };
  useLayoutEffect(() => {
    if (view.kind !== "list" || returnTo.current === null) return;
    const id = returnTo.current;
    returnTo.current = null;
    const section = sectionRef.current;
    const target =
      [...(section?.querySelectorAll<HTMLElement>("[data-model-id]") ?? [])]
        .find((row) => row.dataset.modelId === id)
        ?.querySelector<HTMLElement>(".ohb-settings-row-main") ??
      section?.querySelector<HTMLElement>(".ohb-primary-button");
    target?.focus({ preventScroll: true });
  }, [view]);
  const [rows, setRows] = useState<Readonly<Partial<Record<string, RowState>>>>(
    {},
  );
  const [menu, setMenu] = useState<MenuTarget | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [confirmBusy, setConfirmBusy] = useState(false);
  const [confirmError, setConfirmError] = useState<string | null>(null);
  const editing =
    view.kind === "edit"
      ? models?.models.find((model) => model.id === view.id)
      : undefined;

  // An entry deleted elsewhere returns to the refreshed list (04 §2.6).
  useEffect(() => {
    if (view.kind === "edit" && models && !editing) setView({ kind: "list" });
  }, [view, models, editing]);

  const setRow = (id: string, state: RowState | null): void => {
    setRows((current) => {
      const { [id]: _previous, ...rest } = current;
      return state === null ? rest : { ...rest, [id]: state };
    });
  };

  const select = async (model: UiSettingsModel): Promise<void> => {
    setRow(model.id, { busy: "select" });
    try {
      await settings.selectModel(model.id);
      setRow(model.id, null);
    } catch (error) {
      if (
        isDaemonRequestError(error) &&
        error.code === "MODEL_CONFIG_INCOMPLETE"
      ) {
        setRow(model.id, null);
        setView({ kind: "edit", id: model.id });
        return;
      }
      if (isDaemonRequestError(error) && error.code === "MODEL_NOT_FOUND") {
        setRow(model.id, null);
        void resource.reload();
        return;
      }
      setRow(model.id, {
        error: `Couldn't set as default. ${errorText(error)}`,
      });
    }
  };

  const confirmAction = async (): Promise<void> => {
    if (!confirm) return;
    setConfirmBusy(true);
    setConfirmError(null);
    try {
      if (confirm.kind === "model")
        await settings.deleteModel(confirm.model.id);
      else await settings.deleteProvider(confirm.provider);
      setConfirm(null);
    } catch (error) {
      if (isDaemonRequestError(error) && error.code === "MODEL_NOT_FOUND") {
        setConfirm(null);
        void resource.reload();
      } else setConfirmError(errorText(error));
    } finally {
      setConfirmBusy(false);
    }
  };

  if (view.kind !== "list" && models && (view.kind === "new" || editing))
    return (
      <ModelEditor
        key={view.kind === "edit" ? view.id : "new"}
        settings={settings}
        {...(editing ? { entry: editing } : {})}
        models={models}
        onBack={toList}
        onSaved={toList}
        onMissing={() => {
          toList();
          void resource.reload();
        }}
      />
    );

  const activeId = models?.active?.id ?? null;
  const groups = models ? groupModels(models.models) : [];
  return (
    <section
      ref={sectionRef}
      className="ohb-settings-section"
      aria-label="Models"
    >
      <SectionHeader
        title="Models"
        action={
          <button
            type="button"
            className="ohb-primary-button"
            disabled={!models}
            onClick={() => {
              setView({ kind: "new" });
            }}
          >
            Add model
          </button>
        }
      />
      {models && models.models.length > 0 ? (
        <p className="ohb-settings-lede">
          New chats and chats that haven&apos;t picked a model use the default.
          Pick one for a chat from the menu next to the message box.
        </p>
      ) : null}
      <SectionStatus
        resource={resource}
        empty={models?.models.length === 0 ? "No models yet." : undefined}
      />
      {groups.map((group) => (
        <div key={group.provider} className="ohb-settings-group">
          <div className="ohb-settings-group-title">
            <span>{group.provider}</span>
            <IconButton
              label={`${group.provider} actions`}
              className="ohb-settings-hover-action"
              onClick={(event) => {
                setMenu({
                  kind: "provider",
                  provider: group.provider,
                  anchor: anchorBelow(event.currentTarget),
                });
              }}
            >
              <MoreHorizontal aria-hidden="true" size={14} />
            </IconButton>
          </div>
          {group.models.map((model) => {
            const row = rows[model.id];
            const isDefault = model.id === activeId;
            return (
              <div
                key={model.id}
                className="ohb-settings-row-wrap"
                data-model-id={model.id}
              >
                <SettingsRow
                  muted={!model.configurationComplete}
                  ariaLabel={`Edit ${model.model}${model.label ? ` ${model.label}` : ""}`}
                  label={
                    <>
                      {model.model}
                      {model.label ? (
                        <span className="ohb-settings-row-note">
                          {model.label}
                        </span>
                      ) : null}
                    </>
                  }
                  value={
                    row?.busy ? (
                      <Spinner size={12} label="Setting as default" />
                    ) : !model.configurationComplete ? (
                      "Needs setup"
                    ) : isDefault ? (
                      <span className="ohb-settings-badge">Default</span>
                    ) : undefined
                  }
                  onClick={() => {
                    setView({ kind: "edit", id: model.id });
                  }}
                  control={
                    <IconButton
                      label={`${model.model} actions`}
                      className="ohb-settings-hover-action"
                      disabled={row?.busy !== undefined}
                      onClick={(event) => {
                        setMenu({
                          kind: "model",
                          model,
                          anchor: anchorBelow(event.currentTarget),
                        });
                      }}
                    >
                      <MoreHorizontal aria-hidden="true" size={14} />
                    </IconButton>
                  }
                />
                {row?.error ? (
                  <p className="ohb-settings-row-error" role="alert">
                    {row.error}
                  </p>
                ) : null}
              </div>
            );
          })}
        </div>
      ))}
      {menu ? (
        <Menu
          anchor={menu.anchor}
          label={
            menu.kind === "model"
              ? `${menu.model.model} actions`
              : `${menu.provider} actions`
          }
          onClose={() => {
            setMenu(null);
          }}
        >
          {menu.kind === "model" ? (
            <>
              {menu.model.configurationComplete &&
              menu.model.id !== activeId ? (
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    const model = menu.model;
                    setMenu(null);
                    void select(model);
                  }}
                >
                  Set as default
                </button>
              ) : null}
              <button
                type="button"
                role="menuitem"
                className="is-danger"
                onClick={() => {
                  const model = menu.model;
                  setMenu(null);
                  setConfirmError(null);
                  setConfirm({ kind: "model", model });
                }}
              >
                Delete
              </button>
            </>
          ) : (
            <button
              type="button"
              role="menuitem"
              className="is-danger"
              onClick={() => {
                const provider = menu.provider;
                setMenu(null);
                setConfirmError(null);
                setConfirm({ kind: "provider", provider });
              }}
            >
              Delete provider
            </button>
          )}
        </Menu>
      ) : null}
      {confirm && models ? (
        <ConfirmDialog
          {...confirmText(confirm, models)}
          confirmLabel="Delete"
          danger
          busy={confirmBusy}
          error={confirmError}
          onCancel={() => {
            setConfirm(null);
          }}
          onConfirm={() => {
            void confirmAction();
          }}
        />
      ) : null}
    </section>
  );
}

/** The two confirmations of D17, worded as in 04 §2.6. */
function confirmText(
  confirm: Confirm,
  models: UiSettingsModels,
): { title: string; description: string } {
  if (confirm.kind === "model")
    return {
      title: `Delete ${confirm.model.model}?`,
      description: modelDeleteDescription(
        confirm.model,
        models.models,
        models.active?.id,
      ),
    };
  const entries = models.models.filter(
    (model) => model.provider === confirm.provider,
  );
  const count = entries.length;
  const changesDefault = entries.some(
    (model) => model.id === models.active?.id,
  );
  return {
    title: `Delete ${confirm.provider} and its ${String(count)} ${count === 1 ? "model" : "models"}?`,
    description: changesDefault
      ? "The default model will change. Chats using these models will switch to the default model."
      : "Chats using these models will switch to the default model.",
  };
}
