import type { UiWebCommandCatalog } from "ohbaby-sdk";
import type { KeyboardEvent } from "react";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createSlashPaletteItems,
  paletteSkillName,
  selectedSlashItem,
  type SlashPaletteItem,
} from "../commands/slashCommands.js";

/**
 * The message editor's palette: skills only, opened by a `/` at the start of
 * the request (skill UX frontend 05 §2.6). It shares the main palette's
 * matching and rows; choosing a skill only makes a token.
 */
export function useSkillPalette(input: {
  readonly text: string;
  readonly disabled: boolean;
  readonly listCommands?: () => Promise<UiWebCommandCatalog>;
  readonly commandCatalogVersion?: string | null;
  readonly onSelect: (name: string) => void;
}): {
  readonly open: boolean;
  readonly items: readonly SlashPaletteItem[];
  readonly index: number;
  readonly setIndex: (index: number) => void;
  readonly select: (item: SlashPaletteItem | undefined) => void;
  /** Handles palette keys; returns true when the key was consumed. */
  readonly handleKey: (event: KeyboardEvent<HTMLTextAreaElement>) => boolean;
  readonly onEdited: (nextText: string) => void;
} {
  const { text, disabled, listCommands, commandCatalogVersion, onSelect } =
    input;
  const [catalog, setCatalog] = useState<UiWebCommandCatalog | null>(null);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  const wantsCatalog =
    listCommands !== undefined && !disabled && text.startsWith("/");
  // Loaded lazily, like the composer's palette; a failure keeps it closed.
  useEffect(() => {
    if (!wantsCatalog) return;
    let cancelled = false;
    listCommands()
      .then((next) => {
        if (!cancelled) setCatalog(next);
      })
      .catch(() => {
        if (!cancelled) setCatalog(null);
      });
    return (): void => {
      cancelled = true;
    };
  }, [wantsCatalog, listCommands, commandCatalogVersion]);
  const items = useMemo(
    () =>
      wantsCatalog && catalog
        ? createSlashPaletteItems(catalog, text, { skillsOnly: true })
        : [],
    [catalog, text, wantsCatalog],
  );
  const open = items.length > 0 && dismissed !== text;
  const selected = selectedSlashItem(items, index);

  const select = useCallback(
    (item: SlashPaletteItem | undefined): void => {
      const name = paletteSkillName(item);
      if (name === undefined) return;
      onSelect(name);
      setDismissed(null);
      setIndex(0);
    },
    [onSelect],
  );

  const handleKey = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>): boolean => {
      if (!open) return false;
      const last = items.length - 1;
      switch (event.key) {
        case "ArrowDown":
          setIndex((current) => Math.min(current + 1, last));
          break;
        case "ArrowUp":
          setIndex((current) => Math.max(current - 1, 0));
          break;
        case "PageDown":
          setIndex((current) => Math.min(current + 5, last));
          break;
        case "PageUp":
          setIndex((current) => Math.max(current - 5, 0));
          break;
        case "Tab":
        case "Enter":
          if (event.shiftKey) return false;
          select(selected);
          break;
        case "Escape":
          setDismissed(text);
          break;
        default:
          return false;
      }
      event.preventDefault();
      return true;
    },
    [items.length, open, select, selected, text],
  );

  const onEdited = useCallback(
    (nextText: string): void => {
      setIndex(0);
      if (nextText !== dismissed) setDismissed(null);
    },
    [dismissed],
  );

  return { open, items, index, setIndex, select, handleKey, onEdited };
}
