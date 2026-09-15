# 5. 实施与验收记录

> 2026-09-15；本地分支 `codex/improve-5-cache-accounting`，基线 `114f1e512fb77a3ffef144a9886414fc37a0bd80`。最终 preflight 已通过；综合代码、规格及文档复审 PASS，仅在本地分批提交，不 merge 或 push。

## 5.1 已落地的行为

缓存累计入口由 Run 完成改为 Lifecycle 接受最终 Step usage 的位置：先执行原 aggregate，随后同步观察，再校准及处理取消、length、工具。worker 补齐真实 run/session/scope/子代理身份；backend 保留退休、dispose 与子代理过滤，复用原 session tracker。旧 cache 专用 onRunCompleted 端口已删除，正常 wait/completion/ledger 保留。

tracker 直接接收 canonical TokenUsage，不再要求 Run usageComplete。只纳入输入/输出/总量及分桶合法、输入正数、cacheRead 明确被观测的 Step。例子 `1000/read800 + 2000/read未知 + 1000/read600` 得到 `1400/2000=70%`；中间改为明确零则是 `1400/4000=35%`。后续未知不会覆盖已有累计；空累计显示 `hit —`，明确零显示 `hit 0%`。

SDK 原四字段、CLI/Web 极简显示均未扩充。模型切换、runtime 重建及压缩保留累计；删除/归档清对应桶，dispose 清全部，新进程不恢复旧统计。这里的 hit 是**已观测可信 Step 的输入 token 加权读取占比**，不是请求次数命中率、节省费用或包含所有未知请求的完整比例；按用户决定不在前端增加范围说明。

## 5.2 分批实施与审查

| 批次           | 内容                                                                 | 实际证据                                                                                         |
| -------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| A              | 最终 Step 回调、Run 身份透传、可信 tracker 与 backend 接线           | 红→绿；最终定向 10 文件 / 236 测试通过；独立 spec/quality 审查 PASS                              |
| B              | 主子归属、两活跃 sibling scope、失败 child、metadata 与 Context 隔离 | 最终定向 5 文件 / 172 测试通过；两个初审 P2 测试缺口已补齐并复审 PASS                            |
| C              | SDK/CLI/Web 回归、真实请求 harness、数值证据与文档                   | 初始消费者/runner 单元 38 通过；真实统计见 §5.4；最终综合审查 PASS，生产代码、测试及文档无阻断项 |
| C 真实发现修复 | Anthropic 晚到输入重新分类                                           | 新增 4 单元 + 1 native 集成先在旧实现失败；修复后 provider/native 3 文件 / 45 测试通过           |

A 的直接 Lifecycle 测试验证 overflow 尝试 A 曾 complete、随后抛 raw overflow，重试 B 用量不同，只记 B。真实 llm-client 会把 provider complete 后抛错包装成流中断，不走 raw overflow retry；原生集成另证这种当前 Step 不计入、此前可信 Step 保留。本轮未改变重试错误分类，不能把两种测试混称同一路径。

B 的原生 localhost SSE 使用真实 SDK/provider、llm-client、Lifecycle、ContextManager 和生产 metadata reader。两个共享 child session 的活跃 scope 使用不同用量，核对分别保存的缓存明细、独立校准和预算。真实 backend 的失败 child 先接受 input/read=10000/10000，再失败；ledger 确认失败而父桶仍为 2000/1400。正常 text/tool-only/hybrid 每 Step 至多一个 Part 携带 usage，未知不造零。无 Part 场景不新增记录、不承诺完整费用账本。

### T1–T14 的实际断言映射

下列是已执行测试文件和测试名/断言，不是另列未执行方案。路径相对仓库根；`agent/src` 指 `packages/ohbaby-agent/src`。

| T 项    | 测试文件及实际用例                                                                                                                                                                                                                                                                         | 核对内容                                                                                                   |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| T1      | `agent/src/services/interface-providers/token-usage.unit.test.ts` 的 `accepts revised Anthropic input buckets...`；Responses token-usage 单元；`tests/integration/core/usage-calibration.integration.test.ts` 的 `reclassifies late Anthropic cache usage before accepted-step accounting` | 正/零/未知与非法字段；5394/4992/121 的 native→canonical→tracker/Part/校准                                  |
| T2      | `agent/src/adapters/ui-inprocess/prompt-cache-usage.unit.test.ts` 的 `derives the share from cumulative tokens instead of averaging steps`；`tests/integration/runtime/prompt-cache-step-accounting.integration.test.ts` 的 mixed/跨 Run 用例                                              | 10%、70%、35%、60%；未知不覆盖历史                                                                         |
| T3、T4  | `agent/src/core/lifecycle/lifecycle.unit.test.ts` 的 `observes only the last accepted result when raw complete events disagree`、`isolates mutation and exceptions before calibration and output-length handling`                                                                          | 多 complete 只收最终值；拷贝及异常隔离；校准仍用原值                                                       |
| T5、T6  | 同 Lifecycle 的 `discards completed usage from an overflowing attempt and observes only retry usage`；runtime integration 的 EOF/throw/complete-then-throw、取消、length、tool failure；native usage-calibration integration                                                               | raw overflow 仅成功重试入账；此前 Step 不丢；Run 与校准配对不变；观察及重复 status 不重复累计              |
| T7、T8  | `agent/src/adapters/ui-inprocess.contract.test.ts` 的缓存 session/runtime rebuild/compact/removal/archive/dispose 用例                                                                                                                                                                     | 两 session 明确 100/60 与300/30；切模型及压缩保留；删除和迟到事件不复活；新 backend 归零                   |
| T9、T10 | runtime integration 的 `keeps accepted child usage out of parent status (child fails=%s)`；native integration 的三协议 scoped child；Lifecycle 的 primary/child tool-only/hybrid；既有 Context scope/state-machine 测试                                                                    | 成功/失败 child 均不入父桶；两活跃 scope 独立 metadata/校准；每 Step 至多一个 carrier；预算/压缩不串 scope |
| T11     | `packages/ohbaby-sdk/src/prompt-cache-usage.contract.test.ts`、`packages/ohbaby-cli/src/tui/render/status-panel.unit.test.ts`、`apps/ohbaby-web/src/ui/slashCommands.unit.test.ts`                                                                                                         | 四字段与相同整数百分比、0/未知显示；无新 UI 字段                                                           |
| T12     | `agent/src/services/interface-providers/prompt-cache-wire.contract.test.ts`、`agent/src/core/llm-client/prompt-cache.unit.test.ts`、生产 diff 审查                                                                                                                                         | cache wire/key/TTL/前缀控制与 Responses observe-only 不变                                                  |
| T13     | `tests/smoke/responses-migration.real.e2e.test.ts` 的各 profile `completes text, tool round trip and cumulative cache observation`                                                                                                                                                         | 最终基本三协议4测试通过；扩展8/9组合；真实原生数值、工具往返、Step、Part、校准、累计一致                   |
| T14     | 两次 `pnpm run preflight`、SDK/UI 定向回归、最终代码/文档独立审查、本页                                                                                                                                                                                                                    | 最终3287通过、构建完成；现行说明指向新规则，旧方案留历史                                                   |

## 5.3 真实测试发现并修复的分母问题

ZenMux/Qwen 和百炼/Qwen 的 Anthropic 流可能先报未拆分输入，再报缓存分类。真实百炼样本：start input=5341；final uncached=402、read=4992、write=0、output=121。原逐桶 max 算出 input=10333、total=10454；修复后 input=5394、total=5515。重复加到分母会明显压低 hit%，这不是缓存控制导致的未命中。

输入分桶采用最新合法存在值；保留既有“输入三字段全部显式零且此前正输入”的整组占位例外。输出单调规则保持。依据与边界见 [02 §2.9](./02-optimization-plan-and-change-scope.md#29-实施中经真实证据确认的最小归一化修复)。固定 native 样本直接核对终态数字、Step 回调、tracker、Part 和校准，不只是让两份归一化结果互相比对。

这是本批唯一新增的 provider 生产修复。system prompt、tools 投影、cache_control、key、TTL、压缩算法与 Responses observe-only 均未改；Run aggregate/usageComplete 和校准算法继续原义，但收到的 canonical 输入因此修正。

## 5.4 真实多平台结果

每个成功 profile 实际 4 次 HTTP：独立 text session 一次；另一个 tool session 的工具调用、工具返回后的回答、下一 Run follow-up 共三次。表中比例只取后者的**同 session 三个可信 Step 累计**，没有把两个 session 合并。UI 显示时仍四舍五入为整数。

| Profile                | 完整链路   | HTTP 次数 | 工具 session 纳入输入 | 缓存读取 | 累计读取占比     |
| ---------------------- | ---------- | --------- | --------------------- | -------- | ---------------- |
| zenmux-responses       | 通过       | 4         | 14939                 | 9984     | 66.83%           |
| zenmux-deepseek-chat   | 通过       | 4         | 15601                 | 14975    | 95.99%           |
| zenmux-qwen-chat       | 通过       | 4         | 17119                 | 15232    | 88.98%           |
| zenmux-anthropic       | 通过       | 4         | 17080                 | 16919    | 99.06%           |
| bailian-qwen-chat      | 通过       | 4         | 17122                 | 15360    | 89.71%           |
| bailian-qwen-anthropic | 通过       | 4         | 17080                 | 15360    | 89.93%           |
| zhipu-glm-chat         | 通过       | 4         | 15433                 | 10112    | 65.52%           |
| zhipu-glm-anthropic    | 通过       | 4         | 15385                 | 15232    | 99.01%           |
| bailian-qwen-responses | **未通过** | 1         | —                     | —        | 未产生可结算用量 |

基本三协议矩阵命令发现凭据检查加三个模型测试，**4 项全部通过**。全部扩展尝试中八个组合完成文本、随机工具结果往返和累计核对；百炼 Responses 保留失败，不以八个成功掩盖它。智谱本次 Chat 与 Anthropic 都可调用；没有尝试扩大当前受限 Responses 对 GLM 的能力。

百炼 Responses 首次 HTTP 200 后，在 `response.created` / `response.in_progress` 的 `validateResponse` 状态一致性校验失败（`openai-responses-stream.ts` 的 `response.status === expectedStatus`）。未得到最终 usage 或已接受 Step。现有证据不能判定实际错误 status 值，不能归因于缺缓存、密钥或模型额度；本轮没有放宽严格 Responses 协议校验。该平台组合**未通过 E2E**，应另行调查协议兼容，不承诺开箱即用。

所有成功样本均返回了可用 read 明细；本次实网覆盖正读取和显式零。缺失读取、仅写、损坏明细等分支由固定单元及原生集成验证，不能写成实网已经返回过这些情况。真实 harness 针对合法数字核对 input/output/total/read/write，兼容已知全零占位；异常/损坏 wire 会使其失败以便诊断，其拒收策略由确定性测试证明，harness 没有再造完整 normalizer。

长前缀是测试专用固定合成文本，数字不是产品普遍命中率，也不是 SLA。三次工具 session 请求验证 system/tools 保持一致；没有修改产品请求缓存策略、固定上游路由或追求某个百分比。

## 5.5 测试命令与证据边界

```sh
pnpm run test:unit
pnpm run test:integration
pnpm exec vitest run --config vitest.e2e.config.ts packages/ohbaby-agent/src/adapters/ui-runtime/subagent.e2e.test.ts
pnpm run preflight
OHBABY_REAL_MIGRATION_PROFILE= OHBABY_REAL_MIGRATION_PROTOCOL= OHBABY_REAL_MIGRATION_EXTENDED= pnpm test:cache:real:accounting
OHBABY_REAL_MIGRATION_PROFILE=bailian-qwen-chat pnpm test:cache:real:accounting
OHBABY_REAL_MIGRATION_EXTENDED=1 pnpm test:cache:real:accounting
```

- Stage B 初次全量单元：236 文件、2488 通过 / 2 跳过；全量集成：56 文件、381 通过。
- Context/metadata 定向：195 通过 / 2 opt-in live 跳过；子代理确定性 E2E：3 通过。
- 初次 preflight：format、lint、typecheck、320 文件 / 3280 测试通过（另 16 跳过）、build 全通过。
- Anthropic 修复后最终 preflight：exit 0；format、lint、typecheck、320 文件 / **3287 测试通过**（另 5 文件 / 16 测试按既有 opt-in 条件跳过）、全部包和 Web build 通过。
- 真实基本三协议：最终 baseline 命令 exit 0、4 测试通过；额外成功 profile 各自 exit 0、2 测试通过。包含百炼 Responses 的扩展矩阵应返回失败，不能当作全绿命令。

真实 runner 才读取根 .env；普通测试不加载实网凭据。每个成功 profile 限四次 HTTP、SDK 重试关闭，每次 HTTP 单独超时；总取消早于测试超时以留清理时间。原始请求正文/headers/密钥不落证据，错误只记录安全代码和本地 provider 栈位置。

live 验证范围是生产 Lifecycle → 生产 onStepUsage → 生产 tracker，以及 SDK/provider、原生工具配对、prepared 请求、校准、消息 Part；它不等同于完整 ui-inprocess 的实网测试。完整 runtime/backend 接线和 `/status` 消费由确定性集成覆盖。

首次扩展实测的新增 follow-up 曾设 maxSteps=1，触发 max_steps_finalized，相关用例失败。修正为2后再验证；初次失败文件保留。该配置也会撤掉最终步的 tools，因此没有把“只是终态不一样”当成功。Anthropic 重分类缺陷同样先记录失败/错误数字后修复；不删除历史证据。

本地详细日志及审查报告：`.superpowers/sdd/02-optimization-plan-and-change-scope/improve-5-20260915/`。脱敏数字证据：`.ohbaby/test-evidence/improve-5/real-cache/`，均被 gitignore 排除。下面列出本报告采用的最新独立 profile 文件；本表数字已写入受版本控制的本页，原始私有日志不提交。

- `zenmux-responses-1789439063064.json`：2026-09-15T02:24:23.064Z。
- `zenmux-deepseek-chat-1789439072384.json`：2026-09-15T02:24:32.384Z。
- `zenmux-qwen-chat-1789438672666.json`：2026-09-15T02:17:52.666Z。
- `zenmux-anthropic-1789439082727.json`：2026-09-15T02:24:42.727Z。
- `bailian-qwen-chat-1789438679690.json`：2026-09-15T02:17:59.690Z。
- `bailian-qwen-anthropic-1789438968943.json`：2026-09-15T02:22:48.943Z。
- `zhipu-glm-chat-1789438698655.json`：2026-09-15T02:18:18.655Z。
- `zhipu-glm-anthropic-1789438985872.json`：2026-09-15T02:23:05.872Z。
- `bailian-qwen-responses-1789438987985.json`：2026-09-15T02:23:07.985Z。

## 5.6 交付状态

最终 preflight 已通过，代码及测试独立审查无剩余阻断项；按功能、归一化修复、真实测试与文档分批 commit，保留在本地 improve-5 临时分支。暂不 merge / push 到 `openai-responses-migration`，等待用户审查。百炼 Responses 的未通过结果必须随交付说明一起保留。

本地分批记录：

| 提交             | 内容                                                      |
| ---------------- | --------------------------------------------------------- |
| `55c08559`       | Step 观察、可信 session 累计与 runtime/身份回归           |
| `02b34dbd`       | Anthropic 最新输入快照修复、原生协议及 sibling scope 回归 |
| `e718c5f7`       | 三协议多平台真实请求 harness、脱敏证据和显式 runner       |
| 本页所在文档提交 | 00–05 文档、当前语义与历史后继指针、验收结果              |

每次 commit 保留仓库 pre-commit 的 lint/typecheck 检查；没有绕过 hooks。最终独立审查结论为 Standards PASS / Spec PASS / documentation PASS，先前 P2 均已关闭。包含百炼 Responses 的扩展平台矩阵仍不是全绿，这项限制不因代码审查通过而消失。
