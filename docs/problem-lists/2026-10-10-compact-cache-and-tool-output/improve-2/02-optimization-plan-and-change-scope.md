# improve-2 优化方案与改动面

> 依据 [00](./00-discussion.md) 与 [01](./01-problem-analysis-and-current-state.md)，整体规则见 [plan/02](../plan/02-optimization-plan-and-change-scope.md)。本文供后续实施使用，本次只写开发文档。
> 源码路径相对 `packages/ohbaby-agent/src/`；以符号名定位，行号仅为调查快照。

## 1. 方案总览

保留现有工具结果存储和投影，只补 MCP 错误 metadata 丢失这处缺口。Read 分页、子代理结果引用和四种工具状态以回归测试为主，不增加工具额度、预览状态或通用落盘服务。

```text
MCP 返回错误及 metadata
  → McpToolExecutionError 携带 metadata
  → 调度器通过通用错误结构读取 metadata
  → ToolCallResult（status=error，metadata）
  → 现有 resultToToolState → ToolPart.state.metadata
  → formatToolResultContentForModel
      → 普通请求与摘要请求
      → 第 1 批修好的计数路径；第 4 批消费计数结果选尾段
```

Context 只投影已保存结果；调度器负责把执行结果转成统一结果；MCP adapter 负责协议转换。核心模块不导入 MCP 的错误类。

## 2. 设计取舍

| 项目 | 做法 | 原因 |
| --- | --- | --- |
| 投影 | 复用 `formatToolResultContentForModel` 和现有 metadata 白名单 | 普通与摘要序列化已经共用，不另建装配器 |
| 错误 metadata | 经调度器进入 `ToolCallResult.metadata` | lifecycle 已透传这个字段，只补断掉的一段 |
| 错误状态 | 保持 `status=error` | 不用“成功返回＋executionOutcome”伪装错误 |
| 首次入模 | 已发送正文和引用保持稳定 | 不因后续压力二次裁剪；prune、mask 分别由第 3、5 批删除 |
| Read | 保留现有分页，只补相关回归 | 当前页正文不经过通用裁剪，游标与返回页同源 |
| 大结果与媒体 | 沿用各工具现有返回方式，如实说明捕获边界 | 不承诺未捕获的全文可恢复，不另造媒体管线 |

## 3. 改动面与开发顺序

### Stage 1：补回 MCP 错误 metadata

1. 在 `mcp/errors.ts` 的 `McpToolExecutionError` 上增加可选 metadata；`mcp/integration/tool-adapter.ts` 抛错时传入 `transformMcpResult` 已生成的 `isError`、`contentTypes`、`structuredContent`。
2. 在 `core/tool-scheduler/scheduler.ts` 的通用异常分支，用核心层的结构守卫读取可选 metadata，并传入 `makeResult(call, "error", { error, metadata })`。只接收符合现有 metadata 类型的对象；普通 Error 没有该字段时保持原行为。
3. 复用 `ToolCallResult.metadata` 及其现有 schema。必要的小类型放在 `core/tool-scheduler/types.ts`，不引入错误框架，不扩展 `ToolCallError.details` 的职责。

`core/lifecycle/lifecycle.ts` 的 `resultToToolState` 已在 error 分支透传 `result.metadata`，无需为此改生产代码，也不应导入 `McpToolExecutionError`。现有序列化与白名单保持原语义。

完成条件：MCP 错误仍是 error；metadata 保存后能经现有投影进入模型；无 metadata 的普通错误与成功结果不受影响。

### Stage 2：分页、引用与重放回归

- 按游标连续读取跨页文件，去掉分页提示后的内容无遗漏；游标指向实际交付内容之后。
- 覆盖 completed／error／aborted／pending 的正文、状态和 callId 配对，错误文字不重复拼接。
- 覆盖子代理内联／文件引用切换及 Read 授权链；主上下文只计实际回传正文或引用。
- 重开数据库后，普通请求和摘要请求对同一 ToolPart 的投影一致。MCP 媒体的现有 base64 文本返回是已知边界，不在本批改成新的媒体存储方案。

完成条件：上述风险用例通过。没有实际缺口的 Read 和子代理生产代码不为“加保护”而修改。

### Stage 3：实施后的实网收尾

按 [04](./04-test-and-acceptance.md) 起独立服务，验证分页、工具错误、子代理结果及恢复后的实际回传。本次文档任务不执行这些请求。

## 4. 接口、兼容与回退

- 持久化仍用 `ToolPart` 现有正文、状态和 metadata；不加表或数据库字段，不迁移旧记录。
- 新增的错误 metadata 经既有结果字段传递；旧记录缺 metadata 时按原规则读取。
- 若需回退，恢复 adapter 与调度器的错误传递改动，保留已存结果可读；已发送正文不能在回退时被重新改写。
- 核心依赖方向必须保持：adapter 可以依赖核心契约，核心不依赖 MCP adapter。

## 5. 跨批契约与边界

- 第 1 批 A1 负责 `estimateHistoryForCompaction` 与正式模型投影同源，包含工具 metadata 和活动 reasoning；本批回归错误 metadata 接回后的计数，不重复建设估算器。
- 第 3 批复用稳定工具投影，并删除前置 prune／prune-only；第 4 批用同源计数选择保留段。
- 第 5 批删除 mask，验证完整压力路径下已发送结果不被改写。
- 不做单条 8K／整批 20K 工具配额、均分器、第二份预览存储、通用落盘、历史召回或 Shell 执行改造。每批不留只能靠后续批次拆除的临时实现。
