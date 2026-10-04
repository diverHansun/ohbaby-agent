import { describe, expect, it } from "vitest";
import { createTranscriptMouseParser } from "./use-transcript-mouse.js";

describe("transcript mouse parser", () => {
  it("reports only vertical wheel presses in zero-based terminal cells", () => {
    const parser = createTranscriptMouseParser();
    expect(parser.push("text\x1b[<64;10;3M\x1b[<65;2;1M")).toEqual([
      { delta: -1, x: 9, y: 2 },
      { delta: 1, x: 1, y: 0 },
    ]);
    expect(
      parser.push(
        "\x1b[<0;10;3M\x1b[<0;10;3m\x1b[<64;10;3m\x1b[<66;10;3M\x1b[<67;10;3M",
      ),
    ).toEqual([]);
  });

  it("assembles every split of a mouse report without consuming adjacent text", () => {
    const sequence = "\x1b[<65;123;45M";
    for (let split = 1; split < sequence.length; split++) {
      const parser = createTranscriptMouseParser();
      expect(parser.push(sequence.slice(0, split))).toEqual([]);
      expect(parser.push(sequence.slice(split) + "draft")).toEqual([
        { delta: 1, x: 122, y: 44 },
      ]);
    }
  });

  it("ignores mouse-looking sequences inside arbitrarily fragmented bracketed paste", () => {
    const parser = createTranscriptMouseParser();
    const events = [];
    for (const char of "\x1b[200~paste\x1b[<64;10;3M\x1b[201~\x1b[<65;4;5M")
      events.push(...parser.push(char));
    expect(events).toEqual([{ delta: 1, x: 3, y: 4 }]);
  });

  it("accepts wheel modifiers and recovers from malformed or oversized reports", () => {
    const parser = createTranscriptMouseParser();
    expect(parser.push("\x1b[<84;4;5M")).toEqual([{ delta: -1, x: 3, y: 4 }]);
    expect(
      parser.push("\x1b[<64;0;1M\x1b[<64;1;0M\x1b[<" + "9".repeat(500)),
    ).toEqual([]);
    expect(parser.push("\x1b[<64;1;1M")).toEqual([{ delta: -1, x: 0, y: 0 }]);
  });
});
