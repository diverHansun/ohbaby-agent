import { ArrowUp } from "lucide-react";
import { type ReactElement, type ReactNode, useState } from "react";
import {
  composerDraftKey,
  readSessionValue,
  type StoredComposerDraft,
  writeSessionValue,
} from "../composer/draft-storage.js";
import { DraftHero } from "./DraftHero.js";

const DRAFT_KEY = composerDraftKey("new");

/**
 * The new-chat draft while no instance can be reached, for example when the
 * default workspace is unknown. The text lives in the same `new` draft the
 * composer reads, so it carries over once a project connects; sending waits
 * until then (04 §2.1).
 */
export function DraftFallback(props: {
  readonly picker: ReactNode;
  readonly reason: string;
}): ReactElement {
  const [text, setText] = useState(
    () =>
      (readSessionValue(DRAFT_KEY) as StoredComposerDraft | null)?.text ?? "",
  );
  return (
    <div className="ohb-main-body ohb-main-body-empty">
      <DraftHero picker={props.picker} />
      <section className="ohb-composer ohb-composer-hero">
        <p className="ohb-draft-fallback-reason" role="status">
          {props.reason}
        </p>
        <div className="ohb-composer-input">
          <div className="ohb-composer-text">
            <textarea
              aria-label="Message"
              placeholder="Ask anything..."
              rows={2}
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                writeSessionValue(DRAFT_KEY, {
                  text: event.target.value,
                } satisfies StoredComposerDraft);
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
              disabled
            >
              <ArrowUp aria-hidden="true" size={15} />
            </button>
          </div>
        </div>
      </section>
    </div>
  );
}
