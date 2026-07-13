import { useEffect, useState } from "react";
import type { ReactElement } from "react";

export const COMPOSER_PLACEHOLDER_PHRASES = [
  "Ask Lychee anything…",
  "Describe the change you want…",
  "Plan the next step…",
] as const;

const TYPE_DELAY_MS = 50;
const HOLD_DELAY_MS = 1_400;
const DELETE_DELAY_MS = 32;
const SWITCH_DELAY_MS = 400;

interface TypewriterPlaceholderProps {
  readonly active: boolean;
  readonly phrases?: readonly string[];
}

interface TypewriterFrame {
  readonly phraseIndex: number;
  readonly visibleLength: number;
}

export function TypewriterPlaceholder(
  props: TypewriterPlaceholderProps,
): ReactElement | null {
  const phrases = props.phrases ?? COMPOSER_PLACEHOLDER_PHRASES;
  const prefersReducedMotion = usePrefersReducedMotion();
  const [frame, setFrame] = useState<TypewriterFrame>({
    phraseIndex: 0,
    visibleLength: 0,
  });

  useEffect(() => {
    if (!props.active || phrases.length === 0) {
      return;
    }

    const firstPhrase = phrases[0] ?? "";
    if (prefersReducedMotion) {
      setFrame({
        phraseIndex: 0,
        visibleLength: firstPhrase.length,
      });
      return;
    }

    let cancelled = false;
    let phraseIndex = 0;
    let visibleLength = 0;
    let phase: "typing" | "holding" | "deleting" = "typing";
    let timer: ReturnType<typeof setTimeout> | null = null;

    const schedule = (delay: number, callback: () => void): void => {
      timer = globalThis.setTimeout(callback, delay);
    };

    const tick = (): void => {
      if (cancelled) {
        return;
      }
      const phrase = phrases[phraseIndex] ?? "";
      if (phase === "typing") {
        visibleLength = Math.min(visibleLength + 1, phrase.length);
        setFrame({ phraseIndex, visibleLength });
        if (visibleLength >= phrase.length) {
          phase = "holding";
          schedule(HOLD_DELAY_MS, () => {
            phase = "deleting";
            tick();
          });
        } else {
          schedule(TYPE_DELAY_MS, tick);
        }
        return;
      }
      if (phase === "deleting") {
        visibleLength = Math.max(visibleLength - 1, 0);
        setFrame({ phraseIndex, visibleLength });
        if (visibleLength === 0) {
          phraseIndex = (phraseIndex + 1) % phrases.length;
          phase = "typing";
          schedule(SWITCH_DELAY_MS, tick);
        } else {
          schedule(DELETE_DELAY_MS, tick);
        }
      }
    };

    setFrame({ phraseIndex: 0, visibleLength: 0 });
    schedule(TYPE_DELAY_MS, tick);
    return (): void => {
      cancelled = true;
      if (timer !== null) {
        globalThis.clearTimeout(timer);
      }
    };
  }, [phrases, prefersReducedMotion, props.active]);

  if (!props.active || phrases.length === 0) {
    return null;
  }

  const phrase = phrases[frame.phraseIndex] ?? "";
  const visibleText = prefersReducedMotion
    ? (phrases[0] ?? "")
    : phrase.slice(0, frame.visibleLength);
  return (
    <span aria-hidden="true" className="ohb-composer-typewriter">
      <span>{visibleText}</span>
      <span className="ohb-composer-typewriter-cursor" />
    </span>
  );
}

function usePrefersReducedMotion(): boolean {
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false);

  useEffect(() => {
    if (typeof globalThis.matchMedia !== "function") {
      return;
    }
    const media = globalThis.matchMedia("(prefers-reduced-motion: reduce)");
    const update = (): void => {
      setPrefersReducedMotion(media.matches);
    };
    update();
    media.addEventListener("change", update);
    return (): void => {
      media.removeEventListener("change", update);
    };
  }, []);

  return prefersReducedMotion;
}
