import { type Context } from "hono";
import { randomUUID } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { extname, isAbsolute, relative, resolve } from "node:path";

import { DEFAULT_WEB_STARTUP_INTENT } from "../protocols/web/request-helpers.js";

export interface WebAssetsOptions {
  readonly allowTokenInjection?: boolean;
  readonly baseUrl?: string;
  readonly directory: string;
  readonly workspaceDirectory?: string;
}

function escapeInlineScriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function contentTypeForPath(path: string): string {
  switch (extname(path).toLowerCase()) {
    case ".css":
      return "text/css; charset=utf-8";
    case ".html":
      return "text/html; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".map":
      return "application/json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".wasm":
      return "application/wasm";
    default:
      return "application/octet-stream";
  }
}

export async function serveWebAsset(
  context: Context,
  webAssets: WebAssetsOptions | undefined,
  authToken: string,
): Promise<Response> {
  if (!webAssets) {
    return new Response("Not Found", { status: 404 });
  }
  if (webAssets.allowTokenInjection === false) {
    return new Response("Web assets require a loopback host", {
      status: 403,
    });
  }

  const pathname = new URL(context.req.raw.url).pathname;
  if (
    pathname.startsWith("/api/") ||
    pathname.startsWith("/v1/") ||
    pathname === "/doc"
  ) {
    return new Response("Not Found", { status: 404 });
  }

  const root = resolve(webAssets.directory);
  const relativePath =
    pathname === "/"
      ? "index.html"
      : decodeURIComponent(pathname.replace(/^\/+/, ""));
  if (relativePath.includes("\0")) {
    return new Response("Bad Request", { status: 400 });
  }

  let filePath = resolve(root, relativePath);
  const pathRelation = relative(root, filePath);
  if (pathRelation.startsWith("..") || isAbsolute(pathRelation)) {
    return new Response("Forbidden", { status: 403 });
  }

  let fileStat: Awaited<ReturnType<typeof stat>> | undefined;
  try {
    fileStat = await stat(filePath);
  } catch {
    const acceptsHtml = context.req.header("accept")?.includes("text/html");
    if (!acceptsHtml || extname(filePath).length > 0) {
      return new Response("Not Found", { status: 404 });
    }
    filePath = resolve(root, "index.html");
    fileStat = await stat(filePath);
  }
  if (fileStat.isDirectory()) {
    filePath = resolve(filePath, "index.html");
  }

  let body = await readFile(filePath);
  const contentType = contentTypeForPath(filePath);
  if (contentType.startsWith("text/html")) {
    const bootstrap = {
      baseUrl: webAssets.baseUrl ?? "",
      clientId: randomUUID(),
      ...(webAssets.workspaceDirectory === undefined
        ? {}
        : { directory: webAssets.workspaceDirectory }),
      startupIntent: DEFAULT_WEB_STARTUP_INTENT,
      token: authToken,
    };
    const html = body
      .toString("utf8")
      .replace(
        "</head>",
        `<script>window.__OHBABY__=${escapeInlineScriptJson(
          bootstrap,
        )};</script></head>`,
      );
    body = Buffer.from(html, "utf8");
  }

  return new Response(body, {
    headers: {
      "cache-control": contentType.startsWith("text/html")
        ? "no-store"
        : "public, max-age=31536000, immutable",
      "content-type": contentType,
    },
    status: 200,
  });
}
