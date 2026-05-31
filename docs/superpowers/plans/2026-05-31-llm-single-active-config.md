# LLM Single Active Config Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the first branch for single-active model configuration: validated load/write persistence, `.env` key persistence, active-model summaries, and a responsibility-correct rename from `services/interface-providers` to `services/interface-providers`.

**Architecture:** `config/llm` owns persisted `model.json` plus `.env` API-key writes and exposes a resolved single-active config. `services/llm-model` owns pure model-domain projection for the active model. `services/interface-providers` owns API protocol adapters (`openai-compatible`, `anthropic`) and must not infer protocol from the LLM vendor name.

**Tech Stack:** TypeScript, Node.js `fs/promises`, Vitest, pnpm workspace scripts, OpenAI SDK, Anthropic SDK.

---

## File Structure

- Rename directory: `packages/ohbaby-agent/src/services/interface-providers/` -> `packages/ohbaby-agent/src/services/interface-providers/`
- Modify: `packages/ohbaby-agent/src/config/llm/types.ts`
- Modify: `packages/ohbaby-agent/src/config/llm/validation.ts`
- Modify: `packages/ohbaby-agent/src/config/llm/loaders.ts`
- Modify: `packages/ohbaby-agent/src/config/llm/manager.ts`
- Modify: `packages/ohbaby-agent/src/config/llm/index.ts`
- Create: `packages/ohbaby-agent/src/config/llm/writer.ts`
- Create: `packages/ohbaby-agent/src/config/llm/env-file.ts`
- Modify tests under `packages/ohbaby-agent/src/config/llm/__tests__/`
- Create: `packages/ohbaby-agent/src/services/llm-model/activeModel.ts`
- Modify: `packages/ohbaby-agent/src/services/llm-model/index.ts`
- Create: `packages/ohbaby-agent/src/services/llm-model/activeModel.unit.test.ts`
- Modify imports in `packages/ohbaby-agent/src/core/`, `packages/ohbaby-agent/src/adapters/`, and tests that currently import `services/interface-providers`
- Modify: `packages/ohbaby-agent/src/core/llm-client/client.ts`
- Modify: `packages/ohbaby-agent/src/core/llm-client/types.ts`
- Add guarded e2e test: `packages/ohbaby-agent/src/config/llm/__tests__/llm-config.e2e.test.ts`

## Task 1: Add Config Types And Validation For Interface Provider

**Files:**
- Modify: `packages/ohbaby-agent/src/config/llm/types.ts`
- Modify: `packages/ohbaby-agent/src/config/llm/validation.ts`
- Modify: `packages/ohbaby-agent/src/config/llm/__tests__/validation.test.ts`

- [ ] **Step 1: Write failing validation tests**

Add tests that prove:

```ts
it("should accept optional apiConfig.interfaceProvider", () => {
  const config = {
    ...validConfig,
    apiConfig: {
      ...validConfig.apiConfig,
      interfaceProvider: "openai-compatible",
    },
  };

  expect(() => {
    validateModelJson(config);
  }).not.toThrow();
});

it("should reject unknown apiConfig.interfaceProvider", () => {
  const config = {
    ...validConfig,
    apiConfig: {
      ...validConfig.apiConfig,
      interfaceProvider: "deepseek",
    },
  };

  expect(() => {
    validateModelJson(config);
  }).toThrow(ConfigError);
});
```

Run: `pnpm exec vitest run packages/ohbaby-agent/src/config/llm/__tests__/validation.test.ts`

Expected: FAIL because `interfaceProvider` is not validated yet.

- [ ] **Step 2: Implement config types**

Add these exports in `types.ts`:

```ts
export type InterfaceProviderKind = "openai-compatible" | "anthropic";
```

Add `interfaceProvider?: InterfaceProviderKind` to `ModelJsonConfig["apiConfig"]`.

Add required `apiKeyEnv: string` and `interfaceProvider: InterfaceProviderKind` to `LLMConfig`.

- [ ] **Step 3: Implement validation**

In `validation.ts`, accept `undefined`, `"openai-compatible"`, and `"anthropic"` for `apiConfig.interfaceProvider`; throw `ConfigError` with code `"INVALID_FIELD"` for other values.

Run: `pnpm exec vitest run packages/ohbaby-agent/src/config/llm/__tests__/validation.test.ts`

Expected: PASS.

## Task 2: Add Config Load Options For Testable Paths And Env Sources

**Files:**
- Modify: `packages/ohbaby-agent/src/config/llm/loaders.ts`
- Modify: `packages/ohbaby-agent/src/config/llm/manager.ts`
- Modify: `packages/ohbaby-agent/src/config/llm/__tests__/loaders.test.ts`
- Modify: `packages/ohbaby-agent/src/config/llm/__tests__/manager.test.ts`

- [ ] **Step 1: Write failing loader tests**

Add tests for explicit paths and env source injection:

```ts
it("should load model.json from an explicit path", async () => {
  vi.mocked(fs.readFile).mockResolvedValue('{"provider":"openai"}');

  const result = await loadModelJson({ modelJsonPath: "D:/tmp/model.json" });

  expect(result).toEqual({ provider: "openai" });
  expect(fs.readFile).toHaveBeenCalledWith("D:/tmp/model.json", "utf-8");
});

it("should read API key from provided env before process.env", () => {
  process.env.TEST_API_KEY = "process-key";

  const result = loadApiKey("TEST_API_KEY", { TEST_API_KEY: "provided-key" });

  expect(result).toBe("provided-key");
});
```

Run: `pnpm exec vitest run packages/ohbaby-agent/src/config/llm/__tests__/loaders.test.ts`

Expected: FAIL because loaders do not accept options yet.

- [ ] **Step 2: Implement loader options**

Add:

```ts
export interface LoadModelJsonOptions {
  readonly modelJsonPath?: string;
}
```

Change `loadModelJson()` to `loadModelJson(options: LoadModelJsonOptions = {})` and use `options.modelJsonPath ?? getModelJsonPath()`.

Change `loadApiKey(envVarName: string)` to `loadApiKey(envVarName: string, env: NodeJS.ProcessEnv = process.env)`.

- [ ] **Step 3: Extend manager options tests**

Add a manager test proving `modelJsonPath`, `env`, and default `interfaceProvider` flow into resolved config:

```ts
const config = await manager.load({
  projectDirectory: "D:/repo",
  modelJsonPath: "D:/tmp/model.json",
  env: { OPENAI_API_KEY: "sk-from-options" },
});

expect(config.apiKeyEnv).toBe("OPENAI_API_KEY");
expect(config.interfaceProvider).toBe("openai-compatible");
expect(config.apiKey).toBe("sk-from-options");
expect(loaders.loadModelJson).toHaveBeenCalledWith({
  modelJsonPath: "D:/tmp/model.json",
});
expect(loaders.loadApiKey).toHaveBeenCalledWith("OPENAI_API_KEY", {
  OPENAI_API_KEY: "sk-from-options",
});
```

Run: `pnpm exec vitest run packages/ohbaby-agent/src/config/llm/__tests__/manager.test.ts`

Expected: FAIL because manager options do not include `modelJsonPath` or `env`.

- [ ] **Step 4: Implement manager option plumbing**

Extend `LLMConfigLoadOptions`:

```ts
export interface LLMConfigLoadOptions {
  readonly projectDirectory?: string;
  readonly modelJsonPath?: string;
  readonly envPath?: string;
  readonly env?: NodeJS.ProcessEnv;
}
```

Cache by `projectDirectory`, `modelJsonPath`, and `envPath`. Build `LLMConfig` with:

```ts
apiKeyEnv: modelJson.apiConfig.apiKeyEnv,
interfaceProvider: modelJson.apiConfig.interfaceProvider ?? "openai-compatible",
```

Run: `pnpm exec vitest run packages/ohbaby-agent/src/config/llm/__tests__/loaders.test.ts packages/ohbaby-agent/src/config/llm/__tests__/manager.test.ts`

Expected: PASS.

## Task 3: Add `.env` Parser And Writer

**Files:**
- Create: `packages/ohbaby-agent/src/config/llm/env-file.ts`
- Create or modify: `packages/ohbaby-agent/src/config/llm/__tests__/env-file.unit.test.ts`

- [ ] **Step 1: Write failing env-file tests**

Create tests for parse, set, preserve, and no secret leakage:

```ts
it("should parse simple dotenv assignments", () => {
  expect(parseEnvFile("A=1\nB=\"two words\"\n")).toEqual({
    A: "1",
    B: "two words",
  });
});

it("should replace an existing key while preserving other lines", () => {
  expect(setEnvFileValue("A=1\nB=old\n", "B", "new value")).toBe(
    "A=1\nB=\"new value\"\n",
  );
});

it("should append a missing key with a trailing newline", () => {
  expect(setEnvFileValue("A=1\n", "B", "secret")).toBe(
    "A=1\nB=secret\n",
  );
});
```

Run: `pnpm exec vitest run packages/ohbaby-agent/src/config/llm/__tests__/env-file.unit.test.ts`

Expected: FAIL because the module does not exist.

- [ ] **Step 2: Implement pure env helpers**

Export:

```ts
export function parseEnvFile(content: string): Record<string, string>;
export function setEnvFileValue(content: string, key: string, value: string): string;
```

Rules:
- Ignore blank and comment lines while parsing.
- Preserve unrelated lines while writing.
- Replace `KEY=...` lines for the target key.
- Quote values containing whitespace, `#`, or `=`.
- Always return content ending in `\n`.

Run: `pnpm exec vitest run packages/ohbaby-agent/src/config/llm/__tests__/env-file.unit.test.ts`

Expected: PASS.

## Task 4: Add `setActiveLLMConfig` Persistence

**Files:**
- Create: `packages/ohbaby-agent/src/config/llm/writer.ts`
- Modify: `packages/ohbaby-agent/src/config/llm/manager.ts`
- Modify: `packages/ohbaby-agent/src/config/llm/index.ts`
- Create or modify: `packages/ohbaby-agent/src/config/llm/__tests__/writer.unit.test.ts`
- Modify: `packages/ohbaby-agent/src/config/llm/__tests__/integration.test.ts`

- [ ] **Step 1: Write failing writer tests**

Create tests with mocked `fs/promises` proving:

```ts
await setActiveLLMConfig({
  provider: "custom",
  model: "glm-4.5",
  baseUrl: "https://open.bigmodel.cn/api/paas/v4",
  apiKeyEnv: "ZHIPU_API_KEY",
  apiKey: "sk-secret",
  temperature: 0.2,
  maxTokens: 2048,
  modelJsonPath: "D:/repo/.ohbaby/model.json",
  envPath: "D:/repo/.env",
});
```

writes `model.json` with `provider`, `defaultModel`, `apiConfig.baseUrl`, `apiConfig.apiKeyEnv`, `apiConfig.interfaceProvider: "openai-compatible"`, and `llmParams`; writes `.env` with `ZHIPU_API_KEY=sk-secret`; validates by reloading; and never returns `apiKey` in the result.

Run: `pnpm exec vitest run packages/ohbaby-agent/src/config/llm/__tests__/writer.unit.test.ts`

Expected: FAIL because writer API does not exist.

- [ ] **Step 2: Implement writer API**

Export types:

```ts
export interface SetActiveLLMConfigInput {
  readonly provider: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKeyEnv: string;
  readonly apiKey?: string;
  readonly interfaceProvider?: InterfaceProviderKind;
  readonly temperature?: number;
  readonly maxTokens?: number;
  readonly contextWindowTokens?: number;
  readonly modelJsonPath?: string;
  readonly envPath?: string;
}

export interface SetActiveLLMConfigResult {
  readonly provider: string;
  readonly model: string;
  readonly baseUrl: string;
  readonly apiKeyEnv: string;
  readonly interfaceProvider: InterfaceProviderKind;
  readonly modelJsonPath: string;
  readonly envPath?: string;
}
```

Implement `setActiveLLMConfig(input)`:
- Default `interfaceProvider` to `"openai-compatible"`.
- Default `temperature` to `0.7` and `maxTokens` to `4096` when creating a new config.
- If `modelJsonPath` already exists, preserve existing `llmParams` and `models` unless overridden.
- Write through a temporary file in the target directory and then rename for atomic `model.json` persistence.
- If `apiKey` is provided, write it to `envPath ?? path.join(process.cwd(), ".env")`.
- Validate the raw model JSON before writing.
- Return no secret value.

- [ ] **Step 3: Add manager method and public export**

Add `LLMConfigManager.setActive(input)` that calls writer, clears cache, and loads the new config using merged env values when an API key was written.

Export from `index.ts`:

```ts
export { setActiveLLMConfig } from "./writer.js";
export type { SetActiveLLMConfigInput, SetActiveLLMConfigResult } from "./writer.js";
```

If the manager wraps the writer directly, expose a public `setActiveLLMConfig(input)` function from `index.ts` that delegates to `LLMConfigManager.getInstance().setActive(input)`.

- [ ] **Step 4: Run focused tests**

Run:

```powershell
pnpm exec vitest run packages/ohbaby-agent/src/config/llm/__tests__/writer.unit.test.ts packages/ohbaby-agent/src/config/llm/__tests__/integration.test.ts
```

Expected: PASS.

## Task 5: Add Active Model Domain Projection

**Files:**
- Create: `packages/ohbaby-agent/src/services/llm-model/activeModel.ts`
- Modify: `packages/ohbaby-agent/src/services/llm-model/index.ts`
- Create: `packages/ohbaby-agent/src/services/llm-model/activeModel.unit.test.ts`

- [ ] **Step 1: Write failing active model tests**

Create tests:

```ts
it("should summarize the active model without leaking apiKey", () => {
  const summary = summarizeActiveModel({
    provider: "custom",
    model: "gpt-4o",
    apiKey: "sk-secret",
    apiKeyEnv: "OPENAI_API_KEY",
    baseUrl: "https://api.openai.com/v1",
    interfaceProvider: "openai-compatible",
    temperature: 0.7,
    maxTokens: 4096,
  });

  expect(summary).toMatchObject({
    id: "custom:gpt-4o",
    provider: "custom",
    model: "gpt-4o",
    apiKeyEnv: "OPENAI_API_KEY",
    interfaceProvider: "openai-compatible",
  });
  expect(JSON.stringify(summary)).not.toContain("sk-secret");
});
```

Run: `pnpm exec vitest run packages/ohbaby-agent/src/services/llm-model/activeModel.unit.test.ts`

Expected: FAIL because active model module does not exist.

- [ ] **Step 2: Implement pure projection**

Export:

```ts
export interface ActiveModelSummary {
  readonly id: string;
  readonly provider: string;
  readonly model: string;
  readonly label: string;
  readonly baseUrl: string;
  readonly apiKeyEnv: string;
  readonly interfaceProvider: InterfaceProviderKind;
  readonly profile?: ModelProfile;
}

export function summarizeActiveModel(config: LLMConfig): ActiveModelSummary;
export function listConfiguredModelSummaries(config: LLMConfig): readonly ActiveModelSummary[];
```

Use existing `createModelProfileRegistry()` to resolve a profile. Do not read files, env vars, or API keys.

Run: `pnpm exec vitest run packages/ohbaby-agent/src/services/llm-model/activeModel.unit.test.ts packages/ohbaby-agent/src/services/llm-model/modelProfiles.unit.test.ts packages/ohbaby-agent/src/services/llm-model/tokenCounting.unit.test.ts`

Expected: PASS.

## Task 6: Rename Providers To Interface Providers

**Files:**
- Rename: `packages/ohbaby-agent/src/services/providers/` -> `packages/ohbaby-agent/src/services/interface-providers/`
- Modify all imports found by `rg -n "services/providers|\\.\\./providers|\\.\\./\\.\\./services/providers" packages/ohbaby-agent/src`
- Modify tests under the renamed directory

- [ ] **Step 1: Move directory and update tests first**

Rename the directory and update import paths. Rename API symbols in tests:

```ts
ProviderKind -> InterfaceProviderKind
ProviderInstance -> InterfaceProviderInstance
ProviderRequest -> InterfaceProviderRequest
ProviderStreamEvent -> InterfaceProviderStreamEvent
createProvider -> createInterfaceProvider
resolveProviderKind -> resolveInterfaceProviderKind
```

Run: `pnpm exec vitest run packages/ohbaby-agent/src/services/interface-providers`

Expected: FAIL until implementation names are updated.

- [ ] **Step 2: Implement renamed API**

In `interface-providers/types.ts`, rename the exported types. Keep stream event shapes identical.

In `interface-providers/index.ts`, expose:

```ts
export function resolveInterfaceProviderKind(
  interfaceProvider: InterfaceProviderKind | undefined,
): InterfaceProviderKind {
  return interfaceProvider ?? "openai-compatible";
}

export function createInterfaceProvider(
  options: CreateInterfaceProviderOptions,
): InterfaceProviderInstance;
```

`CreateInterfaceProviderOptions` contains `id`, `interfaceProvider`, `apiKey`, and `baseUrl`. It must not infer Anthropic from the vendor name.

- [ ] **Step 3: Update consumers**

Update `core/llm-client`, lifecycle tests, UI adapter tests, and any other imports to use `services/interface-providers`.

Run:

```powershell
rg -n "services/providers|ProviderKind|createProvider\\(|resolveProviderKind" packages/ohbaby-agent/src
pnpm exec vitest run packages/ohbaby-agent/src/services/interface-providers packages/ohbaby-agent/src/core/llm-client
```

Expected: `rg` finds no stale LLM provider-layer references; tests pass.

## Task 7: Wire Core LLM Client To Explicit Interface Provider

**Files:**
- Modify: `packages/ohbaby-agent/src/core/llm-client/client.ts`
- Modify: `packages/ohbaby-agent/src/core/llm-client/types.ts`
- Modify: `packages/ohbaby-agent/src/core/llm-client/llm-client.test.ts`

- [ ] **Step 1: Write failing llm-client tests**

Add tests proving:

```ts
expect(createInterfaceProviderMock).toHaveBeenCalledWith({
  id: "custom",
  interfaceProvider: "openai-compatible",
  apiKey: "sk-test",
  baseUrl: "https://example.com/v1",
});
```

and the returned client config includes `apiKeyEnv` and `interfaceProvider`, but not `apiKey`.

Run: `pnpm exec vitest run packages/ohbaby-agent/src/core/llm-client/llm-client.test.ts`

Expected: FAIL until `client.ts` passes the explicit protocol value and exposes non-secret config metadata.

- [ ] **Step 2: Implement core wiring**

Change `createLLMClient` to call:

```ts
const provider = createInterfaceProvider({
  id: config.provider,
  interfaceProvider: config.interfaceProvider,
  apiKey: config.apiKey,
  baseUrl: config.baseUrl,
});
```

Add `apiKeyEnv` and `interfaceProvider` to `LLMClientInstance["config"]`.

Run: `pnpm exec vitest run packages/ohbaby-agent/src/core/llm-client/llm-client.test.ts`

Expected: PASS.

## Task 8: Add Guarded Real API E2E

**Files:**
- Create: `packages/ohbaby-agent/src/config/llm/__tests__/llm-config.e2e.test.ts`

- [ ] **Step 1: Write guarded e2e test**

The test must skip unless `OHBABY_LLM_E2E=1`. When enabled, it loads the real project `.env`, reads `model.json`, creates an LLM client, sends one minimal prompt, and asserts at least one text delta or finish event. It must not log or snapshot API keys.

Command:

```powershell
$env:OHBABY_LLM_E2E='1'; pnpm exec vitest run --config vitest.e2e.config.ts packages/ohbaby-agent/src/config/llm/__tests__/llm-config.e2e.test.ts
```

Expected without env flag: SKIP. Expected with valid `.env`: PASS.

## Task 9: Final Verification And Review

**Files:**
- All changed source and docs

- [ ] **Step 1: Run focused tests**

```powershell
pnpm exec vitest run packages/ohbaby-agent/src/config/llm packages/ohbaby-agent/src/services/llm-model packages/ohbaby-agent/src/services/interface-providers packages/ohbaby-agent/src/core/llm-client
```

Expected: PASS.

- [ ] **Step 2: Run integration suite**

```powershell
pnpm run test:integration
```

Expected: PASS, or document pre-existing unrelated failures with evidence.

- [ ] **Step 3: Run typecheck**

```powershell
pnpm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Run e2e when credentials are present**

```powershell
$env:OHBABY_LLM_E2E='1'; pnpm exec vitest run --config vitest.e2e.config.ts packages/ohbaby-agent/src/config/llm/__tests__/llm-config.e2e.test.ts
```

Expected: PASS if `.env` has a usable API key and `model.json` points to a reachable OpenAI-compatible endpoint. If credentials are absent or invalid, record the exact skip/failure without printing secrets.

- [ ] **Step 5: Request subagent code review**

Dispatch a code-review subagent with:
- What was implemented: first-branch single active LLM config foundation plus `services/interface-providers` rename.
- Requirements: this plan and docs under `docs/config/llm/improve-1/` and `docs/services/llm-model/improve-1/`.
- Base SHA: branch creation point.
- Head SHA: current branch head or working tree diff summary if not committed.

- [ ] **Step 6: Fix review findings and stop before merge**

Fix Critical and Important review findings. Leave the branch unmerged and report verification evidence to the user for confirmation.
