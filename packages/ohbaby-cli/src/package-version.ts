import { readFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_JSON_URL = new URL("../package.json", import.meta.url);

function readPackageVersion(packageJsonUrl: URL): string {
  const parsed = JSON.parse(readFileSync(packageJsonUrl, "utf8")) as {
    readonly version?: unknown;
  };
  if (typeof parsed.version !== "string" || parsed.version.length === 0) {
    throw new Error("ohbaby-cli package.json is missing a version");
  }
  return parsed.version;
}

export function getCliPackageVersion(): string {
  return readPackageVersion(PACKAGE_JSON_URL);
}

export function getCliPackageDirectory(): string {
  return dirname(fileURLToPath(PACKAGE_JSON_URL));
}
