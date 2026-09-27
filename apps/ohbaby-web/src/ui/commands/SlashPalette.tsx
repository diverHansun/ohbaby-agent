import type { ReactElement } from "react";
import { type SlashPaletteItem } from "./slashCommands.js";

export function SlashPalette(props: {
  readonly items: readonly SlashPaletteItem[];
  readonly onHover: (index: number) => void;
  readonly onRun: (item: SlashPaletteItem) => void;
  readonly placement: "down" | "up";
  readonly selectedIndex: number;
}): ReactElement {
  return (
    <div className={`ohb-slash-palette ohb-slash-palette-${props.placement}`}>
      <div className="ohb-slash-palette-list">
        {props.items.map((item, index) => (
          <div key={item.command.id}>
            {item.showCategory ? (
              <div className="ohb-slash-category">{item.categoryLabel}</div>
            ) : null}
            <button
              className={[
                "ohb-slash-row",
                item.argsHint.trim() === "" ? "ohb-slash-row-no-args" : "",
                index === props.selectedIndex ? "ohb-slash-selected" : "",
              ]
                .filter(Boolean)
                .join(" ")}
              onClick={() => {
                props.onRun(item);
              }}
              onMouseEnter={() => {
                props.onHover(index);
              }}
              type="button"
            >
              <span className={`ohb-slash-dot ohb-slash-dot-${item.accent}`} />
              <span>{item.label}</span>
              <small className="ohb-slash-args">{item.argsHint}</small>
              <em className="ohb-slash-description">{item.description}</em>
            </button>
          </div>
        ))}
      </div>
      <footer>
        <span>
          <b>↑↓</b> select
        </span>
        <span>
          <b>↵</b> run
        </span>
        <span>
          <b>⇥</b> complete
        </span>
        <span>
          <b>esc</b> dismiss
        </span>
      </footer>
    </div>
  );
}
