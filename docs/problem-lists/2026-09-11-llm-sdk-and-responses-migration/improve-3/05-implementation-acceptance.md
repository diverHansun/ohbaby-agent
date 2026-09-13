# 5. improve-3 实施验收

> 2026-09-13：**本轮技术验收通过，等待用户审核，不自动合并**。A/B/C 测试已分批提交，全量 preflight 与独立审查通过；本记录及模块说明随文档收尾提交。三协议各有本轮真实成功证据，不宣称一次全矩阵全绿，原 Qwen 偶发失败未定因，历史保留。improve-3 接口迁移完成不等于整个 Responses 迁移完成。最新收尾见 §5.8。

## 5.1 版本与验收范围

- 批准方案：本目录 00、02、02a、04 及 design/data-model.md 的 2026-09-13 精确契约。
- 实施基线：`openai-responses-migration@b43a0921`，已包含 improve-2 收尾验收与批准规划。
- 当前分支：`codex/improve-3-model-contract`。
- A 提交：`bd98d0ba`，自有请求契约、三个直接 adapter、必要生产者/估算兼容及内层快照。
- B 提交：`7fd55e04`，结果/观察事件命名、公开入口、callId 和公开 usage 别名清理。
- C 测试提交：`66d6000f`；本记录及独立模块说明随文档收尾提交。
- 用户授权空 `.ohbaby-agent/llm/model.json` 删除提交：`1acc72e6`。Git 基线确认其为 0 字节，可从历史恢复，不涉及其他本地配置。
- 审查范围：本轮全部 A/B/C 代码与测试；旧固定提交双轴结果覆盖 A/B，新收尾复核覆盖到 `66d6000f`。文档另由独立代理核对，发现项已修正。
- main 保持 `dfb6d932`，集成分支保持 `b43a0921`；未 push、未发布包、未调整版本号，未合入 improve-3。

## 5.2 实际范围与 02 对照

| 范围 | 实施结果 | 保持的边界 |
| --- | --- | --- |
| 自有请求消息与工具 | ModelMessage、ModelToolDefinition、ModelToolCall；生产者与三个 adapter 同步 | system 继续在消息序列，不新增通用协议层 |
| 流式结果与调用入口 | messageSnapshot、reasoningText/Delta、callId、ModelFinishReason、streamResponse/toModelTools | 旧公开入口删除；快照不是请求或工具执行授权 |
| context / token-estimation | 新类型读取，私有 legacy-estimation 维持批准的旧数值 | tokenCounting、预算、校准和压缩阈值不改 |
| cache / usage | 新字段适配、三个公开蛇形 usage 别名删除 | inclusive/observed/partial、控制策略及数据库旧 usage 读兼容不改 |
| lifecycle / 观察桥 | 真实结果必有快照；无正文的观察 complete 省略快照 | 不扩 UI wire；scheduler 的 id 体系不改 |
| SQLite / UI 恢复 | 原始旧 JSON、两次真实 reopen、继续对话、新写原格式及 usage 唯一落点 | 不改 schema、Message/Part JSON |
| 公开包 / 本地请求 | 构建根包正负编译消费者、三协议 HTTP/SSE 工具往返通过 | 不以 source alias 或单 SDK 方法 mock 替代 |
| 真实 LLM 请求 | Responses/Chat 文本与工具往返通过；Qwen 定向诊断及清理后原 runner 均完整通过 | 分次补证，不宣称同次矩阵全绿；保留原偶发失败未定因 |

## 5.3 计划与实际差异

生产数据流按 02a 的 A/B 截面落地：复用现有 provider types 与 llm-client types，不另建消息包、管理器或扩展袋。A 同批完成内层快照与直接工具多轮回传，B 只集中改外层名称和入口，没有让两批之间靠强转维持编译。

三个 adapter 直接构造原生请求；SDK wire 字段仍保留原名。Responses 原生状态机、tokenCounting、usage normalizer/metadata codec、数据库 schema 和依赖清单没有生产改动。错误/取消/重试与工具执行门不借字段更名重设。

实际新增的收口项是两处根目录测试的失效 type-only `services/providers` 导入，改为真实 `interface-providers`；TUI fake config 同时补上既有必填 kind。此前运行测试会擦除类型，默认 typecheck/lint 又不覆盖这些根测试，因此能掩盖失效引用。本次只修当前调用方，不顺带清理全部根测试。

真实 T10 的三协议现已分次补齐成功证据，不能抹去先前网络失败和 Qwen 偶发失败。C 测试已提交并完成完整范围审查。用户最新要求 llm-client 改造说明独立存入子目录，原平铺五份文档恢复原内容；该文档落点调整不改变生产合同。

## 5.4 临时保留与后续工作

本轮是接口迁移，不是完整 Responses 能力上线。默认仍是 Chat；Responses 仍需显式选择、受限 stateless replay、store=false、observe-only cache，并拒绝无法保存的原生状态。Grok 的 improve-2 成功不代表原 Luna / DeepSeek Responses 失败已修复，更不能替代本轮重跑。

私有 [legacy-estimation.ts](../../../../packages/ohbaby-agent/src/core/context/legacy-estimation.ts) 只还原旧计量材料，不进入发送链、不从根包导出。用户最新将 improve-4 收窄为估算校准链路与必要字段/接口对齐，核心算法不变；不再默认授权替换计量材料或改变估值。缓存命中处理另排，完成后再检查 context 压缩及占用功能。原生状态保存/续接与全模块迁移验收继续另排。

实际移交点与待确认问题见 [下一阶段候选](./next-stage-candidates.md)。本轮技术验收已收口，用户尚待审核；该文档仍是候选与讨论输入，不是已批准的 improve-4 实施合同。

## 5.5 验证证据

### A / B 分批验证

| 批次 | 实际执行结果 |
| --- | --- |
| A | 完整 unit：235 文件、2457 passed、2 skipped；contract：17 文件、309 passed；integration：52 文件、349 passed；lint/typecheck 及提交 hook 通过；独立审查无阻塞 |
| B | 定向：41 文件、801 passed；完整 unit 通过；contract：17 文件、309 passed；integration：53 文件、352 passed；lint/typecheck/格式及提交 hook 通过；独立审查无阻塞 |
| C 定向 | SQLite/UI/Lifecycle 三文件 48 项通过；构建包消费者 1 文件 5 项通过；TUI 两文件 14 项通过；独立 C 审查无实质问题 |

A 完整 unit 曾三次在未改动的 daemon 启动诊断用例触发 10 秒超时；该用例隔离复跑及最后完整复跑通过。根因未确定，没有改 server 实现或测试超时。曾尝试的 VITEST_MAX_THREADS/MIN_THREADS 未控制实际 forks pool，不能把最终通过称为“单 worker 修复”。实施中的旧 fixture、类型引用及新增 matcher lint 问题均修正复测，不用启动输出冒充退出成功。

B 的 TDD 先复现旧快照名、伪造空正文和非枚举 usage 别名三项失败，再修改实现；新增实际 Lifecycle→worker→bridge 三例覆盖 reasoning/正文分离、wire 不变、部分工具参数与终态后 EOF 前取消均不执行工具。

### C 本地最终 preflight

最终完整复验 **exit 0**：317 文件通过、5 文件跳过；3229 项通过、16 项跳过。测试开始于 2026-09-13 15:28:47（Asia/Taipei），耗时 214.56 秒；format、lint、typecheck 和后续全 workspace build 全部通过。既有 skip 不算通过。

保留失败过程：

1. 第一次 C preflight exit 1：316 文件、3228 项通过，唯一失败是 CLI 包装安装阶段 180 秒超时；build 因测试失败未执行。
2. 隔离包装测试仍同样超时，exit 1。
3. 查看 registry 转发实现、当次 npm 日志及结束后的进程列表：本地 registry 仍需从 npmjs 获取第三方依赖，冷缓存日志出现 7–25 秒元数据请求；未发现本次测试残留进程。临时完整 npm 日志被既有测试清理，不能据此宣布已定位前次失败根因。
4. 未改 CLI 包装测试、timeout、依赖或 registry 配置；一次有界完整复验中安装用例 150.0 秒通过（文件 160.6 秒），并继续完成全部测试和 build。保留前两次失败，不称已经修复包装稳定性。

默认 eslint 不包含根 `tests/`。新增 compiled 测试采用命令级精确 allowDefaultProject 检查后通过，未修改仓库规则。额外检查发现根 lifecycle 文件 9 个既有 nested matcher any 错误、1 个既有返回类型 warning，及 TUI helper 3 处既有 control-regex 诊断，均在本轮新增用例之外。没有扩改这些存量；TUI 仅在额外命令中排除原有 regex 规则后核对类型问题无残余。不能写成“全根 tests lint 通过”。

### T1–T11 对照

| ID | 证据与结论 |
| --- | --- |
| T1 | 三 provider 测试及 prompt-cache-wire.contract：对照原生请求体、工具/schema、参数原文和控制字段；通过 |
| T2 | model-contract 与各 provider 测试：角色闭集、多模态、null/缺失/空串/空数组、Anthropic 空工具结果 JSON fallback；通过 |
| T3 | token-estimation.unit：迁移前固定总量、七桶字面数值、工具来源/tail/active reasoning、composition 缺失及批准键序边界；通过，不承诺任意输入完全等价 |
| T4 | llm-client、model-snapshot、Responses unit/integration：分片/错误/取消/retry/EOF 与工具执行门；通过 |
| T5 | database-store、lifecycle-tool-scheduler、ui-persistent：原始旧 JSON→物理 reopen→新投影/实际续跑→新写旧格式/每 step usage 一次→再次 reopen；通过 |
| T6 | model-response-transport、stream-bridge-run-event-source、manager 与 usage roundtrip：wire 不扩，观察 complete 无 snapshot/parsed calls，不伪造空回复；通过 |
| T7 | compiled-model-contract：真实根 exports 正向编译，29 个独立旧入口/字段负向文件逐个产生诊断，含 AgentRun 间接类型；通过 |
| T8 | summary/title、auxiliary-token-usage-isolation、subagent scope 与完整回归：purpose/scope/usage 隔离保持；通过 |
| T9 | 构建产物经生产 factory/SDK、三协议 loopback HTTP/SSE，各 3 次请求，共 9 次；检查完整请求体、调用关联、参数原文、工具只执行一次和 usage；通过 |
| T10 | 真实 ZenMux：Responses/Chat 通过，Qwen 后续定向诊断与清理插桩后的原 runner 均通过；分次补证通过，原失败未定因；详见历史与最新记录 |
| T11 | 本地 model-snapshot 直接多轮回传保留 raw argumentsJson、去 index、不强转部分结果；实际 goal 真实 fixture 同步新调用方；本地通过，未沿用旧真实成功 |

编译测试草稿独立审查曾发现负例可能因缺少新必填字段而误通过，以及超时只杀父进程就释放锁的问题；均先修正，再执行。现用有效新对象加单个旧字段或属性访问探针，并在构建超时后终止进程树、等待退出再释放锁。

### T10 真实请求失败与停止点

以下按各次运行保留当时结论；不是当前状态。当前状态以 §5.1、T10 对照及最后收尾记录为准。

执行 04 中可发现测试文件的显式命令，从根 `.env` 加载 ZENMUX_API_KEY，不输出密钥，不发送用户会话/仓库内容。没有设置协议筛选，三条批准路径都被发现。

2026-09-13 15:33:11 开始，32.09 秒结束，**exit 1：1 项凭据存在检查通过，3 项协议测试失败，零跳过**。

| 模型 / 协议 | 实际结果 |
| --- | --- |
| x-ai/grok-4.2-fast-non-reasoning / Responses | 首文本步骤约 10.54 秒后 `Real migration request failed (Error)`；没有成功 usage 或工具往返证据 |
| deepseek/deepseek-v4.1-flash / Chat | 首文本步骤约 10.52 秒后同样失败 |
| qwen/qwen3.8-flash / Anthropic | 首文本步骤约 10.52 秒后同样失败 |

当前 runner 在这一早期异常路径仅输出脱敏错误，没有输出捕获到的 HTTP 次数。因此只确认三条测试均开始了首文本步骤，不能给出精确实际 HTTP 次数或费用；每行第 4 次 fetch 前拒绝、SDK retry=0 和失败后停止新网络的既有保护仍在，总上限不变。下一次真实重跑前应补早期失败的安全计数记录，不输出请求 header、密钥或原始 SDK error。

随后做了两次**不带密钥、不生成内容**的 curl HEAD 探测：`https://zenmux.ai` 及强制 IPv4 的 `https://zenmux.ai/api/v1`。两次均 exit 28，HTTP=000；TCP 约 0.016/0.004 秒连接，TLS 尚未完成，约 10 秒超时。这证明当时存在 HTTPS 连接障碍，**不证明三个 E2E 的具体异常完全由同一原因造成，也不证明 API key、模型参数或生产代码已验证正确**。

真实生成请求在该轮失败后已停止，没有额外换模型、降协议、改参数或再次付费重跑。需要连接核查及下一轮明确预算授权后才能继续 T10。

## 5.6 SWE 与独立审查

### T10 追加复跑记录（2026-09-13 17:46）

用户明确通知恢复连接并授权再次执行真实 E2E 后，按相同三协议矩阵、参数和每行最多 3 次实际 fetch 的预算复跑；未更换模型或放宽生产边界。测试开始于 17:46:18（Asia/Taipei），耗时 32.20 秒，exit 1：凭据存在检查 1 passed，协议用例 3 failed，零跳过。

| 模型 / 协议 | fetch 尝试 / provider 调用 / 工具执行 | 结果 |
| --- | --- | --- |
| Grok / Responses | 1 / 1 / 0 | 首文本步骤 10.528 秒失败 |
| DeepSeek / Chat | 1 / 1 / 0 | 首文本步骤 10.506 秒失败 |
| Qwen / Anthropic | 1 / 1 / 0 | 首文本步骤 10.512 秒失败 |

三项均为脱敏的 `Real migration request failed (Error)`；没有成功正文、usage 或工具往返证据。本轮合计 3 次 fetch 尝试，不代表服务端接收数或计费数。runner 仅新增 finally 中的安全计数日志，记录模型、协议、fetch/provider 次数及工具执行次数，不输出请求正文、header、密钥或原始错误，也不改变请求或重试逻辑。日志保存于 `/tmp/ohbaby-responses-migration.aBpgnM/c-real-e2e-recheck.log`；前次失败记录保留。

复跑前无密钥 curl HEAD 仍 exit 28、HTTP=000，10.006 秒超时，TCP/TLS 均未完成；复跑后独立 Node 无密钥 HEAD 探测返回 `TypeError`，cause code 为 `UND_ERR_CONNECT_TIMEOUT`。这说明当前工具进程到 ZenMux 的连接仍有障碍，但不把独立探测当成三个生产异常的完整根因证明。未关闭 TLS 校验、修改代理/DNS、输出密钥或继续生成重跑。T10 仍未通过，C/完整提交复核及合并门保持未关闭。

### SWE 判断

#### Anthropic 后续定向诊断（2026-09-13 21:58–22:00）

用户授权继续小量诊断，必要时可另选 Anthropic 格式 DeepSeek 或低成本 Haiku。本次未换模型、未改参数或 tool_choice，也未修改生产实现。

- 基线证据：improve-2 的 Qwen 仅有文本预检，没有真实工具往返成功基线。旧版与当前都不发送强制工具选择字段。
- 离线差分：以 b43a0921 的 Anthropic adapter 对照当前实现，无参数工具 fixture 在 observe-only、top-level-auto、explicit-last-block 三种策略下原生请求相同，标准工具流转换相同。相关四文件 49 项本地测试通过。
- 第一轮诊断 21:58:06：将旧版动态回放加载置于在线流中的诊断实现发生干扰，首请求后 provider_stream_interrupted，exit 1；消耗 1 次 fetch，不能算生产回归证据。随后将回放移出在线流。
- 第二轮 21:59:04：同一 Qwen runner 增加只读事件结构记录，2 tests passed、exit 0、8.06 秒，3 次 fetch。原生块依次为 thinking/text、thinking/tool_use、thinking/text；结束原因 end_turn/tool_use/end_turn，工具执行一次且回传验证通过。未记录推理正文、signature 正文或密钥。
- 真实响应的脱敏结构离线回放：保留工具调用、参数增量和结束事件，正文替换占位，省略 message_start；三个响应在新旧 adapter 的输出逐项相同，工具增量数为 0/3/0。该对照只证明工具/终态转换一致，不宣称 usage 初始化或原生推理状态无损回放。
- 清理所有临时插桩后，原 runner 于 21:59:45 再跑 Qwen：2 tests passed、exit 0、11.59 秒，3 次 fetch、3 次 provider 调用、工具执行 1 次。文本 input/output/total=114/100/214，工具轮合计 753/126/879，usageComplete=true，均 stop/completed。日志为 `/tmp/ohbaby-responses-migration.aBpgnM/qwen-clean-recheck.log`。

本次共 7 次 fetch（诊断干扰 1 + 诊断通过 3 + 原 runner 通过 3），不继续换模型或付费重试。临时诊断已移除，runner 仅保留此前的安全计数日志；git diff --check 通过。

结论：没有证据支持 improve-3 引入了确定性 Anthropic 工具链回归；当前代码不改即可连续通过两轮。17:54 的失败未保存原生事件，无法据此断言模型未调用工具、网关异常或既有 adapter 缺口中的哪一个才是根因，也不能称其已修复。当前已补足 Qwen 的定向成功证据；历史失败与不稳定性仍需保留，C 和最终验收尚待收尾。

#### T10 TUN 模式复跑（2026-09-13 17:54）

用户启用 Clash Verge TUN 全局模式后授权再次执行。不添加代理环境变量；无密钥 Node HEAD 在 1.301 秒收到 HTTP 404，证明传输连通，不单独作为模型通过证据。相同三协议真实 runner 于 17:54:40 开始，18.79 秒结束，exit 1：3 passed（含凭据检查）、1 failed、零跳过。

| 模型 / 协议 | fetch / provider / 工具执行次数 | 验收结果 |
| --- | --- | --- |
| x-ai/grok-4.2-fast-non-reasoning / Responses | 3 / 3 / 1 | 文本及真实工具往返全部通过，4.870 秒 |
| deepseek/deepseek-v4.1-flash / Chat | 3 / 3 / 1 | 文本及真实工具往返全部通过，5.042 秒 |
| qwen/qwen3.8-flash / Anthropic | 2 / 2 / 0 | 文本标记及正 usage 断言通过；工具阶段正常结束检查通过，但执行次数应为 1、实际为 0，8.315 秒失败 |

本轮共 8 次 fetch 尝试，未超 9 次预算。Responses 的文本 usage 为 input/output/total=245/32/277，工具轮合计 637/35/672；Chat 分别为 84/42/126 与 736/84/820，均 usageComplete=true，结束为 stop/completed。两条通过路径还检查了原生工具结果关联、只执行一次及结果标记回传。Anthropic 在工具执行次数断言停止，不能补写后续工具 usage、结果匹配或回传成功；现有日志不足以区分模型未产生工具调用与适配链路丢失等原因，需另行调查，不能归因于网络或宣布已修复。

日志：`/tmp/ohbaby-responses-migration.aBpgnM/c-real-e2e-tun.log`。未改模型、参数、生产代码、TLS 或代理环境变量，未因失败再发生成请求。前两轮网络失败历史保留；当前停止点改为 Anthropic 工具验收缺口，整体 T10、C 提交及完整提交审查仍未关闭。

实施取舍符合当前阶段的 KISS 和信息隐藏：自有值类型替代 SDK 请求耦合，原生差异留在 adapter；没有为了三家协议建立新的消息框架。估算临时 helper 的重复形状是受“旧数字不变”约束的显式过渡成本，不是发送桥。仅在未来另批获准替换计量材料并完成回归后评估退出，不承诺在 improve-4 删除。

工具副作用、流结束与观察投影仍分开，SQLite 写入继续经过原 Message/Part 边界；没有把显示快照当作可执行状态。外部调用重试、取消、严格 Responses 拒绝边界按既有规则回归，未用扩大权限、关闭 TLS 验证或吞错误解决失败。

分批 A/B 与 C 独立审查均未发现实质阻塞；构建测试草稿的两项测试可靠性问题已修正复核。以下固定提交复核只覆盖 A/B，C 的最终提交范围审查尚待 T10 门通过。

### Standards

无发现（0项）。独立代理只读核对`b43a0921...7fd55e04`的26个生产文件、eslint.config.js和Fowler全部24条异味基线，未发现需修改的规范违规或实质异味。贯穿式改名、provider边界投影与临时估算兼容层不构成额外抽象或集中重构的理由。只覆盖已提交A/B，不包含C工作区，不代表整个improve-3验收完成；代理未运行测试、构建或网络。

### Spec

0项实质偏离，仅覆盖已提交A/B。独立代理对照02/02a和data-model §5–6，确认请求/结果、角色/内容闭集、独立adapter、原始参数、观察快照缺失、usage别名与私有旧估算桥符合批准方案；存储格式、调度、cache策略、默认协议、原生续接等Non-Duties未扩张。04要求本地与真实E2E通过，本地成功不能补足三条真实路径失败；C未提交不归为A/B生产缺陷。代理未运行测试或网络。

本次固定提交复核：Standards 0项，Spec 0项，均无最严重发现；范围仅A/B。整体仍为部分通过，不将两个局部零发现合并成完整验收成功。

## 5.7 重要文件与下一步

- [唯一字段合同](./design/data-model.md)、[跨模块批次清单](./02a-cross-module-interface-migration.md)、[公开 API 迁移说明](./public-api-migration.md)。
- [自有请求类型](../../../../packages/ohbaby-agent/src/services/interface-providers/types.ts)、[结果类型](../../../../packages/ohbaby-agent/src/core/llm-client/types.ts)、[流式入口](../../../../packages/ohbaby-agent/src/core/llm-client/streaming.ts)。
- [构建包验收](../../../../tests/integration/compiled-model-contract.integration.test.ts)、[实际传输链测试](../../../../packages/ohbaby-agent/src/adapters/ui-runtime/model-response-transport.integration.test.ts)、[SQLite/Lifecycle 续跑](../../../../tests/integration/core/lifecycle-tool-scheduler.integration.test.ts)、[真实请求 runner](../../../../tests/smoke/responses-migration.real.e2e.test.ts)。
- [llm-client 本轮独立改造说明](../../../core/llm-client/openai-response-miagration-improve-3/README.md)、[improve-4 候选与待确认决策](./next-stage-candidates.md)。

下一步：用户审核本轮实现与收尾文档，明确同意后才合入 openai-responses-migration。improve-4 按最新收窄边界另行规划；不合 main、不 push。

## 5.8 最终收尾复验（2026-09-13）

本次完整 preflight exit 0：测试开始 23:02:16，222.66 秒；317 文件通过、5 文件跳过，3229 项通过、16 项既有跳过，format/lint/typecheck 和全 workspace build 全通过。CLI packaging 文件耗时 189.006 秒并通过；未修改 timeout 或生产代码。日志：`/tmp/ohbaby-responses-migration.aBpgnM/closure-preflight.log`。本次未新增真实 API 请求，采用前文同一生产实现下各协议成功证据，不抹去历史失败。

完整范围只读审查覆盖 b43a0921 到 A/B HEAD 加 C 测试工作区，未发现阻断提交的生产或测试缺陷；没有把这次静态审查称作代理运行了测试。第二位文档代理核对新模块说明、实际接口、最新 improve-4 边界与相对链接，发现两项：旧 helper 的退出时间承诺越过新边界、config.kind 表述不精确；均由主代理修正，代理复核关闭。原五份 llm-client 平铺文档与 HEAD 完全相同，新增/变更文档共 53 个相对文件链接目标存在。

SWE 收尾判断：保留原文档并建立本轮独立说明，没有引入新的消息框架；测试覆盖真实发布入口、存储恢复和执行门，而不是仅验证类型更名。估算、cache、窗口占用与压缩算法保持边界。尚未定因的 Qwen 偶发失败和 CLI 安装耗时作为残余风险保留，不宣称稳定性已修复。

用户审核仍是合并前置条件；本轮无 push、无 merge，main 和集成分支不变。improve-4 当前只有按用户新要求收窄的候选与代码调查入口，不是正式实施计划。
