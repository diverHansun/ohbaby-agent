# MCP Open Standard Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Align ohbaby-agent MCP with the Anthropic/MCP open standard host-client-server model, focused on stdio and streamable HTTP.

**Architecture:** Keep the existing SDK-based MCP client and manager, then connect it into the runtime tool registry. Extend the MCP boundary around protocol capabilities, change notifications, resources, prompts, and plugin-provided server registration without hard-coding Codex-specific behavior.

**Tech Stack:** TypeScript, Vitest, `@modelcontextprotocol/sdk`, existing `ToolScheduler`, existing `SkillRegistry` cache/change-listener pattern.

---

## File Structure

- Modify `packages/ohbaby-agent/src/mcp/types.ts`: add capability, resource, prompt, registry, and plugin registration types.
- Modify `packages/ohbaby-agent/src/mcp/core/client.ts`: record server capabilities/info/instructions, add list/read resource and prompt APIs, and support list-changed notifications.
- Modify `packages/ohbaby-agent/src/mcp/core/manager.ts`: expose refresh/connect/disconnect/status APIs, register plugin servers, and surface tools/resources/prompts.
- Modify `packages/ohbaby-agent/src/mcp/core/transport.ts`: keep stdio and streamable HTTP as first-class supported transports.
- Modify `packages/ohbaby-agent/src/mcp/integration/tool-adapter.ts`: keep current safe name encoding and annotations mapping.
- Create or modify `packages/ohbaby-agent/src/mcp/integration/resource-tool.ts`: add a read-only module tool for MCP resource reads.
- Create or modify `packages/ohbaby-agent/src/mcp/integration/prompt-tool.ts`: add a read-only module tool for MCP prompt fetches.
- Modify `packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts`: register MCP tools and refresh them when MCP changes.
- Modify tests under `packages/ohbaby-agent/src/mcp/**` and `packages/ohbaby-agent/src/adapters/ui-runtime/**`.
- Update `docs/mcp/*.md` and `docs/config/mcp/*.md` to match the implemented behavior.

## Task 1: Runtime Tool Registration

**Files:**
- Modify `packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts`
- Modify `packages/ohbaby-agent/src/adapters/ui-runtime/composition.unit.test.ts`
- Modify `packages/ohbaby-agent/src/mcp/core/manager.ts`

- [ ] **Step 1: Write failing composition tests**

Add a test that injects a fake MCP manager/registry and expects `createUiRuntimeComposition()` to register the MCP tool alongside builtins and SkillTool.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/ohbaby-agent/src/adapters/ui-runtime/composition.unit.test.ts`

Expected: FAIL because composition does not currently register MCP tools.

- [ ] **Step 3: Implement runtime registration**

Add an optional MCP manager port to composition options, load `getAllTools()`, register returned tools, and report non-fatal MCP load notices through `onNotice`.

- [ ] **Step 4: Run focused tests**

Run: `pnpm exec vitest run packages/ohbaby-agent/src/adapters/ui-runtime/composition.unit.test.ts packages/ohbaby-agent/src/mcp/__tests__/manager.unit.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

Commit message: `feat: register mcp tools in runtime composition`

## Task 2: Protocol Metadata And Tool Refresh

**Files:**
- Modify `packages/ohbaby-agent/src/mcp/types.ts`
- Modify `packages/ohbaby-agent/src/mcp/core/client.ts`
- Modify `packages/ohbaby-agent/src/mcp/core/manager.ts`
- Modify `packages/ohbaby-agent/src/mcp/__tests__/client.unit.test.ts`
- Modify `packages/ohbaby-agent/src/mcp/__tests__/manager.unit.test.ts`

- [ ] **Step 1: Write failing tests**

Add tests that a connected client exposes server capabilities/info/instructions and that a tools/list_changed notification clears cached tools and triggers manager refresh listeners.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/ohbaby-agent/src/mcp/__tests__/client.unit.test.ts packages/ohbaby-agent/src/mcp/__tests__/manager.unit.test.ts`

Expected: FAIL because metadata and change notification handling are absent.

- [ ] **Step 3: Implement metadata and refresh**

Use SDK client getters when present, register `ToolListChangedNotificationSchema`, invalidate tool cache on change, and add `McpManager.onChange()`.

- [ ] **Step 4: Run focused tests**

Run: `pnpm exec vitest run packages/ohbaby-agent/src/mcp/__tests__/client.unit.test.ts packages/ohbaby-agent/src/mcp/__tests__/manager.unit.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

Commit message: `feat: track mcp capabilities and tool changes`

## Task 3: Resources And Prompts

**Files:**
- Modify `packages/ohbaby-agent/src/mcp/types.ts`
- Modify `packages/ohbaby-agent/src/mcp/core/client.ts`
- Modify `packages/ohbaby-agent/src/mcp/core/manager.ts`
- Create or modify `packages/ohbaby-agent/src/mcp/integration/resource-tool.ts`
- Create or modify `packages/ohbaby-agent/src/mcp/integration/prompt-tool.ts`
- Add tests under `packages/ohbaby-agent/src/mcp/__tests__/`

- [ ] **Step 1: Write failing tests**

Add tests for listing resources/prompts and reading a resource/getting a prompt through read-only module tools.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/ohbaby-agent/src/mcp`

Expected: FAIL because resources/prompts APIs and module tools are absent.

- [ ] **Step 3: Implement resources/prompts APIs**

Call SDK `listResources`, `readResource`, `listPrompts`, and `getPrompt` when the server advertises the corresponding capability. Return empty lists for unsupported capabilities and clear errors for unsupported direct reads.

- [ ] **Step 4: Run focused tests**

Run: `pnpm exec vitest run packages/ohbaby-agent/src/mcp`

Expected: PASS.

- [ ] **Step 5: Commit**

Commit message: `feat: expose mcp resources and prompts`

## Task 4: Plugin Server Registration

**Files:**
- Modify `packages/ohbaby-agent/src/mcp/types.ts`
- Modify `packages/ohbaby-agent/src/mcp/core/manager.ts`
- Modify or add `packages/ohbaby-agent/src/mcp/__tests__/manager.unit.test.ts`
- Update `docs/plugins/architecture.md` only if the implemented handoff name differs from the existing plan.

- [ ] **Step 1: Write failing tests**

Add tests for `registerPluginServers(pluginId, servers)`, `deregisterPlugin(pluginId)`, invalidation, and manual config precedence.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run packages/ohbaby-agent/src/mcp/__tests__/manager.unit.test.ts`

Expected: FAIL because plugin server registration APIs are absent.

- [ ] **Step 3: Implement registration**

Store plugin server contributions by plugin id, merge them after file config without overriding manual servers, invalidate clients/tools on change, and notify listeners.

- [ ] **Step 4: Run focused tests**

Run: `pnpm exec vitest run packages/ohbaby-agent/src/mcp/__tests__/manager.unit.test.ts`

Expected: PASS.

- [ ] **Step 5: Commit**

Commit message: `feat: support plugin-provided mcp servers`

## Task 5: Documentation And Final Verification

**Files:**
- Modify `docs/mcp/architecture.md`
- Modify `docs/mcp/dfd-interface.md`
- Modify `docs/config/mcp/architecture.md`
- Modify `packages/ohbaby-agent/src/mcp/index.ts` if new public APIs need exports.

- [ ] **Step 1: Update docs**

Document stdio and streamable HTTP support, runtime registration, capability metadata, resources/prompts, plugin registration, and the safe MCP tool naming format.

- [ ] **Step 2: Run full verification**

Run:

```powershell
pnpm run lint
pnpm run typecheck
pnpm run test:unit
pnpm run test:integration
pnpm run test:smoke
pnpm run build
```

Expected: all commands exit 0. Smoke tests may report skipped tests if no smoke environment is configured.

- [ ] **Step 3: Request subagent review**

Ask a code-review subagent to inspect the final diff against this plan. Fix Critical and Important findings before merge.

- [ ] **Step 4: Merge and cleanup**

Merge `codex/mcp-official-alignment` into `mvp`, remove `.worktrees/mcp-official-alignment`, delete the temporary branch, and do not push it.
