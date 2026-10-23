import { ArrowUp } from "lucide-react";
import type { ReactElement } from "react";
import { isImeComposing } from "../composer/ime.js";
import { DraftHero } from "./DraftHero.js";

/**
 * Empty state before any folder is open. There is no instance yet, so only the
 * text box is shown; sending opens the folder picker and the text is kept for
 * the conversation that starts after a folder is chosen. improve-2 replaces this
 * with sending straight to the default workspace.
 */
export function FolderlessDraft(props: {
  readonly text: string;
  readonly onChange: (text: string) => void;
  readonly onOpenFolder: () => void;
}): ReactElement {
  return (
    <div className="ohb-main-body ohb-main-body-empty">
      <DraftHero directory={null} onOpenFolder={props.onOpenFolder} />
      <section className="ohb-composer ohb-composer-hero">
        <div className="ohb-composer-input">
          <div className="ohb-composer-text">
            <textarea
              aria-label="Message"
              placeholder="Ask anything..."
              rows={2}
              value={props.text}
              onChange={(event) => {
                props.onChange(event.target.value);
              }}
              onKeyDown={(event) => {
                if (isImeComposing(event)) return;
                if (event.key === "Enter" && !event.shiftKey) {
                  event.preventDefault();
                  props.onOpenFolder();
                }
              }}
            />
          </div>
          <div className="ohb-composer-bar">
            <div className="ohb-composer-bar-spacer" />
            <button
              type="button"
              className="ohb-send-button"
              aria-label="Send message"
              title="Send message"
              disabled={props.text.trim().length === 0}
              onClick={props.onOpenFolder}
            >
              <ArrowUp aria-hidden="true" size={15} />
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
