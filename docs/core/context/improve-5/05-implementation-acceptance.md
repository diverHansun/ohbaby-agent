# 5. improve-5 实施与验收记录

> 验收日期：2026-08-24
> 实施分支：`codex/improve-5`
> 合并/推送：均未执行
> 总结：improve-5 代码、测试设施与 compiled Web 主链路已完成；完整仓库门因 packaging 的本机 Node TLS 阻断与既有 format baseline 只能条件验收；真实 provider cache 三个外部门因本机无 credential 明确记为 `skip (partial evidence)`，不能宣称真实服务 cache hit 已验证。

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
| `pnpm run test:unit` | 221 files；1994 passed，2 skipped |
| `pnpm run test:contract` | 14 files；244 passed |
| `pnpm run test:smoke` | 4 files / 12 tests 全部被发现并因未启用外部门显式 skip |
| `pnpm exec vitest run --config vitest.e2e.config.ts` | 2 files passed、3 files external skipped；5 passed、5 skipped；subagent 3/3 passed |
| 排除外部安装 smoke 的全仓 Vitest | 291 files passed、5 skipped；2625 passed、16 skipped |
| `pnpm run lint` | pass |
| `pnpm run typecheck` | pass |
| `pnpm run build` | pass；CLI、agent、server、SDK 与 Web compiled assets 全部生成 |
| improve-5 文档与 Batch E 改动文件 Prettier | pass |

contract 首次与 unit/integration 并行执行时，一个既有 TUI 输入时序用例抖动失败；该用例单独复跑通过，随后完整 contract 244/244 通过，因此归类为并发资源抖动，不是保留失败。

### 5.4.2 明确的环境/基线例外

1. `pnpm run test:integration` 中 45 files / 294 tests 通过；唯一 `tests/integration/cli/packaging-smoke.integration.test.ts` 两次在 `npm install` 阶段 180 秒超时。诊断用 Node 24 直接 `fetch(https://registry.npmjs.org/react)` 复现 `ECONNRESET before secure TLS connection`，而 `curl` 返回 HTTP 200；提高 npm sockets 后仍超时。该用例依赖测试内 Node `fetch` 代理外部 npm registry，属于本机 Node TLS/网络阻断，不是构建或 compiled assets 失败。未修改既有 packaging 测试来制造假绿。
2. 仓库级 `pnpm run format:check` 报告 43 个**未被本批修改**的既有文件不符合当前 Prettier；本批没有批量重写无关文件。improve-5 文档与所有 Batch E 新增/修改文件已定向检查通过。
3. 因完整 `pnpm test` 会再次调度上述 packaging smoke，确认它等待同一 packaging lock 后终止了重复执行；使用排除该单一外部安装用例的全仓 Vitest 取得 2625/2625 本地可执行测试通过证据。

这些例外意味着“本批功能与生产 E2E 通过”，但不能把仓库当前状态描述为无条件的全量 clean CI。

## 5.5 G8 real cache 结果

执行 `pnpm run test:smoke:real` 与 `pnpm run test:cache:real`：

| 子门 | 结果 | 原因 |
|------|------|------|
| OpenAI-compatible cache read | skip | 缺 `OPENAI_API_KEY / DEEPSEEK_API_KEY / ZAI_API_KEY / ZHIPU_API_KEY` |
| Anthropic creation/read + child | skip | 缺 `ANTHROPIC_API_KEY` |
| M13 MCP epoch recovery | skip | 缺 OpenAI-compatible credential |
| Aggregate | `skip (partial evidence)` | 无失败，但没有真实 provider read 证据 |

协议 contract、runner 行为、keyed/keyless projection、真实 MCP transport 和 usage evidence 均已本地验证；真实 provider `tool_choice`、cache creation/read 与 M13 read **未在本机执行**。G8 不能记为 pass。

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
| G8 external cache | skip（partial evidence） | 三门均缺 credential，未宣称真实命中 |
| G9 文档/范围 | pass | README、01、02、04、05 与实现一致；后续联合回归明确未执行 |

## 5.8 终审与 SWE 改动面评估

三路只读子代理终审均为“无 blocker”：

- 架构/E2E：关闭了非 `finally` cleanup、profile credential 未走 `.env`、stale `dist`、`OHBABY_STORAGE_ROOT` 未隔离等问题。
- 协议/cache：关闭了 keyless projection `digest(undefined)`、前缀不足、Anthropic child 单轮、M13 假 MCP/超请求上限/错误 usage 合并等问题。
- 测试：关闭了任意 Enter UI 假绿、runner exit code 未测、provider tool 自然服从不确定、验收状态文档缺失等问题。

按 SWE “管理复杂度、缩短反馈回路、测试作为设计探针”的原则，本批结论如下：

- **复杂度下降**：vendor cache 字段被限制在 adapter；ContextManager 只认 provider-neutral request；`PreparedModelRequest` 消除了 measurement/send 的平行状态，属于删除偶然复杂度而非增加抽象。
- **依赖边界清晰**：capability resolver 决定 wire 策略，usage normalizer 决定观测语义，lifecycle 只聚合规范化结果；没有引入第三种 interface provider 或跨 session 分析库，符合 KISS/YAGNI。
- **可测试性增强**：纯 runner state/exit 函数、provider contracts、主/子代理 integration、真实 SDK transport smoke 与少量 compiled Web E2E 形成测试金字塔；外部 credential 与普通 CI 解耦。
- **有意识的权衡**：real-cache harness 使用 `chars / 4` 做保守 fail-fast，并允许按模型覆盖阈值；test-only fetch wrapper 只在串行 gate 子进程注入 `tool_choice`。两者降低外部模型非确定性，但不等同精确 tokenizer 或生产 caller 自带 tool-choice。
- **保留风险**：本机未验证真实 provider cache read；real smoke 的 child 使用 production core scope/path，但不是完整 `SessionSubagentHost` 编排；compiled E2E runner 较长，后续可在不弱化失败清理的前提下提取独立 helper/unit tests。

本批没有发现需要再引入产品抽象或扩大范围的实现 blocker；G7 仍受 §5.4.2 的环境/基线验收条件约束，G8 仍待有凭据环境补证。

## 5.9 明确未执行的后续工作

用户计划在 improve-5 交付后，对 improve-4、improve-4.1、improve-5 的 context 相关实现做全方位联合回归。该工作**不属于本批**，本记录没有把现有定向兼容测试冒充为后续回归完成。
