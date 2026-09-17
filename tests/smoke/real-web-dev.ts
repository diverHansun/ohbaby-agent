/** Opt-in development UI against a real provider, isolated from daily user data. */
import { createServer } from "node:http";
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import fs, { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import os, { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { createDaemonHttpServer } from "../../packages/ohbaby-server/src/runtime/daemon/server.js";
import {
  createPersistentUiBackendClient,
  closePersistentUiBackendDatabase,
} from "../../packages/ohbaby-agent/src/adapters/ui-persistent.js";
import { createWorkspaceRegistryStore } from "../../packages/ohbaby-agent/src/services/workspace-registry/index.js";
import { loadEnvFile } from "../../packages/ohbaby-agent/src/config/llm/loaders.js";
import { createLLMClient } from "../../packages/ohbaby-agent/src/core/llm-client/index.js";
import { installFormalCacheObserver } from "./formal-cache-observer.js";

if (!process.argv.includes("--run"))
  throw new Error(
    "Pass --run to enable real provider requests (maximum 20 HTTP requests).",
  );
const repository = process.cwd();
const webRoot = join(repository, "apps/ohbaby-web");
const webRequire = createRequire(join(webRoot, "package.json"));
const { createServer: createViteServer } = await import(
  pathToFileURL(
    join(
      dirname(webRequire.resolve("vite/package.json")),
      "dist/node/index.js",
    ),
  ).href
);
const environment = await loadEnvFile(join(repository, ".env"));
if (!environment.ZENMUX_API_KEY && !process.env.ZENMUX_API_KEY)
  throw new Error("Missing real model credential");
process.env.ZENMUX_API_KEY ??= environment.ZENMUX_API_KEY;
const resumeArgument = process.argv.find((arg) =>
  arg.startsWith("--resume-root="),
);
const resumeRoot = resumeArgument?.slice("--resume-root=".length);
const root = resumeRoot
  ? await realpath(resumeRoot)
  : await mkdtemp(join(tmpdir(), "ohbaby-web-dev-real-"));
if (resumeRoot) {
  const temporaryRoot = await realpath(tmpdir());
  if (
    dirname(root) !== temporaryRoot ||
    !root.slice(temporaryRoot.length + 1).startsWith("ohbaby-web-dev-real-")
  )
    throw new Error("Resume only an existing isolated Web E2E directory");
  await fs.access(join(root, "session.db"));
}
// Test-only OS home injection also isolates read-only legacy configuration fallback.
// OHBABY_HOME alone does not suppress that compatibility path. Never change HOME.
os.homedir = () => root;
const home = join(root, "config");
const workspacePath = join(root, "workspace");
await Promise.all([
  mkdir(home, { recursive: true }),
  mkdir(workspacePath, { recursive: true }),
]);
const workdir = await realpath(workspacePath);
await writeFile(join(home, ".skip-auto-migrate"), "");
await writeFile(
  join(workdir, "note.md"),
  "Project: Cedar\nRelease: 17\nOwner: Lin\n",
);
process.env.OHBABY_HOME = home;
const timeline: string[] = [];
const originalReadFile = fs.readFile;
let holdRead = process.argv.includes("--hold-read");
let releaseRead: (() => void) | undefined;
// Pause only the controlled local fixture read; its real contents are read after release.
// Touch <root>/release-read from the test controller to continue. No provider output is replaced.
if (holdRead) {
  fs.readFile = (async (...args: Parameters<typeof fs.readFile>) => {
    if (holdRead && String(args[0]) === join(workdir, "note.md")) {
      holdRead = false;
      timeline.push("fixture-read-waiting");
      await writeFile(join(root, "read-waiting"), "waiting");
      await new Promise<void>((done) => {
        const timer = setInterval(() => {
          void fs.access(join(root, "release-read")).then(finish, () => {});
        }, 50);
        const timeout = setTimeout(finish, 180_000);
        function finish(): void {
          clearInterval(timer);
          clearTimeout(timeout);
          done();
        }
        releaseRead = finish;
      });
      timeline.push("fixture-read-released");
    }
    return originalReadFile(...args);
  }) as typeof fs.readFile;
}
const requests: {
  id: number;
  purpose?: string;
  sessionId?: string;
  model: string;
  protocol: string;
  callIds: string[];
  resultIds: string[];
  nativeMessages: number;
  settled: boolean;
}[] = [];
const evidenceFile = join(
  root,
  resumeRoot
    ? `resume-request-evidence-${Date.now()}.json`
    : "request-evidence.json",
);
const requestContext = new AsyncLocalStorage<{
  id: number;
  purpose?: string;
}>();
const localFetch = globalThis.fetch;
const observer = installFormalCacheObserver({
  maxRequests: 20,
  context: () => requestContext.getStore(),
});
let evidenceWrites = Promise.resolve();
function saveEvidence(): Promise<void> {
  evidenceWrites = evidenceWrites.then(() =>
    writeFile(
      evidenceFile,
      JSON.stringify({ timeline, requests, wire: observer.records }, null, 2),
    ),
  );
  return evidenceWrites;
}
const hashId = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
const backend = createPersistentUiBackendClient({
  dbPath: join(root, "session.db"),
  workdir,
  projectDirectory: workdir,
  createLLMClient: async (options) => {
    const client = await createLLMClient(options);
    const stream = client.provider.streamResponse.bind(client.provider);
    client.provider.streamResponse = async (request) => {
      const row = {
        id: requests.length + 1,
        purpose: request.purpose,
        sessionId: request.sessionId,
        model: request.model,
        protocol: client.config.interfaceProvider,
        callIds: request.messages.flatMap((message) =>
          message.role === "assistant"
            ? (message.toolCalls?.map((call) => hashId(call.callId)) ?? [])
            : [],
        ),
        resultIds: request.messages.flatMap((message) =>
          message.role === "tool" ? [hashId(message.callId)] : [],
        ),
        nativeMessages: request.messages.filter(
          (message) =>
            message.role === "assistant" && message.modelState !== undefined,
        ).length,
        settled: false,
      };
      requests.push(row);
      const iterable = await requestContext
        .run(row, () => stream(request))
        .catch(async (error: unknown) => {
          row.settled = true;
          await saveEvidence();
          throw error;
        });
      const iterator = iterable[Symbol.asyncIterator]();
      return (async function* () {
        try {
          for (;;) {
            const next = await requestContext.run(row, () => iterator.next());
            if (next.done) break;
            yield next.value;
          }
        } finally {
          await iterator.return?.();
          row.settled = true;
          await saveEvidence();
        }
      })();
    };
    return client;
  },
});
const handle = createDaemonHttpServer({
  backend,
  authToken: randomUUID(),
  host: "127.0.0.1",
  port: 0,
  scopeRoot: workdir,
  workspaceRegistry: createWorkspaceRegistryStore(),
  listKnownWorkspaceScopes: () => [workdir],
  createWorkspaceBackend: (scope) => {
    if (scope !== workdir)
      throw new Error("Only the isolated test workspace is available");
    return backend;
  },
  webAssetsDir: webRoot,
});
await handle.start();
let vite: Awaited<ReturnType<typeof createViteServer>>;
const server = createServer((request, response) => {
  const url = request.url ?? "/";
  if (url === "/" || url.startsWith("/?")) {
    // Reuse production bootstrap generation and its escaping/authentication rules.
    void (async () => {
      const htmlResponse = await localFetch(`${handle.url}/`, {
        headers: { accept: "text/html" },
      });
      const html = await vite.transformIndexHtml(
        url,
        await htmlResponse.text(),
      );
      response.writeHead(htmlResponse.status, {
        "content-type": "text/html",
        "cache-control": "no-store",
      });
      response.end(html);
    })().catch(() => {
      response.writeHead(500);
      response.end("Development bootstrap failed");
    });
  } else {
    vite.middlewares(request, response, () => {
      response.writeHead(404);
      response.end();
    });
  }
});
vite = await createViteServer({
  root: webRoot,
  appType: "custom",
  resolve: {
    alias: {
      "ohbaby-sdk": resolve(repository, "packages/ohbaby-sdk/src/index.ts"),
    },
  },
  server: {
    middlewareMode: true,
    proxy: { "/v1": handle.url, "/api": handle.url, "/doc": handle.url },
    hmr: { server },
    fs: { allow: [repository] },
  },
});
await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
const address = server.address();
if (!address || typeof address === "string")
  throw new Error("Missing bound port");
await writeFile(
  join(root, "connection.json"),
  JSON.stringify({ url: `http://127.0.0.1:${address.port}`, workdir, home }),
);
console.log(
  JSON.stringify({
    ready: true,
    url: `http://127.0.0.1:${address.port}`,
    root,
    readFile: join(workdir, "note.md"),
    seededProfile: false,
    maxHttpRequests: 20,
    evidenceFile,
    holdRead,
  }),
);
let closing = false;
async function stop(): Promise<void> {
  if (closing) return;
  closing = true;
  releaseRead?.();
  fs.readFile = originalReadFile;
  const cleanup = await Promise.allSettled([handle.stop(), backend.dispose()]);
  timeline.push(
    ...cleanup.flatMap((result, index) =>
      result.status === "rejected" ? [`cleanup-failed-${index}`] : [],
    ),
  );
  try {
    await observer.drain();
  } finally {
    observer.restore();
    try {
      await saveEvidence();
    } finally {
      await vite.close();
      server.closeAllConnections();
      await new Promise<void>((done) => server.close(() => done()));
      closePersistentUiBackendDatabase();
    }
  }
}
process.once("SIGINT", () => {
  void stop().finally(() => process.exit(0));
});
process.once("SIGTERM", () => {
  void stop().finally(() => process.exit(0));
});
