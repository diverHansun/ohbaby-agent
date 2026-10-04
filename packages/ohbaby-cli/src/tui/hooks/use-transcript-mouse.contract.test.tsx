import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { Terminal } from "@xterm/headless";
import { render, Text, useInput, usePaste } from "ink";
import type { ReactElement } from "react";
import { expect, it } from "vitest";
import {
  useTranscriptMouse,
  type TranscriptMouseWheel,
} from "./use-transcript-mouse.js";

class Output extends EventEmitter {
  readonly isTTY = true;
  readonly columns = 40;
  readonly rows = 12;
  readonly chunks: string[] = [];
  write(
    chunk: string,
    encodingOrCallback?: BufferEncoding | (() => void),
    callback?: () => void,
  ): boolean {
    this.chunks.push(chunk);
    if (typeof encodingOrCallback === "function") encodingOrCallback();
    else callback?.();
    return true;
  }
}

/** Real Node Readable semantics: read() emits data while Ink owns readable. */
class Input extends PassThrough {
  readonly isTTY = true;
  raw = false;
  setRawMode(value: boolean): this {
    this.raw = value;
    return this;
  }
  unref(): this {
    return this;
  }
  ref(): this {
    return this;
  }
}

it("observes Ink reads without stealing keys, routes split wheel reports, ignores paste and restores mouse mode", async () => {
  const input = new Input();
  const output = new Output();
  const wheels: TranscriptMouseWheel[] = [];
  const keys: string[] = [];
  const pastes: string[] = [];
  const term = new Terminal({ cols: 40, rows: 12, allowProposedApi: true });
  let offset = 0;
  const Scene = ({
    enabled = true,
  }: {
    readonly enabled?: boolean;
  }): ReactElement => {
    useTranscriptMouse((event) => wheels.push(event), enabled);
    useInput((text) => keys.push(text));
    usePaste((text) => pastes.push(text));
    return <Text>content</Text>;
  };
  const app = render(<Scene />, {
    alternateScreen: true,
    exitOnCtrlC: false,
    patchConsole: false,
    stdin: input as unknown as NodeJS.ReadStream,
    stdout: output as unknown as NodeJS.WriteStream,
  });
  const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    await app.waitUntilRenderFlush();
    await new Promise<void>((resolve) => {
      term.write(output.chunks.slice(offset).join(""), resolve);
    });
    offset = output.chunks.length;
  };
  try {
    await flush();
    expect(term.buffer.active.type).toBe("alternate");
    expect(term.modes.mouseTrackingMode).toBe("vt200");
    expect(input.raw).toBe(true);
    input.write("before");
    input.write("\x1b[<64;");
    input.write("10;3M");
    input.write("after");
    await flush();
    expect(wheels).toEqual([{ delta: -1, x: 9, y: 2 }]);
    expect(keys.join("")).toBe("beforeafter");
    input.write("\x1b[200~paste\x1b[<65;3;4M");
    input.write("\x1b[201~");
    input.write("\x1b[<0;10;3M\x1b[<0;10;3m");
    await flush();
    expect(wheels).toHaveLength(1);
    expect(keys.join("")).toBe("beforeafter");
    expect(pastes).toEqual(["paste\x1b[<65;3;4M"]);
    app.rerender(<Scene enabled={false} />);
    await flush();
    expect(term.modes.mouseTrackingMode).toBe("none");
    input.write("still typing");
    input.write("\x1b[<65;10;3M");
    await flush();
    expect(keys.join("")).toBe("beforeafterstill typing");
    expect(wheels).toHaveLength(1);
    app.rerender(<Scene />);
    await flush();
    expect(term.modes.mouseTrackingMode).toBe("vt200");
  } finally {
    app.unmount();
    await app.waitUntilExit();
    await new Promise<void>((resolve) => {
      term.write(output.chunks.slice(offset).join(""), resolve);
    });
    expect(term.buffer.active.type).toBe("normal");
    expect(term.modes.mouseTrackingMode).toBe("none");
    expect(input.raw).toBe(false);
    expect(input.listenerCount("data")).toBe(0);
    input.destroy();
    term.dispose();
  }
});
