# 4. 测试与验收标准

> 本文定义验收要求；实际执行、差异与限制见 05/06，不由本表自动宣称通过。遵循仓库 [docs-test](../../../../docs-test/README.md) 的分类、命名、真实组件与外部依赖隔离规则。验收对象为 02 的完整 A–F 改动。

## 4.1 测试组织与每批门槛

- unit：纯配置解析、参数映射、状态累积、估算材料、样本可信判断，co-located `*.unit.test.ts`。
- contract：三协议 SDK 消费、wire 请求与 SSE 形状，自有类型与公开投影；可用本地 HTTP/SSE fake，不能直接伪造最终成功事件绕过 adapter。
- integration：真实 config/client/adapter/Lifecycle/Message/Context/store/tracker 协作，仅替换外部 LLM/计费网络。跨模块放 `tests/integration/`，SQLite 测试用临时文件并真正关闭重开。
- real E2E：新增 `tests/smoke/reasoning-native.real.e2e.test.ts` 和 `scripts/run-real-native-reasoning.mjs`，沿用既有真实请求测试的显式启用规则，显式启用；普通 `pnpm test` 排除 e2e，不能据它通过声称真实接口通过。

每批：先确认固定故障样本在基线变红 → 实现 → 定向 unit/contract → 本批涉及的 production-component integration → 复查上一批保护。后续依赖批次不能用“类型先写了”跳过实际运行验收。B 单独完成不得发布默认开启。

## 4.2 测试矩阵

| ID  | 批次 | 类型/场景                | 必须断言                                                                                                                                                                                                                                       |
| --- | ---- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T01 | A    | 基线故障样本             | phase、created queued、Anthropic 初始 input/空 delta 在旧代码能复现对应错误；不是人为删字段的假样本                                                                                                                                            |
| T02 | A    | 能力表 contract          | SDK声明、平台样本和本地规则来源对应；medium/none/二态/非推理/未知各自行为明确                                                                                                                                                                  |
| T03 | A    | 原生状态合同             | 自有判别类型、来源、版本、序列位置、最终补全、内部投影已定义；多个text/message/phase合并显示后仍原样回放且不双发；unsupported item 负向样本保留；Chat 规范字符串 index／同 index 不同 type／后补重复 id 的正负向样本保留                                                                                                |
| T04 | A    | 隐私/基线证据            | 入库 fixture 无 key、Authorization、用户私有提示词；忽略目录外有可独立运行的正式样本                                                                                                                                                           |
| T05 | B    | config unit+integration  | 旧无reasoning配置得到默认on/medium；关闭/开启/显式强度；逐字段合并off/high+仅覆盖low仍off；disabled时不因暂存effort不适用而拒绝合法关闭；writer往返；0温度不误判missing；省略不补0.2/1                                                         |
| T06 | B    | 三协议 wire contract     | 用生产 serializer/SDK fetch捕获HTTP body，分别断言Chat/Responses/Anthropic开关、effort/budget及温度；错误字段不存在                                                                                                                            |
| T07 | B    | 能力负向                 | 非法强度、medium不支持且无映射、旧budget超总额、未知路由、off不支持均在调用前明确失败；零生成请求                                                                                                                                              |
| T08 | B    | 父子配置 integration     | 父high→子high；父off→子off；默认父→二态/非推理子走默认兼容，显式medium→二态子报错，显式on→非推理子报错；不同模型重新校验；并行session/sibling不串值；排队任务固定入队快照；后续新任务可取新快照                                                |
| T09 | B    | purpose integration      | 真实title/context-summary调用使用2.2策略；主high不影响标题；主/子compact分别继承所属代理当前开关和effort，不注入medium；子compact使用子所属scope；共享client.config未改；不新增工具effort参数                                                  |
| T10 | C    | Anthropic input contract | start.input={}且无delta、只有空delta、start完整对象、非空增量、多个工具交错；输入恰好正确；非法JSON/冲突/截断仍拒绝                                                                                                                            |
| T11 | C    | Responses状态机          | created queued可到in_progress/completed；created后EOF、错误terminal、ID冲突、非法倒退仍失败；支持queued不代表支持后台任务                                                                                                                      |
| T12 | C    | phase/item parser        | message phase保留；合法reasoning接受；不认识的item/phase值明确失败；不删除原始字段来让样本通过                                                                                                                                                 |
| T13 | C    | 旧负向回归               | SDK流异常、权限失败、非法工具参数、不支持hosted/refusal/annotation等保护保持原合同                                                                                                                                                             |
| T14 | D    | 同Run多步 integration    | native reasoning→工具1→带结果/状态请求→工具2→正文；断言每次请求完整序列与真实工具执行次数，不只检查最终文字                                                                                                                                    |
| T15 | D    | terminal补全             | done缺失密文时terminal补全；done已有密文则按SDK回放done值，允许terminal重新封装；其余结构冲突及重复done冲突仍失败、不双写                                                                                                                                           |
| T16 | D    | 尾部异常/取消            | 提前complete后throw、网络EOF、reasoning分块中abort：工具执行0次，无可回放partial state；不把reasoning事件当Step                                                                                                                                |
| T17 | D    | overflow重试             | 同Step第一尝试已有complete随后overflow；第二成功用量与state不同；只保存/观察第二次，单次cache增量；不可用Set掩盖第一次非最终快照                                                                                                               |
| T18 | D    | 保存失败                 | 模型成功且输入1000/read600已接受，再注入commitModelStep失败：Run失败、工具0次、tracker恰增1000/600且不撤销；事务每写点故障/进程中断后SQLite reopen无半套集合；提交后未执行工具不自动重放副作用                                                 |
| T19 | E    | 下一Run/数据库恢复       | 同session下一用户消息及SQLiteclose/reopen均有合法续接；读取旧无state记录；未知版本不给伪造原生回放                                                                                                                                             |
| T20 | E    | 模型/接口/endpoint切换   | 不兼容opaque/signature不发送、不转正文；已完成通用历史保留；未完成往返切源明确失败；切回时不复活已压缩state                                                                                                                                    |
| T21 | E    | 开关/档位切换            | on→off→on，medium→high；按平台规则回放历史，cache不清零；没有用户授权的静默降级                                                                                                                                                                |
| T22 | E    | 手动/自动压缩/prune      | 真实contextmanager执行；已完成且达到prune条件的native工具单元同样跳过prune，普通工具仍可prune；summary选段保完整已结束单元；成功提交后state/text/tool同事务inactive；空/截断/失败摘要不改变有效历史                                            |
| T23 | E    | 私有投影 contract        | model-state不出现在UI文字/reasoning文本、SDK公开snapshot、summary输入、普通日志；内部DB可恢复；新Part不落入tool兜底分支                                                                                                                        |
| T24 | D/E  | usage与length            | output已含reasoning只加一次；缺总量不由子量补；reasoning-only/incomplete/max_tokens有可信usage仍沿现有位置计；未完成工具不执行                                                                                                                 |
| T25 | E    | 估算/校准 integration    | 明确reasoning子量(含0)优先、缺子量用总output、两者缺用同请求maxoutput；纯签名不再加一份；SQLite reopen代理值与来源一致；密文长度不是token数；多块一份opaque代理；切源/压缩后不回传则不加；same-request actual/heuristic匹配；无state旧估算不变 |
| T26 | E    | 主子/持久usage/cache     | 每Step至多一个Part有usage，text/tool/state优先级正确；恢复不重新记账；两个子scope互不串扰；子与辅助不进主hit，子正常路径有静默记录                                                                                                             |
| T27 | F    | improve1～5回归          | SDK、独立kind、工具边界、自有类型、用量校准、session cache全部通过；见4.4                                                                                                                                                                      |
| T28 | F    | 三协议真实E2E            | 三协议各有实际on/medium及off文本/工具续接；Responses与Anthropic至少各一个on样本实际产生目标reasoning/thinking原生状态且下次wire保真回传，不能只测phase；报告真实接受Step、请求参数、usage和应用累计，非仅200                                   |
| T29 | F    | 真实扩展/统计报告        | 目标平台按支持组合逐行测试，主/子归属可追溯；unknown、0、nonzero明确区分；不以命中高低替代正确性                                                                                                                                               |
| T30 | F    | 文档/代码独立审查        | 00→02→04对应，实际结果写05，问题修复后复验；未运行/不支持/失败不得标通过                                                                                                                                                                       |

P1 对应 T02/T05–T09；P2 对应 T01/T03/T11–T17；P3 对应 T01/T10/T14；P4 对应 T14–T23；P5 对应 T19–T25；P6 对应 T17/T24–T26；P7 对应 T08/T09/T26；P8 对应 T27–T30。

## 4.3 两个必须走真实组件的集成骨架

### 骨架一：配置到工具第二轮

通过实际后端配置构造 client，以本地HTTP/SSE fake替换LLM网络。让生产 adapter、streamResponse、Lifecycle、Message、Context运行两次工具及下一用户Run。抓取每次wire body，断言父子配置、原生状态顺序、工具参数与来源；工具本身用可计数的无副作用fixture。

不要mock streamResponse直接返回已解析工具，因为这样看不到本轮曾出现的initial-input丢失、phase拒绝和reasoning状态丢失。

### 骨架二：统计与恢复

在生产 `LifecycleSessionParams.onStepUsage` 上连接真实 `createPromptCacheUsageTracker`；另外跑真实ui-inprocess backend确定性集成验证最终公开status。SQLite保存完整消息，关闭重开后继续请求。恢复可续接，但当前进程cache只统计新接受Step，不能扫描旧usage重新触发回调。

样本：输入1000/读取600，下一可信输入9000/读取0，最终session hit=6%；中间插入缺明细Step不改变可信分子分母。输出reasoning任意增大不改变当次输入比例。校验主子scope，不能只在测试里独立手算6%。

## 4.4 improve-1～5 回归门

| 前序      | 必须保持                                                                                                            |
| --------- | ------------------------------------------------------------------------------------------------------------------- |
| improve-1 | 安装SDK正常消费三协议fixture；认证、取消、SDK错误传递、有限重试正常；升级不是本轮默认修复手段                       |
| improve-2 | 独立openai-responses kind；不按URL自动切协议；成功耗尽流后才允许工具；未新增能力继续明确拒绝                        |
| improve-3 | core不重新导入Chat/Responses SDK消息类型；snapshot不是可执行消息；工具call ID、arguments及顺序一致                  |
| improve-4 | inclusive input，output含reasoning，total=input+output；一次输出预留；same-request校准；每Step至多一份持久usage     |
| improve-5 | 可信Step加权；unknown保留历史、已知0为0；不依赖整Run usageComplete；换模型/压缩不清；无子/辅助合并；无重启cache恢复 |

## 4.5 执行入口

在仓库根执行已有脚本；定向测试按本批新增文件和上述模块选择实际路径：

```bash
pnpm exec vitest run packages/ohbaby-agent/src/services/interface-providers
pnpm exec vitest run packages/ohbaby-agent/src/config/llm packages/ohbaby-agent/src/core/llm-client
pnpm exec vitest run packages/ohbaby-agent/src/core/lifecycle packages/ohbaby-agent/src/core/context packages/ohbaby-agent/src/core/message
pnpm run test:unit
pnpm run test:contract
pnpm run test:integration
pnpm run preflight
```

最终必须包含显式格式检查本轮文档，因为根 format:check 默认未覆盖 docs：

```bash
pnpm exec prettier --ignore-path /dev/null --check 'docs/problem-lists/2026-09-11-llm-sdk-and-responses-migration/improve-5.5/*.md'
```

现有真实请求入口为 `pnpm run test:cache:real:accounting`，实现配置扩展前不能直接把旧profile当5.5验收。F 批扩展该runner/harness以明确选择模型与reasoning组合，保持默认不跑付费测试，并在05记录实际可重放命令、profile、时间和HEAD。普通Vitest命令排除 `.e2e.test.ts`，不得用passWithNoTests兜底声称E2E通过。

不要求每批重跑全部仓库；每批跑相关单元/集成，F 跑完整preflight。失败记录真实命令、原因和修复后重跑结果，不将旧通过数字复制为新结果。

## 4.6 真实请求矩阵与停止条件

先确认实际平台/模型支持和合法配置；不根据兼容URL名称猜测协议能力。第一优先复验曾失败的组合：

| 平台/模型                | 核心协议                             | 目标                                                   |
| ------------------------ | ------------------------------------ | ------------------------------------------------------ |
| ZenMux GPT-5.6 Luna      | Responses + Chat                     | phase/reasoning、默认medium、明确off、工具结果回传     |
| ZenMux Claude Sonnet 5   | Anthropic                            | 合法采样配置、thinking/signature、空参数工具、多步回传 |
| 百炼 Qwen3.8 Flash       | Responses + Chat（实际支持时）       | created queued、reasoning、cache读取明细               |
| ZenMux DeepSeek V4 Flash | Chat；其他协议仅在平台明确支持时扩展 | 强度能力真实映射、原有文本/工具/cache回归              |
| 智谱 GLM-5.3             | Chat；其他协议依实际支持             | 第三方配置映射和可信usage                              |

不能把“ZenMux原生模型”写成“已直连OpenAI/Anthropic原厂”。ZenMux模型来源与HTTP服务入口分别记。用户提供的模型路径是候选，不保证届时全部有效或全部支持medium；不支持项明确列出，不偷偷换模型合并结果。

每个已支持的核心组合执行两个独立session：on/medium与off。每个session做工具往返及下一用户Run，至少包含首次生成→工具结果回传→后续正常请求；再选每协议一个组合改变到另一支持档位，验证用户可调整。真实请求使用生产配置，无删phase/改status/手工补reasoning的wrapper。

Responses与Anthropic各至少一个on样本必须实际出现本轮目标reasoning/thinking原生状态，并核对下次wire中必需内容、顺序与工具关联（可以哈希/结构断言，不要求可见思考）。只出现phase、或adaptive未产生thinking，记“原生续接真实覆盖不足”，不能仅因on/off均200与工具成功宣称该门通过。Chat实际返回必要reasoning_details等时同样核对；未返回则固定样本覆盖与实网限制分开。

有界执行：每个模型/协议/模式profile最多4次生成HTTP，SDK自动重试在验收profile中设0，单请求90秒超时；每个问题最多2次有标记的追加诊断HTTP，合计每profile不超过6次。中途401/403/确定性400立即停止该profile。若多步流程在额度内无法完成，记录未完成，不无限重跑；需要更长流程时先调整测试profile预算并记录原因，不为等cache命中重试。

cache验收无非零门槛。分别保存去密钥的wire参数摘要、原始usage子树、accepted Step事件、生产tracker累计、工具执行次数及结果。缺明细写unknown而非0；失败无acceptedStep不得产出伪百分比。summary质量用固定上下文中的关键约束清单检查是否保留，空/截断摘要必须拒绝提交；记录延迟与输出消耗，不凭单次模型回答宣布某个强度最优。

## 4.7 发布门与诚实报告

1. A–E固定样本及生产组件集成全部通过；默认开启不会绕过尚未接通的原生续接。
2. 完整preflight通过；新字段边界、数据库重开、压缩、主子隔离和估算均有实际证据。
3. 三协议至少各有一个已支持模型完整on/off真实工具续接；Responses与Anthropic的真实原生状态回传覆盖达到T28，未触发不能算通过；目标曾失败组合分别给出结论。平台不可用或模型无off不伪造通过，应明确该模式未覆盖，不能给全矩阵通过结论。
4. 统计与供应商usage逐Step对账一致；比例显示的舍入误差之外，token整数一致。推理输出子项不重复加总，runtime/持久覆盖范围分别说明。
5. 独立代码审查无未处理阻断；05记录实际与规划差异。非零cache、延迟最优、所有模型兼容不是本轮承诺。

报告至少包括：模型/平台/协议、能力来源、请求开关/强度/温度、请求数/acceptedStep数、输入/输出/可用推理细分、cache read和累计比例、工具往返、恢复/压缩覆盖、结论与限制。原始密文/签名无需完整公开，使用长度/哈希或测试断言证明保真；密钥不落日志。

## 4.8 对抗性检查

- 提前complete看似成功但尾部错误：工具0执行、无有效partial state；残余风险由完整SSEfixture覆盖。
- 同Step overflow两个不同最终样本：仅保留成功尝试，不能用ID去重选择第一个。
- terminal补全与重复快照：按SDK选择done密文或缺失时terminal补值，不双计usage；其他结构冲突拒绝。
- 私有Part被默认当tool或公开：穷举分支/DTO白名单断言；新增类型不能依赖any逃过检查。
- 压缩后native状态复活或估算漏掉：实际下一次wire、active state、估算材料同时断言，不能只测压缩函数返回值。
- medium配置“看起来已传”但网关忽略：报告区分HTTP接受、参数在wire、平台能力证据，不能从返回思考文字倒推实际effort。
