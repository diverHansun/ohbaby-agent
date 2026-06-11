# Esc 双击中断生成：设计文档

日期：2026-06-11
状态：已确认，进入实施

## 1. 问题

Agent 生成过程中前端缺少中断入口，且后端把"取消"当作错误处理：

1. TUI 没有 Esc 中断交互；只有 Ctrl+C 在 running 时调用了 `abortRun`（`app.tsx`），用户不易发现。
2. 后端取消链路本身完整（`abortRun` -> `runtime.cancel` -> `AbortController.abort` -> worker 返回 `status: "cancelled"`），但取消结果在四处被渲染成 error：
   - `run-stream-adapter.ts` `toUiRunStatus`：cancelled run 映射为 `{ kind: "error" }` runtime 状态；
   - `run-stream-adapter.ts` `handleRunUpdated`：半截 assistant 消息标为 `status: "error"`；
   - `ui-inprocess.ts` `submitPromptInternal`：非 succeeded 一律 throw 并置全局 error 状态；
   - `prompt/index.tsx`：上述 rejection 落入 prompt 区 `setError`。

中断是用户的正常操作，不应产生任何 error 表现。

## 2. 设计决策（已与用户确认）

- 交互形式：双击 Esc（1.5 秒窗口），不用 slash 命令，不用单击。
- 半截内容：保留已流式输出的部分，标记为完成。
- 提示来源：后端事件驱动，保证 Esc / Ctrl+C / 权限对话框 cancel 三个入口提示一致。
- 提示样式：与 "Compacted" 同款 commandNotice 淡色轻提示，文案 "Interrupted"。

## 3. 方案

### 3.1 交互层（ohbaby-cli / app.tsx）

在现有 `useInput` 中增加 Esc 分支，仅在 `permissions.length === 0 && runtime.kind === "running"` 时生效：

- 第一下 Esc：进入 armed 状态（useState + 1.5s setTimeout 解除），prompt 状态区显示淡色提示 "Press Esc again to interrupt"。
- 窗口内第二下 Esc：调用 `client.abortRun(runtime.runId)`，清除 armed 状态。abort 接口调用本身失败仍走现有 error dispatch。
- idle 时 Esc 无操作；权限对话框打开时不响应（对话框内 Esc 已有安全默认语义）。
- Ctrl+C 现有行为保留，两个入口共存。

### 3.2 语义层（后端，取消不等于错误）

- `run-stream-adapter.ts` `toUiRunStatus`：`cancelled` -> `{ kind: "idle" }`。
- `run-stream-adapter.ts` `handleRunUpdated`：cancelled 时半截消息标 `status: "completed"`、`finishReason: "cancelled"`，内容保留；若中断发生在首个 delta 前则无 assistant 消息，自然跳过。同时 publish `run.interrupted` 事件。
- `ui-inprocess.ts` `submitPromptInternal`：`completion.status === "cancelled"` 时正常 return，不 throw、不置 error。prompt 区的 `setError` 因此不会触发。

### 3.3 事件与呈现层

- SDK `events.ts`：新增 `UiRunInterruptedEvent { type: "run.interrupted"; sessionId; runId; timestamp }`，加入 `UiEvent` 联合。persistent 适配器对事件透传，无需改动。
- TUI store `events.ts`：处理 `run.interrupted`，校验 `sessionId === activeSessionId` 后 `appendCommandNotice({ kind: "info", text: "Interrupted" })`。渲染层零改动。

### 3.4 不做的事

- 不新增 `UiRunStatus` 的 "interrupted" kind（idle + notice 已表达完整语义）。
- 不做 slash 命令形式的中断。
- 不动 streaming 层的 abort 传播（链路已通）。

## 4. 测试

- `run-stream-adapter.unit.test.ts`：cancelled run -> idle 状态、消息 completed + finishReason: cancelled、发出 run.interrupted。
- `ui-inprocess.contract.test.ts`：abortRun 后 submitPrompt 不 reject、snapshot 状态不为 error。
- `app.contract.test.tsx`：双击 Esc 调用 abortRun(runId)；单击超时不调用；idle / 权限对话框打开时不触发；transcript 出现 "Interrupted"。
- E2E：真实 API key 下发起生成并中断，验证进程不报错、transcript 保留半截内容并显示 Interrupted。
