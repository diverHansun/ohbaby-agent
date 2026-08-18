# 3. 参考项目与取舍

> 参考仓库均位于本仓库根目录的同级目录。这里提炼的是数据/呈现边界，不是照搬视觉样式。

## 3.1 OpenCode：工具调用是一份持续演进的实体

代码锚点：

- `../opencode/packages/sdk/js/src/v2/gen/types.gen.ts`：`ToolPart` 同时持有 `callID`、工具名与 `ToolState`；状态从 pending/running 演进到 completed/error，不把 call 与 result 当成两个用户可见零件。
- `../opencode/packages/web/src/components/share/part.tsx`：error 与 completed 都围绕同一个 tool part 渲染；error 是工具实体的一种终态。

可借鉴：

- UI 卡片应该表达“一次工具执行”，不是逐条展示 wire protocol。
- 内部 ID 用于身份匹配和稳定更新，不应自动升级成卡片标题。
- 状态、错误和输出属于同一结果投影，避免标题说 completed、正文却说 exit 1。

本批不照搬：

- 不把 SDK 的 `tool-call + tool-result` 协议改成单一 `ToolPart`。当前问题可在 Web 视图配对解决，跨包协议重构超出范围。
- 不移植 OpenCode 的按工具专用渲染器；本批只做统一卡片的正确语义。

## 3.2 Kimi Code：用 call id 更新同一个活动组件

代码锚点：

- `../kimi-code/apps/kimi-code/src/tui/controllers/streaming-ui.ts`：`_activeToolCalls` 与 `_pendingToolComponents` 都以 tool call id 索引；started 更新/创建组件，result 到达时对同一个组件 `setResult`，随后清理活动索引。
- `../kimi-code/apps/kimi-code/src/tui/components/messages/tool-call.ts`：一个 `ToolCallComponent` 同时承载调用信息、运行态、结果与失败态。

可借鉴：

- 直播不是“再追加一张结果卡”，而是同一实体发生状态跃迁。
- 展开行为要考虑运行态组件已经挂载：仅依赖 React 初始 state 无法覆盖 `running → failed`。
- tool call id 应留在组件身份/配对层，而不是用户文案层。

本批不照搬：

- 不引入命令行组件的全局展开快捷键、工具专用 preview 或后台任务复杂状态。
- Web 保持 React 本地交互，但要为状态跃迁写显式测试。

## 3.3 本仓库 TUI：现成的最小配对语义

代码锚点：

- `packages/ohbaby-cli/src/tui/components/message/message-row.tsx`：`pairToolCallResult` 先按 call id 建索引，把已配对 result 挂到 call 上，并保留孤立 result 的 fallback。
- 同文件的失败着色以 `call.status === "failed" || result?.error` 为准，主文案使用工具名与输入摘要，不显示 call id。

这是本批最直接的行为基线：Web 复制“配对语义”，不复制终端渲染代码，也不为共享几行纯逻辑立即扩展 SDK API。

## 3.4 对本方案的约束

| 参考结论 | 本批落点 | 明确不做 |
|----------|----------|----------|
| 工具是一个用户可见实体 | Web `pairToolCallResult` + 一张 `ToolCard` | 改 SDK wire shape |
| 结果更新同一活动实体 | call id 作为 React key/配对身份；测试 `running → failed` | 追加第二张 result 卡 |
| 失败是一种终态 | agent 单一 outcome projector 输出 status + error | Web 单独猜 metadata |
| 内部身份不等于文案 | DOM 不出现 `result <callId>` 标题 | 暴露调试 ID |
| 专用工具渲染可后置 | 先统一卡片、摘要、展开规则 | SEARCH/READ/EDIT 豪华皮肤 |

## 3.5 长期演进触发条件

当前 SDK 保留 call/result 两段是有意的短期取舍。只有出现以下证据之一，才重新评估“单一稳定 ToolPart”协议：

1. 多个客户端重复实现配对并持续产生不一致；
2. 合法事件流出现并行 result 更新，call id 已不足以稳定表达局部状态；
3. snapshot 与 live 需要维护两套无法收敛的配对逻辑。

在此之前，视图配对 + 单一投影函数更小、更可回滚，也足以解决当前问题。
