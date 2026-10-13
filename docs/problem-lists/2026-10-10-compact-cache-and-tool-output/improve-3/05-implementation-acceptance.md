# improve-3 实施与验收

> 实施日期：2026-10-13。依据本目录 00、02、04，plan/02 与 discussion-notes §17 的最终决策；原始讨论中已撤回的方案不作为实施依据。

## 1. 基线与范围

从 improve-2 本地分支 `codex/context-improve-2` 的 `d640f23d` 创建 `codex/context-improve-3`。实施前核对了 improve-1 的同源计数、完整输出预留和可选 reasoning usage，以及 improve-2 的 MCP 错误 metadata、工具投影与重启回放。沿用这些实现，不另建 tokenizer、工具限额或存储层。

本批实现正常 prepared 请求分叉、独立摘要输出、三协议缓存边界、Context 单一重试预算、90% 与必要容量保护，并删除前置 prune 及消费者。模式 A/B、单滚动摘要、请求记录同事务落库、最终失败终止留在 improve-4；mask 清理留在 improve-5。本批是中间态，不能独立宣称完整压缩策略可发布。

本批 C1～C5（当批部分）、E1/E5 与 A2/A4 回归通过；单元／集成与全仓5944项、类型、构建、三协议独立服务及两类自动容量保护实网通过。Pi复核无当前批阻塞，阶段风险见§5。仅本地提交，不 merge、不 push。

## 2. 对照实施计划

源码路径相对 `packages/ohbaby-agent/src/`。

| 02 阶段 | 实际实施 | 主要证据 |
| --- | --- | --- |
| S1 请求分叉 | `PreparedModelRequest` 携带已解析 settings；Lifecycle 与手动入口解析普通请求配置，Context 保留 messages/tools/inputIds 并只追加一条摘要指令 | `core/context/context-manager.ts`、`core/lifecycle/lifecycle.ts`、`adapters/ui-runtime/composition.ts` |
| S1 摘要客户端 | 直接消费 prepared 材料，返回正文、预分配 summaryMessageId 与尝试记录；不再拍平历史、换短 system、删 tools 或循环提示词 | `adapters/ui-runtime/prompt-context.ts` |
| S1 三协议 | 普通与摘要共享适用缓存身份；Anthropic 显式边界在末尾摘要指令之前；Chat／Responses／Anthropic 使用原转换器输出字段，原生状态保持结构 | `core/llm-client/prompt-cache.ts`、`services/interface-providers/anthropic.ts`、`prompt-cache-wire.contract.test.ts` |
| S2 输出与容量 | 无 thinking 16384，固定 B 为 16384+B，其余已启用 thinking 为 32768；显式 requestedOutputTokens 参与预算，普通请求保留完整 config.maxTokens | `summaryRequest`、`summaryUsage`、`summary-request.integration.test.ts` |
| S2 触发 | 默认 0.90；发送普通请求前为已申请普通输出和下一次摘要留空间；容量触发受现有次数／thrash规则，摘要已超界则本地失败、零模型请求 | `runCompactionCore`、早触发与实际发送边界测试 |
| S2 重试 | Context 首次＋至多一次可取消网络退避；摘要 streamResponse 应用重试为 0，三 SDK maxRetries 为 0；普通应用层次数与中途断流规则保留 | `core/llm-client/retry.ts`、`sdk-retry.integration.test.ts` |
| S2 请求归属 | `SummaryRequestRecord` 沿用普通记录字段，所有权为 compactionId/messageId，不伪造 run/step；observer 记录每次真实 usage 与终态，成功记录随结果返回 | `core/llm-client/types.ts`、`request-observation.ts` |
| S3 清理 | 删除 pruneHistory、专属常量／配置、事件目录、pruned 返回值和 SDK／CLI／Web 消费，保留共用原子退场、配对、scope 与恢复逻辑 | Context、bus、SDK compact、CLI store、Web CompactOverlay |

## 3. 实际差异与取舍

1. **复用现有请求形状。** settings 只包含 model、temperature、resolved reasoning 和 maxTokens，不复制密钥、客户端或全量配置。端点与缓存能力继续由同一 LLMClient 和 session/scope 解析。现有直接 Context 调用允许不带 settings；真实摘要 adapter 要求已解析 settings，缺失明确失败。
2. **请求身份在提交前分配。** Message 的既有 compaction summary 参数接受预分配 messageId，最终消息 ID 与请求记录一致；没有提前保存占位消息或新增尝试表。记录仍只返回，落库归批 4。
3. **保留 mask 的阶段边界。** 自动、手动摘要都从普通请求同一 mask 投影分叉；不为摘要单独解 mask。默认关闭 mask 时，大工具正文保持完整。mask-on 的对齐测试与 mask-off 的无 prune／Stop 测试分别覆盖两种契约。
4. **提前触发与实际发送分开。** 普通／摘要发送时分别校验各自输出预留；发送普通请求之前，提前触发条件还需为本次已申请的普通 maxTokens 留空间，即 `summaryInput + ordinaryMaxTokens >= summaryInputBudget`。这是已知请求上限的预留，不是预测实际增长、不新增固定比例。否则普通输出小于摘要输出时，几乎总会跨过摘要容量才触发，已无机会发送。Pi 的反例促成这一修正。实际摘要已超界仍失败，模式 A 属批 4；容量压力不再伪装 force，旧次数／thrash规则本批保留。
5. **失败记录使用现有诊断设施。** 没有可应用摘要时，每次已发送尝试写一条结构化诊断，未知 usage 省略，记录不作为 UI 技术通知。沿用日志 ID 脱敏策略，以 operationId 保存 requestId 的稳定指纹；不记录请求正文、原始错误文本或凭据。
6. **真实输出能力的局限。** 当前 profile.maxOutputTokens 是普通偏好，并非独立的 provider 硬输出能力字段；不能拿它截小摘要。已校验解析后的 thinking 与总额度、实际窗口预算；服务端更严格的输出上限若未在配置能力中表达，会明确失败，不能声称已做通用硬上限探测。
7. **旧测试按契约替换。** 删除只证明 prune／拍平历史／多提示词重做的断言，保留并迁移 scope、Stop、冲突、原子性、恢复及 UI 进度测试。原 1K／4K 窗口夹具不能承载 16K 摘要，换成合理窗口与显式容量压力，不为保旧测试而增加生产兼容分支。

未新增运行时依赖、数据库表或迁移；没有临时开关、冷热分流、摘要工具执行器或新的请求框架。

## 4. 测试与验收证据

| 验收项 | 结果与证据 |
| --- | --- |
| C1 同源／无 prune | prepared-summary 集成验证完整 messages/tools/settings/inputIds；summary-request 验证普通、手动、自动同投影，mask-off 大工具正文不变；失败／Stop／提交冲突／SQLite重开没有前置退场 |
| C2 最终 wire | prompt-cache-wire 契约覆盖 Chat／Responses／Anthropic 输出字段、工具配对、native opaque/signature、thinking 与显式历史缓存边界；实网结果见下节 |
| C3 实际次数 | sdk-retry 在安装的三个 SDK 下方统计 HTTP：首次成功 1、503 后成功 2、两次失败 2、SDK 包装首字节连接故障后成功 2；普通 5 次应用重试总计 6 次，不再乘 SDK 重试 |
| C3 断流／拒绝 | 摘要 transport 中断可消耗剩余一次；protocol／EOF／provider_abort／Stop／length／空正文／工具调用不重试；半成品不拼接，tool_calls 后 trailing usage 仍保留 |
| C4 本批部分 | 本地摘要超容量零请求，错误不换提示词、不执行工具、不调高额度；无可压旧段仍是 skipped。最终失败终止与无收益运行保护不冒充本批完成 |
| C5 本批部分 | 预分配消息身份与提交一致，普通 run/step 必填不变；成功 attempts 带 usage 返回；失败／Stop／无收益逐请求诊断，无假消息、无尝试表。summary-diagnostics 验真实 UI 组合入口、未知 usage、两次失败的日志唯一性与脱敏 |
| E1 容量 | 普通完整输出与摘要显式 requestedOutputTokens 各自校验，默认阈值 0.90；实际发送容量 −1／0／+1、普通输出小于摘要输出的逐步增长、提前触发与次数／thrash限制，固定 B=65536 申请81920、不加32K帽 |
| E5 清理 | Context／bus／SDK／CLI／Web 引用链清理完成，无生产 prune 常量、函数、事件、状态或空壳；旧退场数据与共用提交路径保留 |
| A2／A4 回归 | 16K／16K+B／32K发送与预留一致；用量仍为既有总量子项，未知不伪造0、不重复加cache/reasoning；普通usage、scope、输入账本、失败历史与长期agent回归通过 |

主要命令：

```sh
pnpm build
pnpm typecheck
pnpm lint
pnpm test
pnpm exec vitest run packages/ohbaby-agent/src/core/context packages/ohbaby-agent/src/core/message
pnpm exec vitest run packages/ohbaby-agent/src/core/llm-client/sdk-retry.integration.test.ts packages/ohbaby-agent/src/services/interface-providers/prompt-cache-wire.contract.test.ts
pnpm exec vitest run packages/ohbaby-agent/src/adapters/ui-runtime/summary-completion.integration.test.ts packages/ohbaby-agent/src/adapters/ui-runtime/summary-diagnostics.integration.test.ts
```

最终全仓：**530 文件通过、6 文件跳过；5944 项通过、17 项跳过，零失败**（198.42秒；Pi 修复后完整重跑）。构建与串行类型检查通过；全仓 ESLint 零错误、108条既有 warnings。修改的 TypeScript 文件 Prettier 检查及 git diff --check 通过。

初次全仓检查暴露了尚未迁移的字符串摘要 fake、tiny-window 与 prune 旧断言，已按新契约替换；并发／UI进度等有效测试保留。一次在代理编辑日志接线时启动构建，读到中间状态而类型失败；上面的结果来自编辑稳定后的完整重跑。没有为测试通过放宽生产规则。

### 4.1 独立 ohbaby 服务实网

通过 `tests/models-4-tests.md` 的真实凭据，在本代理启动的三个独立 HTTP daemon 上验证。各自使用随机本地端口、独立 HOME／项目／SQLite，经远程 JSON-RPC client 创建会话，运行 seed → 普通请求 → 手动 compact → 普通请求。不是仅直连 provider；服务使用本批构建产物。凭据只在进程内加载，不进入参数、报告、提交或审查提示。

每协议4次实际生成HTTP请求，全部200；摘要各1次，全部stop，成功应用并退场2个旧parts。普通输出4096，摘要16384，压后恢复普通4096；tools与thinking保持一致。摘要请求在前一次普通请求材料后新增该次模型回复和摘要指令，已有消息逐条字节一致。压后请求逐字包含数据库中 summaryMessageId 对应正文，最终回答保留项目、版本、负责人三项事实，无工具执行。

| 模型／协议 | 摘要wire | input | output | total | reasoning | cache read | cache write |
| --- | --- | ---: | ---: | ---: | --- | ---: | --- |
| deepseek/deepseek-v4.1-flash／Chat | max_tokens=16384 | 14225 | 252 | 14477 | 未返回 | 13824 | 未观测 |
| openai/gpt-5.6-luna／Responses | max_output_tokens=16384 | 12663 | 193 | 12856 | 明确0 | 12353 | 307 |
| anthropic/claude-sonnet-5／Anthropic | max_tokens=16384 | 21477 | 364 | 21841 | 明确0 | 21004 | 5 |

本次三协议均经 ZenMux 兼容端点。Anthropic 摘要断点在 `/messages/3/content/0/cache_control`，末尾摘要指令不带断点；input=468 uncached+21004 read+5 write，total未重复加cache。Chat的标准化结构有cacheWrite=0，但observed=false，因此上表记“未观测”，不能当真实零写入。Responses沿用observe-only，不因此新加端点不支持的cache字段。服务端这次命中是实测结果，不保证固定命中率。

本地窗口设128000验证这条链路，thinking关闭；固定B、effort、64K/大窗口容量等由离线边界与wire契约覆盖，没有声称真实发送这些规模。第一次实网本身成功，但runner错误限定摘要role=assistant，导致summaryReplayed=false；serializer实际按user的<context_summary>发送。改为按数据库摘要正文逐字校验后，完整重跑三协议，上表采用第二轮结果。

脱敏证据：`/tmp/ohbaby-improve3-live-final.json`；临时runner `.ohbaby/improve3-live.ts` 在忽略目录，不纳入提交。服务和临时目录在finally清理，最终核验无遗留服务或临时目录。

### 4.2 自动提前保护实网

另起一个 Chat 服务，主动将**本地配置窗口收紧为50000**、普通输出设25000（不声称提供商实际窗口只有50K）。普通输入容量23976，摘要输入容量32592，包含1024安全余量。通过两轮普通prompt形成压力，没有调用manual／force。

实际顺序为 seed普通25000 → 第二prompt触发摘要16384 → 第二prompt普通25000 → 后续普通25000。四次HTTP均200/stop，摘要只发送一次。摘要provider input=26117、output=206、total=26323、cacheRead=17408；压后普通input=17005。这个26117是provider实际用量，不能冒充内部启发式触发值；调用链及较低窗口占用证明触发来自容量保护，而非手动force或0.90占用阈值。旧parts退场0→3，保存摘要逐字回放、后续事实核对均通过。

证据：`/tmp/ohbaby-improve3-auto-final.json`、忽略目录 `.ohbaby/improve3-auto.ts`。该轮实网验收16次真实生成请求；另有修正观测前的12次，共28次。实网未人为制造网络故障或打满90%窗口，这些由SDK底层计数与精确容量边界测试覆盖。

### 4.3 Pi 修复后的普通 8K 自动保护实网

在最新构建上，继续使用独立50K本地窗口，将普通输出改为8192。普通输入容量40784、摘要输入容量32592；历史规模与上一个样本相同。这一次普通请求本身仍放得下，但普通输出可能消耗摘要所需空间，专门覆盖P1修正后的分支。

| 阶段 | wire输出上限 | 实际input | 实际output | cacheRead |
| --- | ---: | ---: | ---: | ---: |
| seed普通请求 | 8192 | 17476 | 1 | 17152 |
| 自动摘要 | 16384 | 26123 | 233 | 17408 |
| 压后普通请求 | 8192 | 17035 | 1 | 8320 |
| 后续回忆 | 8192 | 17197 | 13 | 17024 |

四次HTTP全200/stop，摘要一次，无manual/force。`26123 < 32592 < 40784`，而`26123+8192=34315 >= 32592`；这里是provider usage旁证，不作为内部启发式数值。system/tools/thinking的wire哈希保持一致；DB摘要逐字回放、retired parts 0→3、事实保留、无工具均通过。报告`/tmp/ohbaby-improve3-auto8k-final.json`，临时runner`.ohbaby/improve3-auto8k.ts`。服务已停止、临时目录零遗留。本任务实网累计32次生成请求，其中修正观测后的验收20次。

## 5. 独立审查与 SWE 复核

子代理交叉审查基线、最终决策、生产 diff 和真实请求边界。实施中确认并修正了两处问题：mask-on 摘要与普通请求的投影分叉；失败用量误接 UI 通知而非诊断日志。另补工具调用结束帧后 usage 的消费验证，确保“请求完成”与“摘要可以应用”分开。

设计复核关注单一事实来源、重试所有权和失败副作用。删除旧 prune、重复提示词和字符串重建，复用现有 observer、协议转换器与提交事务；没有因三个协议引入平行的摘要客户端。容量与输出使用已有预算解析，保留阶段边界而不提前建设批 4/5。

Pi `github-copilot/claude-opus-5.5`、medium 首轮独立检查生产diff与固定决策，自行运行6文件93项通过，并用source脚本复现两项承重问题：普通输出较小时，容量触发线与摘要拒绝线重合；capacityPressure复用force绕过旧次数／thrash限制。主代理与子代理均独立复现，采纳最小修复并补回归。此前“不叠加两种输出”的解释过窄：实际发送预算应分开，但发送普通请求前必须为其已申请的最大输出保留摘要空间。

同时采纳内部路径改为公共index导入、清理prune删除后空行。未采纳三项可选扩展：①为所有纯投影／测试入口强制settings会扩大迁移，生产两入口已传快照，实际adapter显式拒绝缺失；②成功结果返回records是本批交付给批4的契约，失败回调也有必要，Context按requestId合并，不用新增状态容器；③末尾恰好一条摘要user指令是当前明确契约，缓存层据purpose确定边界并有最终wire测试，不再新增跨层配置字段。

Pi 复核确认两项必修问题均闭环、没有当前批阻塞；自行跑3文件105项通过，重跑原反例在128K/无thinking 82.2%、200K/effort 80.9%处成功压缩，均只请求一次。它抽查了三协议与25K自动实网报告，未运行build/typecheck/全仓，也未看到随后生成的8K实网报告；8K结果由主代理另行核对。

明确保留阶段风险：长run达到旧两次上限后，当前批仍可能继续增长并撞上provider溢出；批4的模式A、删上限／thrash、无进展地板及最终失败终止必须一起补齐。Pi的长链路反例没有被作为本批功能扩展的理由，也没有被隐去。

## 6. 本地提交

| 提交 | 内容 |
| --- | --- |
| `4446bc37` | 三个SDK关闭隐式重试、普通溢出隔离、摘要cache身份／真实历史边界及provider/wire测试 |
| `6d112159` | prepared摘要、独立额度与容量提前保护、记录／诊断、prune清理、SDK／CLI／Web与有效回归迁移 |
| 本文所在文档提交 | improve-3验收、现行Context文档与批次入口状态 |

分支保留 `codex/context-improve-3`，基于 improve-2 `d640f23d`；未 merge、未 push，等待用户审查。临时实网runner与脱敏报告留在本机，没有加入仓库。
