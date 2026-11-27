import type { UiWebCommandCatalog } from "ohbaby-sdk";
import type { KeyboardEvent } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createSlashPaletteItems,
  dropSlashQuery,
  paletteSkillName,
  selectedSlashItem,
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
  /** A skill became the token; the caller puts the caret after it. */
  readonly onSkillSelected?: () => void;
}): {
  readonly slashOpen: boolean;
  readonly slashItems: readonly SlashPaletteItem[];
  readonly slashIndex: number;
  readonly setSlashIndex: (index: number) => void;
  readonly slashError: string | null;
  readonly selectedCommand: SlashPaletteItem | undefined;
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
    onSkillSelected,
  } = input;
  const {
    draft,
    skillName,
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
        ? createSlashPaletteItems(slashCatalog, draft, {
            skillsOnly: skillName !== null,
          })
        : [],
    [canUseSlash, draft, skillName, slashCatalog],
  );
  const selectedCommand = selectedSlashItem(slashItems, slashIndex);
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

  // Choosing a skill makes a token in front of the request; it does not send
  // (skill UX frontend 04 §3). A second Enter sends.
  const selectSkill = useCallback(
    (name: string): void => {
      updateDraft(dropSlashQuery(draft), name);
      setSlashDismissedDraft(null);
      setSlashIndex(0);
      onSkillSelected?.();
    },
    [draft, onSkillSelected, updateDraft],
  );

  const runSlashCommand = useCallback(
    (item: SlashPaletteItem | undefined) => {
      if (!canUseSlash) {
        return;
      }
      const skill = paletteSkillName(item);
      if (skill !== undefined) {
        selectSkill(skill);
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
      selectSkill,
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
          if (paletteSkillName(selectedCommand) !== undefined) {
            runSlashCommand(selectedCommand);
          } else if (selectedCommand) {
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
    runSlashCommand,
    handlePaletteKey,
    onDraftEdited,
    reset,
  };
}
