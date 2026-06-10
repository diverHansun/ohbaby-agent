import { describe, expect, it } from "vitest";
import {
  isSessionProjectRootCaseInsensitivePlatform,
  normalizeSessionProjectRoot,
  sameSessionProjectRoot,
} from "./project-root.js";

describe("session project root comparison", () => {
  it("normalizes path separators and trailing slashes", () => {
    expect(
      normalizeSessionProjectRoot("D:\\Repo\\", { caseInsensitive: false }),
    ).toBe("D:/Repo");
  });

  it("keeps differently-cased POSIX roots distinct when comparison is case-sensitive", () => {
    expect(
      sameSessionProjectRoot("/repo/App", "/repo/app", {
        caseInsensitive: false,
      }),
    ).toBe(false);
    expect(
      sameSessionProjectRoot("/repo/App/", "/repo/App", {
        caseInsensitive: false,
      }),
    ).toBe(true);
  });

  it("folds case when comparison is case-insensitive", () => {
    expect(
      sameSessionProjectRoot("D:\\Repo\\", "d:/repo", {
        caseInsensitive: true,
      }),
    ).toBe(true);
  });

  it("defaults to case-insensitive comparison only on Windows", () => {
    expect(isSessionProjectRootCaseInsensitivePlatform("win32")).toBe(true);
    expect(isSessionProjectRootCaseInsensitivePlatform("linux")).toBe(false);
    expect(isSessionProjectRootCaseInsensitivePlatform("darwin")).toBe(false);
  });
});
