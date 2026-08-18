# 1. 问题基线与当前实施状态

> 时间口径：2026-08-18；本章保存实施前基线，完成状态与证据见 [`05-implementation-acceptance.md`](./05-implementation-acceptance.md)。基线以 Web `App.tsx` 工具卡、`run-stream-adapter.ts`、`persistent-store.ts`、bash `ShellJobRegistry` metadata、TUI `pairToolCallResult` 为准。

---

## 1.1 问题陈述

1. **失败时 Web 把一次调用画成两张卡**：`tool-call`（`list` / `failed`）和 `tool-result`（标题 `result ${callId}`，红色徽章 + 原始错误串）。
2. **成功时「还能看」**：至少有工具名；失败时多一张内部 ID 卡，像调试器。
3. **`bash` 非零退出在 UI 上不是 failed**：工具没抛错，调度器 `success`，失败在 `metadata.status` / `exitCode`；投影只认 `result.status === "success"`。
4. **持久化对 aborted 的既有 output 有损**：`toolResultPart` 把 error/aborted 都写成 `output: ""`。其中 aborted 类型允许携带 output，当前会真实丢失；普通 error 类型本身没有 output 字段，问题是“展开后没有正文回退”，不是持久层能恢复 stdout。
5. **TUI 已配对**：一次调用一行标签 + 失败着色；Web 没有配对，且 `toolAccent` 靠名字是否包含 `"error"` 上色，不看 `call.status`。

## 1.2 已确认的产品/技术分界

引用 `00-discussion.md`：

- UI 上 bash 失败就是 `failed`；bash 工具不 throw。
- 判定：调度器失败 **或** metadata 终态为 `failed / timed_out / cancelled` **或** 数字 `exitCode !== 0`。
- 投影层改（直播 + snapshot），TUI 组件不改、但会随投影变红。
- 一张卡；callId 不露；长输出不自动展开；短错误可展开。
- 不做豪华三色工具卡；不抽 sdk 组件。

```text
领域：bash exit 1 = ToolState.completed + metadata.status=failed   （模型要看 stdout）
UI：  同一事实应显示 call.status=failed + 短 result.error          （人要看标签）
Web 现状：拆成 result ${callId} 卡；bash 连 failed 标签都没有
```

## 1.3 ohbaby-web 现状

### 1.3.1 goals-duty

G3：与 TUI 行为一致。ND3：不重定义领域语义——把 bash 标成 UI `failed` 是投影标签，不是改工具对模型的合同。ui README 决策 1：**不暴露诊断行**；现状把 `callId` 画在失败卡标题上，直接违反。

### 1.3.2 architecture

视图在 `App.tsx`：`MessagePart` 对 `tool-call` / `tool-result` 各渲染一个 `ToolPanel`。没有 pairing。`App.tsx` 已是超大文件（工具卡、会话流、slash、goal 挤在一起）。

代码锚点：

- `MessagePart` / `ToolPanel`：`apps/ohbaby-web/src/ui/App.tsx` 对应同名符号（当前主干约 1947–2003 行；以符号为准）
- `tool-result` 标题：`` `result ${props.part.result.callId}` ``
- 失败色：`accent={props.part.result.error ? "red" : "green"}`（只看 result.error，不看 call.status）
- `toolAccent(name)`：`apps/ohbaby-web/src/ui/App.tsx` 对应同名符号（当前主干约 3995 行；以符号为准），按名字 read/edit/error，**失败的 list/bash 调用卡仍可能是蓝/金**

设计文档 [`docs/ohbaby-web/ui/components.md`](../../ohbaby-web/ui/components.md) §2 写的是「一张可折叠工具卡」（SEARCH/READ/EDIT 是后话皮肤）。实现画的是协议零件。

`ToolPanel` 当前用 `useState(false)` 保存展开态。后续即使改成 `useState(isShortFailure)`，该 initializer 也只在首次挂载执行：直播卡片通常先以 running 挂载，再原地更新为 failed，因此不会自动展开。方案必须显式处理 `running → failed` 状态跃迁，同时尊重用户已经手动折叠/展开后的选择。

### 1.3.3 data-model

SDK（`packages/ohbaby-sdk/src/snapshot.ts`）：

- `UiToolCall.status`：`pending | running | completed | failed`
- `UiToolResult`：`callId`、`output`、可选 `error`——**没有 metadata**

因此「命令失败」必须在进入 UI 协议时折叠成 `status` + `error` 字符串，否则 Web 永远看不见 `exitCode`。

### 1.3.4 dfd-interface

```text
bash waitForTerminal
  → metadata { status: "failed"|"completed", exitCode, error? } + output
  → scheduler 仍 success（工具没 throw）
  → lifecycle resultToToolState → ToolState.completed + metadata
  → 直播：run-stream-adapter appendToolResult
        status = result.status === "success" ? "completed" : "failed"   ✗ bash 变 completed
        error  = result.error?.message                                  ✗ 无
        output = result.output
  → 刷新：persistent-store toolResultPart
        completed → 只有 output，且不读 metadata                         ✗ bash 仍 completed
        error → error 字符串, output ""（类型本身无 output）
        aborted → error 字符串, output ""                              ✗ 可选 output 被丢
  → Web 各画两张 ToolPanel
```

### 1.3.5 use-case

- `list` 不存在的路径：`resolvePathForExisting` throw → 调度器 error → 已是 failed，但两张卡 + callId。
- `bash` 命令失败：用户以为「成功执行了」，直到展开 stdout。
- 刷新历史：抛错类失败虽有 `result.error`，正文若使用 `output ?? error` 会被必填空字符串截断而显示空白；aborted 若原本有 output，还会在 snapshot 投影时被清空。

### 1.3.6 non-functional

失败默认展开整段 bash stderr 会撑爆会话流（00 已否决一律展开）。callId 是排障信息，不应进主 UI。另一个细节是 `UiToolResult.output` 为必填字符串：正文用 `output ?? error` 时，空字符串不会触发回退，必须按 trim 后是否非空选择。

### 1.3.7 test

`App.unit.test.tsx` 覆盖 todo 工具过滤、slash overlay 等，**没有**「失败 tool-result 不得出现 result+callId 标题」的断言。`eventReducer` 不负责配对（配对在视图）。投影测试在 agent：`run-stream-adapter.unit.test.ts` 有成功工具路径，无「metadata.status=failed → UI failed」。

## 1.4 ohbaby-agent 现状

### 1.4.1 goals-duty / architecture

UI 投影职责在 adapters：`run-stream-adapter`（run 直播）、`persistent-store`（snapshot / 刷新）。两者独立把领域结果打成 `UiMessagePart[]`，没有共用「何时算 UI failed」的函数。

### 1.4.2 data-model

- `ToolCallResult`（`packages/ohbaby-agent/src/core/tool-scheduler/types.ts`）：`status`（含 success/error/…）、`output`、`error?: ToolCallError`、`metadata?`
- `ToolState`（`packages/ohbaby-agent/src/core/message/types.ts`）：bash 非零为 `completed` + `metadata`
- `resultToToolState`（`lifecycle.ts` 约 270–280 行）：`result.status === "success"` 一律 `completed`，metadata 原样带上

bash：已启动 shell 的非零退出、timeout 与 child-process error 通过 registry 的 `{ metadata, output }` 返回，调度器仍可能记 success；参数校验、unsupported syntax、preflight 与取消检查等仍可能 throw，再由 scheduler 记 error。`ShellJobRegistry.snapshot` 写入 `status` / `exitCode` / `error`；终态包括 `completed / failed / timed_out / cancelled`，其中 timeout/cancelled 常见 `exitCode: null`，不能只靠非零 exitCode 判断。

同类：`task_output` / `task_kill` 的 model metadata 投影也拷贝 `status`/`exitCode`（`tool-metadata-projection.ts`）。写死 `toolName === "bash"` 会漏。

### 1.4.3 dfd-interface

直播 `appendToolResult`（`run-stream-adapter.ts` 约 159–189 行）只看 scheduler `status === "success"`。上游 `serializableToolResult` 实际会发布 metadata，但 adapter 本地 `ToolResultPayload` 接口没有声明 metadata，实施时必须先补齐类型再交给共享 projector。  
持久化 `toolCallStatus` / `toolResultPart`（`persistent-store.ts` 约 66–98 行）只看 `ToolState.status` 是否 error/aborted，**不读 metadata**；error 与 aborted 都输出 `output: ""`，但只有 aborted 在当前类型里可能真的带 output。

`displayToolError` 能从 JSON 里抠 message，只用于已是 error 态的 part。

### 1.4.4 test

`run-stream-adapter.unit.test.ts`：成功工具顺序、隐藏 todo 工具。  
`persistent-store` 集成测有 scheduler failed 的 tool-result。  
**缺口**：metadata 终态为 `failed / timed_out / cancelled` 且 scheduler success 时，直播与 snapshot 都应是 UI failed 且已有 output 仍在；aborted 已有 output 不能在 snapshot 丢失；Web 正文为空 output 时应回退 error。

## 1.5 ohbaby-cli（对照，组件不改）

`pairToolCallResult`（`packages/ohbaby-cli/src/tui/components/message/message-row.tsx`）：按 `call.id` 挂 result，已配对的 tool-result 不再单独画。失败着色：`call.status === "failed" || result?.error`。`renderToolLabelParts` 用工具名 + 主 input 摘要 + error 正文，不展示 callId。

Web 没有这层。本批复制配对语义到 Web，不改 TUI 文件。投影修复后 TUI 会自动把 bash 非零画红（现逻辑已支持）。

## 1.6 跨模块一致性

| 事实 | 领域 / 模型 | 直播 UI parts | snapshot UI parts | Web 画 | TUI 画 |
|------|-------------|----------------|-------------------|--------|--------|
| list throw | ToolState.error（无 output 字段） | failed + error | failed + error，output 空 | 两张卡，callId | 一行 List + Error |
| bash exit 1 | completed + metadata.failed | **completed**，无 error | **completed** | 绿/普通结果卡 | 当成功 |
| shell/job timeout/cancelled（metadata 返回路径） | completed + metadata 对应终态 | **completed**，无 error | **completed** | 当成功 | 当成功 |
| bash exit 0 | completed + metadata.completed | completed | completed | 正常 | 正常 |

G3（Web 与 TUI 一致）在 bash 失败上双方都「一致地错」（都没把 metadata 标成 failed）。修投影是两边一起对，符合 00。

## 1.7 改动影响面（现状视角）

| 区域 | 会动？ | 说明 |
|------|--------|------|
| `packages/ohbaby-agent/src/adapters/ui-runtime/run-stream-adapter.ts` | 是 | 直播 failed 判定 |
| `packages/ohbaby-agent/src/adapters/ui-state/persistent-store.ts` | 是 | snapshot 判定；保留 completed / aborted 已有 output |
| 新建小 helper（agent adapters 内） | 很可能 | 避免两套 if |
| 上述对应 `*.unit.test.ts` / integration | 是 | |
| `apps/ohbaby-web/src/ui/App.tsx` 及建议拆出的 `tool-card` | 是 | 配对 + 皮肤 |
| `apps/ohbaby-web/src/ui/App.unit.test.tsx` | 是 | 无 result+id 卡 |
| TUI 组件 | **否** | 只吃更好的 UiMessage |
| `packages/ohbaby-agent/src/tools/bash.ts` | **否** | |
| `ohbaby-sdk` `UiToolResult` 加 metadata 字段 | **否**（YAGNI，00：折叠进 status/error） |

## 1.8 SWE 原则审视摘要

- **关注点分离**：领域「工具是否跑完」vs UI「人要不要看成失败」。现在把前者直接当后者。
- **DRY 护栏**：直播和 snapshot 必须共用判定；不要 Web 再写第三套。不抽 sdk 卡片（和时序议题同一 YAGNI）。
- **信息隐藏**：callId 是协议身份，不是用户文案（00 哲学 / ui 不暴露诊断）。
- **App.tsx 上帝文件**（06）：配对逻辑不宜再往 3700 行文件里堆；02 允许拆小模块 `src/ui/tool-card.tsx`，仍留在 web 包内。
- **可逆**：投影与 CSS/结构都可按 commit 回滚；不改 DB schema、不改工具 JSON 合同。

## 1.9 与既有文档关系

| 文档 | 关系 |
|------|------|
| ohbaby-web ui/components.md | 目标「一张卡」；本批达到统一卡，不实现 SEARCH/READ/EDIT 三种豪华体 |
| ohbaby-web ui README 决策 1 | 不暴露诊断 → 本批去掉 callId 标题 |
| 2026-08-18 web-stream-tool-order | 先修顺序再改卡；本批假设 parts 顺序已按时间 |

### 文档 vs 实现

| 文档说 | 代码做 | gap |
|--------|--------|-----|
| 一张可折叠工具卡 | 两个 ToolPanel | 缺 pairing |
| 不暴露诊断 | `result ${callId}` | 直接违反 |
| G3 与 TUI 一致 | TUI 配对；Web 不配对；两边 bash 都未标 failed | 呈现差 + 投影差 |
