# system-prompt 模块 test.md

本文档定义 `system-prompt` 模块的测试策略。

---

## 一、测试目标

- 证明 primary/subagent prompt 按预期层顺序组装。
- 证明 `.md` 模板文件存在、非空，并与导出内容一致。
- 证明 agent prompt addon 不替换默认 identity/task。
- 证明 subagent 不加载 primary custom instructions。
- 证明 unsafe tool snippets/custom instructions 会被过滤或上报。
- 证明 `.md` 模板、生成的 TS 快照、源码运行、tsc、tsup 保持一致。

---

## 二、单元测试

| 测试文件 | 覆盖内容 |
| --- | --- |
| `__tests__/assembler.test.ts` | primary/subagent 组装、task kind、addon、层顺序 |
| `__tests__/provider.test.ts` | `createSystemPromptProvider()` 适配流程 |
| `__tests__/prompt-assets.unit.test.ts` | `.md` 模板存在、非空、导出等价 |
| `__tests__/public-api.unit.test.ts` | 公共 API 不暴露内部 wrapper |
| `__tests__/tools.test.ts` | tool guidance 渲染与去重 |
| `__tests__/custom.test.ts` | custom instruction 加载、fallback、截断、错误处理 |
| `__tests__/environment.test.ts` | environment 渲染 |
| `security/prompt-security.unit.test.ts` | prompt-like 内容扫描 |

---

## 三、关键场景

### 3.1 primary 层顺序

输入包含 `agentPromptAddon`、`toolSnippets`、`customInstructions` 时，应输出：

```text
identity -> primary_task -> agent_prompt_addon -> tool_guidance -> environment -> custom_instructions
```

### 3.2 subagent 层顺序

输入包含 `agentPromptAddon` 和 `toolSnippets` 时，应输出：

```text
subagent_base -> subagent_task -> agent_prompt_addon -> tool_guidance -> environment
```

### 3.3 模板资产

每个静态模板必须有对应 `.md` 文件：

- `prompts/primary/base.md`
- `prompts/primary/tasks/ask.md`
- `prompts/primary/tasks/plan.md`
- `prompts/primary/tasks/agent.md`
- `prompts/subagents/base.md`
- `prompts/subagents/tasks/explore.md`
- `prompts/subagents/tasks/research.md`
- `prompts/subagents/tasks/plan.md`
- `prompts/subagents/tasks/generic.md`

### 3.4 构建验证

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
- `tool_guidance` 是条件层，没有 snippets/guidelines 时可为空。
- 子代理 prompt 可以包含工具指导，但不包含 primary custom instructions。

---

## 五、E2E

真实 API E2E 按 `ohbaby-e2e-test.md` 执行。该文件可能包含真实密钥，运行时不得在日志、提交或回复中泄露密钥值。
