# improve-2 实施与验收

> 实施日期：2026-10-13。依据本目录 02、04 和 plan/00、02 的最终规则。原始讨论与 discussion-notes 保留了已撤回建议，本批不恢复那些机制。

## 1. 基线与范围

从 improve-1 本地分支 `codex/context-improve-1` 的 `c8be589d` 创建 `codex/context-improve-2`。第一批的同源投影计数、完整输出预留、可选 reasoning 用量和危险缩水分支清理均已核对；本批复用它们，不重复建设估算器。第一批已记录的高输出配置容量空档仍由 improve-3 承接。

生产代码只修改三个文件，补回 MCP 工具错误的 metadata；没有新增依赖、配置、数据库字段或迁移。Read、子代理、lifecycle、serializer 和 metadata 白名单生产代码保持原实现，通过实际链路测试验收。仅在本地分批提交，不 merge、不 push。

## 2. 对照实施计划

源码路径相对 `packages/ohbaby-agent/src/`。

| 02 阶段 | 实际实施 | 证据 |
| --- | --- | --- |
| Stage 1：错误 metadata | `McpToolExecutionError` 增加可选 metadata；adapter 传入已生成的 metadata；scheduler 用已有 `isRecord` 守卫接受对象并传给 `makeResult` | `mcp/errors.ts`、`mcp/integration/tool-adapter.ts`、`core/tool-scheduler/scheduler.ts` |
| Stage 2：稳定重放 | adapter → scheduler → lifecycle → SQLite → 下一步真实投影 → 关闭重开数据库，核对错误、两个大结果、摘要投影及同源计数；另补 aborted 持久化回归 | `core/context/serializer.integration.test.ts` |
| Stage 2：已有边界 | 扩充 MCP 音频与 resource_link 的文本表达断言；运行已有 Read 多字节跨页、子代理 51199／51200／51201 字节切换和 Read 授权链测试 | `mcp/__tests__/tool-adapter.unit.test.ts`、`tools/read.unit.test.ts`、`agents/subagents/result-artifacts.integration.test.ts` |
| Stage 3：实网收尾 | 独立 HTTP daemon、真实模型、实际工具与子代理运行、停止服务后重启同一 SQLite，再次请求核对回放 | §5 |

实际数据流：MCP `isError` → 带 metadata 的异常 → `ToolCallResult(status=error, metadata)` → 原有 `resultToToolState` → `ToolPart.state.metadata` → 原有普通／摘要投影。核心层不导入 MCP 错误类，错误仍是 error，不伪装为成功结果。

## 3. 规划之外的必要细节

1. **新增错误字段不可枚举。** scheduler 原本把 Error 保存为 `error.details`，lifecycle 将该详情 JSON 化写入正文。普通可枚举 metadata 会使结构化内容出现两次，还会绕过投影白名单。因此仅将新字段设为不可枚举，仍可直接读取；原有错误正文格式与 details 不变。集成测试确认错误文字与结构化 marker 各一次，`source`、`uiToolSource` 不进入模型结果正文。
2. **沿用注册来源作为 UI 来源。** 有效错误 metadata 与成功结果一样，由 scheduler 覆盖 `uiToolSource=tool.source`，避免工具伪造来源。缺失或非法 metadata 保持 undefined，普通 Error、timeout、cancelled 的行为不变。没有增加通用错误框架或扩展 `ToolCallError.details`。
3. **测试位置按实际职责选取。** 04 列出的 `mcp/integration/tool-sequence.unit.test.ts` 测工具菜单顺序；本次错误转换用例位于 `mcp/__tests__/tool-adapter.unit.test.ts`。完整链路放在已有 serializer SQLite 集成文件，复用其数据库夹具。

## 4. B1～B3 验收

| 项目 | 结果与证据 |
| --- | --- |
| B1-a：状态与配对 | completed／error 由真实调度及 lifecycle 链验证；aborted 的部分输出、错误、退出码、callId 关闭重开后保持一致；pending／running 沿用既有恢复用例，投影为结果未知，不冒充完成 |
| B1-b：MCP 错误 | `isError/contentTypes/structuredContent` 经实际执行存入 ToolPart 并投影；错误正文与结构化内容各一次；普通无 metadata Error 和 null／字符串／数字／数组 metadata 保持原结果行为 |
| B2-a：大结果 | 同一批两个各 60000 字符结果完整回传；降低窗口预算、跨过旧 mask 压力线但不达摘要线，默认 mask 关闭时正文和数据库 parts 均不变，无新增批次配额或二次截断 |
| B2-b：Read | 已有 UTF-8 长行跨三页以上无丢字、续行、过期游标等用例通过；实网按 nextCursor 连读四页，拼接七行与原文件一致 |
| B2-c：引用 | 已有子代理 UTF-8 字节阈值、完整文件内容、实际 scheduler＋sandbox 的授权 Read、越权拒绝和恢复测试通过；MCP resource/resource_link URI 保留 |
| B3-a：重放与计数 | SQLite 重开后普通投影、摘要工具内容和同源计数相同；实网重启服务后已发送工具结果逐字相同；子代理内部历史不进入主会话 |
| B3-b：捕获边界 | MCP 图片为 Markdown data URI、音频为含 base64 的文本，resource 保留 URI／已有文本；没有新增原始媒体文件或可恢复全文承诺。沿用工具原有捕获与限长边界 |

新增错误测试先在基线观察到 adapter 与 scheduler 两处失败，再修复转绿。已有分页和子代理能力无需为本批增加生产保护层。

主要命令：

```sh
pnpm exec vitest run packages/ohbaby-agent/src/core/context packages/ohbaby-agent/src/core/lifecycle packages/ohbaby-agent/src/core/tool-scheduler packages/ohbaby-agent/src/mcp packages/ohbaby-agent/src/tools/read.unit.test.ts packages/ohbaby-agent/src/agents/subagents/result-artifacts.integration.test.ts
pnpm test
pnpm build
pnpm typecheck
```

相关回归首轮为 49 文件通过、1 文件跳过；584 项通过、2 项跳过。后补 aborted 回归后，serializer 与 adapter 两文件 22 项通过。修改范围 ESLint 零错误，类型检查通过，构建通过。完整重跑全仓：526 文件通过、6 文件跳过；5878 项通过、17 项跳过，零失败。全仓 `pnpm lint` 零错误，109 条既有 warnings；修改范围零 warnings。

初次全仓测试未通过：新增 aborted 夹具使用了 `Stopped by user`，与现有 schema 要求的 `Tool execution aborted by user` 不符，导致三个 CLI 打包相关文件的构建失败。已修正测试数据并重跑；没有为此改变生产 schema 或放宽断言。

## 5. 独立服务真实 API 验证

使用 `tests/models-4-tests.md` 对应真实凭据，模型为 `deepseek/deepseek-v4.1-flash`、Chat Completions。密钥仅在进程内加载，不进入参数、报告、fixture 或提交。临时项目中建立只返回预设错误的 MCP stdio 服务，通过正常配置发现／激活／调度。

代理进程启动 `127.0.0.1` 随机端口 HTTP daemon，经 JSON-RPC client 创建会话并提交 prompt；LLM 决定并发出实际工具调用。四个阶段均 succeeded，最终观测 14 次生成 HTTP 请求，全部 HTTP 200，含父会话和前台子代理。设置了 28 次硬上限与请求／阶段超时；排除自动标题等辅助生成，不改变生产标题行为。

| 场景 | 实测结果 |
| --- | --- |
| 分页 | `read(limit=2)` 按游标连续读四页；七行 UTF-8 内容拼接完全一致；最后 hasMore=false |
| 工具错误 | MCP 仍为 error，isError=true，structuredContent 已落库并进入下一请求且只出现一次；Shell 实际退出码 7 保留 |
| 子代理 | 一个 foreground generic 子代理通过真实 LLM 读取专用文件，再只返回约定 sentinel；主代理收到内联结果，子代理内部读到的私有测试标记未进入主会话 |
| 恢复回放 | 完整停止 daemon，重启同一 SQLite 并选择原会话；已存 ToolPart 不变；新普通请求中此前九条工具结果逐字一致，无工具重跑 |

最后重放请求 usage：input=13612、output=59、total=13671、cacheRead=11904。该样本说明实际服务回放与 usage 可用，不代表摘要缓存策略已完成，也不保证提供商必然命中。摘要请求分叉属于 improve-3，本批只在离线链路验证其现有工具投影。

第一轮实网四场景已通过，但 HTTP 观测钩子装在 SDK 创建之后，未捕获 wire 次数；修正为创建 SDK 前安装后完整重跑，以上采用第二轮证据。两轮全部服务均停止，临时配置、SQLite、MCP 服务和测试文件均清理。脱敏证据保存在本机 `/tmp/improve2-live-final.json`；临时脚本移至忽略目录 `.ohbaby/improve2-live.ts`，不纳入提交。

实网子代理验证的是内联路径；大结果文件引用及 Read 授权由现有真实文件系统集成测试覆盖，没有让模型为了触发阈值生成大量付费文字。

## 6. 审查、SWE 与剩余边界

子代理分别核对原始讨论／最终决策、improve-1 基线、改动 diff 和实网接口。采纳了不可枚举字段与来源覆盖两项提醒。独立代码审查运行 adapter、scheduler、serializer 三文件 90 项通过，未发现阻断问题；之后新增 aborted 恢复测试单独验证。

Pi `github-copilot/claude-opus-5.5`、medium 独立审查认为可以收尾，无必须修复问题；自行运行 serializer、scheduler、adapter 和投影四文件 99 项通过，并核对全仓最终日志。它没有重跑实网、build 或 typecheck。

采纳其建议：scheduler 参数化测试将期望 metadata 直接写在表格中，避免复现生产形状守卫；调整新增 import 顺序；修正文档大结果长度为每条 60000 字符，补齐最终验收和提交记录。约 235 行主集成用例的内联模型／MCP 夹具只服务此用例，保留局部定义，不新增工厂与跨文件跳转；未来出现第二个消费者再考虑提取。Pi 提及 gRPC 风格 metadata 类实例只是扩展场景，没有仓库调用方证据，不因此收紧已有 `isRecord`。非 MCP 工具伪造 `source:mcp` 是成功路径也存在的既有信任边界，本批不扩展修复或建设错误框架。采纳建议后再次运行相同四文件，99 项通过；类型检查和受影响文件 ESLint 均通过，生产代码未再变化。

本批复用现有记录、纯投影和局部结构守卫，没有新增抽象层、额度或状态机。测试覆盖新增字段经过的真实跨模块边界，而不要求 Read／子代理为“更稳妥”重复实现已有能力。方向符合 KISS、YAGNI 和稳定依赖原则；参考项目仅借鉴“首次定型后稳定重放、如实区分捕获完整性”，不搬入其落盘服务。

- prune 及 prune-only 的删除归 improve-3；mask 归 improve-5。当前结论只覆盖默认 mask 关闭、未触发旧摘要前置 prune 的普通压力路径，不声称完整压力链已替换。
- 旧记录缺少错误 metadata 时仍按原方式读取，本批不能追补过去已经丢失的结构化内容。
- 回退仅恢复这三个生产文件对应变更；已存 metadata 是既有字段，记录仍可读取。不要重新执行工具、清空会话或改写已有正文来回退。

## 7. 本地提交

| 提交 | 内容 |
| --- | --- |
| `b1e0edae` | MCP 错误 metadata、通用调度器接线及 adapter／scheduler 单测 |
| `b22ab78d` | lifecycle／SQLite／预算变化／重启稳定性及 aborted 回归 |
| 本文所在文档提交 | 本批验收、README 状态和 Context／MCP 现状说明 |

分支保留在 `codex/context-improve-2`，等待用户审查；未 merge、未 push。
