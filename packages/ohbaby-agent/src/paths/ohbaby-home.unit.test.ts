import { describe, expect, it } from "vitest";
import {
  resolveOhbabyDataRoot,
  resolveOhbabyHome,
  resolveProjectOhbabyRoot,
} from "./ohbaby-home.js";

describe("ohbaby path resolution", () => {
  it("uses the home dot directory by default", () => {
    expect(
      resolveOhbabyHome({
        environment: {},
        homeDirectory: "/home/tester",
        platform: "linux",
      }),
    ).toBe("/home/tester/.ohbaby");
    expect(resolveProjectOhbabyRoot("/repo", "linux")).toBe("/repo/.ohbaby");
  });

  it("treats OHBABY_HOME as the complete configuration root", () => {
    expect(
      resolveOhbabyHome({
        environment: { OHBABY_HOME: "/var/lib/ohbaby-profile" },
        platform: "linux",
      }),
    ).toBe("/var/lib/ohbaby-profile");
  });

  it("rejects a relative OHBABY_HOME", () => {
    expect(() =>
      resolveOhbabyHome({
        environment: { OHBABY_HOME: "relative/profile" },
        platform: "linux",
      }),
    ).toThrow("OHBABY_HOME must be an absolute directory path");
  });

  it("lets explicit home injection isolate tests from OHBABY_HOME", () => {
    expect(
      resolveOhbabyHome({
        environment: { OHBABY_HOME: "/ambient/profile" },
        homeDirectory: "/isolated/home",
        platform: "linux",
      }),
    ).toBe("/isolated/home/.ohbaby");
  });

  it("uses XDG data roots on Linux", () => {
    expect(
      resolveOhbabyDataRoot({
        environment: { XDG_DATA_HOME: "/data" },
        homeDirectory: "/home/tester",
        platform: "linux",
      }),
    ).toBe("/data/ohbaby");
    expect(
      resolveOhbabyDataRoot({
        environment: {},
        homeDirectory: "/home/tester",
        platform: "linux",
      }),
    ).toBe("/home/tester/.local/share/ohbaby");
  });

  it("uses Application Support on macOS", () => {
    expect(
      resolveOhbabyDataRoot({
        environment: {},
        homeDirectory: "/Users/tester",
        platform: "darwin",
      }),
    ).toBe("/Users/tester/Library/Application Support/ohbaby");
  });

  it("uses LocalAppData for Windows data", () => {
    const options = {
      environment: {
        APPDATA: "C:\\Users\\tester\\AppData\\Roaming",
        LOCALAPPDATA: "D:\\user-data",
        XDG_DATA_HOME: "Z:\\xdg-data",
      },
      homeDirectory: "C:\\Users\\tester",
      platform: "win32" as const,
    };

    expect(resolveOhbabyDataRoot(options)).toBe("D:\\user-data\\ohbaby");
    expect(
      resolveOhbabyDataRoot({
        ...options,
        environment: { ...options.environment, LOCALAPPDATA: "" },
      }),
    ).toBe("C:\\Users\\tester\\AppData\\Local\\ohbaby");
  });
});
