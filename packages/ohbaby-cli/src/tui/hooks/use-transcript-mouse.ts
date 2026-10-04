import { useStdin, useStdout } from "ink";
import { useEffect, useEffectEvent } from "react";

const ENABLE_MOUSE = "\x1b[?1000h\x1b[?1006h";
const DISABLE_MOUSE = "\x1b[?1006l\x1b[?1000l";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";
const MAX_SEQUENCE_LENGTH = 64;

export interface TranscriptMouseWheel {
  readonly delta: -1 | 1;
  /** Zero-based terminal cell coordinates. */
  readonly x: number;
  readonly y: number;
}

/** Observe SGR wheel reports without changing Ink's keyboard/paste stream. */
export function createTranscriptMouseParser(): {
  push(chunk: string): TranscriptMouseWheel[];
} {
  let pending = "";
  let pasting = false;
  return {
    push(chunk): TranscriptMouseWheel[] {
      pending += chunk;
      const events: TranscriptMouseWheel[] = [];
      while (pending !== "") {
        if (pasting) {
          const end = pending.indexOf(PASTE_END);
          if (end < 0) {
            pending = pending.slice(-(PASTE_END.length - 1));
            break;
          }
          pending = pending.slice(end + PASTE_END.length);
          pasting = false;
          continue;
        }
        const escape = pending.indexOf("\x1b");
        if (escape < 0) {
          pending = "";
          break;
        }
        pending = pending.slice(escape);
        if (pending.length < 2) break;
        if (pending[1] !== "[") {
          pending = pending.slice(1);
          continue;
        }
        let end = 2;
        while (end < pending.length && end < MAX_SEQUENCE_LENGTH) {
          const code = pending.charCodeAt(end);
          if (code < 0x20 || code > 0x3f) break;
          end++;
        }
        if (end === pending.length && end < MAX_SEQUENCE_LENGTH) break;
        const final = pending.charCodeAt(end);
        if (end >= MAX_SEQUENCE_LENGTH || final < 0x40 || final > 0x7e) {
          pending = pending.slice(1);
          continue;
        }
        const sequence = pending.slice(0, end + 1);
        pending = pending.slice(end + 1);
        if (sequence === PASTE_START) {
          pasting = true;
          continue;
        }
        // eslint-disable-next-line no-control-regex -- SGR terminal mouse report.
        const match = /^\x1b\[<(\d+);(\d+);(\d+)M$/u.exec(sequence);
        if (!match) continue;
        const button = Number(match[1]);
        const x = Number(match[2]);
        const y = Number(match[3]);
        const withoutModifiers = button & ~28;
        if (
          ![button, x, y].every(Number.isSafeInteger) ||
          button > 127 ||
          x < 1 ||
          y < 1 ||
          (withoutModifiers !== 64 && withoutModifiers !== 65)
        )
          continue;
        events.push({
          delta: withoutModifiers === 64 ? -1 : 1,
          x: x - 1,
          y: y - 1,
        });
      }
      return events;
    },
  };
}

/**
 * Ink owns stdin.read() and raw mode. A data listener merely observes the
 * chunks emitted by those reads; it neither reads nor resumes stdin itself.
 * Ink 8 consumes complete unknown CSI reports before keyboard handlers, so
 * mouse events never become prompt text.
 */
export function useTranscriptMouse(
  onWheel: (event: TranscriptMouseWheel) => void,
  enabled = true,
): void {
  const { stdin, setRawMode, isRawModeSupported } = useStdin();
  const { stdout } = useStdout();
  const handleWheel = useEffectEvent(onWheel);
  useEffect(() => {
    if (
      !enabled ||
      !isRawModeSupported ||
      !("isTTY" in stdout) ||
      stdout.isTTY !== true
    )
      return;
    const parser = createTranscriptMouseParser();
    const handleData = (chunk: unknown): void => {
      const text =
        typeof chunk === "string"
          ? chunk
          : Buffer.isBuffer(chunk)
            ? chunk.toString("utf8")
            : "";
      for (const event of parser.push(text)) handleWheel(event);
    };
    setRawMode(true);
    stdin.on("data", handleData);
    stdout.write(ENABLE_MOUSE);
    return (): void => {
      stdin.removeListener("data", handleData);
      stdout.write(DISABLE_MOUSE);
      setRawMode(false);
    };
  }, [enabled, isRawModeSupported, setRawMode, stdin, stdout]);
}
