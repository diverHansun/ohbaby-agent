# improve-5 实施与验收

> 实施日期：2026-10-13。基线：本地 improve-4 分支提交 `84b9a71e`；实施分支：`codex/context-improve-5`。依据本目录 02、04 与 plan/discussion-notes §17 的最终决策。
> 实施、单元/集成回归、三协议实网、真实 serve/Web、子代理和 Pi 审查已完成，待用户审查。本记录覆盖第五批；整轮集中收尾由用户后续决定。只保留本地提交，不 merge、不 push。

## 1. 前四批回顾与实施边界

开工时工作区干净。逐一对照原始讨论、固定决策、plan 与各批实施记录、提交和当前代码，沿用以下已交付能力：

| 批次 | 本批消费的成果 | 主要提交 |
| --- | --- | --- |
| improve-1 | 同源估算与请求快照、普通完整输出预留、真实能力与用户偏好分离、用量未知不伪造零 | `77384443`、`a4ebf2f4` |
| improve-2 | 工具首次返回时稳定持久化；正文、引用、错误、原生配对与重启投影保持一致 | `b1e0edae`、`b22ab78d` |
| improve-3 | 正常 prepared 请求分叉摘要；system/tools/reasoning/cache 同源；独立摘要预算、Context 单层重试；prune 已删除 | `4446bc37`、`6d112159` |
| improve-4 | 固定 20K 完整尾组、单滚动摘要、模式 A/B、原子切换、失败终止、成功占用地板与完成提示；次数帽/thrash 已删除 | `fa0260f2`、`8017a8f8`、`84b9a71e` |

原始讨论里已经撤回的比例尾段、40K 第二档和零尾段没有恢复。本批不重写压缩算法，不增加 schema、依赖、分布式锁、永久失败闩锁或新的执行状态框架。

重核 sibling `pi/packages/coding-agent/src/core/agent-session.ts` 的手动 abort 与一次 overflow 标志，以及 `ZCode/apps/zcode-cli/packages/core/src/runtime/methods/turn-model-step.ts` 的 model-step 级标志。借鉴局部控制流；ohbaby 仍遵循已确认的忙时拒绝，不照搬 Pi 的手动先停任务。

## 2. 实施对照

| 阶段 | 交付 | 主要位置 |
| --- | --- | --- |
| 入口准入 | `RunManager.withIdleSession` 同步占有现有 session/scope 锁，活跃 run、正在 claim 的 run、重复手动请求立即 busy；锁内复核已有运行账本 | `runtime/run-manager/manager.ts` |
| 准入准备期 | adapter 检查已接纳/准备中/运行中 prompt，并用短时 `compactingSessions` 预留异步准备窗口；普通 prompt 反向检查并复用原 scheduler；删除 runtime-switch 轮询等待及未使用旁路参数 | `adapters/ui-inprocess.ts`、`ui-inprocess/runtime-controller.ts` |
| 工作区隔离 | 已有 primary-session 检查同时验证 workspace 归属；共享 SQLite 的不同工作区不能用显式 sessionId 越过所属 backend。符号链接与原目录归一到同一 InstanceStore | `ui-inprocess.ts`、persistent/instance-store 测试 |
| Stop 贯通 | CLI Esc/Ctrl+C 和 Web Stop 各自取消手动请求；SDK→command→REST/RPC→runtime→Context 透传 signal；signal 不序列化入 JSON，不借用 abortRun、不伪造 run | SDK、commands、server、CLI/Web |
| 提交边界呈现 | HTTP AbortError 只表示停止等待；重查当前 usage，保留已取得结果和 durable summary。命令显式取消后保留有界迟到事件关联，超时只释放关联，不覆盖权威终态 | Web store/client/overlay、RPC client、CLI prompt |
| mask 退出 | 删除专属配置、cutoff、档位、事件/schema、导出、半窗压力计算、重复投影及计量；保留 serializer/tool metadata projection、原子 store 和工具首次限长 | `core/context/`、bus catalog |
| 跨入口回归 | manual/automatic/force 参数化模式 A/B、Stop、冲突、旧摘要、两次实际请求额度；同一 Lifecycle run 连续四次自动成功压缩后完成 | context plan/lifecycle 集成测试 |
| UI | Pi 参与真实桌面/窄屏截图审查，优化忙碌、取消、成功状态及轻量视觉；主代理检查并实测 | `CompactOverlay`、`StructuredCommandOverlay` |

`projection.ts` 经引用核对仅承担 mask；其测试文件的前段是 fixture，全部 13 个测试均为 mask 专用，因此整体删除。原子性、Stop、scope、工具正文/配对、恢复测试保留或迁入有效流程。`time.compacted`、`commitCompaction`、旧摘要和原文读取无迁移。模块五份当前文档与 bus catalog 同步，plan 及 00–04 保留规划原貌。

## 3. 合同与测试证据

| 合同 | 可执行证据 |
| --- | --- |
| G1/G3 | 三入口仍汇入内部 runCompaction，运行内不重入公开 compact/lane；adapter、CLI/RPC、实网均验证手动成功不另发普通请求、不创建 run |
| G2 | runtime-admission、RunManager、inprocess/persistent 合同：准备中 prompt、已有运行、claim 异步间隙、重复 compact 立即拒绝；不取消首个请求或工具；子代理拒绝、scope/session 隔离 |
| G4 | packages/apps/tests/scripts 引用检查无 mask 配置、事件、专属 helper、prune-only、次数帽或 thrash；bus catalog contract 与类型检查通过 |
| G5 | SQLite 重开读取旧摘要与原文、零 LLM/历史事件；新增 retired IDs 不重返 assemble 断言；实际 serve 重启后历史压缩标记保留 |
| G6/G7 | Lifecycle 失败/无收益停止、force 失败不补额度、同一步 stale input 不复位、用户新 run 可继续、已完成工具不重跑；沿用并回归前批测试 |
| G8 | 一个真实 Lifecycle run 执行三次 30K 工具结果，触发四次自动压缩后正常完成；只一份 active summary、四份 durable summary、工具原文保留；地板与容量变化回归 |
| G9 | CLI command 业务失败仍显示失败；Web busy/result/usage 与当前请求对应；迟到 SSE 成功/失败、60s 释放不篡改终态；无假 run |
| G10 | `compaction-plan.integration.test.ts` 39 项覆盖三入口模式 A 精确遗漏、B 完整输出预留/一次缩尾、最新超大组失败零写、网络/容量混合最多两次；窗口与保护集合沿用前批回归 |
| G11 | 三入口队列 Stop/相关组冲突零写；提交后 Stop 保留成功；新输入保持 active；SQLite 事务故障/硬崩溃重开、请求 records 与正文原子性均回归；真实 Web 发往 LLM 后 Stop 查库零变化 |

各子任务先观察红测再实施：忙请求原先成功或等待；manual signal 原先未传到 provider；Web/RPC command signal 缺失；response body 阶段 AbortError 原先被包装成 invalid JSON；跨 workspace 原先可提交 prompt。修复后保留这些回归。

| 验证 | 结果 |
| --- | --- |
| `pnpm test -- --reporter=dot` | 534 文件通过、6 跳过；6028 项通过、17 跳过，零失败；286.74 秒 |
| `pnpm build` | 通过；与全仓测试串行，避免 dist 清理竞争 |
| `pnpm run typecheck` | 通过 |
| `pnpm run lint` | 0 errors、109 warnings；不扩大既有 warning 清理范围 |
| 全部修改 TS/TSX Prettier、`git diff --check` | 通过 |

最终 UI 调整后，主代理再次运行 Web commands/App 的 202 项测试通过；lint 修正影响的四文件 291 项通过。超窗数字不得随进度条截为 100%：将既有刷新用例改为 112% 后先出现 3 条失败，修复仅限制条宽、保留真实比例。全仓日志 `.ohbaby/improve5-tests-final.log`；其他日志同目录，均不提交。首轮发现 signal 参数断言过时、旧 model-switch 测试仍预期等待，以及新测试可选接口未收窄；逐项修正后完整重跑通过，没有跳过失败用例或修改业务行为迎合测试。

## 4. 三协议真实 API

依据 `tests/models-4-tests.md`，密钥只在进程内读取。独立临时 HOME、工作区、SQLite 与随机端口，通过真实 HTTP daemon/RPC 调用；标题请求在这一补充 runner 中排除，实际 Web serve 保留标题请求。普通输出 8192、摘要 16384、本地窗口 128000。

| 端点/协议 | 成功摘要 | 本地压前 → 压后 | 摘要实际 input/output | cache read/write |
| --- | ---: | --- | --- | --- |
| Zenmux deepseek-v4.1-flash / Chat | 3 | 34077→8609；33598→8359；33151→8288 | 32959/286；33197/341；33094/365 | 32512/未知；32768/未知；32640/未知 |
| Zenmux gpt-5.6-luna / Responses | 1 | 32902→8282 | 31394/254 | 31061/330 |
| Dashscope qwen3.8-flash / Anthropic | 1 | 35739→9122 | 35206/395 | 34816/0 |

Chat 8 次、Responses 4 次、Dashscope Anthropic 4 次生成 HTTP 均为 200。摘要分别复用压前普通请求 4/4、6/6、4/4、3/3、3/3 条前缀，system/tools/thinking/cache 身份保持一致。未知 cache write 与明确零分开记录。

Zenmux Anthropic 首次 seed 成功，第二个普通请求因余额限制返回 402，未完成压缩验收；改用测试说明中已有 Dashscope 凭据完成 Anthropic 协议验证，不把两者当作同一端点通过。初次 Web Zenmux 服务也收到 402，随后改用已配置的 DeepSeek 直连。

人工查看五份摘要和最终回答：Cedar/release 17、文件引用 `src/context.ts`、错误 E_CHECK_41、job-47 仍运行且结果未知、测试未执行、投产建议未批准均保留。Chat 第二轮起继承 Lin→Mia 更正。成功摘要记录与正文同提交，活动摘要始终一份，旧摘要留库。样本是文本记忆任务；真实工具副作用不重跑由可控集成测试证明，不冒称实网工具验收。

脱敏报告 `/tmp/ohbaby-improve5-live.json`、`/tmp/ohbaby-improve5-live-anthropic.json`。补充 daemon 和临时数据在 finally 清理；runner 位于忽略目录，不提交。

## 5. 实际 ohbaby serve 与浏览器

使用最新编译的 `packages/ohbaby-cli/dist/bin.js serve`，独立数据目录与真实 DeepSeek key，Playwright 操作真实 Web。当前服务 `http://127.0.0.1:54896`，为用户保留；运行状态和数据路径见本地 `.ohbaby/improve5-serve-state.json`，凭据未写到配置文件。该隔离测试服务的生成请求总量上限为 30，供本次验收与查看。

1. **自动模式 A**：50K 本地测试窗口，两批长材料之间触发必要容量保护，37627→23824，精确提示 2 parts omitted。用户当前更正 Mia 与未完成/未批准状态保留；自动摘要后继续普通请求，无重复完成提示。
2. **压前普通→手动摘要**：改为 128K 验证完整前缀，摘要继承压前 8/8 条消息及相同 system/tools/thinking/cache 身份。47553→8807；摘要实际 input 45857、output 521、cache read 45440，约 99.1%。手动完成没有额外普通请求。
3. **真实 Stop**：新增材料后点击 Compact，再等请求到达模型端点击 Stop。wire 第 10 次请求为 summary、随后 fetch abort；SQLite 在前后均为 24 parts、相同 2 个 summary IDs 和完全相同 retired IDs。端侧显示停止等待的中性文案，重新查询占用；没有声称服务端回滚。
4. **取消后显式重试**：第 11 次请求成功，34323→8610；input 32911、output 524、cache read 32512，约 98.8%；同样保留之前正常请求 8/8 前缀。390×844 窄屏，按钮 busy 禁用、点击背景仍保留弹层；成功占用即时更新。
5. **压后首个普通请求**：第 12 次 input 9297、cache read 8320（约 89.5%），返回 owner Mia、release 17、E_CHECK_41、job-47 pending、测试未跑、投产未批准。Web fixture 未提供文件路径，因此回答未读写文件；文件引用保留由三协议独立样本覆盖。
6. **Pi 最终视觉版复验**：重新 build 并重启实际 serve 后再发两条普通请求和一次手动摘要。第 15 次请求成功 34611→8673，input 33158/output 599/cache read 32768，完整继承前一普通请求的 10/10 消息与 system/tools/thinking/cache 身份。1440×1000 和 390×844 截图检查通过：手机 context 数字单行，文档宽/滚动宽均 390，context 行宽/滚动宽均 314，2px 进度条贴合圆角；按钮、成功反馈和持久化消息一致。
7. **重启读取**：实际服务重启并复用 SQLite，原有自动/手动压缩提示和会话均恢复。完成提示与模型只消费一个活动摘要的语义分别核对。

自动阶段的隔离模型 profile 最初误用 Zenmux reasoning wire，虽然 UI 选 Off，DeepSeek 仍返回 reasoning tokens；核对 wire 后改为直连的 binary thinking 配置，后续手动/Stop/重试使用正确配置。此为测试夹具更正，没有改产品 provider 逻辑，不将最初阶段声称为 thinking 关闭测试。模式 A 与缓存身份的断言以实际请求为准。模式 B、溢出混合失败、提交后 Stop 竞态由离线故障注入覆盖，不靠反复实网撞限额。

最终截图位于 `.ohbaby/improve5-web-final-{busy-desktop,success-desktop,success-mobile}.png`；脱敏 wire 汇总 `/tmp/ohbaby-improve5-web-evidence.json`。请求体只记录形状、hash、人工测试回答和 usage，不记录 headers/key。服务重启后观察器内部的 priorSharedPrefix 索引从 1 计数，因此跨重启比较改为按实际 request ID 的消息 hash 复核，未把内部索引当作绝对 ID。压后历史变化自然改变缓存前缀，实测命中率不构成后续服务端缓存保证。

## 6. 审查与 SWE 取舍

四个子代理分别回顾前批、实现准入与 Stop、清理 mask、独立对抗审查。独立审查发现并修复了跨工作区 session 越权路由、browser executeCommand 信号遗漏、body 阶段取消错误包装、取消后迟到权威结果被超时覆盖。主代理查看实际 diff，补齐三入口参数化与同一 run 多次压缩，并执行全仓和真实服务验收。

Pi 使用 `github-copilot/claude-opus-5.5`、medium，独立会话 `codex-ohbaby-context-improve5-review-20261013`。浏览器验收期间就参与；前两轮已改进 Stop 文案、secondary 按钮、busy backdrop、完成文字和估算说明。第三轮判断本批代码/SWE/合同可通过，并直接精简占用表和成功提示，删除与完整窗口前后值口径不同的 saved 行、隐藏内部 session ID，增加现有蓝/暖红色的 2px 占用条；没有改核心统计合同。主代理补上超窗百分比不截断的边界，并重新构建实测，最终成功态将两张重复表合并为一个占用卡片，并隐藏内部 ID，窄屏无横向溢出。第四轮 Pi 阅读最终桌面成功/进行中和窄屏截图，确认通过、没有必须修的问题；认可真实超窗百分比与更准确的 workspace owner 边界说明。

保留边界：**手动独占依托正常单 daemon 的 canonical workspace→唯一 backend/runtime 所有权**。多个独立构造的 persistent backend 指向同一工作区/数据库时，本地 RunManager 锁不是跨 owner 分布式互斥；账本检查能拒绝已经登记的运行，但不能消除两个独立 owner 同时检查的竞态。本批没有为该底层使用方式新增分布式租约/表/全局锁。数据库原子快照校验仍在，但不把它等同于全局准入保证。

本批减少 mask 状态和重复计量，以现有锁、scheduler、AbortSignal、原子 store 和事件通道补齐入口，控制抽象数量。没有修改摘要策略、工具执行或持久化 schema。所有改动留在本地分支，整轮多个 improve 的集中收尾尚未进行。

## 7. 本地交付

基线 `84b9a71e` 之后按职责分批提交：

- `38fab870`：mask 清理、完整请求投影、Context signal 与跨入口核心回归。
- `c413c305`：空闲准入、workspace 隔离、SDK/REST/RPC/CLI 取消与 Lifecycle 回归。
- `2e1884f7`：Web Stop、权威结果反馈、Pi 的弹层视觉简化及边界测试。
- 验收记录与当前模块文档单独提交，规划原文不改。

提交钩子执行 lint 和 typecheck 均通过。构建后的真实服务保留给用户查看，合并、推送和整轮收尾由后续审查决定。
