import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { getAgentPackageVersion } from "./package-version.js";

describe("getAgentPackageVersion", () => {
  it("reads the daemon handshake version from the agent package metadata", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { readonly version?: unknown };

    expect(getAgentPackageVersion()).toBe(packageJson.version);
  });
});
