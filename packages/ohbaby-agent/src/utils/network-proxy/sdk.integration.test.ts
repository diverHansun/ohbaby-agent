import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

describe("HTTPS SDK proxy compatibility", () => {
  it("routes Node, Tavily, OpenAI and Anthropic and honors an explicit SDK agent", async () => {
    const env = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) =>
          !/^(https?_proxy|all_proxy|no_proxy|node_use_env_proxy|node_tls_reject_unauthorized)$/iu.test(
            key,
          ),
      ),
    );
    env.NODE_EXTRA_CA_CERTS = fileURLToPath(
      new URL("./fixtures/test-cert.pem", import.meta.url),
    );
    const { stdout } = await promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(
          new URL("./fixtures/sdk-proxy.fixture.ts", import.meta.url),
        ),
      ],
      { env, timeout: 20000 },
    );
    expect(JSON.parse(stdout.trim())).toEqual({
      system: 4,
      environment: 1,
      explicit: 1,
      noProxy: true,
      agentFalse: true,
      loopback: true,
      cidr: true,
      snapshot: true,
      axiosRestored: true,
    });
  }, 25000);
});
