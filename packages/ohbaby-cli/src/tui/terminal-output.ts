/**
 * Terminal output adapter for Ink.
 *
 * Ink brackets every multi-step frame update (erase the previous dynamic
 * frame, print new <Static> rows, print the new frame) with DEC synchronized
 * output (CSI ? 2026 h/l), but sends each step as a separate `write()`.
 * Terminals that implement mode 2026 (Ghostty, iTerm2, kitty, WezTerm) hide
 * the intermediate states; others (e.g. Apple Terminal) can paint the erased
 * frame between syscalls, which shows up as flicker on every streamed update.
 *
 * Like pi-tui's renderer, which assembles a whole frame into one buffer and
 * writes it once, this adapter joins everything between the begin and end
 * markers into a single `write()`. Other writes pass through untouched and
 * synchronously, so shutdown/cursor-restore output is never delayed.
 */
const BEGIN_SYNCHRONIZED_UPDATE = "\u001b[?2026h";
const END_SYNCHRONIZED_UPDATE = "\u001b[?2026l";

type WriteCallback = (error?: Error | null) => void;

export function createFrameCoalescingStdout(
  stdout: NodeJS.WriteStream,
): NodeJS.WriteStream {
  let pending: string[] | undefined;

  const flush = (): boolean => {
    if (pending === undefined) return true;
    const data = pending.join("");
    pending = undefined;
    return stdout.write(data);
  };

  const write = (
    chunk: unknown,
    encodingOrCallback?: BufferEncoding | WriteCallback,
    callback?: WriteCallback,
  ): boolean => {
    const done =
      typeof encodingOrCallback === "function" ? encodingOrCallback : callback;
    if (typeof chunk === "string" && done === undefined) {
      if (chunk === BEGIN_SYNCHRONIZED_UPDATE && pending === undefined) {
        pending = [chunk];
        // Never hold output past the current task if an end marker is lost.
        queueMicrotask(flush);
        return true;
      }
      if (pending !== undefined) {
        pending.push(chunk);
        return chunk === END_SYNCHRONIZED_UPDATE ? flush() : true;
      }
    }
    flush();
    return typeof encodingOrCallback === "function"
      ? stdout.write(chunk as string, encodingOrCallback)
      : stdout.write(chunk as string, encodingOrCallback, done);
  };

  // Everything except `write` is the real stream (TTY size, resize events).
  const handler: ProxyHandler<NodeJS.WriteStream> = {
    get(target, property) {
      if (property === "write") return write;
      const value: unknown = target[property as keyof NodeJS.WriteStream];
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(target)
        : value;
    },
  };
  return new Proxy(stdout, handler);
}
