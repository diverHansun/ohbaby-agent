import { describe, expect, it } from "vitest";
import {
  defineDiagnosticEvent,
  diagnosticField,
  encodeDiagnosticEvent,
  normalizeDiagnosticPath,
  normalizeDiagnosticUrl,
  safeError,
  type DiagnosticEventDefinition,
} from "./logger.js";

const safeEvent = defineDiagnosticEvent({
  component: "diagnostics",
  event: "diagnostics.tested",
  fields: {
    count: diagnosticField.integer(),
    entity: diagnosticField.userEntityName("agent"),
    optionalCount: diagnosticField.optional(diagnosticField.integer()),
    path: diagnosticField.path(),
    url: diagnosticField.url(),
  },
  level: "trace",
});

const builtinSkillEvent = defineDiagnosticEvent({
  component: "diagnostics",
  event: "diagnostics.builtin_skill",
  fields: { skill: diagnosticField.stringEnum(["read"]) },
  level: "trace",
});

const userSkillEvent = defineDiagnosticEvent({
  component: "diagnostics",
  event: "diagnostics.user_skill",
  fields: { skill: diagnosticField.userEntityName("skill") },
  level: "trace",
});

describe("diagnostic event contract", () => {
  it("encodes only declared fields with policy-aware encoders", () => {
    const encoded = encodeDiagnosticEvent(
      safeEvent,
      {
        count: 2,
        entity: "private-agent",
        optionalCount: undefined,
        path: "/workspace/project/file.ts",
        url: "https://user:secret@example.com/v1?q=secret#fragment",
      },
      {
        roots: {
          workspace: "/workspace/project",
        },
      },
      "2026-08-29T00:00:00.000Z",
    );

    expect(encoded.record).toMatchObject({
      component: "diagnostics",
      count: 2,
      event: "diagnostics.tested",
      level: "trace",
      path: "<workspace>/file.ts",
      ts: "2026-08-29T00:00:00.000Z",
    });
    expect(encoded.record.url).toMatch(/^<origin>\/[a-f0-9]{12}$/);
    expect(encoded.record.entity).toMatch(/^agent_[a-f0-9]{12}$/);
    expect(JSON.stringify(encoded.record)).not.toContain("private-agent");
    expect(JSON.stringify(encoded.record)).not.toContain("secret");
  });

  it("rejects undeclared fields and forged definitions at runtime", () => {
    const inputWithExtraField = {
      count: 1,
      entity: "private-agent",
      optionalCount: undefined,
      path: "file.ts",
      prompt: "must-not-pass",
      url: "https://example.com",
    } as const;
    expect(() =>
      encodeDiagnosticEvent(
        safeEvent,
        inputWithExtraField,
        { roots: {} },
        "2026-08-29T00:00:00.000Z",
      ),
    ).toThrow("undeclared field");

    const forged = {} as DiagnosticEventDefinition<Record<string, never>>;
    expect(() =>
      encodeDiagnosticEvent(
        forged,
        {},
        { roots: {} },
        "2026-08-29T00:00:00.000Z",
      ),
    ).toThrow("unrecognized diagnostic event definition");
  });

  it("rejects widened event strings at compile time", () => {
    const dynamicEvent = ["diagnostics", "dynamic"].join(".");
    defineDiagnosticEvent({
      component: "diagnostics",
      // @ts-expect-error Dynamic event names are outside the closed contract.
      event: dynamicEvent,
      fields: {},
      level: "debug",
    });
  });

  it("keeps allowlisted builtin names but hashes the same user-defined name", () => {
    const builtin = encodeDiagnosticEvent(
      builtinSkillEvent,
      { skill: "read" },
      { roots: {} },
      "2026-08-29T00:00:00.000Z",
    );
    const user = encodeDiagnosticEvent(
      userSkillEvent,
      { skill: "read" },
      { roots: {} },
      "2026-08-29T00:00:00.000Z",
    );

    expect(builtin.record.skill).toBe("read");
    expect(user.record.skill).toMatch(/^skill_[a-f0-9]{12}$/);
    expect(user.record.skill).not.toBe("read");
  });

  it("rejects invalid definitions and field values", () => {
    expect(() =>
      defineDiagnosticEvent({
        component: "diagnostics",
        event: "not-dotted",
        fields: {},
        level: "info",
      }),
    ).toThrow("stable dotted identifier");
    expect(() =>
      encodeDiagnosticEvent(
        safeEvent,
        {
          count: 1.5,
          entity: "private-agent",
          optionalCount: undefined,
          path: "file.ts",
          url: "https://example.com",
        },
        { roots: {} },
        "2026-08-29T00:00:00.000Z",
      ),
    ).toThrow("must be an integer");
  });

  it.each([
    "prompt",
    "completion",
    "reasoning",
    "body",
    "command",
    "input",
    "output",
    "request",
    "response",
    "config",
    "context",
    "authorization",
    "token",
    "requestBody",
    "apiToken",
    "apiKey",
    "privateKey",
    "credentialPath",
    "passphraseFile",
  ])("rejects the reserved content field %s at every log level", (field) => {
    for (const level of ["error", "warn", "info", "debug", "trace"] as const) {
      expect(() =>
        defineDiagnosticEvent({
          component: "diagnostics",
          event: `diagnostics.reserved_${level}`,
          fields: {
            [field]: diagnosticField.path(),
          },
          level,
        }),
      ).toThrow("invalid field encoder");
    }
  });
});

describe("diagnostic normalization", () => {
  it("uses the longest configured path root and hashes external paths", () => {
    const roots = {
      home: "/Users/example",
      ohbabyHome: "/Users/example/.ohbaby",
      tmp: "/tmp",
      workspace: "/Users/example/work/project",
    };
    expect(
      normalizeDiagnosticPath("/Users/example/work/project/src/app.ts", roots),
    ).toBe("<workspace>/src/app.ts");
    expect(
      normalizeDiagnosticPath("/Users/example/.ohbaby/model.json", roots),
    ).toBe("<ohbaby-home>/model.json");
    const credentialPath = normalizeDiagnosticPath(
      `/Users/example/work/project/api_key=topsecret/${"x".repeat(700)}.json`,
      roots,
    );
    expect(credentialPath).toContain("api_key=<redacted>");
    expect(credentialPath).not.toContain("topsecret");
    expect(Buffer.byteLength(credentialPath, "utf8")).toBeLessThanOrEqual(512);
    expect(normalizeDiagnosticPath("/opt/private/customer.txt", roots)).toMatch(
      /^<external>\/[a-f0-9]{12}$/,
    );
    expect(normalizeDiagnosticPath("../../private", roots)).toMatch(
      /^<external>\/[a-f0-9]{12}$/,
    );
  });

  it("hashes foreign-platform absolute paths instead of treating them as relative", () => {
    for (const foreignPath of [
      String.raw`C:\Users\alice\secret.txt`,
      String.raw`\\server\private\customer.txt`,
    ]) {
      const normalized = normalizeDiagnosticPath(foreignPath, {});
      expect(normalized).toMatch(/^<external>\/[a-f0-9]{12}$/);
      expect(normalized).not.toContain("alice");
      expect(normalized).not.toContain("server");
      expect(normalized).not.toContain("customer");
    }
  });

  it("resolves foreign-platform relative traversal before retaining paths", () => {
    for (const foreignPath of [
      String.raw`safe\..\..\private-customer.txt`,
      String.raw`C:..\private-customer.txt`,
    ]) {
      const normalized = normalizeDiagnosticPath(foreignPath, {});
      expect(normalized).toMatch(/^<external>\/[a-f0-9]{12}$/);
      expect(normalized).not.toContain("private-customer");
      expect(normalized).not.toContain("..");
    }
    expect(normalizeDiagnosticPath(String.raw`safe\child.txt`, {})).toBe(
      "safe/child.txt",
    );
  });

  it("hashes URL origins without retaining userinfo, host, path, or query", () => {
    const normalized = normalizeDiagnosticUrl(
      "https://tenant:password@internal.example/v1/messages?key=secret#body",
    );
    expect(normalized).toMatch(/^<origin>\/[a-f0-9]{12}$/);
    expect(normalized).not.toContain("tenant");
    expect(normalized).not.toContain("internal.example");
    expect(normalized).not.toContain("messages");
    expect(normalized).not.toContain("secret");
    expect(normalizeDiagnosticUrl("not a url")).toMatch(
      /^<invalid-url>\/[a-f0-9]{12}$/,
    );
  });
});

describe("safeError", () => {
  it("does not trust external messages", () => {
    const error = Object.assign(
      new Error("authorization=Bearer-secret prompt body"),
      { code: "ETIMEDOUT" },
    );
    expect(safeError(error)).toEqual({
      code: "ETIMEDOUT",
      message: "An external operation failed",
      name: "Error",
    });
  });

  it("uses allowlists instead of trusting arbitrary error names or codes", () => {
    const error = Object.assign(new Error("provider body"), {
      code: "SECRET_TOKEN",
      name: "PRIVATECUSTOMERNAME",
    });
    expect(safeError(error)).toEqual({
      message: "An external operation failed",
      name: "Error",
    });
  });

  it("reads allowlisted error metadata only once", () => {
    const error = new Error("provider body") as Error & { code?: unknown };
    let codeReads = 0;
    let nameReads = 0;
    Object.defineProperties(error, {
      code: {
        configurable: true,
        get: () => (codeReads++ === 0 ? "ETIMEDOUT" : "SECRET_TOKEN"),
      },
      name: {
        configurable: true,
        get: () => (nameReads++ === 0 ? "TypeError" : "PRIVATECUSTOMERNAME"),
      },
    });

    expect(safeError(error)).toEqual({
      code: "ETIMEDOUT",
      message: "An external operation failed",
      name: "TypeError",
    });
    expect(codeReads).toBe(1);
    expect(nameReads).toBe(1);
  });

  it("never throws for non-errors", () => {
    expect(
      safeError({
        get message(): never {
          throw new Error("boom");
        },
      }),
    ).toEqual({
      message: "An unknown error occurred",
      name: "UnknownError",
    });
  });
});
