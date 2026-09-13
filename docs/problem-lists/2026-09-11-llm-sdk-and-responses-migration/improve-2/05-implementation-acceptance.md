# 5. 实施验收文档

> 撰写时机：实施完成后，由 plan-code-improvement 验收模式独立检查后撰写。本文替换同路径下实施会话的自证记录；实施会话的提交与 preflight 数字作为旁证保留。

> **2026-09-13 追加复验**：§5.1–5.7保留2026-09-12原验收事实；最新状态见§5.8。本次全量preflight exit 0，T11已补证通过；T12仍未执行，总结论仍为部分通过，不可合入集成分支。

> **同日ZenMux预检更新**：用户修订live证据来源后已发出4条真实文本预检，结果见§5.9。两条Responses失败、Chat与Anthropic文本通过；T12完整工具往返未完成，仍不可合入。上一条“未执行”是此次请求前的历史状态。

> **最小兼容修订诊断更新**：用户批准最小参数兼容修订后，§5.10追加了4条受控诊断请求。省略temperature/指定reasoning.effort=none仍不能满足既有输出合同：Luna返回final_answer phase，DeepSeek仍返回含加密内容的reasoning。没有修改生产代码或放宽保护；合入及improve-3实施继续暂停。

> **最新：替代模型预检通过**：用户批准在ZenMux另选模型后，x-ai/grok-4.2-fast-non-reasoning通过生产adapter文本及llm-client工具往返预检，见§5.11。已据此修订04矩阵；完整生产lifecycle T12仍待执行，整轮仍为部分通过，尚未合入或开始improve-3。

> **收尾更新（2026-09-13 13:52，Asia/Taipei）**：最新全量preflight exit0，生产lifecycle真实T12通过，见§5.12。以上“部分通过/暂停”保留为各次检查时的历史结论；当前技术门已补齐，收尾测试审查完成后按用户授权合入本地集成分支，main不动。

## 5.1 元信息

| 项 | 值 |
| --- | --- |
| 议题 / 轮次 | LLM SDK 与 Responses 迁移 / **improve-2** |
| 规划文档版本 | `24cc4234`（2026-09-12）；实施中 02/04 有 fail-closed / SDK 事件闭集加严，仍以仓库当前 02/04 为对照基线 |
| 实施范围 | `main...HEAD` on `codex/improve-2-responses-migration`（`3d1e04c9` … `a18290f3`，38 files / +3919） |
| 验收日期 | 2026-09-12 |
| 结论 | **部分通过**：02 改动面已落地，Responses 定向测试独立复跑通过；官方 live（T12）未跑，故不能宣称真实可用，也不能合入 `openai-responses-migration`。本验收会话的全量 `pnpm preflight` 因无关的 CLI packaging-smoke 超时未闭环。 |

工作区另有未提交删除 `.ohbaby-agent/llm/model.json`，与本轮无关，未纳入验收范围。

## 5.2 实施概况（对照 02）

| 02 条目 | 状态 | 实际实施摘要 | 证据 |
| --- | --- | --- | --- |
| S1 kind 白名单（types / validation / apply） | 完成 | 三处均含 `openai-responses`；未知 kind 拒绝 | `config/llm/{types,validation,apply-active-model-config}.ts`；`validation.unit.test.ts` / `apply-active-model-config.unit.test.ts` |
| S1 factory 显式分支、禁止 fallthrough | 完成 | exhaustive `switch` + `never`；未知 kind 抛错 | [`index.ts`](../../../../packages/ohbaby-agent/src/services/interface-providers/index.ts)；`index.test.ts` → `does not fall through…` |
| S1 缺省仍 Chat | 完成 | `resolveInterfaceProviderKind(undefined) → openai-compatible` | 同上；`index.test.ts` 缺省用例 |
| S1 responses → observe-only（含 enabled） | 完成 | kind 提前返回，不进 Anthropic / keyed-implicit | [`prompt-cache.ts`](../../../../packages/ohbaby-agent/src/core/llm-client/prompt-cache.ts)；`prompt-cache.unit.test.ts` 三档 policy |
| S1 connect/probe 两值 vs current-model 三值 | 完成 | 无新 UI 控件、无 URL 分流、无 type cast 扩 connect | [`connect-model.ts`](../../../../packages/ohbaby-sdk/src/connect-model.ts)；SDK / ui-inprocess 契约测试 |
| S1 apply + UI runtime 同步 | 完成 | apply 白名单含第三 kind；connect 回写收窄为两值 | `ui-inprocess.ts` 用 `input.interfaceProvider` 覆盖 apply 结果 |
| S2 独立 Responses adapter | 调整 | 请求投影与流状态机拆成两个文件（02 只写了单文件名） | `openai-responses.ts` + `openai-responses-stream.ts` |
| S2 `store: false`、无 continuation/cache 字段 | 完成 | 请求恒 `store: false`；省略 `previous_response_id` / `prompt_cache_*`；流侧拒 `store:true` | `buildRequestParams`；wire contract；unit `rejects stateful response hints` |
| S2 system → instructions（`\n\n`） | 完成 | 全部 string system 依序合并，不进 `input` | unit `moves all system strings into ordered instructions…` |
| S2 tools 扁平 `strict: false` | 完成 | Chat 嵌套 function → Responses `FunctionTool` | 同上 + wire `toEqual` |
| S2 本地 tool index / call_id | 完成 | `output_item.added` 时按加入顺序分配 index；`id = call_id` | unit T5；integration 双工具 roundtrip |
| S2 incomplete + function → reject | 完成 | 含 function 的 incomplete 不发成功终态 | integration `blocks tools when completed function output carries incomplete_details` |
| S2 独立 usage parser | 完成 | `normalizeOpenAIResponsesUsage`；`protocol: "openai-responses"`；不用 Anthropic accumulator | [`token-usage.ts`](../../../../packages/ohbaby-agent/src/services/interface-providers/token-usage.ts)；`responses-token-usage.unit.test.ts` |
| S2 SDK 7.13 事件穷尽 / fail-closed | 完成 | 58 个 `case` + `never` default；未知事件失败 | [`openai-responses-stream.ts`](../../../../packages/ohbaby-agent/src/services/interface-providers/openai-responses-stream.ts)；unit `rejectedEvents` |
| S2 零次 `chat.completions.create` | 完成 | 只调 `client.responses.create` | `openai-responses.ts`；integration `expect(harness.chat).not.toHaveBeenCalled()` |
| S3 cache wire「responses 不发 cache」 | 完成 | auto/enabled/disabled 三档均无 cache 控制字段 | `prompt-cache-wire.contract.test.ts` |
| S3 Responses 镜像单测 | 完成 | unit 208 + integration 7 | `openai-responses.unit.test.ts` / `.integration.test.ts` |
| S3 llm-client 文档第三 kind | 完成 | 写明非默认、非 canonical、cache observe-only | `docs/core/llm-client/*` |
| S3 `pnpm preflight` | 部分 | 见 5.5 T11 | 本会话未能完整复现实施会话的 exit 0 |
| 02.8 列出的后续项 | 未做（正确） | 未做 canonical / cache 对齐 / 默认翻转 / continuation / lifecycle·SQLite 迁移 | `git diff --name-only main...HEAD` 无对应生产改动 |

## 5.3 规划 vs 实际差异

| 维度 | 规划方案 | 实际实施 | 差异原因 | 影响评估 |
| --- | --- | --- | --- | --- |
| 数据结构 | 扩展 `InterfaceProviderKind`；current-model 可回显第三值；connect/probe 仍两值 | 与规划一致 | — | — |
| 数据流 | adapter 门口翻译；lifecycle / llm-client / context 输入形状不变 | 与规划一致；工具 index 在 adapter 合成 | — | 后续 canonical 仍要改累积器（已登记 02.8） |
| 协议/接口 | 显式 kind → `/v1/responses`；`store: false`；共享接口不暴露 OpenAI 专属状态 | 与规划一致；方法名仍为 `streamChatCompletion` | 00 已冻结本轮不重命名 | 名称带 Chat 味道，属有意债务 |
| 文件/包结构 | 新增 `openai-responses.ts` | 另拆 `openai-responses-stream.ts` | 状态机与请求投影分离，便于阅读与测试 | 语义仍在同包 adapter 内；可接受 |
| 错误处理/边界 | wire-complete + capability-limited + fail-closed | 与规划一致；reasoning/phase/refusal/annotation/hosted 在工具执行前失败 | — | — |
| 依赖变更 | 沿用 improve-1 的 OpenAI `7.13.0` | 未再升 SDK | — | — |

越界扫描：`main...HEAD` 生产改动均落在 02.4 改动面。未改 lifecycle 行为、context 算法、SQLite schema、CLI/server 命令、UI 协议开关。

## 5.4 实施理由与注意事项

- 独立文件而不是在 Chat adapter 里加分支，是为了把 Responses 事件模型关在一个入口。共享层继续吃 Chat 形状，换来的是本轮可交付，以及以后还要再翻一次累积器。
- cache 对 `openai-responses` 一律 observe-only，包括 policy=`enabled`。这是防掉进 Anthropic `cache_control` 的门闩，不是「Responses 已经会缓存」。
- `ui-inprocess` 在 connect 成功后用输入 kind 覆盖 apply 结果，是为了把三值 `InterfaceProviderKind` 收窄回两值 connect 联合。只读 current-model 仍可回显 `openai-responses`。
- 给后续维护者：SDK 一旦新增 `ResponseStreamEvent` 成员，`never` 守卫和 `rejectedEvents satisfies` 会一起红。不要为了让推理模型「先跑起来」去吞 reasoning/phase。
- 温度原样下发。reasoning 模型若因此 400，按 02 停并回审，不要在 adapter 里偷删字段。

## 5.5 实施成果（对照 04）

### 5.5.1 验收项结果

本验收会话独立复跑（2026-09-12）：

```text
pnpm exec vitest run  <Responses 相关 11 个文件 + T10 8 个文件>
→ 17 files / 624 tests passed
（ui-inprocess.contract.test.ts 在沙箱因 git init 失败 5 条；放开沙箱后 112/112 passed，含 T-config-ui）
```

| 验收 ID | 结果 | 证据 |
| --- | --- | --- |
| T1 | 通过 | `index.test.ts` 缺省 Chat；`prompt-cache-wire.contract.test.ts` 既有 Chat keyed-implicit 契约仍在 |
| T2 | 通过 | `does not fall through to the Chat Completions adapter for Responses`（断言 `kind`） |
| T2a | 通过 | `prompt-cache.unit.test.ts` 三档 policy observe-only；integration `harness.chat` 零次 |
| T3 | 通过 | unit 省略 cache/continuation；wire `store: false` 且无 `previous_response_id`；流侧拒 `store:true` |
| T4 | 通过 | unit：system + tail 以 `\n\n` 进 `instructions`，不进 `input` |
| T4a | 通过 | unit `rejects unsupported message shape` 表驱动 |
| T-config-ui | 通过 | SDK `keeps Responses display-only…`；ui-inprocess `echoes an explicitly saved Responses kind…`；connect/probe 联合不含第三值 |
| T5 | 通过 | unit 并行 function index；integration 双工具 roundtrip |
| T-tools | 通过 | 扁平 `{ type, name, parameters, strict: false }`；非 function / `strict:true` 拒绝 |
| T6 | 通过 | unit `emits text once and a single stop carrying inclusive usage`（100/40 → uncached 60） |
| T7 | 通过 | integration：reasoning 在 function delta 前或后都失败；工具调度零次 |
| T8 | 通过 | 58 event `case` + `never`；`rejectedEvents satisfies ResponseStreamEvent["type"][]`；未知 `response.future_event` 失败 |
| T8a | 通过 | unit 拒绝非 message/function item；message part 有序；phase/annotation 拒绝 |
| T8b | 通过 | `rejects %s without yielding a success terminal`（缺/多/重排/不一致） |
| T8c | 通过 | failed/error；message-only incomplete → length/content_filter；含 function 的 incomplete 拒绝 |
| T8d | 通过 | 同状态机 describe：id 稳定、added→done、terminal 后事件拒绝 |
| T8e | 通过 | `responses-token-usage.unit.test.ts` inclusive / 省略 breakdown / conflict / raw-total-mismatch |
| T8f | 通过 | `responses-usage.unit.test.ts` protocol 闭集、拒绝未登记枚举 |
| T8g | 通过 | integration 经 lifecycle 聚合后 inclusive usage 不双算；未改下游模块 |
| T9 | 通过 | unit cancellation 4 条；integration abort 后工具零执行 |
| T10 | 通过 | 本会话复跑 improve-1 定向 8 文件均绿：`openai-compatible.test.ts`、`anthropic.test.ts`、`prompt-cache-wire.contract.test.ts`、`token-usage.unit.test.ts`、`llm-client.test.ts`、`lifecycle.unit.test.ts`、`context/manager.unit.test.ts`、`context/token-estimation.unit.test.ts` |
| T11 | 部分 | 见下 |
| T12 | 未做 | 无 Responses live smoke 文件；本会话未读密钥、未打官方 API |

**T11 明细**

| 来源 | 命令 | 结果 |
| --- | --- | --- |
| 本验收会话 | `pnpm preflight` | format / lint / `tsc -b` 通过。Vitest **1 failed / 312 passed / 5 skipped files**；**3195 passed / 16 skipped tests**。失败项：`tests/integration/cli/packaging-smoke.integration.test.ts`（本地 registry `npm install -g` 180s 超时）。test 失败后 **build 未执行**。该文件不在 02 改动面。 |
| 实施会话自证（`e5ec5da1` 起的 05 原稿） | 清理遗留 CLI package-install / 空锁目录后 `pnpm preflight` | 声称 exit 0；Vitest 312 passed / 5 skipped files，3193 passed / 16 skipped tests；build 含各包 `tsc -b --force` |

独立验收**不**把实施会话的成功 preflight 直接记成当场复现。T11 因此标部分。Responses 相关测试已独立通过，CLI packaging-smoke 视为环境噪音，不是本轮功能缺口。

**回归（04 §4.4）**

- Chat `prompt_cache_key` / Anthropic `cache_control` wire：契约文件仍绿。
- lifecycle 步数/工具顺序、context 估算：T10 文件绿；本轮未改这些模块行为。
- SQLite：diff 无 migration。
- UI：无协议开关；connect 不能选 Responses。

**对抗性残余（04 §4.6）**

| 攻击面 | 本轮防御 | 残余 |
| --- | --- | --- |
| enabled 掉进 Anthropic cache / factory 打到 Chat | T2a + T3 | 未来再加 kind 仍必须显式开口 |
| hosted tool 当文本 | item/event Rejected | 未见「hosted 与 output_text 同窗」专用夹具；行为由拒绝表覆盖。SDK 新增 item 仍要更新分类表 |
| call_id / index 错位 | T5 固定夹具 | 并行顺序与 output_index 不一致时规则已钉死为「加入顺序」 |
| usage 嗅探撞 Anthropic | kind 分派 parser | 网关若把 Chat usage 塞进 Responses，只观测、不猜协议 |
| temperature 400 | 记风险，等 T12 | 本轮无模型表 |
| reasoning/phase 压扁后续跑 | T7 + T8a/b | 推理模型工具多轮要等 continuation/canonical |
| 只看增量、漏看终态 | T8b | SDK 新增 output item 时 `never` + fixture 应一起红 |

**未完成 / 不宣称**

1. T12 官方 live smoke 未跑 → 不能声称显式 Responses 已真实可用。
2. 按 04 §4.5 B / §4.3：该状态**不能**合并到 `openai-responses-migration`。
3. T11 本会话未完整复现（packaging-smoke + 未跑到 build）。
4. 02.8 候选全部未做，属正确的范围控制。

### 5.5.2 SWE 层面评估（聚焦改动面）

改动把 Responses 协议的本质复杂度关在 adapter 里，没有为了「接上官方新 API」去改 lifecycle、消息模型和数据库。这是对的：共享层继续用 Chat 形状是过渡，不是假装已经 canonical。

factory 用穷尽 `switch` 而不是 fallthrough，prompt-cache 对第三 kind 提前 observe-only，事件用 `never` 拒绝未知成员——都是在用显式失败换静默错误。代价是 `openai-responses-stream.ts` 大约 710 行，读起来重。这主要是协议状态机本身的密度；他们已经把请求投影拆到另一个文件，没有再叠一层无用的「未来 IR」。

| 发现 | 严重性 | SWE 依据 | 建议 |
| --- | --- | --- | --- |
| 协议复杂度留在 adapter，未泄漏进 lifecycle/context/SQLite | 正面 | 信息隐藏 / 关注点分离（受力 02）；YAGNI（原则 03） | 后续 canonical 再动共享层，不要提前拆 |
| 流状态机单文件偏长 | 低（本质复杂度） | 代码工艺：长函数常是低内聚信号（工艺 06）；此处职责就是一台协议状态机 | 不作为本轮缺口；若再胀，按 handler 拆函数即可 |
| 合成 tool index、Chat 形消息、`streamChatCompletion` 名称 | 已知债务 | 有意的过渡耦合；02.8 已登记 | improve-3 规划时作为输入，不要在 05 里当缺陷重开 |
| T2 工厂测试只断言 `kind`，不 mock `chat.completions.create` | 低 | 测试应钉行为（实践 07）；integration 已补零次 Chat create | 非阻断；若要加强，给 factory 加调用面断言 |
| hosted+text 同窗无专用夹具 | 低 | 对抗性 04.6.2 | 非阻断；拒绝表已覆盖 hosted item/event |
| 独立全量 preflight 未闭环 | 中（门禁，非功能） | 验证应可复现 | 合入前再跑一次干净的 `pnpm preflight`；T12 另排 |

架构审查清单（框架 4，只问本轮碰得到的项）：

- **韧性**：abort 走现有 `APIUserAbortError`；未新造重试。超时仍交给 OpenAI SDK 默认，本轮可接受。
- **AI 护栏**：不支持的 output 在碰工具副作用前失败（T7）。这是本轮最重要的生产护栏。
- **安全**：usage diagnostic 闭集扩展第三 protocol，不放宽敏感字段（T8f）。
- **一致性**：`store: false` + 本地完整 replay，没有半套 `previous_response_id`。
- **规模 / 成本上限**：非本轮范围。

## 5.6 重要文件修改清单

生产代码（相对仓库根）：

| 文件 | 修改摘要 | 新增/修改/删除 |
| --- | --- | --- |
| [packages/ohbaby-agent/src/config/llm/types.ts](../../../../packages/ohbaby-agent/src/config/llm/types.ts) | kind 联合加 `openai-responses` | 修改 |
| [packages/ohbaby-agent/src/config/llm/validation.ts](../../../../packages/ohbaby-agent/src/config/llm/validation.ts) | 白名单与错误文案 | 修改 |
| [packages/ohbaby-agent/src/config/llm/apply-active-model-config.ts](../../../../packages/ohbaby-agent/src/config/llm/apply-active-model-config.ts) | 第二份白名单 | 修改 |
| [packages/ohbaby-sdk/src/connect-model.ts](../../../../packages/ohbaby-sdk/src/connect-model.ts) | current-model 三值 / connect·probe 两值 | 修改 |
| [packages/ohbaby-sdk/src/index.ts](../../../../packages/ohbaby-sdk/src/index.ts) | 导出 `UiCurrentModelInterfaceProvider` | 修改 |
| [packages/ohbaby-agent/src/adapters/ui-inprocess.ts](../../../../packages/ohbaby-agent/src/adapters/ui-inprocess.ts) | 只读回显 + connect 回写收窄 | 修改 |
| [packages/ohbaby-agent/src/services/interface-providers/types.ts](../../../../packages/ohbaby-agent/src/services/interface-providers/types.ts) | kind 联合 | 修改 |
| [packages/ohbaby-agent/src/services/interface-providers/index.ts](../../../../packages/ohbaby-agent/src/services/interface-providers/index.ts) | factory 第三分支 | 修改 |
| [packages/ohbaby-agent/src/services/interface-providers/openai-responses.ts](../../../../packages/ohbaby-agent/src/services/interface-providers/openai-responses.ts) | 请求投影 + `responses.create` | 新增 |
| [packages/ohbaby-agent/src/services/interface-providers/openai-responses-stream.ts](../../../../packages/ohbaby-agent/src/services/interface-providers/openai-responses-stream.ts) | fail-closed 流状态机 | 新增 |
| [packages/ohbaby-agent/src/services/interface-providers/token-usage.ts](../../../../packages/ohbaby-agent/src/services/interface-providers/token-usage.ts) | Responses usage parser | 修改 |
| [packages/ohbaby-agent/src/core/llm-client/prompt-cache.ts](../../../../packages/ohbaby-agent/src/core/llm-client/prompt-cache.ts) | responses 恒 observe-only | 修改 |
| [packages/ohbaby-agent/src/observability/events.ts](../../../../packages/ohbaby-agent/src/observability/events.ts) | protocol 枚举第三值 | 修改 |
| [packages/ohbaby-agent/src/observability/logger.ts](../../../../packages/ohbaby-agent/src/observability/logger.ts) | 安全枚举第三值 | 修改 |

权威文档：`docs/core/llm-client/{architecture,data-model,dfd-interface,goals-duty,test}.md`（修改，未声称默认 Responses / 已 canonical）。

测试与本目录规划/验收文档从略（Stage 3 / 规划面）。

## 5.7 合入与下一轮

```text
main
└── openai-responses-migration          # 仍不可合入
    └── codex/improve-2-responses-migration
```

- **本地实现（04 §4.5 A）**：功能与定向测试通过；T11 本会话未完整复现。
- **合入集成分支（04 §4.5 B）**：未通过。缺 T12，且建议合入前再跑一次干净 `pnpm preflight`（含 build）。
- **improve-3**：02.8 候选可作为新轮输入。根 README 原先写「05 闭环并合入集成分支后才写正式 00–04」。T12 未完成时若仍要开规划，需用户确认这是「主动切割后的下一轮规划」，而不是把合入门禁提前关掉。

## 5.8 2026-09-13 前置复验补证

本节追加新证据，不抹掉上次packaging超时，也不把旧实施会话自证当作本次复跑。

| 项 | 本次结果 |
| --- | --- |
| 代码基线 | codex/improve-2-responses-migration@a18290f3；未改生产代码，未merge |
| 执行命令 | pnpm preflight，进程退出码0 |
| 静态门 | format:check、lint、typecheck均通过 |
| Vitest | 313 passed / 5 skipped files；3196 passed / 16 skipped tests；耗时246.39s |
| 原超时项 | packaging-smoke.integration.test.ts本次通过；不将历史环境超时判断为已修复生产bug |
| build | SDK/agent/server/CLI/Web构建及配置的类型构建完整通过 |
| 独立代码复核 | 子代理重新对照improve-2约定范围及当前实现，未报告新的阻断性代码问题；此结论不替代live |
| T11 | 本次已通过；跳过测试如实保留，不能用于填补T12 |
| T12 | 未执行。当前进程OPENAI_API_KEY未设置；已请求凭据来源、官方模型和预算，未搜索/输出其他位置密钥，也未发出收费请求 |

剩余开工前置项：

1. 明确官方凭据来源、适用于当前受限adapter的模型与请求预算，补官方文本和普通function-tool多轮live证据。失败按04停并回审，不绕过不支持能力。
2. T12通过且新变更复验满足04后，才安排合回openai-responses-migration；当前没有执行合并，也没有创建improve-3实施分支。
3. 用户已明确允许提前撰写improve-3规划；这只解除规划时机限制，不解除合并或实施门禁。
4. 工作区无关删除.ohbaby-agent/llm/model.json继续排除；文档未提交修改仍在工作区，后续提交必须显式限定文件。

## 5.9 ZenMux真实前置检查（2026-09-13）

用户指定ZenMux四条模型/协议路径，并明确凭据位于仓库根.env。先用node --env-file=/Users/hansun025/Projects/code-cli/ohbaby-agent/.env检查ZENMUX_API_KEY是否非空，只输出布尔值；确认存在后用于批准端点，未输出密钥，未修改.env。

执行入口：node --env-file=.env --import tsx --input-type=module，内联脚本直接调用当前生产createOpenAIResponsesProvider/createInterfaceProvider及streamChatCompletion，不直接绕过adapter调SDK。代码基线仍为a18290f3；无生产改动。每条请求只有合成user文本，要求回复固定标记；temperature=0.2、maxTokens=2048、AbortSignal.timeout(60000)、promptCache=observe-only、purpose=agent-step。OpenAI兼容端点https://zenmux.ai/api/v1；Anthropic端点https://zenmux.ai/api/anthropic。

| 模型 / 协议 | 真实文本预检 | 安全记录 |
| --- | --- | --- |
| openai/gpt-5.6-luna / Responses | 失败，HTTP400 | Unsupported parameter: 'temperature' is not supported with this model；0个归一事件，0个文本字符；未得到usage |
| deepseek/deepseek-v4.1-flash / Responses | 失败，adapter拒绝输出 | Responses response.output_item.added: unsupported output item reasoning；0个归一事件，0个文本字符；未得到usage |
| deepseek/deepseek-v4.1-flash / Chat | 单文本通过，不代表完整E2E | finish=stop，OHBABY_LIVE_OK匹配；inputTokens=46、outputTokens=23、totalTokens=69；cacheRead=0，observed.cacheRead=true |
| qwen/qwen3.8-flash / Anthropic | 单文本通过，不代表完整E2E | finish=stop，OHBABY_LIVE_OK匹配；inputTokens=76、outputTokens=46、totalTokens=122；cacheRead/cacheWrite=0，observed均true |

第一条命令exit1；其余三条并行预检的命令整体exit1（DeepSeek Responses失败）。共4个逻辑请求；未获取账单，不宣称失败调用免费或全部usage已知。未重复修改参数重试，未开始工具往返，未把失败输出压扁成文本，未更换模型/协议冒充成功。

本地定向复测：pnpm exec vitest run packages/ohbaby-agent/src/services/interface-providers/openai-responses.unit.test.ts packages/ohbaby-agent/src/services/interface-providers/openai-responses.integration.test.ts，exit0，2 files / 215 tests passed。此前§5.8全量preflight证据仍为同一生产HEAD的基线，不冒充这次重新全量执行。

独立子代理核对生产代码：openai-responses.ts:139固定传temperature；openai-responses-stream.ts:129将reasoning列为不支持item。两条失败与代码一致，不能靠已通过的Chat/Anthropic文本填补T12。子代理未自行发网络请求，其独立结论是代码及门禁核对，不是另一组live结果。

**当前结论与停点**：

- 本地实现门已有通过证据；指定ZenMux的Responses真实路径未通过，T12未完成。
- 暂停合并improve-2，也暂停以前置合并为条件的improve-3生产实施。当前仍在codex/improve-2-responses-migration，未创建improve-3实施分支，main及openai-responses-migration未变。
- 需要用户批准明确的参数兼容修订，及选择如何处理指定模型产生的原生reasoning：核实可用的非推理模式/调整验收模型，或另行改变阶段范围。不能自行省略temperature、忽略reasoning，不能把阻塞简单移到improve-4后宣布验收通过。
- improve-3已批准的内部字段合同保持有效；这些字段改名本身不会修复上述两项真实协议问题。

## 5.10 最小参数兼容方案的受控验证（2026-09-13）

用户确认“这个最小兼容修订”：调查并处理temperature发送条件，核实指定模型非推理模式，同时保持reasoning/phase拒绝保护。该批准不等于允许丢失原生状态或绕过T12。

文档依据：[ZenMux推理指南](https://zenmux.ai/docs/guide/advanced/reasoning.html)明确Responses关闭方式为reasoning.effort=none；安装的OpenAI 7.13 Shared.Reasoning支持none。此能力声明不能替代指定模型/路由的实际结果，也不能用Chat的reasoning.enabled字段代替。

诊断入口仍用node --env-file=.env --import tsx --input-type=module；SDK从packages/ohbaby-agent依赖解析。先前一次从仓库根直接import openai因根包未安装该依赖而在发请求前失败，修正为按agent包解析后执行以下4个逻辑请求。凭据未输出，SDK maxRetries=0，60秒超时，max_output_tokens=2048、store=false、stream=true，只有合成user文本和指定参数。直接SDK调用仅用于隔离变量，**不是生产adapter已经修复的证据**。

| 步骤 | 单变量 / 参数 | 结果 |
| --- | --- | --- |
| 1 · Luna | 相对§5.9仅省略temperature，不配置reasoning | 不再出现温度400；首个message带phase=final_answer，原mapResponsesStream拒绝 |
| 2 · DeepSeek | 保留temperature=0.2，仅加reasoning.effort=none | 仍出现reasoning item，原mapResponsesStream拒绝 |
| 3 · Luna | 在步骤1上加reasoning.effort=none，完整收流后交原校验器重放 | 上游response.completed；回显effort=none，output只有message且phase=final_answer；input21/output10/total31，reasoning_tokens=0；原校验器仍拒绝phase |
| 4 · DeepSeek | 保持步骤2参数，完整收流检查终态后交原校验器重放 | 上游response.completed；回显effort=null；reasoning item的summary为空但encrypted_content非空，随后message phase=final_answer；input46/output26/total72，reasoning_tokens=18；原校验器仍拒绝reasoning |

诊断只输出item类型、phase、加密内容是否存在的布尔值、usage和错误分类；未输出推理正文、加密内容或鉴权头。完整原始事件仅在诊断进程内存中用于调用现有mapResponsesStream，不写入业务历史。诊断命令捕获错误后exit0只表示探测结束，不表示adapter或T12通过；两条最终校验均为失败。

结论：

1. Luna的temperature确实是一个请求参数障碍，但解决它仍留下已明确禁止的phase，不足以关闭live门。
2. DeepSeek此实际路由未获得符合受限合同的无reasoning输出；不能仅凭请求none或summary为空认定没有原生状态。当前证据不能区分是网关转换还是上游模型处理导致，也不应猜测。
3. 不提交一段无法解决验收的生产参数补丁，不扩大成模型名白名单、供应商配置框架，不放宽现有流验证。当前生产代码和分支均未变。
4. 后续需选择：另行寻找并验证符合现有受限输出合同的模型/端点，再修订live矩阵；或明确重排原生状态工作。前者不保证换模型必然成功，必须先预检；后者属于范围变化，不能当作已批准的最小修订。
5. 在上述路径明确且T12通过前，不merge improve-2，不开始improve-3生产实施。improve-3精确契约与验收后等待用户审核的约定保持有效。

## 5.11 ZenMux替代Responses模型预检（2026-09-13）

用户授权先预检再调整矩阵。代码基线仍为a18290f3，生产源码未改。先核对ZenMux公开模型页面及[模型列表API说明](https://zenmux.ai/docs/api/openai/openai-list-models.html)，实际GET /api/v1/models返回189条。模型处于列表中、capabilities.reasoning=false都不能单独证明其Responses路由可用或符合当前受限合同。

### 候选文本探测

入口为node --env-file=.env --import tsx --input-type=module内联诊断，调用生产createOpenAIResponsesProvider与其streamChatCompletion。固定baseUrl=https://zenmux.ai/api/v1，temperature=0.2、maxTokens=512、45秒abort、store=false、stream=true；SDK maxRetries=0。仅发送合成user文本“Reply with exactly OHBABY_LIVE_OK. No tools are needed.”，完整消费归一流至EOF，要求finish=stop且标记匹配。未省略temperature、添加reasoning配置、过滤事件或回落Chat。

| 模型 | 结果 |
| --- | --- |
| openai/gpt-4.1-mini | HTTP404：Requested model is not supported by /v1/responses |
| openai/gpt-4.1 | HTTP502：No provider available |
| google/gemini-2.5-flash-lite | 生产mapper拒绝：Responses response.completed: event follows terminal |
| qwen/qwen3-coder-plus | 生产mapper拒绝：Responses response.created: response status does not match event |
| openai/gpt-4o | HTTP404：Requested model is not supported by /v1/responses |
| mistralai/mistral-large-2512 | HTTP422，无响应正文；不猜测具体原因 |
| x-ai/grok-4.2-fast-non-reasoning | 通过：EOF后finish=stop、标记匹配；inputTokens=199、outputTokens=6、totalTokens=205；uncached=71、cacheRead=128、cacheWrite=0，observed read=true/write=false |

另用2个直接SDK请求核对Gemini/Qwen事件，只在内存收流，再交原mapResponsesStream重放：Gemini出现两个response.completed，两个response对象JSON并不相等，原mapper仍拒绝；Qwen的response.created携status=queued，随后in_progress与唯一completed，原mapper仍拒绝。只输出事件类型、状态、item类型/phase及错误分类，没有保存原始正文。这两条是诊断，不算生产adapter成功，也不能据此断言所有ZenMux Responses路由不兼容。

### Grok工具往返探测

同一模型/端点/参数，用生产core/llm-client/streaming.ts的streamChatCompletion包装实际Responses provider，SDK和llm-client的maxRetries均设为0；两轮分别45秒超时。工具名migration_probe，参数schema要求唯一字符串value，additionalProperties=false。合成提示要求只调用一次，value为fixture；收到工具结果后仅回复其中verification。

1. 完整收第一轮至EOF，断言streamStopReason=provider_finished、finishReason=tool_calls，且只有一个解析后的migration_probe调用，参数恰为{value:"fixture"}，解析call id与completeMessage.tool_calls[0].id相同。
2. 通过这些断言后才生成随机校验值，执行一次无外部副作用的本地fixture函数；将第一轮completeMessage及带匹配tool_call_id的tool结果加入第二轮messages。初始提示不含此随机值。
3. 完整收第二轮至EOF，断言provider_finished、finishReason=stop、无后续工具调用，最终文本trim后恰为工具返回值。全部断言通过，命令exit0；没有用isComplete单独授权工具。

| 请求 | 结束原因 | input / output / total | uncached / cacheRead / cacheWrite | observed read / write |
| --- | --- | --- | --- | --- |
| 工具发起 | tool_calls | 304 / 11 / 315 | 112 / 192 / 0 | true / false |
| 结果回传后回答 | stop | 341 / 18 / 359 | 85 / 256 / 0 | true / false |

这证明实际Responses adapter与现有llm-client能完成此合成工具往返。工具执行由诊断脚本控制，**未经过生产lifecycle调度器、SQLite或构建产物入口，不是完整T12/T10**。usage仅记录现有归一结果，cacheRead出现不代表cache策略、统计对齐或效果验收完成。

本次替代筛选共11个逻辑生成请求（7个文本候选+2个事件诊断+Grok工具2轮），另有1次公开模型列表GET；无自动重试。文本/事件诊断命令捕获各路径错误，exit0只说明探测结束；通过与否以上表及实际断言为准。失败调用不保证免费，未获取完整账单。凭据只在请求进程内从.env加载，未输出、提交或写入文档；只发送合成fixture。

结论：按用户授权将Grok选为当前受限Responses验收模型，替换原两条必过Responses行，不扩大生产能力或增加模型白名单。下一步补生产lifecycle文本与工具T12证据，再核对本地门和独立审查；通过之前不合并improve-2。improve-3仍未实施，改造后须重新跑它自己的三协议矩阵，不能复用本节预检当作改造后的通过记录。

## 5.12 收尾门禁与生产lifecycle真实验收（2026-09-13）

生产基线a18290f3未改，新增独立key-gated验收文件tests/smoke/responses-migration.real.e2e.test.ts。它使用生产factory→adapter→llm-client→Lifecycle、context manager、message manager和真实tool scheduler；memory/system/tokenCounter依赖使用合成fixture，message store为内存实现。不是SQLite重启、构建产物入口或整个迁移完成的证明。

最新本地门：13:46启动pnpm preflight，exit0；format/lint/typecheck/test/build全过，313 files / 3196 tests passed，5 files / 16 tests skipped。CLI packaging-smoke本次通过，未绕过。新real.e2e文件被默认配置排除，另行显式执行；不把默认排除/skip计为live成功。

实际执行命令（13:52）：

```sh
OHBABY_RUN_REAL_RESPONSES_MIGRATION=1 OHBABY_REAL_MIGRATION_PROTOCOL=openai-responses node --env-file=.env --input-type=module <<'JS'
import { startVitest } from 'vitest/node';
const files = ['tests/smoke/responses-migration.real.e2e.test.ts'];
const ctx = await startVitest('test', files, {
  include: files, exclude: ['**/node_modules/**', '**/dist/**'], watch: false,
});
if (!ctx) process.exitCode = 1;
JS
```

显式include/exclude是必要的：默认vitest.config.ts排除.e2e，vitest.e2e.config.ts只含packages路径。命令确实发现并执行1 file / 2 tests，exit0，测试耗时6.6秒。另验证默认未启用时4个测试skip，启用但缺key时凭据测试明确失败、模型行不执行。没有通过passWithNoTests掩盖发现失败。

| 项 | 实际结果 |
| --- | --- |
| 模型/路径 | x-ai/grok-4.2-fast-non-reasoning；3次均为/api/v1/responses，store=false，无Chat回退 |
| 独立文本 | 1请求；随机标记匹配；finishReason=stop，terminalReason=completed |
| 工具往返 | 2请求；真实scheduler执行migration_probe恰好1次；callId关联、结果进入下一请求、最终回复匹配运行时生成的随机工具结果；stop/completed |
| 文本usage | input240 / output27 / total267；uncached112 / read128 / write0；observed read=true/write=false；usageComplete=true |
| 工具两步累计usage | input633 / output31 / total664；uncached249 / read384 / write0；observed read=true/write=false；usageComplete=true |
| 请求预算 | 实际HTTP3次、provider调用3次；SDK maxRetries=0；第4次发网前硬停，首次HTTP失败后也不再发网 |

Lifecycle当前没有对外retry覆盖参数，因此没有为了测试新增生产配置，也不宣称llm-client重试已关闭；预算守卫覆盖实际HTTP次数。maxSteps=3仅给正常两步往返留余量，避免最后一步强制finalization改变请求；实际工具路径仍限定2请求。原始请求仅在测试内存用于断言；输出只保留合成结果与安全usage摘要，不打印密钥、鉴权头或真实用户资料。

独立收尾代码审查：spec与quality均未发现新阻断；EOF后释放terminal、工具授权、默认Chat、observe-only保护与02对齐。测试脚本另作独立审查。本轮技术验收现为通过修订后的受限ZenMux门，不代表原Luna/DeepSeek Responses、直连官方API、原生续接、计量/cache对齐已完成。这些限制继续登记后续；improve-3必须改造后重新验收。

脚本审查补强：将200响应后的流迭代异常也接入失败锁；工具回传从JSON子串检查改为按原生function_call/function_call_output结构精确关联callId与output，并检查执行前两次请求不含运行时校验值。独立子代理复核确认两项均解决、修改区无新阻断。13:55用同一命令复验，exit0，1 file / 2 tests passed，耗时6.8秒，实际HTTP3次/provider3次，工具执行1次、最终stop/completed。最新文本usage为input243/output30/total273（uncached115/read128/write0）；工具两步为636/34/670（uncached252/read384/write0），均usageComplete=true、observed read=true/write=false。收尾两次运行合计6个生成请求，无重试；第一轮保留旁证，第二轮是修订脚本的最终live证据。
