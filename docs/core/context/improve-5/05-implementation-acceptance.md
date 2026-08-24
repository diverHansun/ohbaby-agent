# 5. improve-5 实施与验收记录

> 验收日期：2026-08-24
> 实施分支：`codex/improve-5`
> 合并/推送：均未执行
> 总结：improve-5 代码、测试设施与 compiled Web 主链路已完成；完整仓库门因 packaging 的本机 Node TLS 阻断与既有 format baseline 只能条件验收；ZenMux `deepseek/deepseek-v4-flash` 已补齐 OpenAI-compatible、Anthropic、M13 与真实 Web 证据，G8 由 skip 更新为 pass；Batch G 又关闭了独立复测指出的可复现覆盖与 summary 投影缺口。

## 5.1 交付结果

本批完成了三条用户目标，并保证主代理、子代理及辅助 caller 不走旁路：

1. **LLM 请求信息对齐和完善**：建立 inclusive `TokenUsage`、可选 `inputBreakdown + observed`、provider-neutral purpose、capability resolver、scoped cache identity 和统一 `PreparedModelRequest`。
2. **cache 命中信息获取**：OpenAI-compatible、Anthropic、DeepSeek/智谱兼容 usage 在 adapter 边界归一化，随后无损穿过 lifecycle、run worker/bridge 与 assistant metadata；缺字段保持 unavailable，不伪造 0%。
3. **cache 命中率提升**：稳定 system/tool prefix，runtime context 固定在 initiating user，删除 environment 的重复 `Available tools`，按 `sessionId + contextScopeId` 生成 key，并用 scope-owned tool sequence/epoch 控制 MCP 动态加载后的单次失效。

此外，improve-4.1 遗留的 `additionalMessages` 手工双传已收拢；context summary/session title 明确使用辅助 purpose；scope dispose、UI/title/transcript 隐私投影和主/子代理隔离均补齐测试。

## 5.2 分批提交

| 批次 | Commit | 结果 |
|------|--------|------|
| 规划冻结 | `29ac10d` `docs(context): finalize improve-5 implementation plan` | 对齐用户七项确认、协议矩阵与分批门禁 |
| A · usage | `e2bb783` `refactor(llm): normalize cache-aware token usage` | inclusive usage、observed、stream/retry、aggregate、metadata/calibration |
| B · capability | `f3b3a89` `feat(llm): add scoped prompt cache strategies` | policy/purpose、endpoint capability、scoped key、OpenAI/Anthropic wire |
| C · request | `cd60c28` `refactor(context): unify prepared model requests` | measurement/projection/send 共用 immutable request，收拢 tail messages |
| D · prefix/MCP | `bf89962` `feat(context): stabilize prompt prefixes and tool epochs` | runtime user snapshot、删除重复 tools 文本、scope tool epoch/cleanup |
| E · 系统验收 | `test(context): complete improve-5 system verification` | 本文、real-cache runner/fixtures、compiled Web E2E；SHA 见最终交付消息 |
| F · ZenMux 真实补证 | `test(context): verify ZenMux prompt cache end to end` | 双协议 profile、真实 cache read/M13、真实 provider Web/context UI；SHA 见最终交付消息 |
| G · 反馈闭环 | `fix(context): keep runtime metadata out of summaries` | U03/PFX06/A08 专测、summary model-only 投影与验收映射校正；SHA 见最终交付消息 |

所有提交都位于临时分支；没有 merge 或 push。

## 5.3 Batch E 新增验收能力

- `scripts/real-cache-runner.mjs` 与 `scripts/run-real-cache-smoke.mjs`：三个独立 gate 串行执行，配置/测试失败返回非零；无 credential 逐门 skip。
- `tests/smoke/real-cache-harness.ts`：生产 `createLLMClient → ContextManager → Lifecycle → adapter → scheduler` 链路；稳定前缀联网前 fail-fast；test-only wire `tool_choice` 强制本地 fixture tool；真实 MCP SDK linked transport、`McpClient/McpManager` discovery、admission、`select_tools` 和 epoch 恢复。
- 脱敏 evidence 写到 `.ohbaby/test-evidence/improve-5/real-cache/`：只含 request digest/key presence+fingerprint/strategy/scope/tool epoch 与 normalized usage，不含 credential、完整 key、prompt 或原始 request body。
- `scripts/run-compiled-web-e2e.mjs`：每次先 build，隔离 HOME/XDG/AppData/OHBABY_HOME/DB/storage/workspace，以 profile `.env` 正常加载 fixture key；统一 `finally` 验证 stop/status/PID/pid-lock/动态端口/provider cleanup。
- `ohbaby serve --no-open`：保持默认自动打开行为兼容，同时允许自动化环境无系统浏览器副作用启动 compiled Web。

## 5.4 测试结果

### 5.4.1 已通过

| 命令/门 | 结果 |
|---------|------|
| Batch E targeted runner/harness/serve | 22/22；其中最终 runner+harness 7/7、serve 15/15 |
| Batch F ZenMux resolver/runner/harness | 12/12；包含双协议 credential、reasoning 映射与 URL/Request body length 回归 |
| `pnpm run test:unit` | 221 files；2001 passed，2 skipped |
| `pnpm run test:contract` | 14 files；245 passed |
| `pnpm run test:smoke` | 4 files / 12 tests 全部被发现并因未启用外部门显式 skip |
| `pnpm exec vitest run --config vitest.e2e.config.ts` | 2 files passed、3 files external skipped；5 passed、5 skipped；subagent 3/3 passed |
| 排除外部安装 smoke 的全仓 Vitest（Batch F 基线） | 291 files passed、5 skipped；2625 passed、16 skipped |
| `pnpm run lint` | pass |
| `pnpm run typecheck` | pass |
| `pnpm run build` | pass；CLI、agent、server、SDK 与 Web compiled assets 全部生成 |
| improve-5 文档与 Batch E/F/G 改动文件 Prettier | pass |

contract 首次与 unit/integration 并行执行时，一个既有 TUI 输入时序用例抖动失败；该用例单独复跑通过，随后完整 contract 通过；Batch G 再次串行复跑为 245/245，因此归类为并发资源抖动，不是保留失败。

### 5.4.2 明确的环境/基线例外

1. `pnpm run test:integration` 的 Batch F 全套运行中，293 个测试通过；`tests/integration/cli/packaging-smoke.integration.test.ts` 在外部 `npm install` 阶段达到 240 秒超时，另一个 daemon resync 用例在同轮高负载下达到 10 秒时序上限。daemon 文件随后隔离复跑 44/44 通过；Batch G 排除唯一外部安装 smoke 后，完整本地 integration 为 45 files / 295 tests 全通过。此前诊断用 Node 24 直接 `fetch(https://registry.npmjs.org/react)` 复现 `ECONNRESET before secure TLS connection`，而 `curl` 返回 HTTP 200；提高 npm sockets 后仍超时。packaging 用例依赖测试内 Node `fetch` 代理外部 npm registry，属于本机 Node TLS/网络阻断，不是构建或 compiled assets 失败。未修改既有 packaging 测试来制造假绿。
2. 仓库级 `pnpm run format:check` 报告 43 个**未被本批修改**的既有文件不符合当前 Prettier；本批没有批量重写无关文件。improve-5 文档与所有 Batch E/F/G 新增/修改文件已定向检查通过。
3. 因完整 `pnpm test` 会再次调度上述 packaging smoke，确认它等待同一 packaging lock 后终止了重复执行；使用排除该单一外部安装用例的全仓 Vitest 取得 2625/2625 本地可执行测试通过证据。

这些例外意味着“本批功能与生产 E2E 通过”，但不能把仓库当前状态描述为无条件的全量 clean CI。

## 5.5 G8 real cache 结果

首次无 credential 执行时三门为 `skip (partial evidence)`；2026-08-24 使用用户授权的 ZenMux credential、同一模型 `deepseek/deepseek-v4-flash` 和官方双协议端点再次执行 `pnpm run test:cache:real`。credential 未写入仓库、evidence 或文档，测试结束后已从进程与临时 profile 清除。

| 子门 | 结果 | 脱敏证据 |
|------|------|------|
| OpenAI-compatible cache read | pass | `https://zenmux.ai/api/v1`；最终复验 follow-up `input=5373, cacheRead=5120, uncached=253` |
| Anthropic primary + child read | pass | `https://zenmux.ai/api/anthropic`；primary 与 child 均观测到 4096/5120 cache read |
| M13 MCP epoch recovery | pass | 4 个请求、tool epoch `0,0,1,1`；epoch 1 仍读到 4096/5120 |
| Aggregate | pass | 三个串行外部门全部退出 0，脱敏 evidence 已落盘 |

该模型默认 thinking mode 拒绝 named/required `tool_choice`。harness 按 ZenMux 官方双协议映射，仅对首个强制工具请求关闭 reasoning；修复了由测试 wrapper 重写 body 却保留旧 `Content-Length` 导致的 Undici 发送失败。真实 Web 仍使用生产默认 thinking mode，不依赖该测试注入。

ZenMux/DeepSeek 的 Anthropic 协议转接采用隐式 cache 写入：一次 cold 复验中首请求的 creation/read 字段均明确出现但数值为 0，随后 primary 读到 5120、child 读到 4096/5120；因此 smoke 对 ZenMux 验收“字段已观测 + 后续非零 read”，不把首请求零值误报成 write。official Anthropic 直连仍保留首请求 creation/read 的严格断言。

## 5.6 compiled Web E01–E07

执行 `pnpm run test:e2e:compiled-web`。该命令从当前分支重新 build，并由 runner 启动动态端口的 isolated `ohbaby serve --no-open`。验收 URL、PID、session ID 与临时目录均只用于本次运行，不在文档保存完整值。

实际 browser/DOM 观察：

- E01：页面 title 为 `ohbaby`，workspace/fake-model/idle bootstrap 正常；served HTML asset basenames 与本次 `dist/web` 一致。
- E02/E03：首个用户消息可见；真实 `read fixture.txt` 先进入 running、后进入 completed；最终文本 `OHBABY_COMPILED_WEB_TOOL_OK` 刷新前后各只有 1 个。
- E04：同一 URL/session 发送 `OHBABY_COMPILED_WEB_FOLLOWUP`，最终 `OHBABY_COMPILED_WEB_FOLLOWUP_OK` 只有 1 个。
- E05：刷新后 URL/session identity 不变，5 条持久化消息恢复；tool panel 为 completed；sidebar title 更新为 `Compiled E2E fixture`；只有 1 个 session；页面/标题均不含 runtime marker、fixture sentinel 或 `<environment_context>`。
- E06：`subagent.e2e.test.ts` 3/3 通过，覆盖 child scope、parent return 和清理。
- E07：runner 在真正 `finally` 内完成同-env stop/status、PID、pid lock、动态端口与 provider cleanup。

浏览器实际读取并提交给 runner 的结构化证据：

```json
{"activeSessionStable":true,"followupFinalAfterRefresh":1,"followupFinalBeforeRefresh":1,"followupUserAfterRefresh":1,"runtimeMarkersVisible":false,"titleContainsRuntimeMarker":false,"toolFinalAfterRefresh":1,"toolFinalBeforeRefresh":1,"toolPanelCompleted":true}
```

runner 脱敏证据：

```text
E2E_BACKEND_PASS {"keyPresent":true,"keyStable":true,"requestCount":3,"runtimePartCounts":[1,1,2],"titleRequests":1,"toolResultConsumed":true}
E2E_CLEANUP_PASS {"finalStatus":"stopped","pidReleased":true,"portReleased":true}
```

本地 scripted endpoint 的 synthetic `cached_tokens` 只证明 normalization、metadata 与 UI 生产链路，不是 G8 的真实服务 cache hit。

### 5.6.1 真实 ZenMux compiled Web 补证

使用本次 `pnpm build` 产物、隔离 HOME/XDG/AppData/OHBABY_HOME/DB/storage/workspace 和动态端口启动 `ohbaby serve --no-open`；profile 指向 ZenMux OpenAI-compatible 官方端点，模型 context window 显式配置为 1,000,000。真实浏览器完成两轮对话并刷新：

- 两个用户 prompt 与两个精确模型响应均唯一可见；刷新后 4 条消息和同一 session 恢复。
- 第一轮 provider usage：`input=6819, cacheRead=0, uncached=6819, output=39`。
- 第二轮 provider usage：`input=6983, cacheRead=6144, uncached=839, output=14`。
- Web 顶栏在第二轮及刷新后均显示约 `7.1k / 1m`，与 inclusive input/context projection 一致；它没有错误显示成仅约 0.8k 的 uncached 占用。粗略占用约为 0.71%。
- 页面 title/模型/idle 状态正确，无 framework overlay、console error/warn；runtime environment part 未出现在 transcript。
- 结束后使用同一隔离环境 stop，状态为 stopped，captured PID 已释放且无匹配的 serve 进程；临时 profile/数据库被定向删除，进程凭证已清除。

## 5.7 发布门结论

| 门 | 结论 | 证据摘要 |
|----|------|----------|
| G1 usage | pass | inclusive usage/observed/retry/aggregate/calibration tests |
| G2 capability | pass | endpoint matrix、policy、wire contract、auxiliary observe-only |
| G3 request identity | pass | scoped key + immutable `PreparedModelRequest`，measurement/send 同源 |
| G4 prefix | pass | initiating-user runtime part、删除 `Available tools`、UI-hidden projection |
| G5 tools/MCP | pass | M01–M12 本地门、真实 SDK transport、scope sequence/cleanup |
| G6 agent parity | pass | primary/subagent integration、metadata、summary/purpose/scope 隔离 |
| G7 system E2E | conditional / 未满足完整仓库门 | compiled Web E01–E07 pass；packaging Node TLS 与既有 format baseline 阻止无条件 G7 pass，见 §5.4.2 |
| G8 external cache | pass | ZenMux OpenAI-compatible、Anthropic primary/child 与 M13 均有真实 cache read |
| G9 文档/范围 | pass | README、01、02、04、05 与实现一致；后续联合回归明确未执行 |

## 5.8 终审与 SWE 改动面评估

三路只读子代理终审均为“无 blocker”：

- 架构/E2E：关闭了非 `finally` cleanup、profile credential 未走 `.env`、stale `dist`、`OHBABY_STORAGE_ROOT` 未隔离等问题。
- 协议/cache：关闭了 keyless projection `digest(undefined)`、前缀不足、Anthropic child 单轮、M13 假 MCP/超请求上限/错误 usage 合并等问题。
- 测试：关闭了任意 Enter UI 假绿、runner exit code 未测、provider tool 自然服从不确定、验收状态文档缺失等问题。

Batch F 再由同三路子代理做只读终审，最终同样为 0 blocker / 0 major；审查推动补齐 URL 与 `Request` 两条 stale `Content-Length` 回归、把 cold zero 例外收窄为 exact DeepSeek 模型级 capability，并对齐 04 中 ZenMux OpenAI-compatible 网关门。该批没有修改 production `packages/` / `apps/` 文件，tracked diff 与脱敏 evidence 均未发现 credential、完整 prompt 或完整 cache key。

Batch G 继续由同三路子代理只读终审，最终为 0 blocker / 0 major / 0 minor。架构审查曾指出 A08 重算 usage 时引用外部 tools fixture，可能漏掉最终 request 丢 schema 的回归；修复后改为分别深比较并消费 primary/child 各自的 `request.messages + request.tools`，复审确认关闭。协议审查推动把 keyed prefix 用例收窄命名为 official OpenAI，避免与 ZenMux implicit/无 key 混淆；测试/文档审查逐项确认 U03/U08/C20/R01–R02/PFX06/PFX09/M08/A08 的证据与条件验收口径一致。tracked diff 未发现 credential、Authorization、完整真实 cache key 或原始 evidence。

按 SWE “管理复杂度、缩短反馈回路、测试作为设计探针”的原则，本批结论如下：

- **复杂度下降**：vendor cache 字段被限制在 adapter；ContextManager 只认 provider-neutral request；`PreparedModelRequest` 消除了 measurement/send 的平行状态，属于删除偶然复杂度而非增加抽象。
- **依赖边界清晰**：capability resolver 决定 wire 策略，usage normalizer 决定观测语义，lifecycle 只聚合规范化结果；没有引入第三种 interface provider 或跨 session 分析库，符合 KISS/YAGNI。
- **可测试性增强**：纯 runner state/exit 函数、provider contracts、主/子代理 integration、真实 SDK transport smoke 与少量 compiled Web E2E 形成测试金字塔；外部 credential 与普通 CI 解耦。
- **有意识的权衡**：real-cache harness 使用 `chars / 4` 做保守 fail-fast，并允许按模型覆盖阈值；test-only fetch wrapper 只在串行 gate 子进程注入 `tool_choice`。两者降低外部模型非确定性，但不等同精确 tokenizer 或生产 caller 自带 tool-choice。
- **保留风险**：本轮真实 provider 是 ZenMux 双协议网关，未等同验证 OpenAI/Anthropic 官方直连；real smoke 的 child 使用 production core scope/path，但不是完整 `SessionSubagentHost` 编排；compiled E2E runner 较长，后续可在不弱化失败清理的前提下提取独立 helper/unit tests。

本批没有发现需要再引入产品抽象或扩大范围的实现 blocker；G7 仍受 §5.4.2 的环境/基线验收条件约束，G8 的 ZenMux 目标已补证通过。

## 5.9 明确未执行的后续工作

用户计划在 improve-5 交付后，对 improve-4、improve-4.1、improve-5 的 context 相关实现做全方位联合回归。该工作**不属于本批**，本记录没有把现有定向兼容测试冒充为后续回归完成。

## 5.10 独立复测（2026-08-24 晚）

> 撰写时机：实施完成后的独立验收会话。该会话没有改产品代码；对照 02/04 与当时 `codex/improve-5` HEAD `ba59287` 分批复跑测试，并由只读子代理审查验收 ID 覆盖。随后 Batch G 对反馈逐项复现、补测和校正本节。
> 本轮结论：**本地实现门通过（条件验收）**。targeted tests 与 lint/typecheck/unit/contract/integration（排除 packaging）全绿；真实缺口已在 Batch G 关闭，若干原 `partial` 属已有行为覆盖的映射误判；G7 compiled Web 与 G8 真实 cache 在独立复测会话未重跑，仍引用 §5.5/§5.6 的已完成证据。

### 5.10.1 分批 commits

与 §5.2 一致，全部仍是 HEAD 祖先：

| 批次 | Commit |
|------|--------|
| 规划冻结 | `29ac10d` |
| A · usage | `e2bb783` |
| B · capability | `f3b3a89` |
| C · request | `cd60c28` |
| D · prefix/MCP | `bf89962` |
| E · 系统验收 | `1ad4f26` |
| F · ZenMux 补证 | `ba59287` |
| G · 反馈闭环 | 本提交（SHA 见最终交付消息） |

### 5.10.2 分批 targeted tests（本轮实跑）

| 批次 | 命令范围 | 结果 |
|------|----------|------|
| A | token-usage / lifecycle / metadata / roundtrip / auxiliary isolation / stream-bridge / llm-client / openai-compatible / anthropic / context-window-usage | 11 files，102 passed |
| B | prompt-cache / prompt-cache-wire.contract / llm config validation+writer+manager+integration / title-generator / prompt-context | 8 files，125 passed |
| C | prepared-request.contract / context manager / runner / run-manager / instance.integration / context-improve-4-1 / lifecycle-tool-scheduler | 7 files，107 passed |
| D | environment / assembler / tool-sequence / dynamic-tool-menu / composition / persistent-store / title-fallback / serializer.integration / context-subagent-scope / run-stream-adapter / ui-inprocess.contract | 11 files，210 passed |
| E/F 本地 | real-cache-runner + harness unit、serve-awareness、`test:smoke`、`subagent.e2e.test.ts` | unit 14 passed；smoke 12 skipped（无 env gate）；e2e 3 passed |
| G | token-usage / prompt-cache-wire / prompt-context / serializer / context-subagent-scope | 5 files，46 passed；修复静态扩展字段类型与 A08 request-tools 证据后复验 |

Batch D 的 `ui-inprocess.contract.test.ts` 在沙箱里会因临时目录 `git init` 被拦截出现 5 条假失败；关闭沙箱后 107/107 通过。后续复测该文件须允许 git。

### 5.10.3 仓库门（本轮实跑）

| 命令 | 结果 |
|------|------|
| `pnpm run lint` | pass |
| `pnpm run typecheck` | pass |
| `pnpm run test:contract` | 14 files，245 passed |
| `pnpm run test:unit` | 221 files；2001 passed，2 skipped（`ohbaby-home.unit.test.ts`） |
| integration 排除 `packaging-smoke.integration.test.ts` | 45 files，295 passed |
| `pnpm run test:smoke` | 4 files / 12 tests 全部 skip（无凭据/gate） |
| G8 `test:cache:real` | **本轮未执行**。当前环境 `ZENMUX_CONFIGURED=no`；沿用 §5.5 已落盘的 ZenMux evidence，不把未重跑写成新的 pass |
| G7 compiled Web `test:e2e:compiled-web` | **本轮未执行**。该 runner 需要人工浏览器 + stdin JSON；沿用 §5.6 记录 |

packaging smoke 与仓库级 `format:check` 的既有基线例外仍以 §5.4.2 为准，本轮未为制造假绿去改那些用例。

### 5.10.4 对照 04 的验收 ID 映射与 Batch G 处置

独立复测给出的条目分成三类：真实测试缺口、真实投影缺口，以及已经存在行为证据但映射时遗漏。Batch G 只为前两类补实现/测试；第三类直接校正文档，不为了验收编号重复制造同义用例。

| 批次 / ID | 映射 | 说明 |
|-----------|------|------|
| A · U03 | **covered** | 新增「仅 nested `cached_tokens > 0`、无 write」精确 fixture：read 被观测，write 保持未观测，三分量之和等于 input |
| A · U08 | **covered（共享解析器）** | 智谱与 OpenAI-compatible 共用 provider-neutral nested parser；U03 的正例直接覆盖该 wire shape，避免按 provider 名复制同一 fixture |
| A · U21 | covered，落点不同 | inclusive calibration 在 `lifecycle.unit.test.ts`，不在 `context-window-usage.unit.test.ts` |
| A · §4.3 统一 invariant helper | **covered** | `expectUsage` 统一验证整数/非负、`total=input+output`、breakdown 总和与命中率不超过 1 |
| B · C16 | **covered（跨层证据）** | prompt-cache unit 已验证 append、compact、tool-menu 变化时 scoped key 稳定；PFX06 与 tool-sequence tests 再证明变化落在 provider payload prefix/epoch，而不是 identity key |
| B · C20 | **covered（原映射误判）** | `ui-inprocess.contract.test.ts` 已从已有 `promptCache: disabled` 执行 `connectModel`，断言写回仍为 disabled，并由 `reloadLLMConfig` 再读确认 |
| C · R01/R02 | **covered（原映射误判）** | manager unit 覆盖普通、tail、mask、compact/remeasure；`context-improve-4-1.integration.test.ts` 深比较发送的 `{messages, tools}` 与 `onRequestMeasured` |
| D · PFX06 | **covered** | 在既有 Anthropic contract 之外新增 official OpenAI Chat Completions 两步工具请求，深比较 system、tools 与 prior messages 前缀并验证 key 稳定；ZenMux auto 仍由相邻矩阵断言不发送 key |
| D · PFX09 | **covered / 当前 export N/A** | live UI、fallback title、持久化已有过滤；context summary 现显式 `includeModelContext: false`。AI title 只消费经脱敏的 initiating prompt，从不调用 `serializeHistory`；仓库当前没有用户 session-export 产品面，不虚构接口 |
| D · M08 | **covered（行为级）** | 现有 scope/epoch 用例已覆盖 schema/可见集合变化、工具移除、survivor 顺序与 epoch 递增；权限撤销或 MCP 断开最终都投影为同一「可见集合变化」输入 |
| D · A08 | **covered** | 新增同一 integration 中 primary 与 child 各自触发 compact，校验 scope 隔离、summary 不串线，并用各自最终 `{messages, tools}` 重算 usage |

对抗性审查（04 §4.11）现在可回答：Q1/Q3/Q5/Q7/Q9/Q11/Q12/Q13 有自动化证据；Q8 引用 §5.5 已完成的真实 read，本次反馈闭环没有重新消耗外部凭据；Q14 引用 §5.6 已完成的 compiled Web 证据，本轮未把历史证据伪装成新复验。

### 5.10.5 SWE 改动面评估（独立会话）

大白话：improve-5 把「数字怎么算、字段怎么发、前缀怎么稳」拆开了，复杂度是下降的，不是又堆了一层框架。本轮复测没有跑红，也不该把映射缺口说成实现坏了。

| 发现 | 严重性 | SWE 依据 | 建议 |
|------|--------|----------|------|
| vendor cache 字段停在 adapter，ContextManager 只认中性 request | 正面 | 02 耦合方向 / 信息隐藏 | 保持；后续 UI 命中率必须读 `observed`，不能直接用 `cacheRead` |
| `PreparedModelRequest` 消除 measurement/send 双份状态 | 正面 | 偶然复杂度 / DRY | 保持 |
| context summary 曾把 runtime text 编入 durable summary 输入 | 已关闭 | SoC：model-only 快照可进入主模型请求，但不应进入人类/summary 投影 | 只在 summary caller 关闭 model-context；默认 serializer 仍包含它，保持主请求与 token 计量不回退 |
| 04 ID 与测试名不完全对齐 | 已校正 | 测试作为设计探针，但探针标签要能追溯需求 | 补真实缺口；对 C20/M08/R01/R02 引用已有行为证据，不复制测试 |
| 本轮未重跑 G8 / compiled Web | 条件验收 | 外部依赖与人工步骤不应假装刚验过 | 有凭据后再跑 `test:cache:real`；需要发布形态时再跑 `test:e2e:compiled-web` |

Batch G 的投影改动刻意保持窄边界：默认 `serializeHistory` 仍包含 model-context，避免 compact heuristics 和 context-window 计量少算真实会发送给主模型的 runtime token；只有 durable context summary 输入显式排除该 part。用户计划的 improve-4～improve-5 联合回归仍见 §5.9，本轮未执行。
