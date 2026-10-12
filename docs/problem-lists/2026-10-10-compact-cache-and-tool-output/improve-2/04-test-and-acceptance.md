# improve-2 测试与验收标准

> 依据 [00](./00-discussion.md)、[01](./01-problem-analysis-and-current-state.md)、[02](./02-optimization-plan-and-change-scope.md)。本文件是待实施的验收目标，不是已通过的结果。
> 复用仓库已有 Vitest、集成测试和协议契约测试，不新建测试框架。整体用例见 [plan/04](../plan/04-test-and-acceptance.md)。

## 1. 验收分层

- 单元／契约：投影按工具白名单、四状态取值、callId 配对、错误 metadata 透传。
- 集成：持久化往返、恢复后投影一致、子代理内联／文件引用切换、Read 跨页游标。
- 有界真实 API：在独立 ohbaby 服务里读分页页、错误结果、子代理结果，核对正文与引用。

## 2. 用例与 plan 测试 ID 映射

本批主要落在 plan 的 B1～B3，改动时同步回归相邻的 A、C 项。编号只用于追踪，不要求每行建一个重复文件。

| 本批用例 | 对应 plan ID | 场景与断言 |
| --- | --- | --- |
| B1-a | B1 | completed／error／aborted 及退出码、必要错误内容、callId、子代理引用，存储恢复后投影一致；错误正文不重复拼接（aborted 的 output 与 error 各出现一次） |
| B1-b | B1（T1 新增） | MCP 工具出错时，`isError`／`contentTypes`／`structuredContent` 仍落进 `ToolPart.state.metadata`，投影能看到 `isError`；成功路径行为不变 |
| B2-a | B2 | 多个大工具结果不触发新增批次均分或二次截断；各工具既有分页／限长仍有效 |
| B2-b | B2（T3） | Read 续读游标对应实际返回内容：循环按游标读完，拼接结果等于原文件且无跳过；`nextCursor`／`nextOffset` 与页正文同源 |
| B2-c | B2 | 已有可读引用可读取：子代理结果文件经授权链可用 Read 打开；MCP `resource`／`resource_link` 的 uri 保留 |
| B3-a | B3、B2 | 运行、恢复、后续普通请求和摘要请求共用同一投影；压力关闭（mask 默认关闭）下，已发送结果不因后续预算变化被改写。完整压力路径的贯通结果留第 5 批验证 |
| B3-b | B3、T4 | 未捕获的全文不被宣称可恢复；MCP 媒体内联如实标注为文本渲染，不声称原始媒体可取回 |

基线已满足的行为（A、C 相关）在改动邻近处回归；这不表示本批目标已实施或通过。MCP 错误用例还须验证无 metadata 的普通 Error 仍正常处理，核心模块没有导入 MCP 错误类。

## 3. 优先复用的测试位置与命令

路径相对仓库根：

| 领域 | 已有位置 |
| --- | --- |
| 工具投影 | `packages/ohbaby-agent/src/core/context/tool-metadata-projection.unit.test.ts` |
| Read 分页 | `packages/ohbaby-agent/src/tools/read.unit.test.ts` |
| 子代理结果 | `packages/ohbaby-agent/src/agents/subagents/result-artifacts.integration.test.ts` |
| 调度器结果 | `packages/ohbaby-agent/src/core/tool-scheduler/scheduler.unit.test.ts` |
| MCP 工具 | `packages/ohbaby-agent/src/mcp/integration/tool-sequence.unit.test.ts` |
| 序列化／恢复 | `packages/ohbaby-agent/src/core/context/serializer.integration.test.ts`、`packages/ohbaby-agent/src/core/message/database-store.integration.test.ts` |

示例定向命令，在仓库根执行；它不代表全部验收项已被现有测试覆盖：

```sh
pnpm exec vitest run packages/ohbaby-agent/src/core/context/tool-metadata-projection.unit.test.ts packages/ohbaby-agent/src/tools/read.unit.test.ts packages/ohbaby-agent/src/agents/subagents/result-artifacts.integration.test.ts packages/ohbaby-agent/src/core/tool-scheduler/scheduler.unit.test.ts
```

只改文档不要求重跑业务测试；改行为后必须执行对应风险用例与必要静态检查。

## 4. 真实 API 与上下文探测（本批收尾动作，本次不执行）

按 [plan/04 §4](../plan/04-test-and-acceptance.md)，实网测试是每批的收尾动作，不攒到最后。本批用仓库 `tests/models-4-tests.md` 里的真实 api-key 起独立 ohbaby 服务：

1. 读一个跨页文件，按游标读到底，核对拼接结果与文件一致、无跳过。
2. 触发一个工具错误，核对错误正文、退出码与（MCP 情形下的）`isError` 展示。
3. 跑一个子代理，核对回传正文或文件引用可读、内部历史未整体进入主上下文。
4. 重启会话后重放同一记录，核对正文与引用不变。

key 在进程内加载，不写进参数、日志、文档或 fixture。本次规划不执行这些步骤，也不读取凭据。

## 5. 对抗性审查要点

- **投影分叉**：改动后是否又出现第二处工具正文序列化？核对 `serializer.ts` 与 `serialization.ts` 仍共用同一函数。
- **游标越过正文**：任何新增的模型层截断都必须同时处理游标；只截正文会跳过内容。
- **错误 metadata 假成功**：把 MCP 错误改成“成功返回 + metadata”是错的，错误状态必须仍是 error，只是补回 metadata。
- **范围蔓延**：是否顺手加了批次额度、预览状态或落盘服务？本批不应出现。
- **子代理计量**：确认只计实际回传正文／引用，不把子代理内部历史算进主上下文。

## 6. 记录位置

本批的实际变更、测试命令与结果、实网证据、兼容与回退限制、未解决问题，后续写入本 `improve-2/` 目录；实施完成后由验收模式产出 `05-implementation-acceptance.md`。本 plan 不提前生成验收通过结论。
