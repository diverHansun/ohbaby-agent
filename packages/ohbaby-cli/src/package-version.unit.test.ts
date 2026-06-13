import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getCliPackageVersion } from "./package-version.js";

describe("getCliPackageVersion", () => {
  it("reads the displayed CLI version from the CLI package metadata", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { readonly version?: unknown };

    expect(getCliPackageVersion()).toBe(packageJson.version);
  });
});
