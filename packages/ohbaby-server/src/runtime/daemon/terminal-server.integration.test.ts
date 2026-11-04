import { once } from "node:events";
import { request } from "node:http";
import { homedir } from "node:os";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createDaemonHttpServer, type WorkspaceBackend } from "./server.js";

const token = "terminal-test-token";
const authorization = `Bearer ${token}`;
const protocols = [
  `ohbaby.bearer.${Buffer.from(token).toString("base64url")}`,
  "ohbaby.terminal.v1",
];

async function createTerminal(
  url: string,
  headers: Record<string, string> = {},
): Promise<{ id: string; directory: string }> {
  const response = await fetch(`${url}/v1/terminals`, {
    method: "POST",
    headers: { authorization, "content-type": "application/json", ...headers },
    body: JSON.stringify({ cols: 80, rows: 24 }),
  });
  expect(response.status).toBe(201);
  return (
    (await response.json()) as { terminal: { id: string; directory: string } }
  ).terminal;
}

async function deniedUpgrade(
  url: string,
  headers: Record<string, string | undefined>,
): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `${url.replace("http:", "ws:")}/v1/terminals/missing/attach`,
      protocols,
      { headers },
    );
    ws.on("unexpected-response", (_request, response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
      ws.terminate();
    });
    ws.on("open", () => {
      ws.terminate();
      reject(new Error("Unexpected successful upgrade"));
    });
    ws.on("error", () => undefined);
  });
}

function backend(): WorkspaceBackend {
  // Terminal routes never enter the agent backend; these are its startup hooks.
  return {
    subscribeEvents: () => () => undefined,
    subscribePermissionEvents: () => () => undefined,
    getSessionIndex: () => Promise.resolve([]),
    getPermissionSnapshot: () => Promise.resolve({ permissionEpoch: "test" }),
  } as unknown as WorkspaceBackend;
}

async function withDaemon(
  run: (url: string, stop: () => Promise<unknown>) => Promise<void>,
  multiScope = false,
  host = "127.0.0.1",
): Promise<void> {
  const server = createDaemonHttpServer({
    authToken: token,
    backend: backend(),
    host,
    port: 0,
    ...(multiScope
      ? { scopeRoot: process.cwd(), createWorkspaceBackend: backend }
      : {}),
  });
  await server.start();
  try {
    await run(server.url.replace("0.0.0.0", "127.0.0.1"), () => server.stop());
  } finally {
    await server.stop();
  }
}

function rawRequest(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers }, (response) => {
      let body = "";
      response.setEncoding("utf8");
      response.on("data", (chunk: string) => {
        body += chunk;
      });
      response.on("end", () => {
        resolve({ status: response.statusCode ?? 0, body });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

describe("daemon terminal HTTP and WebSocket boundary", () => {
  it.each([false, true])(
    "guards all hosts and mounts global terminals (multi scope %s)",
    async (multiScope) => {
      await withDaemon(async (url) => {
        for (const path of ["/", "/v1/health", "/v1/terminals", "/api/rpc"]) {
          expect(
            (
              await rawRequest(`${url}${path}`, {
                host: "attacker.example",
                authorization,
              })
            ).status,
          ).toBe(403);
        }
        const response = await rawRequest(`${url}/v1/terminals`, {
          authorization,
          host: "localhost:9999",
          "x-ohbaby-directory": "bad-directory",
        });
        expect(response.status).toBe(200);
        expect(JSON.parse(response.body)).toEqual({ ok: true, terminals: [] });
        expect((await fetch(`${url}/v1/terminals`)).status).toBe(401);
      }, multiScope);
    },
  );

  it("denies terminal REST on non-loopback listeners", async () => {
    await withDaemon(
      async (url) => {
        const response = await fetch(`${url}/v1/terminals`, {
          headers: { authorization },
        });
        expect(response.status).toBe(403);
        expect(await response.json()).toMatchObject({
          error: { code: "TERMINAL_LOOPBACK_ONLY" },
        });
      },
      false,
      "0.0.0.0",
    );
  });

  it("authenticates after upgrade and never echoes the bearer protocol", async () => {
    await withDaemon(async (url) => {
      for (const [offered, expectedCode] of [
        [protocols, 4404],
        [["ohbaby.terminal.v1"], 4401],
        [["ohbaby.terminal.v1", "ohbaby.bearer.d3Jvbmc"], 4401],
      ] as const) {
        const ws = new WebSocket(
          `${url.replace("http:", "ws:")}/v1/terminals/missing/attach`,
          [...offered],
        );
        const closed = once(ws, "close");
        await once(ws, "open");
        expect(ws.protocol).toBe("ohbaby.terminal.v1");
        expect((await closed)[0]).toBe(expectedCode);
      }
    });
  });

  it("rejects malicious Host and Origin before WebSocket upgrade", async () => {
    await withDaemon(async (url) => {
      for (const headers of [
        { host: "evil.example" },
        { origin: "https://evil.example" },
        { origin: "null" },
        { origin: "malformed" },
      ])
        expect(await deniedUpgrade(url, headers)).toBe(403);
      const local = new WebSocket(
        `${url.replace("http:", "ws:")}/v1/terminals/missing/attach`,
        protocols,
        {
          origin: "http://localhost:5173",
          headers: { host: "localhost:9999" },
        },
      );
      const closed = once(local, "close");
      await once(local, "open");
      expect((await closed)[0]).toBe(4404);
    });
    await withDaemon(
      async (url) => {
        expect(await deniedUpgrade(url, {})).toBe(403);
      },
      false,
      "0.0.0.0",
    );
  });

  it("validates create dimensions and directory without falling back to home", async () => {
    await withDaemon(async (url) => {
      for (const body of [
        { cols: 1, rows: 24 },
        { cols: 80, rows: 201 },
        { cols: 80.5, rows: 24 },
        { cols: "80", rows: 24 },
        null,
      ]) {
        expect(
          (
            await fetch(`${url}/v1/terminals`, {
              method: "POST",
              headers: { authorization, "content-type": "application/json" },
              body: JSON.stringify(body),
            })
          ).status,
        ).toBe(400);
      }
      for (const directory of [
        "relative",
        "",
        "/does-not-exist-terminal-test",
        "%GG",
      ]) {
        const response = await fetch(`${url}/v1/terminals`, {
          method: "POST",
          headers: {
            authorization,
            "content-type": "application/json",
            "x-ohbaby-directory": directory,
            "x-ohbaby-directory-encoding": "percent-utf8",
          },
          body: JSON.stringify({ cols: 80, rows: 24 }),
        });
        expect(response.status).toBe(400);
      }
      expect(
        await (
          await fetch(`${url}/v1/terminals`, { headers: { authorization } })
        ).json(),
      ).toEqual({ ok: true, terminals: [] });
      const terminal = await createTerminal(url, {
        "x-ohbaby-directory": encodeURIComponent(`${process.cwd()}/packages`),
        "x-ohbaby-directory-encoding": "percent-utf8",
      });
      expect(terminal.directory).toBe(process.cwd());
      const deleted = await fetch(
        `${url}/v1/terminals/${terminal.id}?force=1`,
        {
          method: "DELETE",
          headers: {
            authorization,
            "x-ohbaby-directory": "%GG",
            "x-ohbaby-directory-encoding": "percent-utf8",
          },
        },
      );
      expect(deleted.status).toBe(200);
    }, true);
  });

  it("refuses unauthenticated create and delete without changing terminal inventory", async () => {
    await withDaemon(async (url) => {
      expect(
        (
          await fetch(`${url}/v1/terminals`, {
            method: "POST",
            body: JSON.stringify({ cols: 80, rows: 24 }),
          })
        ).status,
      ).toBe(401);
      const terminal = await createTerminal(url);
      expect(
        (
          await fetch(`${url}/v1/terminals/${terminal.id}?force=1`, {
            method: "DELETE",
            headers: { authorization: "Bearer wrong" },
          })
        ).status,
      ).toBe(401);
      expect(
        await (
          await fetch(`${url}/v1/terminals`, { headers: { authorization } })
        ).json(),
      ).toMatchObject({ terminals: [{ id: terminal.id, state: "running" }] });
    });
  });

  it("enforces the complete message size across WebSocket fragments", async () => {
    await withDaemon(async (url) => {
      const terminal = await createTerminal(url);
      const ws = new WebSocket(
        `${url.replace("http:", "ws:")}/v1/terminals/${terminal.id}/attach`,
        protocols,
      );
      await once(ws, "open");
      const closed = once(ws, "close");
      ws.send('{"type":"input","data":"' + "a".repeat(40000), { fin: false });
      ws.send("a".repeat(40000) + '"}', { fin: true });
      expect((await closed)[0]).toBe(1009);
      expect(
        await (
          await fetch(`${url}/v1/terminals`, { headers: { authorization } })
        ).json(),
      ).toMatchObject({ terminals: [{ id: terminal.id, state: "running" }] });
    });
  });

  it("discards malformed, binary, server-only messages and invalid dimensions", async () => {
    await withDaemon(async (url) => {
      const terminal = await createTerminal(url);
      const address = `${url.replace("http:", "ws:")}/v1/terminals/${terminal.id}/attach`;
      const ws = new WebSocket(address, protocols);
      const output: string[] = [];
      ws.on("message", (data) => {
        if (!Buffer.isBuffer(data)) return;
        const message = JSON.parse(data.toString()) as {
          type: string;
          data?: string;
        };
        if (message.type === "output") output.push(message.data ?? "");
      });
      await once(ws, "open");
      ws.send("not-json");
      ws.send(
        JSON.stringify({ type: "input", data: "echo INJECTED_BINARY\r" }),
        { binary: true },
      );
      for (const message of [
        null,
        [],
        { type: "input", data: 123 },
        {
          type: "snapshot",
          data: "echo INJECTED_SNAPSHOT\r",
          cols: 80,
          rows: 24,
        },
        { type: "output", data: "echo INJECTED_OUTPUT\r" },
        { type: "exit", exitCode: 0 },
        { type: "resize", cols: 1, rows: 24 },
        { type: "resize", cols: 501, rows: 24 },
        { type: "resize", cols: 80, rows: 0 },
        { type: "resize", cols: 80, rows: 201 },
        { type: "resize", cols: 80.5, rows: 24 },
        { type: "resize", cols: "80", rows: 24 },
      ])
        ws.send(JSON.stringify(message));
      ws.send(
        JSON.stringify({
          type: "input",
          data: "printf 'checked-%s\\n' valid\r",
        }),
      );
      await expect.poll(() => output.join("")).toContain("checked-valid");
      expect(output.join("")).not.toContain("INJECTED_");
      const viewer = new WebSocket(address, protocols);
      const snapshot = once(viewer, "message");
      expect(
        JSON.parse(((await snapshot)[0] as Buffer).toString()),
      ).toMatchObject({ type: "snapshot", cols: 80, rows: 24 });
      viewer.terminate();
      ws.send(JSON.stringify({ type: "resize", cols: 100, rows: 30 }));
      ws.send(
        JSON.stringify({
          type: "input",
          data: "printf 'resized-%s\\n' valid\r",
        }),
      );
      await expect.poll(() => output.join("")).toContain("resized-valid");
      const resized = new WebSocket(address, protocols);
      const resizedSnapshot = once(resized, "message");
      expect(
        JSON.parse(((await resizedSnapshot)[0] as Buffer).toString()),
      ).toMatchObject({ type: "snapshot", cols: 100, rows: 30 });
      resized.terminate();
      ws.terminate();
    });
  });

  it("sends no terminal data to unauthorized sockets even with a query token", async () => {
    await withDaemon(async (url) => {
      const terminal = await createTerminal(url);
      const ws = new WebSocket(
        `${url.replace("http:", "ws:")}/v1/terminals/${terminal.id}/attach?token=${token}`,
        ["ohbaby.terminal.v1"],
      );
      const messages: unknown[] = [];
      ws.on("message", (data) => messages.push(data));
      const closed = once(ws, "close");
      await once(ws, "open");
      expect((await closed)[0]).toBe(4401);
      expect(messages).toEqual([]);
    });
  });

  it("stops the daemon with an attached shell and releases the listening port", async () => {
    await withDaemon(async (url, stop) => {
      const terminal = await createTerminal(url);
      const ws = new WebSocket(
        `${url.replace("http:", "ws:")}/v1/terminals/${terminal.id}/attach`,
        protocols,
      );
      await once(ws, "open");
      const closed = once(ws, "close");
      expect(await stop()).toEqual({ status: "confirmed", errors: [] });
      await closed;
      await expect(fetch(`${url}/v1/terminals`)).rejects.toThrow();
    });
  });

  it("creates in home, runs real shell commands, reconnects, and closes", async () => {
    await withDaemon(async (url) => {
      const response = await fetch(`${url}/v1/terminals`, {
        method: "POST",
        headers: { authorization, "content-type": "application/json" },
        body: JSON.stringify({ cols: 80, rows: 24 }),
      });
      expect(response.status).toBe(201);
      const { terminal } = (await response.json()) as {
        terminal: { id: string; directory: string };
      };
      expect(terminal.directory).toBe(homedir());
      const address = `${url.replace("http:", "ws:")}/v1/terminals/${terminal.id}/attach`;
      const ws = new WebSocket(address, protocols);
      const messages: { type: string; data?: string }[] = [];
      ws.on("message", (data) => {
        if (Buffer.isBuffer(data))
          messages.push(
            JSON.parse(data.toString()) as { type: string; data?: string },
          );
      });
      await once(ws, "open");
      await expect.poll(() => messages[0]?.type).toBe("snapshot");
      ws.send(
        JSON.stringify({
          type: "input",
          data: "printf 'terminal-%s\\n' boundary-ok\r",
        }),
      );
      await expect
        .poll(() =>
          messages
            .filter((message) => message.type === "output")
            .map((message) => message.data)
            .join(""),
        )
        .toContain("terminal-boundary-ok");
      const disconnected = once(ws, "close");
      ws.close();
      await disconnected;
      const again = new WebSocket(address, protocols);
      const snapshot = once(again, "message");
      await once(again, "open");
      expect(
        JSON.parse(((await snapshot)[0] as Buffer).toString()),
      ).toMatchObject({
        type: "snapshot",
        data: expect.stringContaining("terminal-boundary-ok") as unknown,
      });
      const closed = once(again, "close");
      const deleted = await fetch(
        `${url}/v1/terminals/${terminal.id}?force=1`,
        { method: "DELETE", headers: { authorization } },
      );
      expect(deleted.status).toBe(200);
      expect((await closed)[0]).toBe(1000);
      expect(
        await (
          await fetch(`${url}/v1/terminals`, { headers: { authorization } })
        ).json(),
      ).toEqual({ ok: true, terminals: [] });
    });
  });
});
