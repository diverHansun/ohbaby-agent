/**
 * Asks the terminal for its default background/foreground colors (OSC 11 /
 * OSC 10) before Ink takes over stdin, the same capability pi-tui exposes as
 * `queryTerminalColors` and Gemini CLI uses to adapt its theme. A DA1 request
 * follows the queries: every terminal answers DA1, so terminals that ignore
 * OSC 10/11 end the probe immediately instead of waiting for the timeout.
 */
export interface RgbColor {
  readonly r: number;
  readonly g: number;
  readonly b: number;
}

export interface TerminalColors {
  readonly background?: RgbColor;
  readonly foreground?: RgbColor;
}

/* eslint-disable no-control-regex -- Terminal replies are control sequences by definition. */
const QUERY = "\u001b]11;?\u001b\\\u001b]10;?\u001b\\\u001b[c";
const OSC_REPLY = /\u001b\](1[01]);([^\u0007\u001b]*)(?:\u0007|\u001b\\)/gu;
const DA1_REPLY = /\u001b\[\?[\d;]*c/u;
/* eslint-enable no-control-regex */

export function parseTerminalColorReplies(data: string): TerminalColors {
  let background: RgbColor | undefined;
  let foreground: RgbColor | undefined;
  for (const match of data.matchAll(OSC_REPLY)) {
    const color = parseOscColor(match[2]);
    if (!color) continue;
    if (match[1] === "11") background = color;
    else foreground = color;
  }
  return {
    ...(background ? { background } : {}),
    ...(foreground ? { foreground } : {}),
  };
}

function parseOscColor(raw: string): RgbColor | undefined {
  const value = raw.trim().replace(/^rgba?:/iu, "");
  const channels = value.startsWith("#")
    ? splitHex(value.slice(1))
    : value.split("/");
  if (channels?.length !== 3) return undefined;
  const [r, g, b] = channels.map(parseChannel);
  return r === undefined || g === undefined || b === undefined
    ? undefined
    : { r, g, b };
}

function splitHex(hex: string): string[] | undefined {
  if (!/^[0-9a-f]+$/iu.test(hex) || hex.length % 3 !== 0) return undefined;
  const size = hex.length / 3;
  return [hex.slice(0, size), hex.slice(size, size * 2), hex.slice(size * 2)];
}

function parseChannel(channel: string): number | undefined {
  if (!/^[0-9a-f]{1,4}$/iu.test(channel)) return undefined;
  return Math.round((parseInt(channel, 16) / (16 ** channel.length - 1)) * 255);
}

export interface ProbeTerminalColorsOptions {
  readonly stdin?: NodeJS.ReadStream;
  readonly stdout?: NodeJS.WriteStream;
  readonly timeoutMs?: number;
}

export async function probeTerminalColors({
  stdin = process.stdin,
  stdout = process.stdout,
  timeoutMs = 200,
}: ProbeTerminalColorsOptions = {}): Promise<TerminalColors> {
  if (!stdin.isTTY || !stdout.isTTY || typeof stdin.setRawMode !== "function") {
    return {};
  }
  const wasRaw = stdin.isRaw;
  // Replies are ASCII. A latin1 string keeps a one-to-one mapping to input
  // bytes, including an unfinished UTF-8 character when the probe times out.
  let received = "";
  return new Promise<TerminalColors>((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      stdin.off("data", onData);
      try {
        stdin.setRawMode(wasRaw);
      } catch {
        // The terminal may already be gone; detection is best-effort.
      }
      stdin.pause();
      // Return keystrokes typed during the probe to the input stream.
      const rest = received.replace(OSC_REPLY, "").replace(DA1_REPLY, "");
      if (rest !== "") stdin.unshift(Buffer.from(rest, "latin1"));
      resolve(parseTerminalColorReplies(received));
    };
    const onData = (chunk: Buffer | string): void => {
      const bytes =
        typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      received += bytes.toString("latin1");
      if (DA1_REPLY.test(received)) finish();
    };
    const timer = setTimeout(finish, timeoutMs);
    try {
      stdin.setRawMode(true);
      stdin.on("data", onData);
      stdin.resume();
      stdout.write(QUERY);
    } catch {
      finish();
    }
  });
}

/** Relative luminance (WCAG) in 0..1. */
export function luminance({ r, g, b }: RgbColor): number {
  const linear = (value: number): number => {
    const channel = value / 255;
    return channel <= 0.03928
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

export function mixRgb(from: RgbColor, to: RgbColor, amount: number): RgbColor {
  const mix = (a: number, b: number): number =>
    Math.round(a + (b - a) * amount);
  return { r: mix(from.r, to.r), g: mix(from.g, to.g), b: mix(from.b, to.b) };
}

export function rgbToHex({ r, g, b }: RgbColor): string {
  return `#${[r, g, b]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("")
    .toUpperCase()}`;
}
