# lifecycle improve-2 问题分析

本文档对照 2026-05-28 的代码现状，重新划定 `core/lifecycle` improve-2 的问题范围。

---

## 一、当前事实

### 已完成，不再重复规划

- `agents/service.ts` 的 `startSession` 已调用 `runAgent({ waitMode: "stream" })`。
- `agents/service.ts` / `agents/tasks/manager.ts` 的 task/subagent 路径已调用 `runAgent({ waitMode: "waitForCompletion" })`。
- `runtime/run-manager/worker.ts` 在没有 legacy `messages` 时调用 `lifecycle.runSession(...)`。

因此，旧文档中"primary 路径未切换"、"`waitMode: stream` 可以暂不实现"等表述已经过期。

### 仍然存在的问题

| 编号 | 问题 | 严重度 | 证据 |
|------|------|--------|------|
| PL-1 | `runSession` 只在第一 step 调用 `prepareTurn` | 高 | `lifecycle.ts` 中 `if (!conversationMessages) prepareTurn(...)` |
| PL-2 | LLM context overflow 无自动恢复 | 高 | `runModelStep` 直接迭代 `streamChatCompletion`，错误向外传播 |
| PL-3 | completion budget 未动态传入 provider | 中 | `streamChatCompletion(..., { signal, tools })` 未携带 max output 参数 |
| PL-4 | `run()` 与 `runSession()` 两套 tool loop 重复 | 中 | 两个 async generator 各自实现 LLM step、tool start/result、step complete、max step |
| PL-5 | RunWorker 通过 `context.messages` 隐式选择 legacy/session 模式 | 中 | `createLifecycleLoop()` 用字段存在性决定 `run()` vs `runSession()` |
| PL-6 | session-run 事件语义需要支持多次 context prepare | 中 | 当前 `turn:start` 只在第一次 prepare 时产生 |
| PL-7 | tool metadata 只在当前 step 内存链路可见，未进入 message store | 高 | `resultToToolState` 只持久化 `output/error`；下一 step 重新 `prepareTurn` 后会丢失 `mtimeMs`、`exitCode`、MCP `structuredContent` |

---

## 二、根因

### RC-1：lifecycle 把"turn"和"step"混在同一层

当前 `runSession` 在 turn 开始时准备 context，然后在 step 循环中持续追加工具协议消息。这个模型对短链路足够，但长 tool 链会让 step 内上下文增长脱离 `ContextManager` 管控。

### RC-2：错误恢复没有成为 lifecycle 协议的一部分

`runModelStep` 只负责流式调用和事件生成，不区分可恢复错误与不可恢复错误。context overflow 本应是"压缩后重试"的恢复路径，却被当成普通失败。

### RC-3：legacy message-run 仍保留完整执行循环

`run()` 曾是 primary 的主路径，现在 agent 路径已经走 `runSession`，但 `run()` 仍保留大量重复逻辑。它是兼容入口，不应继续驱动新功能设计。

### RC-4：工具执行事实没有进入持久化消息源

当前同一个 step 内，`runSession` 可以通过内存中的 `ToolCallResult.metadata` 把完整 tool result 追加到 `conversationMessages`。但 per-step prepare 的目标是让 provider messages 重新来自 `MessageManager + ContextManager.prepareTurn`，这会暴露一个事实：成功工具结果的 metadata 没有落入 `ToolPart.state`。一旦从 message store 重建上下文，模型只能看到 `state.output`，看不到 `read.mtimeMs`、`bash.exitCode`、MCP `structuredContent` 等后续推理必需事实。

这不是 UI 展示问题，而是 source-of-truth 问题。raw metadata 应持久化到 message store；模型可见内容再由 context serializer 做白名单投影。

---

## 三、优先级

| 优先级 | 问题 | 理由 |
|--------|------|------|
| P0 | PL-1 per-step prepare / PL-2 overflow recovery | 直接影响长 tool 链生产可用性 |
| P0 | PL-7 tool metadata 持久化 | per-step prepare 后仍需保留模型继续工作所需的执行事实 |
| P1 | PL-3 dynamic completion budget | 降低 overflow 概率，是恢复链路的前置防线 |
| P1 | PL-6 多次 context prepare 的事件语义 | UI 和 run stream 必须能解释多次压缩 |
| P1 | PL-4 legacy 双循环收敛 | P0 行为稳定后，用独立 commit 删除旧 message-run 路径 |
| P1 | PL-5 显式 run mode | runtime 类型清晰度优化 |

---

## 四、边界判断

### 不应该把 P0 变成大重构

虽然 `run()` / `runSession()` 重复违反 DRY，但当前产品路径主要走 `runSession`。首批实现应先让 session-run 正确抗住长 tool 链，再收敛 legacy path。否则会把行为修复和结构整理耦合在一起，扩大风险。

### 不应该把 metadata 白名单分散到各工具里

各工具可以继续产出 raw metadata，但“哪些 metadata 进入模型上下文”必须由 context serializer 统一决定。否则 `bash`、`read`、MCP、task 等工具会各自发明格式，长期会形成新的工具层耦合和 prompt 污染。

### 不应该保留本地 `conversationMessages.push(...)` 作为生产 fallback

per-step prepare 的核心承诺是：provider messages 来自持久化消息源和 `ContextManager.prepareTurn`。本地数组只能作为当前 step 的临时变量，不能成为工具结果、metadata 或压缩后上下文的生产来源。

### 不应该照搬完整事件溯源

lifecycle 需要的是可恢复错误协议和事件语义；context 的持久化事件流应由 `core/context` 或 runtime ledger 规划，不能让 lifecycle 直接写 jsonl。

### 不应该新增 agent 层抽象

primary/subagent 的统一入口已经由 agents improve-2 完成。lifecycle improve-2 只处理执行循环内部的 context 与 tool step 语义。
