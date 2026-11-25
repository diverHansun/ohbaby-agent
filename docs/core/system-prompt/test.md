# system-prompt 模块 test.md

本文档定义 `system-prompt` 模块的测试策略。

---

## 一、测试目标

- 证明 primary/subagent prompt 按预期层顺序组装。
- 证明 `.md` 模板文件存在、非空，并与导出内容一致。
- 证明 agent prompt addon 不替换默认 identity/task。
- 证明 primary 的 Todo 行为策略位于 base，Plan Agent 同时具备 Todo 读写工具。
- 证明主、子代理的稳定 system 层只包含各自的任务契约、addon 和适用的角色信息，文件指令经 user 侧 reminder 发送。
- 证明稳定 system 不混入环境或工具菜单，MCP catalog reminder 中的菜单只公告精确本地名和固定说明。
- 证明 MCP 工具的动态披露、准入和按 session/context scope 的 loaded 状态均 fail-closed。
- 证明 `.md` 模板、生成的 TS 快照、源码运行、tsc、tsup 保持一致。

---

## 二、单元测试

| 测试文件 | 覆盖内容 |
| --- | --- |
| `__tests__/assembler.test.ts` | primary/subagent 稳定层组装、task kind、addon、角色边界 |
| `__tests__/provider.test.ts` | `createSystemPromptProvider()` 适配流程 |
| `__tests__/prompt-assets.unit.test.ts` | `.md` 模板存在、非空、导出等价 |
| `__tests__/public-api.unit.test.ts` | 公共 API 不暴露内部 wrapper |
| `__tests__/environment.test.ts` | environment 渲染 |
| `security/prompt-security.unit.test.ts` | prompt-like 内容扫描 |

---

## 三、关键场景

### 3.1 primary 层顺序

输入包含 `agentPromptAddon` 和 `availableSubagentRoles` 时，应输出：

```text
base -> primary_task -> agent_prompt_addon -> subagent_roles
```

### 3.2 subagent 层顺序

输入包含 `agentPromptAddon` 时，应输出：

```text
subagent_base -> subagent_task -> agent_prompt_addon
```

### 3.3 模板资产

每个静态模板必须有对应 `.md` 文件：

- `prompts/primary/base.md`
- `prompts/primary/tasks/plan.md`
- `prompts/primary/tasks/agent.md`
- `prompts/subagents/base.md`
- `prompts/subagents/tasks/explore.md`
- `prompts/subagents/tasks/research.md`
- `prompts/subagents/tasks/generic.md`

### 3.4 Todo 行为策略

- `prompt-assets.unit.test.ts` 断言 primary base 包含复杂任务启用、简单任务跳过、先理解再创建、里程碑更新、多 `in_progress` 和 run 结束不清空。
- `agents/registry.unit.test.ts` 断言 Plan Agent 同时包含 `todo_read` 与 `todo_write`。
- `tools/todo.unit.test.ts` 断言 Todo description 只保留接口语义，数量、字段和状态边界继续由 schema 测试覆盖。

### 3.5 构建验证

必须覆盖：

```powershell
node packages/ohbaby-agent/scripts/generate-system-prompt-assets.mjs
pnpm --filter ohbaby-agent prompt:check
pnpm exec vitest run packages/ohbaby-agent/src/core/system-prompt
pnpm run typecheck
pnpm --filter ohbaby-agent build
pnpm exec vitest run tests/integration/cli/prompt-process.integration.test.ts
```

---

## 四、回归边界

- 删除 `generateAgentPrompt` 公共导出后，公共 API 测试应确保它不再暴露。
- 删除死类型后，代码与文档都不应把层元数据结果描述为正式返回模型。
- `.md` 模板迁移不得改变现有 prompt 内容。
- MCP catalog reminder 是条件内容；只有当前 session/context scope 仍未加载的安全 MCP 工具才会出现。
- MCP catalog reminder 不得包含 description、schema、server 返回值或其他未信任文本。
- 子代理保留自己的身份与委派边界，并在自己的历史中接收项目／全局说明。
- 通过真实 composition 和三协议请求捕获验证同一 run 修改文件后，下一步系统前缀相同，user 历史追加新指令快照。
- 文件指令的发现、清空、扫描、压缩后重发及历史隔离见[指令测试](../../services/instructions/test.md)。

---

## 五、E2E

真实 API E2E 按 `ohbaby-e2e-test.md` 执行。该文件可能包含真实密钥，运行时不得在日志、提交或回复中泄露密钥值。
