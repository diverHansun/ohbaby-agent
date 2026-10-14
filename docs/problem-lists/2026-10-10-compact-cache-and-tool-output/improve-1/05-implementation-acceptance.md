# improve-1 实施与验收

> 实施日期：2026-10-13。依据本目录 02、04 和 plan/discussion-notes.md 的最终决策。仅记录第一批，不把后续批次写成已经完成。

## 1. 基线与结论

| 项目 | 结果 |
| --- | --- |
| 代码基线 | 本机 main：`844af9fc`；规划调查基线为 `c5cfda26`，实施前已复核差异 |
| 分支 | `main` → `codex/context-optimization` → `codex/context-improve-1` |
| 当前验收 | 本批 A1～A5、全仓回归、构建、类型检查、三协议独立 HTTP 服务实网通过；子代理和 Pi 复核无阻断问题，保留 §6 已知容量空档 |
| 集成方式 | 仅本地分批 commit；不 merge、不 push，等待用户审查 |

## 2. 对照实施契约

下列源码路径相对 `packages/ohbaby-agent/src/`。

| 02 阶段 | 实际实施 | 主要证据 |
| --- | --- | --- |
| 1.1 完整输出预算 | `calculateTokenBudget` 完整预留本次额度；显式 override 不被普通偏好截小。mask／thrash 局部保留旧压力公式 | `services/llm-model/modelProfiles.ts`；`core/context/compaction-policy.ts`、`projection.ts`、`context-manager.ts` |
| 1.2 删表、统一缺省 | 删除 builtin 前缀规则、来源标签和无消费者的辅助函数／list；user > fallback；普通缺省统一 8192 | `config/llm/writer.ts`、`apply-active-model-config.ts`；modelProfiles／tokenCounting 单测 |
| 1.3 计数同源 | 全量及逐条尾段均使用正式模型投影和现有估算器；活动 reasoning 从请求一路传入 | `estimateHistoryForCompaction`、`findCutPoint`、`generateSummaryCandidate`；summary-serialization／native-context 单测 |
| 1.4 可选 usage | reasoning 是 output 子项；缺失与 0 分开；流帧、metadata、事件、Run 聚合均传递；请求记录增加可选 usage | `services/interface-providers/token-usage.ts`、`core/llm-client/types.ts`、`core/message/events.ts` 等既有链路 |
| 1.5 危险恢复退出 | 摘要超窗直接失败，不发缩水请求；删除 helper、droppedRounds、失用次数常量和专属 failure reason | `summary-overflow.ts` 删除；compaction-atomic 集成测试、manager 单测、event catalog 契约 |

## 3. 规划与实际差异

1. **旧压力比还有 thrash 消费者。** 规划主要列 mask；实际 `context-manager` 用同一比率记录锁定位置并判断增长解锁。直接换成完整输出后的比率会提前解锁，输入预算为零时还可能再也无法解锁。本批用 `getCompactionPressureRatio` 供 mask 判断／事件及 thrash 存取共用；容量预算始终保留完整输出。没有新增预算字段、开关或新状态，后续删除原机制时一并清理对应引用。
2. **生产预算还需接普通配置。** `composition` 传入 `defaultMaxOutputTokens=config.maxTokens`；`activeModelBudgetProfiles` 保留原路由／窗口／reasoning 能力，但普通输出使用当前配置，防止旧 models[] 输出值覆盖普通偏好。`activeModel` 的 fallback 同步接当前窗口与输出配置。只改解析函数不足以消除实际发送漂移。
3. **usage 不能只加类型。** 多处既有代码逐字段复制用量，必须同步 metadata、stream bridge 和消息事件 schema。Chat 的后续 usage 帧、Anthropic 累计 output 增长且未提供新明细时，不能保留早期 reasoning 冒充最终明细。任一请求明细未知，Run 汇总也未知。
4. **清理随引用关系完成。** overflow while 删除后，原 `MAX_SUMMARY_PROVIDER_ATTEMPTS` 及两个专属 failure reason 已无生产用途，同批删除。第 3 批在唯一重试拥有者处落实两次总额度，不保留本批已失用的常量。

没有新增依赖、数据库表、schema 迁移、模型目录服务或第二套 tokenizer。普通请求的 runId/messageId/step 所有权不变；尚未写入摘要 usage。

## 4. A1～A5 验收

| 验收项 | 结果与证据 |
| --- | --- |
| A1 投影计数 | 工具 metadata 与最终投影计数一致；无 native 的活动 reasoning 不漏计且改变尾段切点；展示副本不重复计数；native opaque 估算不随密文长度膨胀 |
| A2 额度与配置 | 普通 4K／64K、大于半窗、显式 override 和零剩余输入预算均有测试；gpt/claude 前缀不能覆盖探测／默认值；无输出配置为 8192 |
| A3 fixed B | B=32768、65536 且额度为 16384+B 时保留 B；总额度≤B 明确报错，不暗降 B；本批不设置摘要专用额度或新增 wire 策略 |
| A4 usage | 缺失、明确 0、非法大于 output、多帧覆盖、聚合未知传播、metadata／事件往返与 SQLite 重开均覆盖；total 仍为 input+output |
| A5 精确退场 | 首次超窗、预设第二次成功，断言仍只请求一次；隔离 prune 后原 parts 在 SQLite 重开后完全不变；成功样本精确退场 IDs 等于实际发送范围 |

回归用例先观察失败，再修复转绿。首次 Context 红测具体复现了可读文本分支计数 9 而正式投影为 163、兼容 reasoning 分支计数 17 而正式投影为 5188，以及超窗后仍成功缩水退场。测试使用确定性字符计数，这些数字不是提供商 token 精度承诺。

定向结果：预算／配置 19 文件 223 项；usage 20 文件 552 项；Context／reasoning 20 文件 237 项，均通过。三组有交集，不相加为独立用例总数。

`pnpm lint` 零错误；全仓仍有既有 warnings，新增 Context 测试的返回类型警告已补齐，修改范围定向 ESLint 零错误。

主要命令：

```sh
pnpm test
pnpm typecheck
pnpm build
pnpm lint
pnpm exec vitest run packages/ohbaby-agent/src/core/context packages/ohbaby-agent/src/services/interface-providers/reasoning.unit.test.ts
pnpm exec vitest run packages/ohbaby-agent/src/bus/event-catalog.contract.test.ts
```

首次全仓回归为 5868 passed／1 failed／17 skipped：唯一失败是文档事件目录仍含 droppedRounds；修正文档后该契约 7 项通过，随后重跑全仓：526 文件通过、6 文件跳过；5869 项通过、17 项跳过，零失败。Pi 建议后的函数改名和具名常量另跑 25 文件、277 项通过（2 项实网条件跳过）。检查过程中两次并行启动 build／typecheck，build 清理 dist 导致 TS6305；最终以构建完成后串行 typecheck 通过的结果为准。此处是检查调度失误，不是源码类型错误。

## 5. 独立服务真实 API 验证

在本代理进程中顺序启动三个 ohbaby HTTP daemon，监听 `127.0.0.1` 随机端口；每个使用独立临时 OHBABY_HOME、项目、SQLite、状态和认证。通过远程 JSON-RPC client 创建会话、提交短 prompt 并等待成功，非直连 provider 冒充端到端。服务使用本批构建产物。

密钥由脚本读取用户指定清单／现有环境，只在内存中传递。观测只保留模型、协议、输出参数及数值 usage，不记录 headers、完整请求／响应或秘密。完成后全部服务停止，临时配置、数据库与凭据环境清理。

| 模型与协议 | 检测窗口 | 实际 wire／预留 | input | output | total | reasoning |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| deepseek/deepseek-v4.1-flash，Chat | 1000000 | max_tokens=4096 | 8594 | 1 | 8595 | 未返回，保持未知 |
| openai/gpt-5.6-luna，Responses | 1050000 | max_output_tokens=65536 | 7031 | 5 | 7036 | 明确 0 |
| anthropic/claude-sonnet-5，Anthropic | 1000000 | max_tokens=8192 | 13176 | 4 | 13180 | 明确 0 |

三者 HTTP 200、prompt succeeded；配置输出、provider 参数、wire 与预留额度四者一致；标准 usage 与 SQLite part.metadata.tokenUsage 一致，total 不重复加 reasoning/cache。

本次 Responses cache write=7028，Anthropic cache write=13174；Anthropic 原始 input=2，归一化 input=2+13174=13176，未再次加到 total。Chat 没有 reasoning 子项，不能解释成 0。短 prompt 未产生非零 reasoning，非零／非法边界由单元与集成测试覆盖；这不证明摘要质量或摘要缓存命中，新摘要流程尚属后续批次。

首次实网夹具限制每协议一次生成，自动标题请求先占额度，导致普通 prompt 失败；这是测试夹具问题，未计为通过。修正为在 provider 边界排除 session-title 辅助请求后重跑，普通 agent-step 完整走真实服务和网络。未修改生产标题行为。临时脚本 `.superpowers/improve1-live.ts` 和脱敏 `/tmp/ohbaby-improve1-live-final.json` 留在本机供本次复核，不提交脚手架。

## 6. 审查与 SWE 评估

计划核查子代理与独立全 diff 审查代理均未发现尚未处理的阻断问题。采纳了 thrash 隐藏消费者、生产 fallback 输出接线、逐条尾段漏计与空类型／事件清理提醒，并补了对应测试。

Pi `github-copilot/claude-opus-5.5`、medium 首轮认为核心实现符合预期、未发现推翻主要逻辑的错误，要求修正文档残留，并指出高输出配置的容量空档。已补 architecture／data-model 等现状文档；查询函数重命名为 `activeModelBudgetProfiles`，显式说明输出是普通偏好；局部半窗比例使用具名常量。

核实与取舍：

- **保留公式不等于所有旧配置的触发点完全不变。** 修复前某些路径使用 builtin／8192，修复后正确使用 config.maxTokens，配置本身的预算来源纠正会改变压力比。局部 helper 只避免把完整输出直接用于旧 mask／thrash 分母所产生的额外变化。
- **容量空档明确记录，未在本批另加配置拒绝。** 例如 C=128000、maxTokens=100000 时输入预算为 26976；若尚未达到现有 95% 摘要线，有非空 protectedInputs 且输入超预算的 prepareTurn 会明确报输入预算不足，而不会低估预算后继续发送。maxTokens≥C−1024 时输入预算为零，有非空 protectedInputs 且输入估算大于零的请求也会被现有容量检查拒绝。这是改为真实预留后暴露／扩大的限制，提前容量保护按计划在第 3 批接入，模式 A/B 在第 4 批承接。用户可降低普通输出偏好或纠正窗口配置；不留下持久失败锁。只在 writer 拒绝零预算不能解决非零预算空档，反而增加本批未约定的配置校验策略，故不采用该建议。
- **纠正 Pi 的两处事实表述。** event-catalog 契约实际比较 requiredContext 列，首次全仓失败正是它抓到了文档残留；该文档是在审查进行中修正的。thrash 的删除按第 4 批，mask 按第 5 批，不能一起后移。
- reasoning 非法值诊断属可选建议；本批按已定规则丢弃非法子项并保留可信总量，不加新的诊断机制。

同一 Pi 会话的第二轮复核认可上述取舍，未发现本批必须修复的问题，同意进入分批提交；建议合并的重复 JSDoc 已处理。Pi 的实网判断依据本记录，没有另行执行真实请求。其回复时最后一轮全仓测试尚未结束，本文结果为随后完成的最终结果。容量失败后当次输入的账本状态尚未逐行验收，按建议在第 3 批容量保护验收中补齐。

本批主要减少了前缀猜测、平行计数和危险重试分支。新增字段沿既有数据流传递，未为未来模式 A/B 建框架。保留现有 tokenizer、原生状态代理和事务，符合 KISS／YAGNI；压力比 helper 的价值是保留仍在使用的旧压力公式，不是新容量策略。

## 7. 后续承接与回退

- 第 2 批继续处理工具结果稳定性，本批只按现有实际投影计量。
- 第 3 批接摘要请求分叉、独立额度、缓存、90% 与容量保护、请求记录填充和统一重试，同时删除 prune；补验容量失败后当次输入在账本中的状态及恢复行为。
- 第 4 批接模式 A/B、滚动摘要、尾段与精确遗漏、原子提交、失败终止和 UI 刷新，删除旧次数帽／thrash。
- 第 5 批贯通入口并清理 mask 等剩余机制。
- 普通未配置输出的连接不再继承 builtin 大上限，改为 8192；显式配置仍有效。既有显式普通偏好不自动改写。
- 本批不迁移数据库。回退代码时保留原记录及已有 compacted 标记，不无条件恢复历史；新增可选 usage 可被旧读取路径忽略。不要为回退重新发送摘要或清除会话。
