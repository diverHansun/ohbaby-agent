/** Failure-only retention of the local test database; no general recovery framework. */
import { chmod, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface FailedLoopWorkspace {
  root: string;
  manifestPath: string;
  auditPath: string;
  profile: string;
  sessionId?: string;
  httpRequests: number;
  commit: string;
}

function containsInlineCredential(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(containsInlineCredential);
  if (!value || typeof value !== "object") return false;
  return Object.entries(value).some(
    ([key, item]) =>
      [
        "apikey",
        "api_key",
        "authorization",
        "access_token",
        "accesstoken",
        "secret",
        "password",
      ].includes(key.toLowerCase()) || containsInlineCredential(item),
  );
}

async function restrictTree(directory: string): Promise<void> {
  await chmod(directory, 0o700);
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) await restrictTree(path);
    else if (entry.isFile()) await chmod(path, 0o600);
    // Do not follow a symlink outside the controlled temporary workspace.
  }
}

export async function retainFailedLoopWorkspace(
  input: FailedLoopWorkspace,
): Promise<void> {
  await restrictTree(input.root);
  const configPath = join(input.root, "config", "model.json");
  const raw: unknown = JSON.parse(await readFile(configPath, "utf8"));
  const config =
    raw && typeof raw === "object" && !Array.isArray(raw)
      ? (raw as Record<string, unknown>)
      : {};
  const api =
    config.apiConfig &&
    typeof config.apiConfig === "object" &&
    !Array.isArray(config.apiConfig)
      ? (config.apiConfig as Record<string, unknown>)
      : {};
  if (containsInlineCredential(config) || api.apiKeyEnv !== "ZENMUX_API_KEY") {
    throw new Error("UNSAFE_INLINE_CREDENTIAL_CONFIG");
  }
  // Only identifiers, paths and counters are exported. SQLite retains model state privately.
  await writeFile(
    input.manifestPath,
    JSON.stringify(
      {
        version: 1,
        status: "retained-failed-run",
        profile: input.profile,
        sessionId: input.sessionId,
        auditPath: input.auditPath,
        workspaceRoot: input.root,
        databasePath: join(input.root, "session.db"),
        configPath,
        workdir: join(input.root, "workspace"),
        credential: { kind: "environment", name: "ZENMUX_API_KEY" },
        httpRequestsAlreadyConsumed: input.httpRequests,
        commit: input.commit,
        note: "Read-only test artifacts. Resume requires an explicit remaining HTTP budget; original paths identify the persisted project.",
      },
      null,
      2,
    ) + "\n",
    { mode: 0o600 },
  );
  await chmod(input.manifestPath, 0o600);
}
