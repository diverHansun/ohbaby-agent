# system-prompt 模块 review-and-improvements

> 日期：2026-05-29
> 范围：`packages/ohbaby-agent/src/core/system-prompt/`
> 参考：kimi-code、opencode 的 prompt 文件组织方式

---

## 一、实施前审查结论

### Critical

无阻断级问题。当前 `SystemPrompt.assemble()` 是纯组装入口，`createSystemPromptProvider()` 是 context adapter，边界清楚，可以小步实施。

### Important

1. 文档与现状不一致。代码实际已有 `identity/task/agent/tools/environment/custom` 层，但旧文档仍描述四层结构，容易误导实施者移动或删除 task/tools 层。
2. `AssembleResult` 是公开死类型。`assemble()` 实际返回 `string[]`，文档不应把层元数据对象描述为正式返回模型。
3. 静态 prompt 内容仍嵌在 TS 字符串中。内容已经按文件拆分，但高频编辑时 diff 会混入 TS 语法、反引号和 `${}` 转义噪音。
4. `generateAgentPrompt()` 是恒等函数，增加公共 API 面和调用链深度，没有独立语义。

### Minor

- custom instruction loader 物理上仍在 `layers/custom.ts`，未来可移到 `services/`。
- provider/modelFamily overlay 没有真实第二份 prompt 内容，暂缓。
- `LAYER_ORDER + sort` 会增加间接层，暂缓。

---

## 二、本轮改进

### 2.1 公共 API 清理

- 删除 `layers/agent.ts`。
- 删除 `generateAgentPrompt` 导出。
- 删除 `AssembleResult` 类型。
- 新增 `public-api.unit.test.ts` 保证内部 wrapper 不再暴露。

### 2.2 模板资产化

新增 `.md` 模板：

- `prompts/primary/base.md`
- `prompts/primary/tasks/ask.md`
- `prompts/primary/tasks/plan.md`
- `prompts/primary/tasks/agent.md`
- `prompts/subagents/base.md`
- `prompts/subagents/tasks/explore.md`
- `prompts/subagents/tasks/research.md`
- `prompts/subagents/tasks/plan.md`
- `prompts/subagents/tasks/generic.md`

TS wrapper 使用 `templates.generated.ts` 中的生成常量。生成脚本从 `.md` 文件读取内容、规范化换行并写入 checked-in TS 快照。

### 2.3 构建对齐

- 新增 `scripts/generate-system-prompt-assets.mjs`。
- 新增 `prompts/templates.generated.ts`。
- 新增 `prompt:generate` / `prompt:check`，并在 build 前检查生成快照未漂移。
- 使用 Vitest、`tsc -b`、`tsup && tsc -b --force` 和 CLI source-mode 集成测试验证模板路径。

### 2.4 文档对齐

主文档已更新为当前事实：

- `goals-duty.md`
- `architecture.md`
- `data-model.md`
- `dfd-interface.md`
- `test.md`

---

## 三、实施边界

已实施：

- Wave 1 低风险清理。
- Wave 2 模板外置。
- Wave 3 文档对齐。

未实施：

- provider/modelFamily overlay。
- profile renderer。
- prompt template engine。
- runtime hot reload。
- custom loader 迁移到 services。
- 扩充 subagent prompt 内容。

---

## 四、验证要求

必须运行：

```powershell
pnpm exec vitest run packages/ohbaby-agent/src/core/system-prompt packages/ohbaby-agent/src/agents/manager.unit.test.ts packages/ohbaby-agent/src/adapters/ui-runtime/composition.unit.test.ts packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts
pnpm run typecheck
pnpm --filter ohbaby-agent build
```

合并前还需运行全量测试与真实 API E2E。真实 API E2E 按 `ohbaby-e2e-test.md` 执行，不能提交或输出密钥。
