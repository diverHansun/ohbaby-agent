# context improve-2 验收标准

本文档定义 context improve-2 的验收口径。验收必须基于真实代码、真实测试输出和明确 grep 规则；不能用伪造数据或只写文档代替实现。

---

## AC-0 文档完整性

**判定**：

- `docs/core/context/improve-2/README.md` 存在并说明当前状态是待实施规划。
- `problem-analysis.md` 明确区分已实现能力与待实现缺口。
- `implementation-plan.md` 给出分阶段实施顺序。
- `acceptance.md` 给出可执行验收命令。
- 文档不再声称 agents primary 路径未切到 `runAgent`。

---

## AC-1 Per-step context 准备

**目标**：长 tool 链中，`Lifecycle.runSession` 不再只在第一步调用 `prepareTurn`。

**判定**：

- 新增测试覆盖：一个 session turn 内连续两次以上 tool call，第二次 LLM 调用前会重新准备 provider messages。
- 若第二步前触发 compaction，后续 LLM 请求使用压缩后的 `PreparedTurn.messages`。
- assistant tool call 与 tool result 的 OpenAI 协议顺序保持正确。
- 无 tool call 的普通 prompt 不产生额外可见行为回归。

**建议命令**：

```powershell
pnpm exec vitest run packages\ohbaby-agent\src\core\lifecycle\lifecycle.unit.test.ts --testTimeout=300000
pnpm exec vitest run packages\ohbaby-agent\src\core\context\manager.unit.test.ts --testTimeout=300000
```

---

## AC-2 Overflow recovery

**目标**：context overflow 类错误可恢复时自动压缩并重试一次。

**判定**：

- llm-client/provider 层存在窄错误识别函数。
- `runSession` 捕获 overflow 后调用 `prepareTurn({ force: true, ... })`。
- 同一 step 最多重试一次，避免无限循环。
- 强制压缩后仍失败时，返回结构化 error，不吞错。

**建议测试**：

- 第一次 `streamChatCompletion` 抛 overflow，第二次成功。
- 第一次和重试都 overflow，最终 run failed 且错误可读。
- 非 overflow 错误不触发强制压缩。

---

## AC-3 Dynamic completion budget

**目标**：LLM 调用可以根据当前 input usage 限制输出预算。

**判定**：

- `streamChatCompletion` 或 provider 调用接收动态 output budget。
- 当 provider 不支持该字段时有明确降级路径。
- 预算计算有下限保护。
- 单测覆盖大输入、小剩余空间和 provider no-op 三种情况。

---

## AC-4 Origin 追踪

**目标**：新写入的上下文关键内容具备来源信息，旧消息保持兼容。

**判定**：

- 新增 `PromptOrigin` 或等价窄类型。
- user / assistant / tool / context-summary 至少有新增写入路径携带 origin。
- 旧消息无 origin 时序列化、压缩、UI 展示不报错。
- 不修改 message 表结构的破坏性字段；优先使用 metadata/info 的向后兼容扩展。

---

## AC-5 文件操作跨压缩累积

**目标**：多次压缩后，summary 仍保留会话级文件读写状态。

**判定**：

- 第二次压缩能继承第一次 summary 的 read/modified files。
- 已 compacted 的 tool parts 不被重复统计为新操作。
- summary 文本或 metadata 中能区分当前区间与累计状态。

---

## AC-6 架构边界

**判定**：

- `core/context` 不 import `runtime/`、`adapters/`、`agents/`。
- `core/context` 只通过 `Bus` / 类型契约暴露事件，不直接调用 UI。
- P0 实现不引入 hooks、后台 worker、RAG、branch/fork。
- `ContextManager` 现有公共方法签名保持兼容。

**建议 grep**：

```powershell
rg -n "from .*runtime|from .*adapters|from .*agents" packages\ohbaby-agent\src\core\context
rg -n "TODO|NotImplemented|throw new Error\\(\"not implemented" packages\ohbaby-agent\src\core\context packages\ohbaby-agent\src\core\lifecycle
```

---

## AC-7 回归测试矩阵

实现完成后至少运行：

```powershell
pnpm -F ohbaby-agent typecheck
pnpm run lint -- --no-cache
pnpm exec vitest run packages\ohbaby-agent\src\core\context\manager.unit.test.ts packages\ohbaby-agent\src\core\lifecycle\lifecycle.unit.test.ts --testTimeout=300000
pnpm exec vitest run packages\ohbaby-agent\src\runtime\run-manager\manager.unit.test.ts packages\ohbaby-agent\src\adapters\ui-inprocess.contract.test.ts --testTimeout=300000
pnpm test
```

真实 provider e2e 只在实现完成后运行，并且不得提交真实 API key。
