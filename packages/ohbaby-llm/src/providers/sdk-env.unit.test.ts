import { afterEach, describe, expect, it, vi } from "vitest";
import { createInterfaceProvider } from "./index.js";
import { withoutEnvCustomHeaders } from "./sdk-env.js";
import type { InterfaceProviderKind } from "./types.js";

const LEAKED = "leaked-shell-secret";

function stubHostEnv(): void {
  vi.stubEnv("ANTHROPIC_AUTH_TOKEN", LEAKED);
  vi.stubEnv("ANTHROPIC_API_KEY", LEAKED);
  vi.stubEnv("ANTHROPIC_BASE_URL", "http://env-base.invalid");
  vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", `X-Leak: ${LEAKED}`);
  vi.stubEnv("OPENAI_API_KEY", LEAKED);
  vi.stubEnv("OPENAI_ADMIN_KEY", LEAKED);
  vi.stubEnv("OPENAI_BASE_URL", "http://env-base.invalid");
  vi.stubEnv("OPENAI_ORG_ID", LEAKED);
  vi.stubEnv("OPENAI_PROJECT_ID", LEAKED);
  vi.stubEnv("OPENAI_CUSTOM_HEADERS", `X-Leak: ${LEAKED}`);
}

// The SDKs capture fetch at construction, so stub it before creating a client.
function captureRequest(): { url: string; headers: Headers }[] {
  const seen: { url: string; headers: Headers }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((input: string | URL | Request, init?: RequestInit) => {
      const url = input instanceof Request ? input.url : input.toString();
      seen.push({ url, headers: new Headers(init?.headers) });
      return Promise.reject(new Error("captured"));
    }),
  );
  return seen;
}

async function sendOnce(kind: InterfaceProviderKind): Promise<void> {
  const provider = createInterfaceProvider({
    id: "isolation",
    interfaceProvider: kind,
    apiKey: "configured-key",
    baseUrl: "http://configured.invalid/v1",
  });
  await expect(
    (async (): Promise<void> => {
      const stream = await provider.streamResponse({
        model: "m",
        messages: [{ role: "user", content: "hi" }],
        maxTokens: 16,
        promptCache: { strategy: "observe-only", reason: "test" },
      });
      for await (const _event of stream) {
        // Drain until the captured fetch rejects.
      }
    })(),
  ).rejects.toThrow();
}

describe("provider SDK env isolation", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it.each<InterfaceProviderKind>([
    "anthropic",
    "openai-compatible",
    "openai-responses",
  ])("%s sends only the configured credentials", async (kind) => {
    stubHostEnv();
    const seen = captureRequest();

    await sendOnce(kind);

    expect(seen).toHaveLength(1);
    const [{ url, headers }] = seen;
    expect(url.startsWith("http://configured.invalid/v1/")).toBe(true);
    for (const [name, value] of headers) {
      expect(`${name}: ${value}`).not.toContain(LEAKED);
    }
    if (kind === "anthropic") {
      expect(headers.get("x-api-key")).toBe("configured-key");
      expect(headers.has("authorization")).toBe(false);
    } else {
      expect(headers.get("authorization")).toBe("Bearer configured-key");
    }
  });
  it.each<InterfaceProviderKind>([
    "anthropic",
    "openai-compatible",
    "openai-responses",
  ])(
    "%s preserves generated auth and protocol headers when env names collide",
    async (kind) => {
      stubHostEnv();
      vi.stubEnv(
        "ANTHROPIC_CUSTOM_HEADERS",
        `X-Api-Key: ${LEAKED}\nx-api-key: ${LEAKED}\nAuthorization: Bearer ${LEAKED}\nanthropic-version: ${LEAKED}\nContent-Type: ${LEAKED}\nX-Leak: ${LEAKED}`,
      );
      vi.stubEnv(
        "OPENAI_CUSTOM_HEADERS",
        `Authorization: Bearer ${LEAKED}\nauthorization: Bearer ${LEAKED}\nContent-Type: ${LEAKED}\nX-Leak: ${LEAKED}`,
      );
      const seen = captureRequest();
      const envBefore = {
        anthropic: process.env.ANTHROPIC_CUSTOM_HEADERS,
        openai: process.env.OPENAI_CUSTOM_HEADERS,
      };
      await sendOnce(kind);
      expect(process.env.ANTHROPIC_CUSTOM_HEADERS).toBe(envBefore.anthropic);
      expect(process.env.OPENAI_CUSTOM_HEADERS).toBe(envBefore.openai);
      expect(seen).toHaveLength(1);
      const [{ headers }] = seen;
      expect(headers.get("content-type")).toContain("application/json");
      expect(headers.has("x-leak")).toBe(false);
      if (kind === "anthropic") {
        expect(headers.get("x-api-key")).toBe("configured-key");
        expect(headers.has("authorization")).toBe(false);
        expect(headers.get("anthropic-version")).toBe("2023-06-01");
      } else expect(headers.get("authorization")).toBe("Bearer configured-key");
      for (const [, value] of headers) expect(value).not.toContain(LEAKED);
    },
  );
});

it("restores custom-header env values after a failed synchronous constructor", () => {
  vi.stubEnv("ANTHROPIC_CUSTOM_HEADERS", "X-Test: original");
  try {
    expect(() =>
      withoutEnvCustomHeaders("ANTHROPIC_CUSTOM_HEADERS", () => {
        expect(process.env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
        throw new Error("constructor failed");
      }),
    ).toThrow("constructor failed");
    expect(process.env.ANTHROPIC_CUSTOM_HEADERS).toBe("X-Test: original");
  } finally {
    vi.unstubAllEnvs();
  }
});
