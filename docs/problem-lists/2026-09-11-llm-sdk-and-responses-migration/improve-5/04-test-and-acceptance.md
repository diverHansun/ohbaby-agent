# 4. 测试与验收标准

> 本文是实施后的验收合同，不是测试结果。遵循仓库 [docs-test](../../../../docs-test/README.md)。规划阶段没有运行本轮新测试或真实 LLM 请求。

## 4.1 验证分工

- unit：原生字段归一化、单步可信判断、累计算术、观察一次与异常隔离。
- contract：SDK 原 DTO、Web/TUI unknown-payload 与极简显示、请求 cache wire 不变。
- integration：真实 Lifecycle → runtime/composition → backend tracker → `/status`；主子身份、scope、退休、重建和 metadata。只 fake 外部 LLM/网络等不可控依赖。
- real E2E：既有三协议 Responses migration runner 显式 opt-in；记录实际原生 usage，核对生产归一与新累计。不拿实际命中率高低当实现标准。

新增跨模块测试集中在 `tests/integration/runtime/prompt-cache-step-accounting.integration.test.ts`（规划期未创建）。局部用例扩展现有源码旁测试；沿用既有 `.real.e2e.test.ts` 的单独配置例外，不批量移动历史文件。

## 4.2 验收矩阵

| ID  | 场景与必须断言                                                                                                                                                                | 主要证据入口                                                                                   | Stage |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | ----- |
| T1  | Chat/Responses/Anthropic 原生 usage → canonical：读取正数/明确零/读取缺失/仅写/读有写无/损坏明细；inclusive input 不双算；Anthropic 晚到缓存重新分类与全零占位兼容            | provider token-usage、responses-token-usage unit；原生协议集成 fixture                         | A     |
| T2  | 按可信 Step 累计：100/read100 + 900/read0 为 10%；混合明细 70%；第二步明确零为 35%；跨 Run 加权为 60%                                                                         | prompt-cache-usage unit；新增集成                                                              | A     |
| T3  | 同一步多个 raw complete，首尾 usage 不同，采用最终 accepted usage 且只记一次；usage-only 累计更新不当作新增样本                                                               | streaming/Lifecycle unit + 新增集成                                                            | A     |
| T4  | 观察回调抛错不改变任务结果、校准或工具执行；无回调调用者保持原行为；载荷不被观察端修改                                                                                        | Lifecycle / RunManager unit                                                                    | A     |
| T5  | 后步缺 usage、缺明细、EOF、抛错、工具失败、取消，保留已结算前步；Step 和 Run 完成不双记；重复 wait/status 不加数                                                              | 新增真实 runtime 集成、RunManager unit、ui-inprocess contract                                  | A     |
| T6  | Run aggregate、usageComplete、校准配对与调用次数仍按 improve-4；不能为了 cache 将 Run 完整性恢复为 true 或过滤其正常总输入                                                    | lifecycle token-usage/lifecycle unit、usage-calibration integration                            | A     |
| T7  | 两个 session 分别累计；切换显示不串桶；换模型、runtime 重建、手动/自动 compact 不清累计或回减历史                                                                             | ui-inprocess contract、新增集成                                                                | B     |
| T8  | 删除/归档清目标桶、迟到观察不复活；dispose 后不再记录；全新 backend 不从持久消息恢复旧累计                                                                                    | ui-inprocess contract                                                                          | B     |
| T9  | 子代理完成/失败观察不进主桶；两个 child scope 共用 child session 时归属清楚；主请求包含工具返回后只计供应商实际父请求 usage                                                   | 新增集成、ui-inprocess contract、subagent 既有测试                                             | B     |
| T10 | 子代理 text/tool-only/hybrid 有效 usage 的生产 metadata reader 保留 read/write/observed，每 Step 至多一个 Part；未知不造零，无 Part 不造记录；主子预算与压缩 scope 隔离不回归 | 扩展 usage-calibration 或新增集成、metadata unit、context-state-machine/context-subagent-scope | B     |
| T11 | SDK 四字段不变；CLI/Web 相同输入得相同整数百分比、零/未知显示；最新未知保持旧累计；不增加范围/覆盖率/缺失提示                                                                 | SDK prompt-cache contract、CLI status-panel unit、Web slashCommands unit                       | C     |
| T12 | prompt/system/tools 组装及 cache wire 不变；不动 key/TTL/cache_control，Responses observe-only 不变；无新存储或 UI 状态                                                       | prompt-cache-wire contract、prompt-cache unit、生产 diff 审查                                  | C     |
| T13 | 同一次真实三协议运行中核对实际原生 usage、canonical、最终 Step 观察、session 累计；文本及工具往返；有明细/无明细按实际分支记录                                                | 扩展 responses-migration.real.e2e；§4.6                                                        | C     |
| T14 | 定向测试、相关集成、SDK 消费者和最终 preflight；现行文档改为可信 Step，旧规则只保留历史指针                                                                                   | §4.5 命令、diff 与本轮 05                                                                      | C     |

“已有文件”不表示表内全部组合已经覆盖。实施验收要列出真实测试名、关键断言与 T 项映射，不能仅报文件数量。

## 4.3 固定样本与关键断言

### A. 原生协议最小样本

三个等价输入样本分别使用原生字段，经生产 parser 得出总输入 1,000/read800：

```text
Chat:
  prompt_tokens=1000, completion_tokens=100
  prompt_tokens_details.cached_tokens=800

Responses:
  input_tokens=1000, output_tokens=100
  input_tokens_details.cached_tokens=800

Anthropic:
  input_tokens=200, output_tokens=100
  cache_read_input_tokens=800, cache_creation_input_tokens=0
```

写入明细另设 Responses input1000/read600/write100，得到 uncached300，比例60%；缺 write 与明确 write0 的读取占比可相同，但 observed 不同。没有 read、仅 write100 时不纳入读取比例。

还需覆盖：read0 有效；read 缺失；details 缺失；read 为 null/负数/小数/字符串；read+write 大于 input；零输入；整份 usage 缺失。生产 parser 已正确的边界复用已有测试，别为本轮改变原始 total 不一致的既有归一规则。

### B. 序列必须有顺序变化

固定 mixed Run：`1000/800 → 2000/未知 → 1000/600`。断言 session 新增输入2000/read1400，原 Run 总输入仍为4000，Run breakdown/完整性按旧合同，不要求 cache 分母等于 Run 总输入。

至少调换一次已知/未知顺序，证明首步未知不会让后续有效 Step 永久拒收；追加明确零，证明它会增加分母；在已有历史的 session 继续运行，证明不是把每个 Run 的比例覆盖上去。

### C. 真正结算与原始流完成分开

构造同一 Step 多个 `isComplete` 输出，最后一次用量不同。断言观察回调发生在 runModelStep 正常返回后的单次用量处理处，只使用最终接受的 usage。不能只造两个相同数字的 complete，否则“首个值锁定”也可能误过。

补充生产 overflow 路径：同一 Step 第一次 runModelStep 已输出 complete 和用量 A，然后抛 context overflow；强制重新准备后第二次成功返回不同用量 B。断言仅 B 进入单步观察和 cache 累计，A 不计；Run 总量与校准仍配 B。

最终用量已接受后 abort/length，应保留本 Step；只收到中间事件、尚未走到最终用量处理就抛错，不额外计本 Step。先前已结算 Step 保留。EOF、provider throw、length、工具中断分别按各自生产路径验证，不用一个万能 error fixture 代替。

这些用例必须经过生产观察接缝，不仅手工调用 tracker 多次。至少一项从 native SSE/transport fake 经过真实 provider、llm-client、Lifecycle；另有真实 runtime/composition 到 `/status` 的链路，证明 wiring 没漏接。

### D. 子代理记录与窗口机制

构造主 session 和两个共享 child session、不同 scope 的子代理，使用不同 cache 数值避免混账仍偶然得到相同比例。正常 text、tool-only、hybrid 样本通过 production metadata reader 核对，而非只断言回调 spy。

子代理已有保存路径的样本可要求恰好一个 Part 带 usage；一般合同为至多一个。tool-only 在创建工具 Part 前取消、无 final usage、reasoning-only 无 Part 等情形，不要求补建持久记录。运行时观察和持久化覆盖分别断言。

复用已有真实 ContextManager 的 scope 校准及主/子压缩状态机测试。压缩改变后续请求内容，但不删除 tracker 的历史数值；不新增另一套子代理压缩测试框架。新缓存统计无需把压缩辅助请求纳入主桶。

## 4.4 集成边界与公开合同

本地测试外部 API 使用 transport fake/loopback；被测 parser、Lifecycle、tracker 不 mock 掉。原有 fake Lifecycle 的 worker/bridge 测试证明传输，不能单独证明“最终 accepted Step 只观察一次”。

SDK、Web、CLI 使用相同固定 DTO 样本。至少覆盖 share=null、share=0、share=0.6、一个需要四舍五入的比例、非法 payload；通过真实后端得到的最新未知场景仍是此前 share，而非由 UI 自行保留旧值。

测试确认 `/status` 仍为唯一可见入口，不增加 cache SSE 专用协议、snapshot 字段、顶部显示或 tooltip 解释。读命令不改累计，不从历史消息重新算账。

## 4.5 本地命令

在仓库根运行。下面列出定向入口，不将未创建文件或无测试匹配的成功退出当作验收。新增文件只在实施后运行。

```sh
# 原生用量、单步结算与旧总量保护
pnpm exec vitest run \
  packages/ohbaby-agent/src/services/interface-providers/token-usage.unit.test.ts \
  packages/ohbaby-agent/src/services/interface-providers/responses-token-usage.unit.test.ts \
  packages/ohbaby-agent/src/core/lifecycle/lifecycle.unit.test.ts \
  packages/ohbaby-agent/src/core/lifecycle/token-usage.unit.test.ts \
  packages/ohbaby-agent/src/runtime/run-manager/manager.unit.test.ts \
  packages/ohbaby-agent/src/adapters/ui-inprocess/prompt-cache-usage.unit.test.ts

# backend、消息和公开显示
pnpm exec vitest run \
  packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts \
  packages/ohbaby-agent/src/core/message/token-usage-metadata.unit.test.ts \
  packages/ohbaby-sdk/src/prompt-cache-usage.contract.test.ts \
  packages/ohbaby-cli/src/tui/render/status-panel.unit.test.ts \
  apps/ohbaby-web/src/ui/slashCommands.unit.test.ts

# 既有用量、scope 与请求控制回归
pnpm exec vitest run \
  tests/integration/core/usage-calibration.integration.test.ts \
  tests/integration/core/context-subagent-scope.integration.test.ts \
  packages/ohbaby-agent/src/core/context/context-state-machine.unit.test.ts \
  packages/ohbaby-agent/src/adapters/ui-runtime/token-usage-roundtrip.integration.test.ts \
  packages/ohbaby-agent/src/adapters/ui-runtime/auxiliary-token-usage-isolation.integration.test.ts \
  packages/ohbaby-agent/src/services/interface-providers/prompt-cache-wire.contract.test.ts \
  packages/ohbaby-agent/src/core/llm-client/prompt-cache.unit.test.ts

# 新增纵向集成，实施后文件必须存在
pnpm exec vitest run tests/integration/runtime/prompt-cache-step-accounting.integration.test.ts

# 最终本地门；含 format、lint、typecheck、常规 test、build
pnpm preflight
```

常规 preflight 排除 `.e2e.test.ts`，不能据此声称 T13 已运行。也不以旧缓存控制的 real 脚本代替 T13：基线 `test:cache:real` 的正命中、epoch 等断言属于另一套目标，本轮不为迁就它去改 system prompt 或缓存控制。

## 4.6 真实三协议观测门

扩展既有 `tests/smoke/responses-migration.real.e2e.test.ts`。沿用受限 Responses 模型/能力边界和实际三协议 profile；本轮不开放 reasoning item/phase 原生续接。在现有 harness 的生产 LifecycleSessionParams 挂 onStepUsage，接生产 createPromptCacheUsageTracker；真实运行据此核对累计。live 不声称覆盖完整 ui-inprocess，后者由 T5/T7/T9 的确定性集成覆盖。原生 SSE usage 与最终 Step 观察单独留证，不只手算期望后声称后端完成。

```sh
# 前提：执行环境已有有效 ZENMUX_API_KEY；不要把密钥写入命令、文档或证据。
# 不设置协议筛选时按 runner 的三个 profile 执行。
pnpm test:cache:real:accounting

# 额外平台矩阵；显式 runner 从 .env 加载凭据，不输出值
OHBABY_REAL_MIGRATION_EXTENDED=1 pnpm test:cache:real:accounting

# 定点复现单 profile（不能冒充整矩阵）
OHBABY_REAL_MIGRATION_PROFILE=bailian-qwen-chat pnpm test:cache:real:accounting
```

执行前确认环境没有将 `OHBABY_REAL_MIGRATION_PROTOCOL` 限制为单个协议。单协议调试可用该筛选，但不能冒充最终三协议门。本轮增加 vitest.responses-migration.config.ts，仅发现该 real 文件；原 vitest.e2e.config.ts 只发现 packages 下 E2E，不能用于此 tests/smoke 文件。新增断言及装配须先实施。通过平台 profile 筛选补跑智谱/百炼，未支持的协议不伪称已测。

每次运行的最小证据：协议、模型、实际 endpoint、执行时间/提交 SHA；原生 usage 是否含读/写字段及其值；canonical input/read/write/observed；最终 Step 观察序列；主 session 的累计输入、读取与 share；可承载 Part 的 metadata。只记录必要用量和归属，不保存密钥或整段用户对话。

| 实际返回                              | 通过标准                                                       | 证据表述                           |
| ------------------------------------- | -------------------------------------------------------------- | ---------------------------------- |
| 有合法缓存读取明细且大于零            | 字段映射、最终 Step 观察、累计及 metadata 对齐                 | 已实际观察非零读取                 |
| 有合法读取明细且为零                  | 按已知零计入分母，结果与累计一致                               | 已实际观察明确零                   |
| 只有总量、没有读取明细                | 保留总量，cache 样本排除；新 session 为 null，已有累计不被覆盖 | 未知分支已验证；实际非零读取未观测 |
| 原始 usage 明细损坏                   | 按既有归一化丢弃不可信 breakdown，不能造零或错误比例           | 记录实际异常字段和排除结果         |
| 网络/鉴权失败、没有执行到有效用量路径 | 不可认定该协议观测门通过                                       | 未完成，记录具体原因               |

固定样本必须证明正读取、写入、零和缺失所有本地分支；真实环境仅能证明本次实际返回的分支。零或缺明细不自动使 T13 失败，也不能写成“已实证非零命中”。不以达到某个百分比验收，不改缓存规则制造结果，不为等到一次命中无限重试。

真实三协议链路、固定样本与 UI 集成证据共同构成验收。仅跑直接 SDK 请求、不经过生产 adapter/单步观察，不算 T13。真实外部观测不要求对子代理强制触发压缩；子代理窗口和记录由确定性集成保护。

## 4.7 对抗性审查与最终结论

| 攻击面                           | 防御                                         | 保留限制                                     |
| -------------------------------- | -------------------------------------------- | -------------------------------------------- |
| complete 多次、末次 usage 改变   | 最终 Step 接缝；不同数值 fixture             | 不提供任意跨进程消息投递的 exactly-once 服务 |
| 有效/未知交错使 Run 不完整       | Step 独立采样，未知分子分母成对排除          | 结果代表已观察样本，不能还原未知实际比例     |
| 回调与 Run completion 两条链相加 | 仅一个 cache 写入口；重复 wait/status 只读   | backend 新实例不恢复历史累计                 |
| 同 child session 不同 scope      | 按 scope 读取 metadata，主桶按身份排除 child | 无承载 Part 的路径没有持久记录承诺           |
| 归档后旧任务返回                 | 退休过滤、dispose 拒收                       | 不恢复已清理的统计桶                         |

最终 05 应分别记录：新统计行为是否完成、原用量/校准/控制是否回归、子代理记录验证范围、UI/SDK 合同、本地命令、真实三协议实际分支。若必选门未执行或失败，明确写部分完成或待补验，不以历史 improve-4 结果替代本轮证据。

文档对齐检查包括：00 的确认全部落入 02；P1–P5 有实施与 T 项对应；当前模块文档不再要求整 Run 门槛；旧冻结文档只通过后继指针标明替代关系。此规划阶段不创建 05，也不写自检报告到仓库。
