# Connect Command Model Switch Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build `/connect` single-model provider switching with secure API key handling, explicit interface provider config, runtime reconnect, context window sync, tests, real-key E2E, review, and batch commits.

**Architecture:** TUI `/connect` opens a local `ConnectPanel` and submits sensitive data through `CoreAPI.connectModel()`, bypassing `executeCommand` so API key values never enter slash command argv. Backend implementation funnels TUI and non-sensitive `/connect` argv mode into `applyActiveModelConfig()`, which validates input, writes `model.json`/`.env`, reloads config, and resets the in-process runtime.

**Tech Stack:** TypeScript, pnpm, Vitest, Ink/React, ohbaby-sdk, ohbaby-agent, ohbaby-cli.

---

## File Map

- Create `packages/ohbaby-sdk/src/connect-model.ts`: public input/result types for secure model connection.
- Modify `packages/ohbaby-sdk/src/client.ts`, `packages/ohbaby-sdk/src/rpc/types.ts`, `packages/ohbaby-sdk/src/index.ts`: expose `connectModel()`.
- Create `packages/ohbaby-agent/src/config/llm/apply-active-model-config.ts`: shared backend validation/profile/write/reload helper.
- Modify `packages/ohbaby-agent/src/config/llm/writer.ts`: update active per-model profile and clear stale context when requested.
- Modify `packages/ohbaby-agent/src/services/llm-model/modelProfiles.ts`: support proxy providers and namespaced model IDs.
- Create `packages/ohbaby-agent/src/commands/connect.ts`: parse non-sensitive `/connect` argv mode and call the shared helper.
- Modify `packages/ohbaby-agent/src/commands/catalog.ts`, `packages/ohbaby-agent/src/commands/builtin.ts`: register and route `/connect`.
- Modify `packages/ohbaby-agent/src/adapters/ui-inprocess.ts`, `ui-persistent.ts`, `host/core-api-factory.ts`: implement/pass through `connectModel()`.
- Create `packages/ohbaby-cli/src/tui/components/dialog/connect-panel.tsx`: form UI with masked API key value.
- Modify `packages/ohbaby-cli/src/tui/components/dialog/command-panel-state.ts`, `command-panel-manager.tsx`, `app.tsx`, `components/prompt/index.tsx`: route `/connect` to `ConnectPanel`.
- Add/update unit, contract, TUI, integration, and E2E tests in the existing colocated test files.

---

### Task 1: SDK Contract and Backend Shared Helper

**Files:**
- Create: `packages/ohbaby-sdk/src/connect-model.ts`
- Modify: `packages/ohbaby-sdk/src/client.ts`
- Modify: `packages/ohbaby-sdk/src/rpc/types.ts`
- Modify: `packages/ohbaby-sdk/src/index.ts`
- Create: `packages/ohbaby-agent/src/config/llm/apply-active-model-config.ts`
- Test: `packages/ohbaby-agent/src/config/llm/__tests__/apply-active-model-config.unit.test.ts`
- Test: `packages/ohbaby-agent/src/host/core-api-factory.unit.test.ts`

- [ ] **Step 1: Write failing tests**

Create tests proving:

```ts
it("rejects a missing provider without writing files", async () => {
  await expect(
    applyActiveModelConfig({
      provider: "",
      baseUrl: "https://zenmux.ai/api/anthropic",
      interfaceProvider: "anthropic",
      apiKeyEnv: "ZENMUX_API_KEY",
      model: "anthropic/claude-sonnet-4.6",
      projectRoot: tempProject,
      modelJsonPath,
    }),
  ).rejects.toThrow("Provider required");
});

it("writes a safe config result without exposing the API key value", async () => {
  const result = await applyActiveModelConfig({
    provider: "zenmux",
    baseUrl: "https://zenmux.ai/api/anthropic",
    interfaceProvider: "anthropic",
    apiKeyEnv: "ZENMUX_API_KEY",
    apiKey: "sk-test-secret",
    model: "anthropic/claude-sonnet-4.6",
    projectRoot: tempProject,
    modelJsonPath,
  });

  expect(result).toMatchObject({
    provider: "zenmux",
    model: "anthropic/claude-sonnet-4.6",
    apiKeyEnv: "ZENMUX_API_KEY",
    interfaceProvider: "anthropic",
    saved: true,
  });
  expect(JSON.stringify(result)).not.toContain("sk-test-secret");
});
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
pnpm exec vitest run packages/ohbaby-agent/src/config/llm/__tests__/apply-active-model-config.unit.test.ts packages/ohbaby-agent/src/host/core-api-factory.unit.test.ts
```

Expected: fail because `apply-active-model-config.ts` and `connectModel()` do not exist.

- [ ] **Step 3: Implement minimal SDK and helper**

Implement `UiConnectModelInput`, `UiConnectModelResult`, `connectModel()` interface methods, and `applyActiveModelConfig()` validation for provider, URL, interface provider, env name, model, positive integer fields, running guard, and safe result.

- [ ] **Step 4: Run tests and verify GREEN**

Run the same command. Expected: new tests pass.

- [ ] **Step 5: Commit batch**

```powershell
git add packages/ohbaby-sdk/src packages/ohbaby-agent/src/config/llm packages/ohbaby-agent/src/host/core-api-factory.unit.test.ts docs/problem-lists/connect-command-model-switch docs/superpowers/plans/2026-06-08-connect-command-model-switch.md
git commit -m "feat: add secure connect model contract"
```

### Task 2: Writer and Profile Resolution

**Files:**
- Modify: `packages/ohbaby-agent/src/config/llm/writer.ts`
- Modify: `packages/ohbaby-agent/src/services/llm-model/modelProfiles.ts`
- Test: `packages/ohbaby-agent/src/config/llm/__tests__/writer.unit.test.ts`
- Test: `packages/ohbaby-agent/src/services/llm-model/modelProfiles.unit.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests:

```ts
it("matches a namespaced Claude model through a proxy provider", () => {
  const registry = createModelProfileRegistry({ defaultProvider: "zenmux" });
  expect(
    registry.resolve("anthropic/claude-sonnet-4.6", "zenmux"),
  ).toMatchObject({
    contextWindowTokens: 200_000,
    maxOutputTokens: 8_192,
    source: "builtin",
  });
});

it("does not carry the old context window when clearing the active override", async () => {
  await setActiveLLMConfig({
    provider: "custom",
    model: "unknown-model",
    baseUrl: "https://example.com/v1",
    apiKeyEnv: "CUSTOM_API_KEY",
    modelJsonPath,
    clearContextWindowTokens: true,
  });

  const written = JSON.parse(await fs.readFile(modelJsonPath, "utf8"));
  expect(written.llmParams.contextWindowTokens).toBeUndefined();
});
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
pnpm exec vitest run packages/ohbaby-agent/src/services/llm-model/modelProfiles.unit.test.ts packages/ohbaby-agent/src/config/llm/__tests__/writer.unit.test.ts
```

Expected: proxy/namespaced profile test fails; writer input lacks clear/profile support.

- [ ] **Step 3: Implement profile and writer changes**

Add namespaced model candidates, loosen provider matching for proxy providers, add writer fields for `maxOutputTokens`, `updateActiveModelProfile`, and `clearContextWindowTokens`, and update existing `models[]` entry by `provider + model`.

- [ ] **Step 4: Run tests and verify GREEN**

Run the same command. Expected: tests pass.

- [ ] **Step 5: Commit batch**

```powershell
git add packages/ohbaby-agent/src/config/llm packages/ohbaby-agent/src/services/llm-model
git commit -m "feat: sync connect model profiles"
```

### Task 3: Backend connectModel, Runtime Reconnect, and Command Mode

**Files:**
- Modify: `packages/ohbaby-agent/src/adapters/ui-inprocess.ts`
- Modify: `packages/ohbaby-agent/src/adapters/ui-persistent.ts`
- Modify: `packages/ohbaby-agent/src/host/core-api-factory.ts`
- Create: `packages/ohbaby-agent/src/commands/connect.ts`
- Modify: `packages/ohbaby-agent/src/commands/catalog.ts`
- Modify: `packages/ohbaby-agent/src/commands/builtin.ts`
- Test: `packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts`
- Test: `packages/ohbaby-agent/src/adapters/ui-persistent.integration.test.ts`
- Test: `packages/ohbaby-agent/src/commands/service.unit.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests that:

```ts
it("rebuilds the runtime after connectModel so the next prompt uses the new client", async () => {
  const createdModels: string[] = [];
  const client = createInProcessUiBackendClient({
    createLLMClient: async () => {
      const config = await getLLMConfig({ envPath });
      createdModels.push(config.model);
      return createFakeLLMClient([], { config });
    },
  });

  await client.connectModel(validPayload);
  await client.submitPrompt("hello");

  expect(createdModels.at(-1)).toBe(validPayload.model);
});

it("rejects --api-key in argv mode", async () => {
  await service.executeCommand(makeInvocation("connect", ["connect", "--api-key", "sk-secret"]));
  expect(lastError()).toMatchObject({ code: "UNSUPPORTED_SECRET_ARG" });
});
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
pnpm exec vitest run packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts packages/ohbaby-agent/src/adapters/ui-persistent.integration.test.ts packages/ohbaby-agent/src/commands/service.unit.test.ts
```

Expected: fail because methods/command are missing.

- [ ] **Step 3: Implement backend routing**

Add `connectModel()` to in-process client, reject when `promptInFlight` or snapshot status is running, call `applyActiveModelConfig()`, update `process.env`, call `reloadLLMConfig()`, clear `runtimePromise`, publish safe model update, and add `/connect` argv handler without secret args.

- [ ] **Step 4: Run tests and verify GREEN**

Run the same command. Expected: tests pass.

- [ ] **Step 5: Commit batch**

```powershell
git add packages/ohbaby-agent/src/adapters packages/ohbaby-agent/src/commands packages/ohbaby-agent/src/host
git commit -m "feat: connect active model in backend"
```

### Task 4: TUI ConnectPanel

**Files:**
- Create: `packages/ohbaby-cli/src/tui/components/dialog/connect-panel.tsx`
- Modify: `packages/ohbaby-cli/src/tui/components/dialog/command-panel-state.ts`
- Modify: `packages/ohbaby-cli/src/tui/components/dialog/command-panel-manager.tsx`
- Modify: `packages/ohbaby-cli/src/tui/app.tsx`
- Modify: `packages/ohbaby-cli/src/tui/components/prompt/index.tsx`
- Test: `packages/ohbaby-cli/src/tui/app.contract.test.tsx`

- [ ] **Step 1: Write failing TUI tests**

Add tests:

```tsx
it("opens ConnectPanel for /connect without executing a command", async () => {
  const client = createFakeClient(snapshot(), catalogWithConnect);
  const app = render(<OhbabyTerminalApp client={client} subscribeEvents={subscribeEvents} />);

  await type(app, "/connect");
  pressEnter(app);

  expect(client.executeCommand).not.toHaveBeenCalled();
  expect(lastFrame(app)).toContain("Connect Provider");
});

it("masks API key value and submits through connectModel", async () => {
  const client = createFakeClient(snapshot(), catalogWithConnect);
  fillConnectPanel(app, {
    provider: "zenmux",
    baseUrl: "https://zenmux.ai/api/anthropic",
    apiKeyEnv: "ZENMUX_API_KEY",
    apiKey: "sk-test-secret",
    model: "anthropic/claude-sonnet-4.6",
  });

  expect(lastFrame(app)).not.toContain("sk-test-secret");
  expect(client.connectModel).toHaveBeenCalledWith(
    expect.objectContaining({ apiKey: "sk-test-secret" }),
  );
});
```

- [ ] **Step 2: Run tests and verify RED**

Run:

```powershell
pnpm exec vitest run packages/ohbaby-cli/src/tui/app.contract.test.tsx
```

Expected: fail because ConnectPanel and routing are missing.

- [ ] **Step 3: Implement ConnectPanel**

Create a small field-list form with `Connection` and `Model` sections, `PgUp/PgDn` section switching, `Enter` field edit/submit, masked API key value rendering, automatic save only when complete and not running, and `Saved`/short error statuses.

- [ ] **Step 4: Run tests and verify GREEN**

Run the same command. Expected: tests pass.

- [ ] **Step 5: Commit batch**

```powershell
git add packages/ohbaby-cli/src/tui
git commit -m "feat: add connect panel"
```

### Task 5: Verification, Real-key E2E, and Review

**Files:**
- Create or modify: `packages/ohbaby-agent/src/config/llm/__tests__/connect-model.e2e.test.ts`
- Use existing: project `.env` with real API keys

- [ ] **Step 1: Add E2E tests**

Add tests that skip unless `ZENMUX_API_KEY` is present and use a temp project/model config:

```ts
it("connects Zenmux Anthropic with a real API key and resolves 200K context", async () => {
  const apiKey = process.env.ZENMUX_API_KEY;
  if (!apiKey) return;

  const result = await applyActiveModelConfig({
    provider: "zenmux",
    baseUrl: "https://zenmux.ai/api/anthropic",
    interfaceProvider: "anthropic",
    apiKeyEnv: "ZENMUX_API_KEY",
    apiKey,
    model: "anthropic/claude-sonnet-4.6",
    projectRoot: tempProject,
    modelJsonPath,
  });

  expect(result.contextWindowTokens).toBe(200_000);
});
```

- [ ] **Step 2: Run focused and full verification**

Run:

```powershell
pnpm run test:unit
pnpm run test:contract
pnpm run test:integration
pnpm exec vitest run --config vitest.e2e.config.ts packages/ohbaby-agent/src/config/llm/__tests__/connect-model.e2e.test.ts
pnpm run typecheck
```

Expected: all pass. The E2E must use real keys from `.env` and skip only if the required key is absent.

- [ ] **Step 3: Request subagent review**

Dispatch a reviewer against the branch diff with:

```text
Implemented secure /connect ConnectPanel, connectModel backend, model profile sync, runtime reconnect, command argv mode, and tests.
Requirements: docs/problem-lists/connect-command-model-switch/06-confirmed-design.md and this plan.
```

- [ ] **Step 4: Address review findings**

Fix Critical and Important findings with tests first, rerun focused tests, then rerun full verification.

- [ ] **Step 5: Final batch commit**

```powershell
git add packages/ohbaby-agent/src/config/llm/__tests__/connect-model.e2e.test.ts
git commit -m "test: verify connect model e2e"
```

---

## Self-Review

- Spec coverage: the plan maps to SDK secure API, backend apply helper, writer/profile sync, runtime reconnect, `/connect` argv mode, TUI ConnectPanel, tests, real-key E2E, review, and batch commits.
- Placeholder scan: no TODO/TBD steps remain; each task includes concrete files, commands, and expected outcomes.
- Type consistency: the shared payload type is `UiConnectModelInput`; backend shared function is `applyActiveModelConfig()`; user-facing TUI method is `connectModel()`.

