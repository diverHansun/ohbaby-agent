# 04 · 测试与验收标准

本文件定义后续实施的验收门，**不是本轮已通过的报告**。核心目标是证明自有结构可靠、旧 Chat 中间格式可删除、最小修复没有改变压缩策略。沿用 Vitest unit／contract／integration 与 preflight，不另建测试体系。

## 1. 可靠性矩阵

| ID                   | 必须证明的行为                                                                                                                                                                                 | 测试位置／方式                                                                                                             |
| -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| T1 · 自有契约        | 通用角色／文本／工具定义与调用结果合法；旧 tool_calls/tool_call_id/function 形状不能进入自有边界；无 any 或双重断言绕过；未支持内容明确拒绝                                                    | 扩展 provider model-contract 与 context prepared-request contract；类型编译负例与运行时验证                                |
| T2 · 三协议实际转换  | 同一通用样例经过生产 builder：Chat nested tools/tool_calls、Responses instructions/flat tools/function_call/output、Anthropic system/tool_use/tool_result 均保留内容、调用 ID、结果关联和顺序  | 真实 provider 映射＋fake transport 捕获；不能只测另写的映射 helper                                                         |
| T3 · 参数与少见内容  | 空文本／空结果、多调用、参数中空格转义／Unicode、支持的媒体／name 等不丢失。Chat/Responses 保持支持的 argumentsJson 原文；Anthropic 的对象转换按协议验证语义等价，不能承诺 JSON 字节一致       | model-contract 与 provider contract；固定可读 expected，避免 expected 再调用生产映射                                       |
| T4 · 原生状态        | 三协议支持的原生数据同源持久化→重开→回放保真；ID／顺序／phase／signature／opaque 值保留；通用镜像冲突／坏版本／错误 origin／未知 item 拒绝；跨源已完成降级，未完成保护                         | native-state、serializer、native-policy／SQLite integration，加生产发送捕获                                                |
| T5 · 估算材料        | system/memory、summary wrapper、whitelist、tools、调用参数和结果、tail directives、活动推理覆盖；tools=[] 不带上一步工具；不 stringify 完整 ModelState；不把镜像重复估算                       | token-estimation、native-context；独立材料样例＋实际 builder 内容断言                                                      |
| T6 · 不透明数据      | 同 response 多块共享一次 proxy；reasoning→output→max output 来源保持；signature 长度不影响文本估算；已过滤 state 无 proxy；Chat 镜像推理文本去重                                               | native-context/native-policy 与 provider 状态测试                                                                          |
| T7 · 分类修复        | native subagent_run/status/close 调用及结果进入 subagent-exchanges；同条文字／推理留 conversation；只改计量贡献，发送 items 不拆不重排；只有 modelState 不同也不能通过来源匹配；缺来源整体省略 | token-estimation composition 回归＋native replay 对照                                                                      |
| T8 · 用量合同        | raw、校准后 input、actual input 不混用；因子只应用一次；同一次最终 sentHeuristic 配 accepted input；cache input 不扣除；UI 分母 window，触发分母 input budget；辅助 usage 隔离                 | manager/lifecycle/window-usage/cache 既有测试；扩展新材料样例                                                              |
| T9 · 摘要终态        | 正常耗尽＋stop＋非空才返回；非空 length/content_filter/tool_calls、无终态 EOF、完成后异常均失败；取消保持 AbortError；stop 空文本保留原重试上限                                                | prompt-context 使用真实 streamResponse＋fake provider；manager/store 联测证明失败不退休候选                                |
| T10 · 摘要工具语义   | 两个不同动作即使 output 相同或为空，摘要输入也能分辨名称／输入／状态；aborted 部分输出保留且不伪造完成；metadata 白名单和脱敏保持；无密文／签名进入摘要                                        | serialization 摘要用途 fixture＋summary client 捕获实际请求                                                                |
| T11 · 算法不变       | prune 工具 output 评分、普通历史评分、mask 条件与材料、overflow 的历史评分保持；normal/aggressive、阈值／cap／thrash、force 例外不变；native 合法切点保持；完整候选未变小不提交                | policy/manager/state-machine 回归；丰富摘要材料前后对同一历史比较策略评分，固定数字且不调用新摘要 serializer 生成 expected |
| T12 · 持久化和语义   | prune 成功后摘要失败／abort，prune 保留、候选不退休；summary 原子写；stale 零候选写、安全尾部追加保留；重开后 compacted native 不复活                                                          | compaction-atomic/hard-crash/native-state integration                                                                      |
| T13 · 累积与有损恢复 | 连续两次摘要保留旧摘要，新摘要不再输入旧摘要；overflow 只缩摘要输入，成功仍退休原选段；断言哪些轮没给摘要模型、哪些 Parts 退休；补充工具事实导致较长摘要输入时仍有界恢复                       | manager/summary-overflow 集成；不能只断言调用次数                                                                          |
| T14 · 快照与 scope   | static tools-aware 总量；缓存命中仍为最后 prepare/compact 快照；manual usageAfter 更新并清旧分类；connect reset；主子 scope 隔离；只读查询无写入／压缩／校准副作用                             | ui-runtime/ui-inprocess/tracker＋context scope 集成                                                                        |
| T15 · 跨模块回归     | context:prepared→worker→raw bridge→tracker 以及 bridge→LifecycleEvent 两分支不丢 composition；SDK/UI 不破坏；overflow 重试使用新请求估算；cache 与 reasoning 继承不回退                        | 既有 transport、lifecycle、SDK 和 reasoning/cache 集成                                                                     |
| T16 · 删除与全量门   | legacy 文件及生产引用删除；SDK Chat 类型仅在合法边界；旧 usage 存储仍可读；新数字有依据；typecheck/preflight 通过                                                                              | 定向依赖搜索＋全仓编译、测试、构建                                                                                         |
| T17 · 真实续接       | 三协议各自完成实际工具往返→真实压缩→继续请求→SQLite reopen→继续；记录估算、actual inclusive input、摘要状态和协议结果                                                                          | 复用 5.5 的正式 persistent-agent harness，见 §3                                                                            |

T1～T8 对应 Stage A/B，T9～T13 对应 C，T14～T17 对应 D。多数位置已有测试；新增风险用例尚待实施。T9 的成功 mock 必须含真实规范化 finishReason，不能继续用仅 isComplete 的不完整 fixture 验收新合同。

“旧 Chat 可以删除”的证据需要同时有**编译依赖检查、三协议语义转换、原生持久化回放、实际计量集成**。单靠字符串搜索或旧测试全绿不够。协议没有共同支持的能力单列限制，不伪造三协议全功能对称。

## 2. 本地执行门与已有证据

最新触发口径单独验收：metadata 检测到的完整窗口进入 profile/counter 后，界面分母和自动摘要分母一致；94.999% 不摘要，95% 与以上进入摘要；输入预算即使耗尽也不提前摘要。保留 force、mask／thrash 和上游超限恢复测试。

本次规划复跑命令：

```sh
pnpm exec vitest run \
  packages/ohbaby-agent/src/services/interface-providers/model-contract.unit.test.ts \
  packages/ohbaby-agent/src/services/interface-providers/native-state.unit.test.ts \
  packages/ohbaby-agent/src/core/context/native-context.unit.test.ts \
  packages/ohbaby-agent/src/core/context/native-policy.integration.test.ts \
  packages/ohbaby-agent/src/core/context/token-estimation.unit.test.ts \
  packages/ohbaby-agent/src/core/context/serializer.integration.test.ts \
  packages/ohbaby-agent/src/core/context/context-window-usage.unit.test.ts \
  packages/ohbaby-agent/src/adapters/ui-runtime/prompt-context.unit.test.ts \
  packages/ohbaby-agent/src/core/context/compaction-atomic.integration.test.ts \
  packages/ohbaby-agent/src/core/context/native-state.integration.test.ts \
  packages/ohbaby-agent/src/core/context/prepared-request.contract.test.ts
```

2026-09-15 结果：**11 文件、82 测试通过**。仅说明当前基线的这些测试通过；P1～P6 尚未实施，不是本轮验收通过。

实施后先跑改动对应定向测试，再执行：

```sh
pnpm exec vitest run packages/ohbaby-agent/src/core/context packages/ohbaby-agent/src/core/lifecycle packages/ohbaby-agent/src/adapters/ui-runtime tests/integration/core/context-subagent-scope.integration.test.ts tests/integration/core/context-agent-concurrency.integration.test.ts
pnpm preflight
```

provider 新增测试按实际文件加入定向命令。旧“保持迁移前数值”快照应替换为新材料对应的固定预期，保留语义覆盖和前后差异说明；不能删除困难用例，也不能继续留旧生产转换只为通过旧快照。

本地 fail-closed、重试、并发和 crash 用确定性测试完成；`.real.test.ts` 默认开关和凭证方式沿用仓库约定。普通 Vitest 通过不代替实网。

## 3. 实网验收的最小范围

复用 improve-5.5 的正式 persistent-agent harness、真实 store 和 Lifecycle；优先扩展已有脚本，只有入口难以复用时再建薄入口，不能复制一套 agent 接线。脚本接收明确 profile、模型和日志目录；每协议设置实际请求总上限（建议 20 次，含重试），到限记录未完成，不能无限换模型刷通过。

每协议选择一个已确认支持目标能力的路由，执行：

1. 文本及无外部副作用的工具往返，保存原生状态。
2. 对受控旧历史手动 force，调用真实摘要模型；核对正常终态、摘要可读性和 before/after。
3. 压缩后继续请求，检查工具关联、保留历史和 native 状态合法。
4. 关闭并重新打开 SQLite/runtime 后继续请求，验证退休状态不复活。
5. 确认摘要 usage 不进入主代理校准/cache，reasoning 继承正确。

记录 raw estimate、校准后 estimate、actual inclusive input、误差、proxy 来源、摘要状态与请求成功情况。日志不含凭证、完整密文或签名。人工读受控摘要样本，检查目标、约束、已做工具动作和待办是否可理解。

不预设所有模型统一误差百分比。通过重点是内容可靠、估算配对正确、协议可继续、失败有边界；新材料不保证每条路由立即更接近实际 token。预算公式本轮未变，不把预算精确对齐实际 maxTokens 写成通过项。

实网 force 压缩不能证明真实自动越阈值和真实 upstream overflow。后两者本轮主要以本地确定性用例覆盖；若另外实测，必须列独立 upstream 证据。无可用凭证／路由时如实列未执行，不能把 mock 当实网完成。

## 4. 验收交付与残余限制

实施完成后创建本轮 05，记录基线／提交、T1～T17 状态、准确命令、三协议分项结果、估算前后样例、文件级改动、独立审查与未执行项。

保留的限制：启发式不是精确 tokenizer；既有媒体估算有误差；旧摘要继续累积；overflow 恢复可能有损；输出预留仍是现有策略；tracker 显示测量快照；三协议各自支持范围不同。

验收不得将“结构传递可靠”扩大为“摘要永远无损”，也不得将已实施的历史能力包装成本轮新建。对比参考项目的新压缩／prune 算法不进入本轮验收。
