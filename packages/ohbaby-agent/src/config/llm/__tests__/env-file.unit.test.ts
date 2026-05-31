import { describe, expect, it } from "vitest";
import { parseEnvFile, setEnvFileValue } from "../env-file.js";

describe("env-file helpers", () => {
  it("should parse simple dotenv assignments", () => {
    expect(parseEnvFile('A=1\nB="two words"\n')).toEqual({
      A: "1",
      B: "two words",
    });
  });

  it("should parse dotenv export syntax and inline comments", () => {
    expect(
      parseEnvFile("export A=1\nB=two # comment\nC='three # kept'\n"),
    ).toEqual({
      A: "1",
      B: "two",
      C: "three # kept",
    });
  });

  it("should ignore blank and comment lines while parsing", () => {
    expect(parseEnvFile("\n# comment\nA=1\n")).toEqual({
      A: "1",
    });
  });

  it("should replace an existing key while preserving other lines", () => {
    expect(setEnvFileValue("A=1\nB=old\n", "B", "new value")).toBe(
      'A=1\nB="new value"\n',
    );
  });

  it("should remove duplicate keys so the written value is authoritative", () => {
    expect(setEnvFileValue("A=1\nB=old\nB=older\nC=3\n", "B", "new")).toBe(
      "A=1\nB=new\nC=3\n",
    );
  });

  it("should append a missing key with a trailing newline", () => {
    expect(setEnvFileValue("A=1\n", "B", "secret")).toBe("A=1\nB=secret\n");
  });

  it("should quote values containing comment or equals characters", () => {
    expect(setEnvFileValue("", "A", "value#with=chars")).toBe(
      'A="value#with=chars"\n',
    );
  });
});
