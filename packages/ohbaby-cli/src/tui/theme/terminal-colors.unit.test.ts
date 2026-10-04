import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  parseTerminalColorReplies,
  probeTerminalColors,
} from "./terminal-colors.js";

describe("terminal color probe", () => {
  it("parses OSC 10/11 replies in 16-bit, 8-bit and hex forms", () => {
    expect(
      parseTerminalColorReplies(
        "\u001b]11;rgb:1e1e/1e1e/2e2e\u001b\\\u001b]10;rgb:cd/d6/f4\u0007\u001b[?62;c",
      ),
    ).toEqual({
      background: { r: 30, g: 30, b: 46 },
      foreground: { r: 205, g: 214, b: 244 },
    });
    expect(parseTerminalColorReplies("\u001b]11;#ffffff\u0007")).toEqual({
      background: { r: 255, g: 255, b: 255 },
    });
    expect(parseTerminalColorReplies("garbage")).toEqual({});
  });

  it("stops at the DA1 sentinel, restores the tty and returns typed keys", async () => {
    const stdin = Object.assign(new EventEmitter(), {
      isTTY: true,
      isRaw: false,
      rawModes: [] as boolean[],
      unshifted: [] as string[],
      setRawMode(mode: boolean) {
        this.rawModes.push(mode);
        this.isRaw = mode;
      },
      resume: () => undefined,
      pause: () => undefined,
      unshift(chunk: Buffer) {
        this.unshifted.push(chunk.toString());
      },
    });
    const stdout = {
      isTTY: true,
      write: (query: string): boolean => {
        expect(query).toContain("\u001b]11;?");
        queueMicrotask(() => {
          stdin.emit("data", Buffer.from("x\u001b]11;rgb:ff/ff/ff\u0007"));
          stdin.emit("data", Buffer.from("\u001b[?1;2c"));
        });
        return true;
      },
    };
    const colors = await probeTerminalColors({
      stdin: stdin as unknown as NodeJS.ReadStream,
      stdout: stdout as unknown as NodeJS.WriteStream,
      timeoutMs: 1000,
    });
    expect(colors).toEqual({ background: { r: 255, g: 255, b: 255 } });
    expect(stdin.rawModes).toEqual([true, false]);
    expect(stdin.unshifted).toEqual(["x"]);
    expect(stdin.listenerCount("data")).toBe(0);
  });

  it.each(["DA1", "timeout"])(
    "preserves split UTF-8 input bytes when the probe ends with %s",
    async (ending) => {
      const partial = ending === "timeout";
      const typed = Buffer.from("中👩‍💻", "utf8");
      const expected = partial
        ? typed.subarray(0, 1)
        : Buffer.concat([typed, Buffer.from("é")]);
      const restored: Buffer[] = [];
      const stdin = Object.assign(new EventEmitter(), {
        isTTY: true,
        isRaw: false,
        setRawMode: () => undefined,
        resume: () => undefined,
        pause: () => undefined,
        unshift: (chunk: Buffer) => restored.push(chunk),
      });
      const stdout = {
        isTTY: true,
        write: (): boolean => {
          queueMicrotask(() => {
            stdin.emit("data", typed.subarray(0, 1));
            if (!partial) {
              for (const byte of typed.subarray(1))
                stdin.emit("data", Buffer.from([byte]));
              stdin.emit("data", "é");
              stdin.emit(
                "data",
                Buffer.from("\u001b]11;rgb:ff/ff/ff\u0007\u001b[?1;2c"),
              );
            }
          });
          return true;
        },
      };
      const colors = await probeTerminalColors({
        stdin: stdin as unknown as NodeJS.ReadStream,
        stdout: stdout as unknown as NodeJS.WriteStream,
        timeoutMs: 10,
      });
      expect(Buffer.concat(restored)).toEqual(expected);
      expect(colors).toEqual(
        partial ? {} : { background: { r: 255, g: 255, b: 255 } },
      );
      expect(stdin.listenerCount("data")).toBe(0);
    },
  );

  it("does nothing without an interactive terminal", async () => {
    expect(
      await probeTerminalColors({
        stdin: { isTTY: false } as unknown as NodeJS.ReadStream,
        stdout: { isTTY: false } as unknown as NodeJS.WriteStream,
      }),
    ).toEqual({});
  });
});
