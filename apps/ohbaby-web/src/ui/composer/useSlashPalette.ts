import type { UiWebCommandCatalog } from "ohbaby-sdk";
import type { KeyboardEvent } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createSlashPaletteItems,
  selectedSlashItem,
  slashCompletionSuffix,
  type SlashPaletteItem,
} from "../commands/slashCommands.js";
import type { StructuredCommandRequest } from "../commands/StructuredCommandOverlay.js";
import type { ComposerDraftState } from "./useComposerDraft.js";

/**
 * The slash-command palette: loading the catalog while the draft starts with
 * `/`, filtering, keyboard selection and running the chosen command.
 */
export function useSlashPalette(input: {
  readonly draftState: ComposerDraftState;
  readonly canUseSlash: boolean;
  readonly disabled: boolean;
  readonly commandCatalogVersion: string | null;
  readonly onListCommands: () => Promise<UiWebCommandCatalog>;
  readonly onStructuredCommand: (request: StructuredCommandRequest) => void;
  readonly onSubmit: (text: string) => Promise<boolean>;
}): {
  readonly slashOpen: boolean;
  readonly slashItems: readonly SlashPaletteItem[];
  readonly slashIndex: number;
  readonly setSlashIndex: (index: number) => void;
  readonly slashError: string | null;
  readonly selectedCommand: SlashPaletteItem | undefined;
  readonly completionSuffix: string | null | undefined;
  readonly runSlashCommand: (item: SlashPaletteItem | undefined) => void;
  /** Handles palette keys; returns true when the key was consumed. */
  readonly handlePaletteKey: (
    event: KeyboardEvent<HTMLTextAreaElement>,
  ) => boolean;
  /** Called when the user edits the draft directly. */
  readonly onDraftEdited: (nextDraft: string) => void;
  readonly reset: () => void;
} {
  const {
    draftState,
    canUseSlash,
    disabled,
    commandCatalogVersion,
    onListCommands,
    onStructuredCommand,
    onSubmit,
  } = input;
  const {
    draft,
    updateDraft,
    setIsSubmitting,
    draftScopeGeneration,
    editRevision,
  } = draftState;
  const [slashCatalog, setSlashCatalog] = useState<UiWebCommandCatalog | null>(
    null,
  );
  const [slashDismissedDraft, setSlashDismissedDraft] = useState<string | null>(
    null,
  );
  const [slashError, setSlashError] = useState<string | null>(null);
  const [slashIndex, setSlashIndex] = useState(0);
  const slashItems = useMemo(
    () =>
      canUseSlash && slashCatalog && draft.startsWith("/")
        ? createSlashPaletteItems(slashCatalog, draft)
        : [],
    [canUseSlash, draft, slashCatalog],
  );
  const selectedCommand = selectedSlashItem(slashItems, slashIndex);
  const completionSuffix = slashCompletionSuffix(selectedCommand, draft);
  const slashOpen =
    draft.startsWith("/") &&
    slashDismissedDraft !== draft &&
    slashItems.length > 0 &&
    canUseSlash &&
    !disabled;

  useEffect(() => {
    if (!draft.startsWith("/") || !canUseSlash || disabled) {
      return;
    }
    let cancelled = false;
    setSlashCatalog(null);
    setSlashError(null);
    onListCommands()
      .then((catalog) => {
        if (!cancelled) {
          setSlashCatalog(catalog);
          setSlashError(null);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setSlashCatalog(null);
          setSlashError(error instanceof Error ? error.message : String(error));
        }
      });
    return (): void => {
      cancelled = true;
    };
  }, [canUseSlash, draft, onListCommands, commandCatalogVersion, disabled]);

  const runSlashCommand = useCallback(
    (item: SlashPaletteItem | undefined) => {
      if (!canUseSlash) {
        return;
      }
      const commandText = item?.label ?? draft.trim();
      if (!commandText) {
        return;
      }
      if (item?.executionKind === "overlay") {
        onStructuredCommand({ item, text: draft.trim() || item.label });
        updateDraft("");
        setSlashDismissedDraft(null);
        setSlashError(null);
        return;
      }
      const generation = draftScopeGeneration.current;
      const revision = editRevision.current;
      setIsSubmitting(true);
      void onSubmit(commandText)
        .then((sent) => {
          if (
            sent &&
            generation === draftScopeGeneration.current &&
            revision === editRevision.current
          ) {
            updateDraft("");
            setSlashDismissedDraft(null);
          }
        })
        .finally(() => {
          if (generation === draftScopeGeneration.current)
            setIsSubmitting(false);
        });
    },
    [
      canUseSlash,
      draft,
      draftScopeGeneration,
      editRevision,
      onStructuredCommand,
      onSubmit,
      setIsSubmitting,
      updateDraft,
    ],
  );

  const handlePaletteKey = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!slashOpen) return false;
      const last = slashItems.length - 1;
      switch (event.key) {
        case "ArrowDown":
          setSlashIndex((index) => Math.min(index + 1, last));
          break;
        case "ArrowUp":
          setSlashIndex((index) => Math.max(index - 1, 0));
          break;
        case "PageDown":
          setSlashIndex((index) => Math.min(index + 5, last));
          break;
        case "PageUp":
          setSlashIndex((index) => Math.max(index - 5, 0));
          break;
        case "Tab":
          if (event.shiftKey) return false;
          if (selectedCommand) {
            updateDraft(selectedCommand.label);
            setSlashDismissedDraft(null);
          }
          break;
        case "Enter":
          if (event.shiftKey) return false;
          runSlashCommand(selectedCommand);
          break;
        case "Escape":
          setSlashDismissedDraft(draft);
          break;
        default:
          return false;
      }
      event.preventDefault();
      return true;
    },
    [
      draft,
      runSlashCommand,
      selectedCommand,
      slashItems.length,
      slashOpen,
      updateDraft,
    ],
  );

  const onDraftEdited = useCallback(
    (nextDraft: string): void => {
      setSlashIndex(0);
      if (nextDraft !== slashDismissedDraft) setSlashDismissedDraft(null);
    },
    [slashDismissedDraft],
  );

  const reset = useCallback((): void => {
    setSlashDismissedDraft(null);
    setSlashError(null);
    setSlashIndex(0);
  }, []);

  return {
    slashOpen,
    slashItems,
    slashIndex,
    setSlashIndex,
    slashError,
    selectedCommand,
    completionSuffix,
    runSlashCommand,
    handlePaletteKey,
    onDraftEdited,
    reset,
  };
}
