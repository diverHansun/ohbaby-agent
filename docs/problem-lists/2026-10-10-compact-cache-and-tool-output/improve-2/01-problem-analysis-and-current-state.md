# improve-2 现状、问题与证据

> 基线 `c5cfda26`（当前 HEAD），2026-10-12 复核。未实施本批方案。
> 本批目标见 [02](./02-optimization-plan-and-change-scope.md)，整体问题见 [plan/01](../plan/01-problem-analysis-and-current-state.md)。路径相对 `packages/ohbaby-agent/src/`，定位以符号为准。

## 1. 现状：工具结果怎么进入模型

工具执行结束后，结果存进 `ToolPart` 的正文、状态与 metadata，落点见 `core/lifecycle/lifecycle.ts:234` 的 `resultToToolState`。组装模型输入时，`core/context/serializer.ts:245` 的 `toolResultContent` 对 completed／error／aborted／pending 分别取值，再经 `core/context/tool-metadata-projection.ts:280` 的 `formatToolResultContentForModel` 追加 `<tool_metadata>` 块；调用与结果按 callId 配对（`serializer.ts:200`）。

摘要请求走另一条序列化入口 `core/context/serialization.ts:47` 的 `serializeSummaryTool`，它同样调用 `formatToolResultContentForModel`。**投影函数是同一个**，这是本批要保住的不变量。

## 2. 缺口与问题

| ID | 事实与影响 | 代码证据 |
| --- | --- | --- |
| T1 | **MCP 错误的结构化 metadata 丢失**。`transformMcpResult` 算好 `isError`、`contentTypes`、`structuredContent`，但同一分支随即抛 `McpToolExecutionError`，只带一段文字；调度器把抛错转成 error 结果且不附 metadata，于是错误路径下这几个字段全被丢掉。`isError` 只在抛错分支设置，因此从不进模型（成功路径的 `contentTypes`／`structuredContent` 仍会投影） | `mcp/integration/tool-adapter.ts:101`、`:145`；`core/tool-scheduler/scheduler.ts:1734`（error 只带 `error`）、`:713`（`makeResult` 的 metadata 只来自入参）；`core/lifecycle/lifecycle.ts:255`（`resultToToolState` 本可透传 `result.metadata`） |
| T2 | `estimateHistoryForCompaction` 无原生依赖时走可读文本 `serializeHistory`，漏掉正式投影中的工具 metadata；有原生依赖时虽用 `serializeHistoryMessages`，却未传活动 reasoning。两条路径都需与正式请求的回传表示对齐 | `core/context/compaction-policy.ts:26`；`core/context/token-estimation.ts:90` |
| T3 | Read 页正文不经过通用裁剪，游标与返回页当前一致。本批只保留跨页无遗漏的回归，不安排生产代码改动 | `tools/utils/read-file-page.ts:13`、`:262`；`tools/utils/output.ts:6` |
| T4 | 通用限长名为 8K token，实为约 32K 字符，且只用在 web 与 bash；MCP 把图片、音频内联成含 base64 的字符串，无大小上限，也不区分“文本渲染”与“原始媒体” | `tools/utils/output.ts:4`；`utils/truncate.ts:2`；`tools/web.ts:488`；`tools/shell-job-registry.ts:173`；`mcp/integration/tool-adapter.ts:61` |
| T5 | 压力改写仍在：mask 默认关闭但可改写 completed／error／aborted 正文；prune 让整条工具 part 退出模型视图 | `core/context/context-manager.ts:287`（`maskEnabled ?? false`）、`:726`（`pruneHistory`） |

T2 属第 1 批 A1 的同源计数，第 4 批消费它选择尾段；T5 的 prune 归第 3 批、mask 归第 5 批。本批修 T1、回归 T3，并如实记录 T4 的现有边界；跨批关系见 [02 §5](./02-optimization-plan-and-change-scope.md)。

## 3. 已稳定、无需改动

- **错误／状态／调用配对**：`serializer.ts:245` 已覆盖四种状态；aborted 时 output 与 error 各出现一次，不重复拼接。
- **metadata 白名单**：`tool-metadata-projection.ts:88` 按工具只投影必要字段（read 的 `hasMore`／`nextOffset`／`nextCursor`、bash 的 `exitCode`／`status`、mcp 的 `isError`／`contentTypes`），非必要内部字段不进正文。
- **持久化往返**：投影只读持久化的 `ToolPart`，不依赖进程内状态，重开后同一记录投影相同。
- **子代理回传**：正文不超过 51200 字节内联返回，超出写文件并给可读路径；只有实际回传的正文或引用计入主上下文。可读引用已接入 Read 的授权链。证据：`agents/subagents/result-artifacts.ts:16`、`:215`；`adapters/ui-runtime/composition.ts:425`。

## 4. 测试现状与缺口

`tools/read.unit.test.ts`（21 项）已覆盖游标续读、续行、跨页边界；`core/context/tool-metadata-projection.unit.test.ts` 覆盖按工具投影。缺口集中在：MCP 错误 metadata 透传、估计与正式投影一致、压力关闭下已发送结果不因后续预算变化被改写、子代理内联／引用切换。具体用例见 [04](./04-test-and-acceptance.md)。

## 5. SWE 审视

复杂度来自“同一事实有多套序列化入口”（正式请求、摘要请求、估计评分）。本批不新增预算口径、预览状态或落盘服务，只把工具正文收敛到一条投影，并把被丢弃的错误 metadata 接回同一条投影，方向是减少分叉。批次额度分配器、预览状态机、通用落盘与召回都属过度设计，不引入。
