import { type ReactElement, useLayoutEffect, useRef, useState } from "react";
import { type SlashPaletteItem } from "./slashCommands.js";

// Gap to the composer card (matches the CSS offset) plus a margin to the edge.
const PALETTE_GAP_PX = 10 + 12;
const HEADER_HEIGHT_PX = 44;
// Below this much room the preferred side flips when the other side has more.
const COMFORTABLE_HEIGHT_PX = 240;

interface PaletteFit {
  readonly placement: "down" | "up";
  readonly maxHeight: number | undefined;
}

/**
 * One line per command: name, then description. The args hint shows on the
 * selected row only, so the list stays quiet while browsing. One faint line
 * at the foot lists the keys. The palette sizes itself to the room left in
 * the viewport and scrolls inside, so every command stays reachable.
 */
export function SlashPalette(props: {
  readonly items: readonly SlashPaletteItem[];
  readonly onHover: (index: number) => void;
  readonly onRun: (item: SlashPaletteItem) => void;
  readonly placement: "down" | "up";
  readonly selectedIndex: number;
}): ReactElement {
  // The hook keeps the index while the list narrows; clamp like selectedSlashItem.
  const selectedIndex = Math.min(props.selectedIndex, props.items.length - 1);
  const paletteRef = useRef<HTMLDivElement | null>(null);
  const [fit, setFit] = useState<PaletteFit>({
    placement: props.placement,
    maxHeight: undefined,
  });

  useLayoutEffect(() => {
    const measure = (): void => {
      const card = paletteRef.current?.parentElement;
      if (!card) return;
      setFit(paletteFit(props.placement, card.getBoundingClientRect()));
    };
    measure();
    window.addEventListener("resize", measure);
    return (): void => {
      window.removeEventListener("resize", measure);
    };
  }, [props.placement]);

  useLayoutEffect(() => {
    // Scroll only the list; scrollIntoView would also move outer containers.
    const list = paletteRef.current?.querySelector(".ohb-slash-palette-list");
    const row = list?.querySelector(".ohb-slash-selected");
    if (!list || !row) return;
    const rowBox = row.getBoundingClientRect();
    const listBox = list.getBoundingClientRect();
    if (rowBox.top < listBox.top) list.scrollTop -= listBox.top - rowBox.top;
    else if (rowBox.bottom > listBox.bottom)
      list.scrollTop += rowBox.bottom - listBox.bottom;
  }, [selectedIndex, props.items]);

  return (
    <div
      className={`ohb-slash-palette ohb-slash-palette-${fit.placement}`}
      ref={paletteRef}
      style={
        fit.maxHeight === undefined ? undefined : { maxHeight: fit.maxHeight }
      }
    >
      <div className="ohb-slash-palette-list">
        {props.items.map((item, index) => (
          <div key={item.command.id}>
            {item.showCategory ? (
              <div className="ohb-slash-category">{item.categoryLabel}</div>
            ) : null}
            <button
              className={`ohb-slash-row${index === selectedIndex ? " ohb-slash-selected" : ""}`}
              onClick={() => {
                props.onRun(item);
              }}
              onMouseEnter={() => {
                props.onHover(index);
              }}
              type="button"
            >
              <span>{item.label}</span>
              <em className="ohb-slash-description">{item.description}</em>
              {item.argsHint.trim() === "" ? null : (
                <small className="ohb-slash-args">{item.argsHint}</small>
              )}
            </button>
          </div>
        ))}
      </div>
      <footer className="ohb-slash-hint">
        ↑↓ select · ↵ run · ⇥ complete · esc dismiss
      </footer>
    </div>
  );
}

/** Keeps the preferred side unless it is cramped and the other side has more room. */
export function paletteFit(
  preferred: "down" | "up",
  card: Pick<DOMRect, "bottom" | "top">,
  viewportHeight = window.innerHeight,
): PaletteFit {
  const below = viewportHeight - card.bottom - PALETTE_GAP_PX;
  const above = card.top - HEADER_HEIGHT_PX - PALETTE_GAP_PX;
  const room = preferred === "down" ? below : above;
  const other = preferred === "down" ? above : below;
  const placement =
    room < COMFORTABLE_HEIGHT_PX && other > room
      ? preferred === "down"
        ? "up"
        : "down"
      : preferred;
  return {
    placement,
    maxHeight: Math.max(0, Math.floor(placement === "down" ? below : above)),
  };
}
