# 5. 实施验收文档

> 2026-09-14。由主代理对照本轮 00/02/04、完整 diff、实际日志及独立子代理意见整理。只覆盖 improve-4；不重写 improve-3 的验收。

## 5.1 元信息与结论

| 项       | 值                                                                                |
| -------- | --------------------------------------------------------------------------------- |
| 轮次     | improve-4：用量与校准链路对齐                                                     |
| 规划版本 | `5804d9f9`；00–04 保留规划时点的文字，不回填实施进度                              |
| 实施基线 | `c7572a38`，即已验收并合入的 improve-3                                            |
| 实施分支 | `codex/improve-4-usage-calibration`                                               |
| 实施范围 | `c7572a38..77815125`；本文件及索引更新另作收尾文档提交                            |
| 验收环境 | 2026-09-14，Asia/Taipei；macOS，Node v26.3.1                                      |
| 技术结论 | 通过。本轮 T1–T12 具备分项证据；最终完整 preflight 及同一次 ZenMux 三协议矩阵通过 |
| 发布状态 | 等待用户审核；没有 merge、push 或修改 main                                        |

本轮把已有合同说清楚并用测试保护，没有提高估算精度，也没有改变占用数字、cache 命中公式或压缩算法。有效供应商事件经过现有 adapter 后，未发现本轮需要修复的跨模块用量算术或校准配对错误。这里的“通过”不意味着精确计费、所有失败尝试可追溯、官方直连或原生状态续接通过。

用户在规划审核后明确授权实施、单元/集成/ZenMux E2E、子代理审查和分批提交，同时要求暂不 merge/push。收尾核对：`openai-responses-migration` 仍为 `c7572a38`，`main` 仍为 `dfb6d932`。

## 5.2 三批实施与提交

| 批次                | 实际结果                                                                                                                | 提交       |
| ------------------- | ----------------------------------------------------------------------------------------------------------------------- | ---------- |
| 规划基线            | 提交已审阅的 00–04 与索引                                                                                               | `5804d9f9` |
| A：固定已有行为     | 补两步配对、overflow B、缺 usage/异常时机、校准过滤和 scope 清理；新增真实三协议 adapter 集成与 canonical SQLite reopen | `5299a804` |
| B：最小参数名与说明 | 5 个生产文件仅改位置参数名或注释；另补相同内容的两个 session 校准及清理隔离测试                                         | `b84f1eac` |
| C：真实链路观察     | 现有 live runner 增加逐步准备、provider 用量、校准、Run 小计和 Part metadata 断言，不增加请求                           | `84dfede5` |
| 独立审查补测        | 补“部分文本后自然 EOF、没有最终事件”的公开路径；保留受控异常用例，纠正之前的不可达判断                                  | `77815125` |

每批子代理审查后提交。A/B/C 分别执行专门的 unit、contract、integration 和完整 preflight；最后一条补测又执行定向检查、完整 unit 和完整 preflight。真实 E2E 仅跑了一次，9 次 HTTP；补测不改生产代码或 live 文件，因此没有重复付费请求。

## 5.3 规划与实际差异

| 维度               | 实际核对                                                                                                | 差异或取舍                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- |
| 数据结构/公开 API  | 仅 `realPromptTokens → actualInputTokens` 位置参数及局部引用；类型成员、参数位置/数量、导出、DTO 均不变 | 与封闭改名表一致，不是 JSON key 迁移                                               |
| 数据流             | adapter 归一 → 单步 final usage → 本次 Run 累计、实际 prepared 校准、可承载 Part 的 metadata            | 调用位置和职责不变                                                                 |
| 算法与状态         | normalizer、aggregate、EMA/clamp/guard、session/scope、dispose、legacy 估算、窗口和 cache 不变          | 五个生产文件经去注释编译、归一参数名后的 JS 与基线一致；另有固定数值及包消费者测试 |
| 测试改动面         | 5 个测试文件；新增集成文件 1 个，复用现有主测试及 live runner                                           | B 补 session 隔离、最终补 EOF 分支，均属于已有 T3/T5，不扩产品范围                 |
| 测试类型适配       | live helper 的 `RequestInfo` 改用 `Parameters<typeof fetch>`                                            | 仅测试文件的类型兼容；根 tests 不在普通包 typecheck 范围，另作显式检查             |
| 错误路径判断       | 早期审查把 no-finalEvent 判断为公开路径不可达；整轮独立审查指出遗漏                                     | 已用公开路径补测并纠正报告，不以异常抛出用例代替正常 EOF                           |
| 依赖/存储/默认协议 | 无新依赖、schema、持久化格式、生产 Map、事件、日志框架或额外网络请求                                    | 与规划一致                                                                         |

生产代码确实只有 5 个文件的小改动；测试增加较多，是为了分别保护原生协议、跨步配对和失败边界，没有把这些 fixture 提升为新的生产框架。

## 5.4 现在明确保护的合同

1. **供应商用量**是当前响应归一后的值。输入包含缓存部分，`totalTokens = inputTokens + outputTokens`；cache 明细可以缺失，不能据此删除有效总量。
2. **单步原始估算**是实际使用的 `PreparedTurn.request` 对应的 `sentHeuristic`。它仍使用 legacy Chat 形计量材料；不等于最终 provider wire 的精确 token。
3. **校准**用本响应的输入用量除以该请求的原始估算。发生 overflow 重新准备后使用 B，不拿失败 A、Run 累计或已经校准的占用作样本。
4. **累计**只属于一次 `Lifecycle.run()`。终态、`usageComplete`、cache `observed` 各自表达自己的事，不合并为统一状态。
5. **持久化**每步最多在一个已有 Part 上携带 usage；没有可承载 Part 就不伪造空正文。Run 小计不承诺等于所有历史 Part 的总和。
6. **窗口占用和 cache 统计**仍消费各自原有数据，不改计算方式。system 仍在消息序列中表达，本轮没有顶层抽取改造。

尤其要区分以下三条已有路径：

| 流的情况                                          | 当前行为及本轮证据                                                                                                                                                |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 完全没有归一事件的空流                            | streaming 的 `!emittedAnyResponse` 路径合成完成；若无 usage，进入现有缺失用量规则。该区别来自源码核对，本轮未新增专门空流用例                                     |
| 已输出部分文本，随后正常 EOF，但没有 finishReason | 不合成最终事件；Lifecycle 返回 `provider_stream_interrupted`，保留此前小计及其 complete 值；新 EOF 用例明确检查第二步 delta、无 complete、无 metadata、无额外校准 |
| 抛出受控中断异常                                  | 走异常返回路径；此前小计仍保留。原受控异常用例继续存在，不再把它当作上一行的替代证据                                                                              |

未分类异常仍 rejection；已有 usage 处理后再 abort/length，保留原聚合和校准时机。这里不增加未知样本、不补零、不扩大成失败尝试账本。

## 5.5 测试与验收证据

### 5.5.1 T1–T12 对账

测试路径根分别为 `packages/ohbaby-agent/src/` 与仓库根 `tests/`；下表给出可定位的文件和测试名，完整命令见 [04 §4.5/4.6](./04-test-and-acceptance.md)。

| ID  | 结果与新增/复用证据                                                                                                                                                                                                                                                                                   |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | 通过。新增 `tests/integration/core/usage-calibration.integration.test.ts` 的 `normalizes %s cache usage through Lifecycle and calibrates its prepared request` 三协议参数用例；复用 provider `token-usage.unit`、`responses-token-usage.unit` 的缺失、显式零、冲突和累计字段用例                      |
| T2  | 通过。新增 Lifecycle `pairs each successful step usage with that step's raw prepared heuristic`；强化 `force prepares and retries once when the provider reports context overflow`；新增集成 `pairs two native Chat requests with their own estimates and usage`，原始估算 231/449 分别配输入 100/200 |
| T3  | 通过。新增 missing→known、known→missing、known→controlled failure、known→unclassified error，以及 `treats a partial provider event followed by EOF as an interrupted stream`；补 usage→abort、强化 length。EOF 与抛错分别断言，未新增失败记账规则                                                     |
| T4  | 通过。真实 ContextManager 委托调用原更新函数并检查下一次 prepare：固定 raw 83，输入 120，得到 102；两步 231/449、100/200 后固定 raw 231 得到 144；复用 EMA/clamp 并补现有 guard 的非法样本表                                                                                                          |
| T5  | 通过。强化 `keeps subagent calibration isolated by context scope` 的非目标 scope 保留；新增 `isolates calibration and disposal across sessions`；复用 dispose-session 与 `context-subagent-scope.integration`                                                                                         |
| T6  | 通过。复用 `persists tool-only and hybrid usage on exactly one part per step`、reasoning-only 无空 Part、metadata 深拷贝/缺失/legacy fallback；新集成及 live 检查可承载 Part 的唯一性和数值                                                                                                           |
| T7  | 通过。新增 `round-trips canonical token usage metadata through a physical reopen`，调用生产 creator → 真 SQLite close/reopen → 生产 reader；复用字面量 legacy reopen、`token-usage-roundtrip.integration`、`auxiliary-token-usage-isolation.integration`                                              |
| T8  | 通过。复用 prompt-cache wire/usage unit/contract、context-window-usage、token-estimation；生产 cache/window 文件没有修改                                                                                                                                                                              |
| T9  | 通过。仅五文件注释/参数名变化；旧生产名称扫描无匹配、typecheck、编译后 JS 等价检查及 `compiled-model-contract.integration` 通过；无新增生产结构或依赖                                                                                                                                                 |
| T10 | 通过。复用 `preserves the approved pre-migration totals and all seven literal buckets`：字符长度测试计数器 1453、内置计数器 raw 372、七桶 44/87/45/42/88/21/63；窗口 38400/1000000=0.0384 等原字面量不变；七桶不强行加成总量                                                                          |
| T11 | 通过。各批全套门、补测后最终 preflight 和显式根测试类型检查通过；见下一节。原有 opt-in/platform skip 单列，不算 live 成功                                                                                                                                                                             |
| T12 | 通过。同一次 ZenMux 三协议矩阵 1 文件/4 叶子测试实际通过；每行 3 HTTP、一次真实工具执行。逐步请求配对、校准效果、用量小计与 metadata 均已断言，见 §5.5.3                                                                                                                                              |

新增本地集成测试在测试进程中启动 `127.0.0.1` 随机端口 SSE 服务，使用真实 SDK adapter、llm-client 流处理、Lifecycle、ContextManager 和 message manager；外部供应商传输使用确定性 fixture。两步 Chat 使用真实 ToolScheduler。服务在 `finally` 中关闭，不修改用户已有 daemon。

完整集成测试也实际启动了 daemon 子进程，覆盖监听复用、并发、重启和队列等已有场景。真实 ZenMux 测试直接运行生产编排，不经过 UI；它使用内存 store 和测试 TokenCounter，不能被称作 SQLite、UI 或估算精度 E2E。SQLite 与内置计数器分别由 T7/T10 证明。

### 5.5.2 实际执行记录

日志目录：`/tmp/ohbaby-improve-4-validation.Mw3aX9/`，为本机执行证据，不提交密钥或原始请求正文。执行辅助脚本、任务报告和审查 diff 收尾后转存该目录的 `execution/`，不作为生产文件提交。专门分类测试与 preflight 有重复覆盖，数字不能相加当作不同用例总数。

| 批次/命令                        | 实际结果                                                                                       | 日志                                                               |
| -------------------------------- | ---------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| 改动前复用基线                   | 18 文件 / 233 测试通过                                                                         | `baseline-targeted.log`                                            |
| A：`pnpm test:unit`              | 235 文件；2470 通过、2 平台跳过                                                                | `A-test-unit.log`                                                  |
| A：`pnpm test:contract`          | 17 文件 / 309 通过                                                                             | `A-test-contract.log`                                              |
| A：`pnpm test:integration`       | 55 文件 / 365 通过；250.50s                                                                    | `A-test-integration.log`                                           |
| A：最终 `pnpm preflight`         | 318 文件 / 3246 测试通过；5 文件/16 测试跳过；全部构建通过                                     | `A-preflight-recheck.log`                                          |
| B：unit / contract / integration | 2471+2 skip / 309 / 365；各命令 exit 0，集成 216.76s                                           | `B-test-unit.log`、`B-test-contract.log`、`B-test-integration.log` |
| B：`pnpm preflight`              | 318 文件 / 3247 通过；5 文件/16 测试跳过；全部构建通过                                         | `B-preflight.log`                                                  |
| C：unit / contract / integration | 2471+2 skip / 309 / 365；各命令 exit 0，集成 217.78s                                           | `C-test-unit.log`、`C-test-contract.log`、`C-test-integration.log` |
| C：补 EOF 前 `pnpm preflight`    | 318 文件 / 3247 通过；5 文件/16 测试跳过；全部构建通过，测试 232.29s                           | `C-preflight.log`                                                  |
| 最终 EOF 补测                    | Lifecycle 文件 30/30；精确文件 ESLint 零 warning、Prettier、包 typecheck、diff check 均 exit 0 | 独立补测报告，提交 `77815125`                                      |
| 最终 `pnpm test:unit`            | 235 文件；2472 通过、2 平台跳过，exit 0                                                        | `Final-test-unit.log`                                              |
| 最终 `pnpm preflight`            | 318 文件 / 3248 通过；5 文件/16 测试跳过；format/lint/typecheck/test/build 全部通过，exit 0    | `Final-preflight.log`                                              |
| 实时三协议矩阵                   | 1 文件 / 4 测试实际通过，exit 0；16:58:23 开始，23.27s                                         | `C-live.log`                                                       |

最终 preflight 的测试阶段于 17:07:12 开始，耗时 185.35s；它包含 EOF 补测后的全部代码，随后全部构建完成。普通 preflight 不默认发现 `.real.e2e.test.ts`，因此 T12 用 04 的显式 programmatic include 另跑，并检查文件数、叶子数和每个测试状态。

**失败、纠正及跳过没有隐藏：**

- A 首次根测试显式类型检查失败：缺失必需工具参数、unused import 和 SDK client narrowing 等测试类型问题。先前不带文件参数的检查实际没检查根文件；已纠正报告和脚本，并用两个明确文件重新检查通过。失败日志 `A-root-test-types.log`，修复日志 `A-root-test-types-fixed.log`。
- A 首次 preflight 在新增 abort fixture 的 async-generator lint 处失败；修复仅涉及测试类型和异步 yield，复验通过，原失败保留在 `A-preflight.log`。
- 最终独立审查发现 T3 正常 EOF 漏测；补测后定向及完整检查通过，生产行为没有改变。
- 16 项原有跳过：2 项 Windows-only migration；其余 14 项为既有 opt-in TUI、cache live、compact real、Firecrawl real 用例。本轮没有新增 skip，也不以这些 skip 替代 T12。
- Node 26 的 `localStorage` ExperimentalWarning 在部分 web 测试中仍出现，已在 improve-3 日志中确认存在；不是本轮新增，未压制 warning 或改全局环境。
- CLI packaging 曾有安装超时历史，本轮 A/B/C 已实际通过；补测后的最终完整 preflight 也通过。不把历史失败豁免为当前成功。

根 `tests/` 不在普通包 typecheck 的检查范围。除正常包 typecheck 外，本轮用 TypeScript 的 `createProgram` 明确检查下列两个文件，继承 `tsconfig.base.json`、`noEmit: true`、`incremental: false`，并要求所有诊断为空：

- `tests/integration/core/usage-calibration.integration.test.ts`
- `tests/smoke/responses-migration.real.e2e.test.ts`

根测试及 Markdown 也单独运行 Prettier；文档用 `--ignore-path /dev/null`，避免普通检查忽略 Markdown。最终文档另检查本地链接和 `git diff --check`。

### 5.5.3 ZenMux：同一次矩阵的实际样本

命令使用 04 §4.6 的同一 programmatic runner，显式清空协议筛选，并仅为该进程从授权的仓库 `.env` 读取 `ZENMUX_API_KEY`。没有打印密钥，没有修改代理或模型配置。SDK retry=0、每行第 4 次发送前拒绝、失败后停止该行，均保持。

下面数组顺序均为“文本请求、工具调用请求、工具结果返回后的请求”。估算来自 live 的测试计数器，只用于请求与校准配对，**不能用这组比值评价内置 estimator 精度**。

| 协议 / 模型                                    | 原始估算       | 单响应输入用量  | 单响应输出用量 | 文本 Run 总量 / 工具 Run 总量 |
| ---------------------------------------------- | -------------- | --------------- | -------------- | ----------------------------- |
| Responses / `x-ai/grok-4.2-fast-non-reasoning` | 62 / 126 / 206 | 241 / 298 / 335 | 28 / 5 / 26    | 269 / 664                     |
| Chat / `deepseek/deepseek-v4.1-flash`          | 62 / 126 / 299 | 85 / 325 / 461  | 44 / 94 / 31   | 129 / 911                     |
| Anthropic / `qwen/qwen3.8-flash`               | 62 / 126 / 200 | 119 / 341 / 413 | 114 / 54 / 122 | 233 / 930                     |

每行均为 3 次实际 HTTP、3 次 provider 调用、1 次真实工具执行；三个 assistant step 的 carryingCounts 都是 `[1, 1, 1]`。metadata 通过生产 reader 读取，与独立捕获的单响应归一用量相等。文本 Run 等于自己的一个响应，工具 Run 等于自己的两个响应之和。

首次工具准备使用初始系数 1；下一步按已有 clamp + EMA 和取整得到的占用分别为 347、535、371，测试有精确断言。这里是一次调用之间的校准效果，不是精确占用证明。

仅一次矩阵、总计 9 次 HTTP，无补跑、无替换模型、无暖缓存或额外校准请求。Qwen 本次通过，但不能据此声称此前偶发“工具执行 0 次”已经归因或修复；ZenMux 兼容入口通过也不等于官方直连通过。

## 5.6 Token 机制审计：哪些正确，哪些仍是估算

保持原有模块分工，不新增 TokenManager：

| 模块/文件                                                   | 当前职责与核对结论                                                                                     | 不应作出的解释                                                              |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------- |
| `services/llm-model/tokenCounting.ts`                       | ASCII 每码点 0.25、非 ASCII 1.3，最终向上取整；预算按现有 model profile                                | 不是模型 tokenizer；不能承诺精确 token                                      |
| `core/context/token-estimation.ts` + `legacy-estimation.ts` | 同一实际 prepared 请求投影成旧计量 JSON，包含消息和 tools                                              | 不是 Responses/Anthropic 最终 wire 的计量；七桶独立估算，不要求相加等于总量 |
| `core/context/context-manager.ts`                           | 当前响应 input/raw，夹取 [0.5,3]，EMA alpha 0.5；按 session/scope 存在内存中                           | 不是每 Run 重置，也没有 model 维度或重启恢复                                |
| `services/interface-providers/token-usage.ts`               | Chat/Responses 输入 inclusive；Anthropic 的互斥输入分项求和；累计 delta 取现有单调快照，不逐帧重复相加 | 供应商报告值不是本地独立验真或费用计算                                      |
| `core/lifecycle/token-usage.ts`                             | 本次 Run 已进入聚合路径的已知小计及完整性                                                              | 不是 Session 账本，也不覆盖所有失败/重试 HTTP                               |
| `core/message/token-usage-metadata.ts`                      | canonical 写入、旧键兼容读取、有效 Part 上稀疏携带                                                     | 不保证每个运行时 usage 都落库                                               |
| `core/context/context-window-usage.ts`                      | 将最新准备时的占用投影为 UI 数据，分母为完整窗口                                                       | 不等于累计用量；也不等于压缩决策的输入预算比例                              |
| worker/bridge 与 cache tracker                              | 前者传递 canonical；后者保持原有可信完整主 Run 的加权统计和过滤                                        | 不补全失败用量，不把 cache 价格优惠当作不占窗口                             |

窗口 UI 使用完整窗口；核心压缩判断使用预留输出和安全余量后的输入预算。两者百分比不同不构成算错证据。summary/title、subagent 隔离仍由现有测试保护，没有把辅助调用混进主 agent-step 的校准和统计。

**后续值得核对，但本轮不修：**

- 校准系数是 session/scope 内的单个数，跨模型使用仍可能沿用旧系数；重启会丢失。字符权重和 legacy 计量材料的误差尚未评估。
- 内部接口依赖上游合法输入：直接传负的 actualInputTokens 仍会经过现有 clamp；metadata writer 不独立验证所有明细；自定义计数器若提供 NaN，窗口投影可能传播 NaN。这些是绕过正常归一链的边界健壮性候选，不能说已证明正常供应商路径出错；本轮没有增加 guard 或改 DTO。
- runtime 构建 TokenCounter 时使用模型配置/profile 的预算，没有在该构建点注入每次请求的 maxTokens 覆盖。是否应联动，需后续单独确认，不在本轮改预算。
- 没有持久化校准样本历史、完整失败尝试账本或事件与落库的事务性保证，不能靠当前 metadata 反推精确账单。

后续顺序保持 [02 §2.8](./02-optimization-plan-and-change-scope.md)：先独立处理 cache 命中议题，再检查既有窗口占用与压缩；精确 tokenizer/wire 估算、跨模型校准策略、原生续接等另行批准，不提前纳入本轮成果。

## 5.7 独立审查与工程质量

A/B/C 分别由不同的任务审查子代理检查规范符合性和代码质量；整轮由独立子代理检查全量 diff、关键源码和实际日志，没有复用实施者结论代替检查。整轮审查发现一个 Important：正常 EOF 分支漏测。补测后另一个子代理做限定范围复审，确认该项已关闭，未引入新的阻断问题。

按 learn-swe 的改动面审查及架构检查，本轮没有新增跨模块抽象或改变依赖方向。provider 仍负责协议归一，context 负责估算/校准，lifecycle 负责单步编排与 Run 累计，message 负责存储兼容；超时、重试、取消和持久化边界没有趁命名调整改变。新增测试使用公开接口及受控网络，不暴露密钥，不增加生产请求。

代价是测试 fixture 较长，特别是三协议 SSE 和两步工具链；它们保护不同的实际边界，暂不为缩短代码抽成通用框架。后续变更应优先维护这些合同断言，不以“减少测试行数”为由改成只检查 spy 次数。

结论：实施范围和测试证据支持本轮技术验收。保留的精度、记账覆盖和模型波动限制已经明确；它们不是本轮通过测试后就自动解决的问题。合入仍等用户审核。

## 5.8 重要文件

| 文件                                                                                                                                | 本轮修改                                        |
| ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------- |
| [context/types.ts](../../../../packages/ohbaby-agent/src/core/context/types.ts)                                                     | 原始估算/实际请求说明，位置参数名               |
| [context/context-manager.ts](../../../../packages/ohbaby-agent/src/core/context/context-manager.ts)                                 | 仅参数名及局部引用                              |
| [lifecycle/types.ts](../../../../packages/ohbaby-agent/src/core/lifecycle/types.ts)                                                 | Run 累计与 usageComplete 的覆盖边界             |
| [lifecycle/lifecycle.ts](../../../../packages/ohbaby-agent/src/core/lifecycle/lifecycle.ts)                                         | 实际 prepared 校准配对注释                      |
| [interface-providers/types.ts](../../../../packages/ohbaby-agent/src/services/interface-providers/types.ts)                         | input inclusive、total、breakdown/observed 语义 |
| [context/manager.unit.test.ts](../../../../packages/ohbaby-agent/src/core/context/manager.unit.test.ts)                             | guard、scope 清理和 session 隔离保护            |
| [lifecycle/lifecycle.unit.test.ts](../../../../packages/ohbaby-agent/src/core/lifecycle/lifecycle.unit.test.ts)                     | 配对、overflow、缺失/失败、EOF 与更新时机       |
| [message/database-store.integration.test.ts](../../../../packages/ohbaby-agent/src/core/message/database-store.integration.test.ts) | canonical 生产 writer/reader 经物理 reopen      |
| [usage-calibration.integration.test.ts](../../../../tests/integration/core/usage-calibration.integration.test.ts)                   | 新增三协议本地服务集成与真实两步工具链          |
| [responses-migration.real.e2e.test.ts](../../../../tests/smoke/responses-migration.real.e2e.test.ts)                                | 现有受限 live 的被动用量/校准/metadata 断言     |
