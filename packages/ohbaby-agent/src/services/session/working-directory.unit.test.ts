import { describe, expect, it } from "vitest";
import {
  isSessionDirectoryCaseInsensitivePlatform,
  normalizeSessionDirectory,
  sameSessionDirectory,
} from "./working-directory.js";

describe("session project root comparison", () => {
  it("normalizes path separators and trailing slashes", () => {
    expect(
      normalizeSessionDirectory("D:\\Repo\\", { caseInsensitive: false }),
    ).toBe("D:/Repo");
  });

  it("keeps differently-cased POSIX roots distinct when comparison is case-sensitive", () => {
    expect(
      sameSessionDirectory("/repo/App", "/repo/app", {
        caseInsensitive: false,
      }),
    ).toBe(false);
    expect(
      sameSessionDirectory("/repo/App/", "/repo/App", {
        caseInsensitive: false,
      }),
    ).toBe(true);
  });

  it("folds case when comparison is case-insensitive", () => {
    expect(
      sameSessionDirectory("D:\\Repo\\", "d:/repo", {
        caseInsensitive: true,
      }),
    ).toBe(true);
  });

  it("defaults to case-insensitive comparison only on Windows", () => {
    expect(isSessionDirectoryCaseInsensitivePlatform("win32")).toBe(true);
    expect(isSessionDirectoryCaseInsensitivePlatform("linux")).toBe(false);
    expect(isSessionDirectoryCaseInsensitivePlatform("darwin")).toBe(false);
  });
});
