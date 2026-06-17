# API Key Env Centralization Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Persist LLM and built-in Tavily API keys to the user-level `~/.ohbaby-agent/.env`, then add `/connect-search` as the interactive search-key setup path.

**Architecture:** Keep JSON configuration files as non-secret metadata that store provider settings and API key environment variable names. Add one shared global `.env` secret writer, route LLM saves through it by default, and add a parallel search-key save path through the SDK, daemon RPC, backend, slash command, and TUI.

**Tech Stack:** TypeScript, pnpm workspace, Vitest, Ink TUI, JSON-RPC daemon protocol.

---

### Task 1: Shared Global `.env` Secret Writer

**Files:**
- Create: `packages/ohbaby-agent/src/config/secrets/env-secrets.ts`
- Test: `packages/ohbaby-agent/src/config/secrets/__tests__/env-secrets.unit.test.ts`
- Modify: `packages/ohbaby-agent/src/config/llm/writer.ts`

**Step 1: Write the failing tests**

Add tests for `writeGlobalEnvSecret`:
- creates `~/.ohbaby-agent/.env` and parent directory when absent;
- replaces an existing key without duplicating it;
- quotes values with spaces or special characters through the existing `setEnvFileValue` behavior;
- returns the resolved global `.env` path.

**Step 2: Verify red**

Run:

```bash
pnpm test -- packages/ohbaby-agent/src/config/secrets/__tests__/env-secrets.unit.test.ts
```

Expected: FAIL because `env-secrets.ts` does not exist.

**Step 3: Implement minimal writer**

Create `writeGlobalEnvSecret(key, value, options?)` using:
- `getGlobalEnvPath(homeDirectory?)`;
- `setEnvFileValue(content, key, value)`;
- temp-file + rename atomic write.

Export a small `writeFileAtomically` helper if needed by search writer, or keep it local until reuse is necessary.

**Step 4: Verify green**

Run the same test and expect PASS.

### Task 2: Phase 1 LLM Key Defaults to Global `.env`

**Files:**
- Modify: `packages/ohbaby-agent/src/config/llm/apply-active-model-config.ts`
- Modify: `packages/ohbaby-agent/src/config/llm/writer.ts`
- Test: `packages/ohbaby-agent/src/config/llm/__tests__/apply-active-model-config.unit.test.ts`
- Test: `packages/ohbaby-agent/src/config/llm/__tests__/writer.unit.test.ts`

**Step 1: Write failing tests**

Add or adjust tests so `applyActiveModelConfig` without an explicit `envPath` writes the API key to `getGlobalEnvPath(tempHome)` and sets `process.env[apiKeyEnv]`. Preserve existing explicit `envPath` behavior.

**Step 2: Verify red**

Run:

```bash
pnpm test -- packages/ohbaby-agent/src/config/llm/__tests__/apply-active-model-config.unit.test.ts packages/ohbaby-agent/src/config/llm/__tests__/writer.unit.test.ts
```

Expected: FAIL because the default still points at `projectRoot/.env` or `process.cwd()/.env`.

**Step 3: Implement phase 1**

Change default save paths to `getGlobalEnvPath()` and route secret writing through `writeGlobalEnvSecret`. Keep runtime read paths unchanged.

**Step 4: Verify green**

Run the same tests and expect PASS.

### Task 3: Search Config Writer

**Files:**
- Create: `packages/ohbaby-agent/src/config/tools/search/writer.ts`
- Modify: `packages/ohbaby-agent/src/config/tools/search/index.ts`
- Test: `packages/ohbaby-agent/src/config/tools/search/__tests__/writer.unit.test.ts`

**Step 1: Write failing tests**

Cover:
- default `TAVILY_API_KEY` is written to global `.env`;
- absent `tools/search.json` creates minimal `{ provider, apiKeyEnv }`;
- existing `search.json` keeps base URL/defaults and updates only provider/key name metadata;
- result never includes the cleartext API key;
- `process.env[apiKeyEnv]` is set for immediate use.

**Step 2: Verify red**

Run:

```bash
pnpm test -- packages/ohbaby-agent/src/config/tools/search/__tests__/writer.unit.test.ts
```

Expected: FAIL because `setSearchApiKey` does not exist.

**Step 3: Implement minimal writer**

Add `setSearchApiKey(input)` that writes the global secret, writes or preserves `search.json`, validates with existing schema, sets `process.env`, and returns `{ apiKeyEnv, provider, envPath, searchJsonPath }`.

**Step 4: Verify green**

Run the same test and expect PASS.

### Task 4: SDK, JSON-RPC, and Backend Path

**Files:**
- Create: `packages/ohbaby-sdk/src/connect-search.ts`
- Modify: `packages/ohbaby-sdk/src/index.ts`
- Modify: `packages/ohbaby-sdk/src/client.ts`
- Modify: `packages/ohbaby-sdk/src/rpc/types.ts`
- Modify: `packages/ohbaby-server/src/protocols/jsonrpc/protocol.ts`
- Modify: `packages/ohbaby-server/src/protocols/jsonrpc/client.ts`
- Modify: `packages/ohbaby-server/src/runtime/daemon/server.ts`
- Modify: `packages/ohbaby-agent/src/adapters/ui-inprocess.ts`
- Modify: `packages/ohbaby-agent/src/adapters/ui-persistent.ts`
- Modify: `packages/ohbaby-agent/src/host/core-api-factory.ts`
- Test: relevant existing protocol/backend tests.

**Step 1: Write failing tests**

Add tests that the JSON-RPC allowed-method list includes `setSearchApiKey`, the client proxies it, and the backend path calls the search writer plus `reloadSearchConfig`.

**Step 2: Verify red**

Run targeted protocol and backend tests. Expected: FAIL because the method is not wired.

**Step 3: Implement route**

Add SDK types, CoreAPI/UiBackendClient methods, JSON-RPC whitelist/client/server dispatch, persistent forwarding, in-process implementation, and core API factory forwarding.

**Step 4: Verify green**

Run targeted protocol/backend tests and expect PASS.

### Task 5: `/connect-search` Command

**Files:**
- Create: `packages/ohbaby-agent/src/commands/connect-search.ts`
- Modify: `packages/ohbaby-agent/src/commands/catalog.ts`
- Modify: `packages/ohbaby-agent/src/commands/builtin.ts`
- Test: `packages/ohbaby-agent/src/commands/catalog.unit.test.ts`
- Test: command parser tests as needed.

**Step 1: Write failing tests**

Cover command catalog entry, `category: "tool"`, interactive behavior, default provider/key env parsing, and rejection of `--api-key` slash args.

**Step 2: Verify red**

Run targeted command tests. Expected: FAIL because the command is absent.

**Step 3: Implement command**

Mirror `/connect` argument handling where useful, but allow only non-secret arguments and call `options.setSearchApiKey`.

**Step 4: Verify green**

Run targeted command tests and expect PASS.

### Task 6: TUI `/connect-search` Panel

**Files:**
- Create: `packages/ohbaby-cli/src/tui/components/dialog/connect-search-panel.tsx`
- Modify: `packages/ohbaby-cli/src/tui/components/dialog/command-panel-state.ts`
- Modify: `packages/ohbaby-cli/src/tui/components/dialog/command-panel-manager.tsx`
- Test: dialog state/manager/component tests as available.

**Step 1: Write failing tests**

Cover `interactivePanelKindForCommandId("connect-search")`, panel rendering branch/title, secret masking, and save calling `client.setSearchApiKey`.

**Step 2: Verify red**

Run targeted CLI TUI tests. Expected: FAIL because the panel kind and component are absent.

**Step 3: Implement panel**

Add a compact Ink panel with Provider, API key env, and API key value fields. Mask secret input, sanitize errors, and display the saved global path without exposing the key.

**Step 4: Verify green**

Run targeted CLI tests and expect PASS.

### Task 7: Documentation and End-to-End Verification

**Files:**
- Modify: `README.md`
- Modify: `README.zh.md`

**Step 1: Update docs**

State that `/connect` and `/connect-search` save secret values to `~/.ohbaby-agent/.env`, while JSON config files store only key names and non-secret settings.

**Step 2: Run verification**

Run:

```bash
pnpm run typecheck
pnpm run lint
pnpm run test:unit
pnpm run test:integration
pnpm run test:contract
```

Then run a local CLI smoke test in this process using a temporary HOME/USERPROFILE so it does not mutate the real user config. Verify `/connect` and `/connect-search` create the expected global `.env` files and do not print cleartext keys.

**Step 3: Stop before merge**

Leave the branch unmerged for user inspection.
