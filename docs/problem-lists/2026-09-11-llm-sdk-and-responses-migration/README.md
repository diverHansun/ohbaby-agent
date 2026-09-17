# LLM SDK 升级与 Responses 协议调查

## 当前入口（2026-09-17）

improve-1～8 已于 2026-09-17 按用户授权合入本地 `main`，本轮 Responses 接入开发阶段完成。`openai-responses-migration` 先快进到 `4fb72271`，main 再从 `dfb6d932` 快进到同一提交；合并前完整 preflight 和合并后全仓测试均为 3722 项通过、17 项跳过，三协议实网、main 上的 TUI Responses 与强制压缩续聊检查通过。合并过程、证据和未测边界见 [main 合并验收](./main-merge-acceptance.md)。尚未 push。下方早期状态记录中的“待合入”等文字保留历史时间口径，不代表当前分支状态。

用户开启的 **[improve-6：Context 计量与压缩链路适配](./improve-6/README.md)** 已完成实施与独立审查，按“部分通过”合入本地 `openai-responses-migration`。内部旧 Chat 估算桥已删除；保留压缩／prune 算法，补足摘要语义并按用户要求将自动摘要统一到完整窗口 95%。真实自动越过 95% 与真实上游 overflow 未实测，尚未推送；结果与限制见 [05 实施验收](./improve-6/05-implementation-acceptance.md)。

用户已开启 **[improve-7：Agent loop 三协议执行语义与历史交接](./improve-7/README.md)**。本轮已完成实施、三协议真实测试与独立审查，已快进合入本地集成分支，未推送；结果见 [05 实施验收](./improve-7/05-implementation-acceptance.md)。保留 SDK 重试，整理内部工具累积、完成/失败语义与失败历史交接，验证既有 Context 管理规则；压缩算法不变。断流正文的两层处理已获用户确认：过滤原始失败协议消息，允许从已保存可见正文派生带中断说明的普通文本历史，见 [00 §3](./improve-7/00-discussion.md#3-已确认的两层处理)。

**[improve-8-regression：连接入口、推理设置与编辑反馈](./improve-8-regression/README.md)** 已完成 A–D、主动推理档位探测和 TUI `/effort` 收尾，包含三协议产品入口、会话推理选择、模型保存与运行切换以及 Web/TUI 验证。CLI packaging 在本次合并前后均通过；真实百万窗口自然达到 95% 和真实上游 overflow 仍未验证。

## 历史阶段状态

以下按各阶段当时记录保留；最新集成状态以上方“当前入口”为准。

- 文档状态：Improve 1 已实施并通过本地验收；Improve 2 最新技术验收通过修订后的受限ZenMux门（2026-09-13全量preflight及生产lifecycle T12通过，见05 §5.12）
- 代码状态：Improve 1 完成；独立 `openai-responses` provider 已落地，仍为显式 kind，默认路径仍是 Chat Completions
- Improve 2 审查状态：独立代码审查无新阻断，真实测试脚本补强后复验通过；按用户授权收尾提交并合入本地openai-responses-migration，main不动
- Improve 1 实施基线：同步远端后的 `main@e095c7fa`
- 调查日期：2026-09-11
- Improve 2 规划开启日期：2026-09-12
- Improve 3 规划开启日期：2026-09-13。2026-09-14 独立验收及合入前完整补验通过（见 [improve-3/05 §5.9](./improve-3/05-implementation-acceptance.md#59-用户授权与合入前补验2026-09-14)），用户已明确授权本地合入集成分支；不合 main、不 push。
- Improve 3 合入结果：2026-09-14 已快进合入本地 `openai-responses-migration@c7572a38`；main 保持 `dfb6d932`，未 push。
- Improve 4 开启日期：2026-09-14；“用量与校准链路对齐”已按用户授权实施，最终 preflight 及同一次 ZenMux 三协议矩阵通过，独立审查缺口补测后关闭。见 [improve-4/05](./improve-4/05-implementation-acceptance.md)；等待用户审核，未 merge/push。
- Improve 5：2026-09-14 开始研究，2026-09-15 用户确认统计新规则并授权撰写规划。承接 improve-4 主动切出的 cache 统计议题；按可信 Step 累计替代整 Run 筛选。见 [improve-5](./improve-5/README.md)，已在本地 `codex/improve-5-cache-accounting` 实施；基本三协议实网通过，扩展八组通过、一组未通过，详见其 05；暂不 merge/push。

本目录把协议调查、SDK 升级与 Responses 接入分成独立轮次：

- [`investigation/`](./investigation/)：Chat Completions、Responses、Anthropic Messages、第三方兼容性和参考项目结论（Improve 1 规划期调查，跨轮仍有效）。
- [`improve-1/`](./improve-1/)：只升级 OpenAI 与 Anthropic 官方 TypeScript SDK，并修复升级直接暴露的兼容问题。
- [`improve-2/`](./improve-2/)：新增独立 `openai-responses.ts`，三者共享现有 provider 接口；默认仍走 Chat Completions。首个过渡切片只承诺不需要原生 reasoning/output-item 续接的能力。
- [`improve-3/`](./improve-3/)：请求与结果去 Chat 类型耦合，保留旧估算和存储合同；已通过技术验收并合入本地集成分支。
- [`improve-4/`](./improve-4/)：用量与校准数据合同、最小参数命名和证据补齐；算法不变，技术验收通过，等待用户审核合入。
- [`improve-5/`](./improve-5/)：三协议 cache 观测与可信 Step 累计、主子代理隔离和最小展示；不改变缓存请求控制、上下文组装或压缩算法。

- [`improve-5.5/`](./improve-5.5/)：2026-09-15 已实施 reasoning 请求配置与三协议原生续接；默认开启/medium、子代理默认继承开关与强度。实际结果及限制见其 05／06／07，不包含前端或主代理显式覆盖子强度工具参数。
- [`improve-6/`](./improve-6/)：2026-09-15 用户开启 Context 计量与压缩链路适配规划，承接此前延后的 context 议题；保留算法，完成自有消息计量、旧 Chat 中间格式退出与最小语义修复。

- [`improve-7/`](./improve-7/)：2026-09-16 对齐 Agent loop 规划与验收；00–04 已对齐；实现与本轮验收完成，05 记录结果。

## 分支策略

- `main` 保持稳定；本迁移建立本地长期集成分支 `openai-responses-migration`。
- 每一波从集成分支建立临时分支；improve-2 使用 `codex/improve-2-responses-migration`。
- 单波通过自己的实施验收后只合回集成分支。Responses 后端、token estimation/counting、cache 命中统计、context 占用统计与 lifecycle 全部完成并通过整体验收后，才把集成分支合并到 `main`。

## 轮次地图

| 轮次                 | 开启日期                               | 触发事件                                                              | 状态                                                                                |
| -------------------- | -------------------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| investigation        | 2026-09-11                             | 议题启动调查                                                          | 完成                                                                                |
| improve-1            | 2026-09-11                             | 第一轮：SDK 升级，主动切割 Responses                                  | 05 已闭环                                                                           |
| improve-2            | 2026-09-12                             | improve-1 主动切割后的独立实施                                        | 最新preflight与修订后的生产lifecycle T12通过，按用户授权收尾合入集成分支            |
| improve-3            | 2026-09-13                             | improve-2 §2.8主动切割的内部契约；用户授权提前规划                    | 05 独立验收和完整补验通过，已合入本地集成分支（2026-09-14）                         |
| improve-4            | 2026-09-14                             | improve-3 主动切出的用量/校准议题，承接其 05 与用户确认的收窄范围     | 已实施；最终 preflight、同一次三协议 live 及独立审查通过，待用户审核；未 merge/push |
| improve-5            | 2026-09-14 研究；2026-09-15 规划与实施 | improve-4 主动切出的 cache 议题；用户确认开启并替代旧整 Run 筛选规则  | 00–05 已完成；本地实施/基本三协议验收通过，扩展限制见 05                            |
| improve-5.5          | 2026-09-15                             | improve-5 新模型实网暴露上游协议缺口，用户明确指定返修/能力扩展轮次   | 已实施并收尾，结果及限制见 05／06／07                                               |
| improve-6            | 2026-09-15                             | improve-5.5 实施后，用户开启前序主动延后的 context 议题               | 部分通过，已合入本地集成分支；未推送                                                |
| improve-7            | 2026-09-16                             | improve-6 后继续对齐 Agent loop；用户确认保留 SDK 与失败历史边界      | 已本地合入 `135a6cda`，未推送                                                       |
| improve-8-regression | 2026-09-17                             | improve-7 合入后暴露连接入口回归，承接 improve-5.5 延后的产品推理设置 | 已完成并合入本地 main；最终结果见 main 合并验收                                     |

## 已冻结的阶段边界

### Improve 1（已完成）

不引入 `/v1/responses`，不新建 `openai-responses.ts`，不改变当时的 Chat Completions 与 Anthropic Messages 路径。

### Improve 2（受限live门已完成）

引入独立 Responses provider 与 `"openai-responses"` kind。**不**改变缺省 `openai-compatible` 路径，**不**对用户露出协议开关，**不**按 base URL 在 Chat / Responses 之间分流，**不**做内部 canonical IR，**不**做 cache 完全对齐，**不**使用 `previous_response_id`。

由于当前 Chat-shaped 历史无法保存并重放 Responses 的 `reasoning` item / `phase`，本轮只支持不产生这些续接要求的 Responses 文本与 function-tool 路径；一旦出现原生 reasoning item、assistant `phase`、refusal、annotation 或 hosted/custom tool，必须明确失败，不得降级后继续。

以下内容仍登记为后续候选（improve-2 的 05 已写出；合入集成分支仍要 T12。是否在 T12 前开 improve-3 规划，由用户确认）：

- provider-neutral message/tool/output IR 与命名规范；
- Chat / Responses cache 完全对齐、显式缓存；
- 产品默认改为 Responses，Chat 另开入口；
- `previous_response_id`、Conversations 或其他服务端状态链；
- lifecycle、context 压缩、SQLite 消息格式的协议迁移；

Chat Completions 作为显式兼容入口长期保留；移除它不属于本议题目标。

## Improve 2 之后的候选迁移顺序

> 2026-09-13 更新：下列顺序保留为先前候选记录，已不作为 improve-3 的实施范围。用户已确认本轮只整理 LLM 请求/结果契约与必要类型适配，旧估算和存储保持；原生 continuation、统计对齐留后续。当前依据为 [improve-3/00](./improve-3/00-discussion.md) 与 [02](./improve-3/02-optimization-plan-and-change-scope.md)。

2026-09-14 当前依据为 [improve-4](./improve-4/README.md) 与其 [验收结果](./improve-4/05-implementation-acceptance.md)：只对齐供应商用量、单步估算和校准合同，保留算法、统计与占用数字行为。此前 [候选范围](./improve-3/next-stage-candidates.md) 仅作历史输入；不授权替换 wire 估算材料或原生续接。以下旧路线保留为历史候选，不覆盖本轮 00/02 边界。

这是提前登记的依赖路线，不代表后续轮次已经立项。improve-2 的 05 已写出（部分通过）。根目录原先把正式 00–04 放在「合入 `openai-responses-migration` 之后」；若要在 T12 前开 improve-3 规划，需要用户确认。

1. 建立 provider-neutral canonical item 与 provider-continuation envelope，先定义 reasoning item、assistant phase、原生 call ID 和 opaque continuation 数据的所有权、持久化与回放边界。
2. 让 context serializer / persistence 能无损保存并重放这些 continuation 数据，同时保持项目消息仍是会话真相源，不依赖 `previous_response_id` 才能正确运行。
3. 改造 llm-client 累积器与 lifecycle 消费 canonical envelope，验证推理模型工具循环、并行调用、重试、abort、compaction 与恢复；之后才解除 improve-2 的 reasoning/phase fail-closed 限制。
4. 基于“实际 provider 请求投影”对齐 token estimation/counting，区分 heuristic、provider actual usage 与校准误差，避免继续按转换前 Chat JSON 估算 Responses wire。
5. 让 context occupancy/composition/compaction 与同一请求投影对齐，验证 system→instructions、扁平 tools、continuation item 不漏算也不重复计算。
6. 在 improve-2 仅证明现有通用 usage 链不回归的基础上，正式对齐 Responses cache 命中统计口径、跨步聚合与校准；确认观测口径稳定后，再单独决定 cache 控制策略，不能把统计对齐等同于主动缓存。
7. 做跨模块契约、重启恢复、live smoke 与回归 eval；全部门禁通过后，才讨论产品默认翻转到 Responses，Chat 继续保留为显式兼容入口。

## 审核入口

最新规划：[improve-8-regression README](./improve-8-regression/README.md) → [方案](./improve-8-regression/02-optimization-plan-and-change-scope.md) → [前端设计](./improve-8-regression/03-frontend-design.md) → [验收标准](./improve-8-regression/04-test-and-acceptance.md)。前轮结果见 [improve-7 验收](./improve-7/05-implementation-acceptance.md)。前序 [improve-6](./improve-6/README.md) 已本地合入，其真实容量测试缺口继续保留；improve-7 的 force 压缩测试不能关闭该缺口。

历史 Improve 5 审核入口：[README](./improve-5/README.md) → [已确认决策](./improve-5/00-discussion.md) → [现状](./improve-5/01-problem-analysis-and-current-state.md) → [方案](./improve-5/02-optimization-plan-and-change-scope.md) → [七个参考项目](./improve-5/03-reference-projects.md) → [验收标准](./improve-5/04-test-and-acceptance.md)。实际结果见 [05 实施验收](./improve-5/05-implementation-acceptance.md)。Improve 5 新规则只替代旧缓存统计的纳入门槛，不追溯改写 improve-4 的验收结论。

Improve 1 结果：

1. [`investigation/00-discussion.md`](./investigation/00-discussion.md)
2. [`investigation/01-problem-analysis-and-current-state.md`](./investigation/01-problem-analysis-and-current-state.md)
3. [`investigation/03-reference-projects-and-ecosystem.md`](./investigation/03-reference-projects-and-ecosystem.md)
4. [`improve-1/02-optimization-plan-and-change-scope.md`](./improve-1/02-optimization-plan-and-change-scope.md)
5. [`improve-1/04-test-and-acceptance.md`](./improve-1/04-test-and-acceptance.md)
6. [`improve-1/05-implementation-acceptance.md`](./improve-1/05-implementation-acceptance.md)
7. [`planning-review.md`](./planning-review.md)

Improve 2 实施与验收：

1. [`improve-2/00-discussion.md`](./improve-2/00-discussion.md)
2. [`improve-2/01-problem-analysis-and-current-state.md`](./improve-2/01-problem-analysis-and-current-state.md)
3. [`improve-2/02-optimization-plan-and-change-scope.md`](./improve-2/02-optimization-plan-and-change-scope.md)
4. [`improve-2/03-reference-projects.md`](./improve-2/03-reference-projects.md)
5. [`improve-2/04-test-and-acceptance.md`](./improve-2/04-test-and-acceptance.md)
6. [`improve-2/05-implementation-acceptance.md`](./improve-2/05-implementation-acceptance.md)
