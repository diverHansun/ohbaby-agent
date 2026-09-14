# 5. 实施验收文档

> 撰写时机：2026-09-14，由 plan-code-improvement 验收模式对照 `b43a0921...HEAD` 独立检查后撰写。实施会话原稿（`734f2ef6`）的分批数字与 T10 过程作为旁证保留，不把实施自证直接当成当场复现。

## 5.1 元信息

| 项 | 值 |
| --- | --- |
| 议题 / 轮次 | LLM SDK 与 Responses 迁移 / **improve-3** |
| 规划文档版本 | `b43a0921` 冻结的 00/02/02a/04 与 `design/data-model.md` §5–6 |
| 实施范围 | `openai-responses-migration@b43a0921` 上的 `codex/improve-3-model-contract`：`bd98d0ba`（A）→ `7fd55e04`（B）→ `66d6000f`（C）→ `1acc72e6`（空 model.json）→ `734f2ef6`（文档收尾） |
| 验收日期 | 2026-09-14 |
| 结论 | **通过，等待用户审核后合入集成分支。** 02 改动面落地，本会话定向测试复跑全绿；未整包复跑 `pnpm preflight`，也未重打真实 API。T10 采用实施会话分次成功证据。残余：Qwen 偶发未定因、CLI packaging 超时史、T2 闭集矩阵不完整。improve-3 完成不等于整个 Responses 迁移完成，也不自动 merge。 |

## 5.2 实施概况（对照 02）

| 02 条目 | 状态 | 实际实施摘要 | 证据 |
| --- | --- | --- | --- |
| A 请求与 adapter | 完成 | 自有 `ModelMessage` / `ModelToolDefinition` / `ModelToolCall`；三 adapter 直接投影，无共享层 Chat SDK alias | [`types.ts`](../../../../packages/ohbaby-agent/src/services/interface-providers/types.ts)；`openai-compatible.ts` / `anthropic.ts` / `openai-responses.ts` |
| A serializer / converter / tools | 完成 | `toolCalls`/`callId`/`reasoningText`；`toModelTools` | `serializer.ts`、`converter.ts`、`runner.ts` |
| A 估算 U5 | 完成 | 读新字段；私有 `legacy-estimation.ts` 还原旧 JSON 口径 | [`legacy-estimation.ts`](../../../../packages/ohbaby-agent/src/core/context/legacy-estimation.ts)；`token-estimation.unit.test.ts` |
| A cache 读取 | 完成 | 读新字段；wire 仍用协议原名 | `prompt-cache.ts`；`prompt-cache-wire.contract.test.ts` |
| B 外层结果 | 完成 | `messageSnapshot`、`reasoningText`/`reasoningTextDelta`、`ParsedToolCall.callId` | [`llm-client/types.ts`](../../../../packages/ohbaby-agent/src/core/llm-client/types.ts) |
| B 入口更名 | 完成 | `streamResponse`；无 `streamChatCompletion` 别名 | [`llm-client/index.ts`](../../../../packages/ohbaby-agent/src/core/llm-client/index.ts) |
| B 观察 U4 | 完成 | `run.llm.complete` 不再伪造空 snapshot | [`stream-bridge-run-event-source.ts`](../../../../packages/ohbaby-agent/src/adapters/ui-runtime/stream-bridge-run-event-source.ts) |
| B 公开 usage 别名 | 完成 | `StreamingTokenUsage = TokenUsage`；蛇形公开别名删除 | `types.ts`；compiled 负向编译 |
| C 公开入口 / 构建消费者 | 完成 | 根导出新入口；29 个旧入口负向编译 | `compiled-model-contract.integration.test.ts` |
| C SQLite reopen | 完成 | 旧 JSON → 物理 reopen → 新投影/续跑 → 仍写旧格式 | `database-store.integration.test.ts`、`ui-persistent.integration.test.ts` |
| D1 模块文档 | 调整 | 平铺五份 `docs/core/llm-client/*.md` 未改；写入子目录 | `docs/core/llm-client/openai-response-miagration-improve-3/`（拼写按当时指定保留） |
| 02.8 不做项 | 未做（正确） | 未改精确计数、cache 策略、压缩、默认协议、原生续接、SQLite schema | `git diff b43a0921...HEAD` 无对应生产改动 |

02.9 C1–C8 均完成。02a 点名的 `runtime/run-manager/types.ts`、`worker.ts` 生产文件未改：类型经 Lifecycle 传导。本会话定向 typecheck 未单独跑全仓 `tsc -b`，但 compiled consumer 与实施 preflight 记录覆盖了编译面。

## 5.3 规划 vs 实际差异

| 维度 | 规划方案 | 实际实施 | 差异原因 | 影响评估 |
| --- | --- | --- | --- | --- |
| 数据结构 | F01–F19；无 SDK alias | 与规划一致 | — | — |
| 数据流 | A 内层 + 多轮回传；B 外层命名；C 收口 | 与规划一致；无新旧运行时桥 | — | — |
| 协议/接口 | `streamResponse` / `toModelTools`；删除旧公开入口 | 与规划一致 | — | 外部调用方必须按 [`public-api-migration.md`](./public-api-migration.md) 迁移 |
| 文件/包结构 | 不新增 package/manager | 仅新增私有 `legacy-estimation.ts` | U5 批准 | 过渡债，improve-4 不默认删除 |
| 错误处理/边界 | 观察缺 snapshot；工具授权不靠快照完整度 | 与规划一致 | — | — |
| 依赖变更 | 无 | 无 SDK 再升级 | — | — |
| 文档落点 | D1 改平铺五份 | 独立子目录，平铺保持 | 用户后改落点 | 权威文档分裂两处；拼写 `miagration` 是可读性债 |

越界扫描：生产 26 个 `.ts` 均在 02.4/02a 内。未改 `token-usage.ts`、`token-usage-metadata.ts`、`tokenCounting.ts`、database migrations、默认 `interfaceProvider`。空 `.ohbaby-agent/llm/model.json` 删除为用户授权 chore。

## 5.4 实施理由与注意事项

- 共享层用自有值类型，协议差异留在三个 adapter。没有为三家协议再造消息框架。
- `legacy-estimation.ts` 只还原旧计量材料，不进发送链、不从根包导出。删它会改变估算数字和压缩时机，improve-4 不得当顺手清理。
- `streaming.ts` 内部仍有 `buildCompleteMessage` 私有名，对外已是 `messageSnapshot`。
- 流片段 `InterfaceProviderToolCallDelta.id` 仍是局部 index 绑定字段，累积后再映到 `callId`。scheduler 的 `ResolvedToolCall.id` 体系未改。
- 给后续：默认仍是 Chat；Responses 仍是显式 kind、store=false、observe-only cache、reasoning/phase fail-closed。Grok 通过不修复 Luna/DeepSeek Responses 的原生状态限制。

## 5.5 实施成果（对照 04）

### 5.5.1 验收项结果

本验收会话独立复跑（2026-09-14，未打真实 API）：

```text
19 个定向文件，415 tests passed
含 compiled-model-contract（T7/T9）与 lifecycle-tool-scheduler（T5 续跑）
```

| 验收 ID | 结果 | 证据 |
| --- | --- | --- |
| T1 | 通过 | `model-contract.unit.test.ts`；`prompt-cache-wire.contract.test.ts` 三协议 wire；本会话复跑绿 |
| T2 | 通过（覆盖偏弱） | Anthropic 空工具 JSON fallback 有表驱动；Chat 空值/多模态有保留用例；Responses 拒绝矩阵仍在。不是 design §5「每类正反例」完整闭集表 |
| T3 | 通过 | `token-estimation.unit.test.ts`：迁移前总量、七桶字面值、空 tools/tail/reasoning、键序边界 |
| T4 | 通过 | `model-response-transport` abort 不授权工具；Responses integration 取消零执行；`llm-client.test.ts` abort/retry |
| T5 | 通过 | `database-store` 物理 reopen 读旧 usage JSON；`ui-persistent` 两次 reopen 续跑；`lifecycle-tool-scheduler` |
| T6 | 通过 | stream-bridge complete 省略 snapshot；transport 观察路径无 `tool:start` |
| T7 | 通过 | compiled consumer：新入口可编译；旧导出/字段逐个负向失败 |
| T8 | 通过 | `auxiliary-token-usage-isolation`；title-generator canonical usage |
| T9 | 通过 | compiled 三协议 loopback HTTP/SSE 文本+一工具往返 |
| T10 | 通过（实施会话证据，本会话未复跑） | runner：`tests/smoke/responses-migration.real.e2e.test.ts`。见 §5.7 |
| T11 | 通过 | `model-snapshot.unit.test.ts` 保留原始 `argumentsJson`；compiled 不强转 partial snapshot |
| 全量 preflight | 未在本会话复跑 | 实施会话 §5.8：2026-09-13 23:02 `pnpm preflight` exit 0（317 files / 3229 tests）。本轮不把该数字写成当场复现 |

**回归**

- cache wire、lifecycle 工具门、SQLite JSON 键、默认协议：有测试且本会话抽测绿。
- 02 明确不改的 usage normalizer / metadata codec / tokenCounting 公式：无 diff。

**对抗性残余**

| 面 | 防御 | 残余 |
| --- | --- | --- |
| 改名漏多模态 | T2 部分正反例 | 无完整闭集表；未知外部消费者见 public-api-migration |
| null 变空文本 | 请求+估算双检 | 仍依赖 fixture，不是生成器穷尽 |
| isComplete 当成功 | abort/缺终态零工具 | 与 improve-2 相同，需保持 |
| 观察事件冒充模型事实 | complete 无 snapshot | manager.unit 无专测，主证据在 transport/bridge |
| DB JSON 改名 | 物理 reopen | schema 未改；旧 `promptTokens` 读路径未动 |

### 5.5.2 SWE 层面评估

这轮把 Chat SDK 类型从共享请求/结果上拆掉，复杂度留在三个 adapter 的投影函数里。没有新包、没有通用 extras 袋，也没有把快照当成可执行状态。这是对的：本质复杂度是「三套协议、一套 agent 循环」；偶然复杂度（共享层直接吃 OpenAI generated union）被减掉了。

`legacy-estimation.ts` 是显式重复，不是偷偷的发送桥。它存在是因为估算数字不能在改名时跟着漂。代价是以后改字段要记得改两份形状。

| 发现 | 严重性 | SWE 依据 | 建议 |
| --- | --- | --- | --- |
| 自有值类型 + adapter 投影，无新框架 | 正面 | 信息隐藏 / YAGNI | 后续 canonical item 另开轮，不要在共享层提前堆 Responses 字段 |
| 私有 legacy 估算桥 | 已知债务 | DRY 护栏：重复的是「旧计量合同」，不是发送知识 | improve-4 不删；替换材料要单独批准 |
| 文档子目录拼写 `miagration` | 低 | 代码是写给人读的 | 改名有链接成本；可在文档整理时修 |
| 内部 `buildCompleteMessage` 旧名 | 低 | 命名一致性 | 非阻断；可随下次动 streaming.ts 时改 |
| T2 闭集矩阵不完整 | 低 | 测试应对准风险 | 非阻断；improve-4 不必补，除非再动请求联合 |
| run-manager worker 生产文件未改 | 低 | 02a 点名 | 类型已传导；合入前一次完整 typecheck/preflight 即可 |

架构清单（框架 4，只问本轮碰得到的）：

- **一致性**：SQLite 仍写原 Message/Part JSON，reopen 有证。
- **AI 护栏**：工具执行仍看流耗尽+既有权限，不看 snapshot 完整度。
- **安全**：T10 runner 不打印密钥；本会话未读 `.env`。
- **韧性**：abort/retry 规则未借更名重写。超时仍交给既有客户端。

## 5.6 重要文件修改清单

生产代码（相对 `b43a0921`）：

| 文件 | 修改摘要 | 新增/修改/删除 |
| --- | --- | --- |
| [packages/ohbaby-agent/src/services/interface-providers/types.ts](../../../../packages/ohbaby-agent/src/services/interface-providers/types.ts) | 自有请求消息/工具 | 修改 |
| […/openai-compatible.ts](../../../../packages/ohbaby-agent/src/services/interface-providers/openai-compatible.ts) 等三 adapter | 直接投影 | 修改 |
| […/core/llm-client/types.ts](../../../../packages/ohbaby-agent/src/core/llm-client/types.ts)、[streaming.ts](../../../../packages/ohbaby-agent/src/core/llm-client/streaming.ts)、[index.ts](../../../../packages/ohbaby-agent/src/core/llm-client/index.ts) | snapshot / streamResponse | 修改 |
| […/core/context/legacy-estimation.ts](../../../../packages/ohbaby-agent/src/core/context/legacy-estimation.ts) | 旧计量材料 | 新增 |
| […/core/context/token-estimation.ts](../../../../packages/ohbaby-agent/src/core/context/token-estimation.ts)、[serializer.ts](../../../../packages/ohbaby-agent/src/core/context/serializer.ts) | 读新字段、旧数字 | 修改 |
| […/core/lifecycle/lifecycle.ts](../../../../packages/ohbaby-agent/src/core/lifecycle/lifecycle.ts)、[types.ts](../../../../packages/ohbaby-agent/src/core/lifecycle/types.ts) | 事件/工具映射 | 修改 |
| […/adapters/ui-runtime/stream-bridge-run-event-source.ts](../../../../packages/ohbaby-agent/src/adapters/ui-runtime/stream-bridge-run-event-source.ts) | 观察 complete 无 snapshot | 修改 |
| […/core/agents/runner.ts](../../../../packages/ohbaby-agent/src/core/agents/runner.ts) | `toModelTools` | 修改 |
| […/core/message/converter.ts](../../../../packages/ohbaby-agent/src/core/message/converter.ts) | 投影输出类型 | 修改 |

未改：`token-usage.ts`、`token-usage-metadata.ts`、`lifecycle/token-usage.ts`、`context-window-usage.ts`、`tokenCounting.ts`。

## 5.7 T10 实施会话记账（本会话未复跑）

凭据来源、命令与预算以 04 §4.6 为准。实施会话结论（2026-09-13）：

| 模型 / 协议 | 最终成功证据 | 保留的失败 |
| --- | --- | --- |
| `x-ai/grok-4.2-fast-non-reasoning` / Responses | TUN 复跑文本+工具往返通过（3 fetch / 工具 1 次） | 前两轮连接阶段失败 |
| `deepseek/deepseek-v4.1-flash` / Chat | 同上通过 | 前两轮连接阶段失败 |
| `qwen/qwen3.8-flash` / Anthropic | 21:59 定向诊断与清理后原 runner 均通过（工具 1 次） | 17:54 TUN 跑工具执行次数为 0；根因未定 |

分次补证，不写成同一次矩阵全绿。ZenMux ≠ 官方 OpenAI/Anthropic。Grok 通过不代表 Luna/DeepSeek Responses 原生状态限制已解除。

## 5.8 合入与下一轮

```text
main @ dfb6d932
└── openai-responses-migration @ b43a0921
    └── codex/improve-3-model-contract @ 734f2ef6
```

- 技术合同：通过。
- 合入 `openai-responses-migration`：仍须用户明确同意；建议合入前再跑一次干净 `pnpm preflight`。
- 不合 `main`、不 push、不改版本号。
- improve-4 候选见 [next-stage-candidates.md](./next-stage-candidates.md)。本 05 不批准 improve-4 实施合同。
