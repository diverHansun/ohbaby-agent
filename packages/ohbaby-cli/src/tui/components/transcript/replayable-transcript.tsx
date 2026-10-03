import { Static, useStdout } from "ink";
import {
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import type { TranscriptItem } from "../../store/transcript.js";
import { useTuiLayout } from "../../layout/context.js";
import { useTheme } from "../../theme/index.js";
import { MessageRow, renderMessageParts } from "../message/message-row.js";
import { PromptCompletion } from "./prompt-completion.js";

const CLEAR_TRANSCRIPT = "\u001b[2J\u001b[3J\u001b[H";

/** Append stable output; replace it only when its projection changes. */
export function ReplayableTranscript({
  items,
  identity,
}: {
  readonly items: readonly TranscriptItem[];
  readonly identity?: string;
}): ReactElement {
  const layout = useTuiLayout();
  const theme = useTheme();
  const { write } = useStdout();
  const [generation, setGeneration] = useState(0);
  const previous = useRef<
    | {
        readonly identity?: string;
        readonly width: number;
        readonly fingerprints: readonly string[];
      }
    | undefined
  >(undefined);
  // Store messages are immutable. Cache expensive Markdown projection by its
  // source identity; width/theme changes intentionally discard this local cache.
  const projections = useMemo(
    () =>
      new WeakMap<
        TranscriptItem["message"],
        {
          item: TranscriptItem;
          fingerprint: string;
        }
      >(),
    [layout.contentWidth, theme],
  );
  const fingerprints = items.map((item) => {
    const cached = projections.get(item.message);
    if (
      cached?.item.id === item.id &&
      cached.item.spacing === item.spacing &&
      cached.item.promptCompletion === item.promptCompletion
    ) {
      return cached.fingerprint;
    }
    const fingerprint = JSON.stringify({
      id: item.id,
      spacing: item.spacing,
      role: item.message.role,
      completion: item.promptCompletion,
      parts: item.promptCompletion
        ? undefined
        : renderMessageParts(
            item.message,
            Math.max(
              1,
              layout.contentWidth - (item.message.role === "user" ? 2 : 0),
            ),
            theme,
          ),
    });
    projections.set(item.message, { item, fingerprint });
    return fingerprint;
  });
  useLayoutEffect(() => {
    const old = previous.current;
    const next = { identity, width: layout.contentWidth, fingerprints };
    previous.current = next;
    if (
      !old ||
      (old.identity === identity &&
        old.width === layout.contentWidth &&
        old.fingerprints.length <= fingerprints.length &&
        old.fingerprints.every(
          (fingerprint, index) => fingerprint === fingerprints[index],
        ))
    )
      return;
    write(CLEAR_TRANSCRIPT);
    setGeneration((value) => value + 1);
  }, [fingerprints, identity, layout.contentWidth, write]);

  return (
    <Static key={generation} items={items as TranscriptItem[]}>
      {(item): ReactElement =>
        item.promptCompletion ? (
          <PromptCompletion key={item.id} prompt={item.promptCompletion} />
        ) : (
          <MessageRow
            key={item.id}
            message={item.message}
            contentWidth={layout.contentWidth}
            bottomMargin={item.spacing ? 1 : 0}
          />
        )
      }
    </Static>
  );
}
