import { readFileSync } from "node:fs";
import { get as httpGet } from "node:http";
import { get as httpsGet } from "node:https";
import { join } from "node:path";
import semver from "semver";
import { writeUpdateJson } from "./settings.js";

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 3_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

interface UpdateCheckOptions {
  readonly ohbabyHome: string;
  readonly currentVersion: string;
  readonly env?: NodeJS.ProcessEnv;
}

interface UpdateCheck {
  readonly checkedAt: number;
  readonly latestVersion: string;
}

export function isExactVersion(version: unknown): version is string {
  return (
    typeof version === "string" &&
    /^[0-9][0-9A-Za-z.+-]*$/.test(version) &&
    semver.valid(version) !== null
  );
}

function cachePath(ohbabyHome: string): string {
  return join(ohbabyHome, "update", "check.json");
}

function readCheck(ohbabyHome: string): UpdateCheck | undefined {
  try {
    const check = JSON.parse(
      readFileSync(cachePath(ohbabyHome), "utf8"),
    ) as Partial<UpdateCheck> | null;
    if (
      check &&
      typeof check.checkedAt === "number" &&
      Number.isFinite(check.checkedAt) &&
      isExactVersion(check.latestVersion)
    ) {
      return { checkedAt: check.checkedAt, latestVersion: check.latestVersion };
    }
  } catch {
    // The cache is optional, including on first launch.
  }
  return undefined;
}

export function readUpdateNotice({
  ohbabyHome,
  currentVersion,
  env = process.env,
}: UpdateCheckOptions):
  | { readonly latestVersion: string; readonly message: string }
  | undefined {
  if (env.OHBABY_NO_UPDATE_CHECK === "1" || !isExactVersion(currentVersion))
    return undefined;
  const check = readCheck(ohbabyHome);
  if (!check) return undefined;
  const latest = check.latestVersion;
  if (semver.prerelease(latest) && !semver.prerelease(currentVersion))
    return undefined;
  if (semver.gt(latest, currentVersion)) {
    return {
      latestVersion: latest,
      message: `ohbaby ${latest} is available (current: ${currentVersion}). Run ohbaby update to upgrade.`,
    };
  }
  return undefined;
}

export async function fetchLatestVersion(
  env: NodeJS.ProcessEnv = process.env,
  background = false,
): Promise<string> {
  const registry =
    env.npm_config_registry?.trim() || "https://registry.npmjs.org";
  const url = new URL(`${registry.replace(/\/+$/, "")}/ohbaby-cli/latest`);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("The npm registry URL must use HTTP or HTTPS.");
  }
  const get = url.protocol === "https:" ? httpsGet : httpGet;
  const controller = new AbortController();
  const timeout = setTimeout(() => {
    controller.abort();
  }, REQUEST_TIMEOUT_MS);
  if (background) timeout.unref();
  try {
    return await new Promise<string>((resolve, reject) => {
      const request = get(url, { signal: controller.signal }, (response) => {
        if (response.statusCode !== 200) {
          response.destroy();
          reject(
            new Error(
              `npm registry returned HTTP ${String(response.statusCode)}.`,
            ),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("error", reject);
        response.on("data", (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > MAX_RESPONSE_BYTES) {
            response.destroy(new Error("npm registry response is too large."));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          try {
            const metadata = JSON.parse(
              Buffer.concat(chunks).toString("utf8"),
            ) as {
              version?: unknown;
            } | null;
            if (!isExactVersion(metadata?.version))
              throw new Error("invalid version");
            resolve(metadata.version);
          } catch {
            reject(new Error("npm registry did not return a valid version."));
          }
        });
      });
      request.on("error", reject);
      if (background) {
        request.on("socket", (socket) => socket.unref());
      }
    });
  } finally {
    clearTimeout(timeout);
  }
}

export function writeVersionCache(
  ohbabyHome: string,
  latestVersion: string,
): Promise<void> {
  return writeUpdateJson(cachePath(ohbabyHome), {
    checkedAt: Date.now(),
    latestVersion,
  });
}

export function refreshVersionCacheInBackground({
  ohbabyHome,
  env = process.env,
}: Omit<UpdateCheckOptions, "currentVersion">): void {
  if (env.OHBABY_NO_UPDATE_CHECK === "1") return;
  const previous = readCheck(ohbabyHome);
  if (previous && Date.now() - previous.checkedAt < CHECK_INTERVAL_MS) return;
  void fetchLatestVersion(env, true)
    .then((version) => writeVersionCache(ohbabyHome, version))
    .catch(() => undefined);
}
