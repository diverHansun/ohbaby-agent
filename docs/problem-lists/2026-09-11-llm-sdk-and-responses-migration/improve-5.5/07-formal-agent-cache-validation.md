# improve-5.5 收尾：正式 Agent 链路的缓存验证

日期：2026-09-15。实现基线 `ddcaea72`，分支 `codex/improve-5.5-reasoning`。本次只新增验证工具、测试与报告，没有修改生产 prompt、缓存控制、推理适配或累计公式。原来的 [06 短续接验证](./06-real-native-reasoning-validation.md) 保留原样，其 0% 仍是当时的真实结果。

## 1. 这次究竟怎么跑

在持续的 Node 交互进程里，逐条调用正式 `createPersistentUiBackendClient` 的 `submitPromptAndWait`，相当于用户在客户端一条一条发消息。每个协议使用独立配置目录、工作目录、SQLite 和 session；同一个协议的后续消息明确传回同一 session ID。

完整链路是：

`用户消息 → 持久化 backend → prompt scheduler → RunManager / AgentService → Lifecycle → 生产 system prompt / ContextManager → 真实 SDK 与接口 → 内置工具 → SQLite → 生产 /status`

没有手写模型 HTTP 请求，没有替换 system prompt builder、token counter、ContextManager、工具执行器或 cache tracker。LLM 工厂调用真实 `createLLMClient` 后，只在 provider 边界记录用途和最终用量；fetch 观察器原样转交参数及原 Response，异步读取副本。标题请求没有禁用，压缩也调用正式 `compactSession({force:true})`。

验证材料只有一份四行文件 `cache-note.md`：项目 Cedar、版本 17、负责人 Lin、只读约束。没有为刷 hit 注入长 system prompt。生产 prompt 自己就足够长：主请求的 system 结构约 14,374 字节，加上生产工具定义和运行环境，真实输入在数千到一万多 token。

最初三次用户 Run 分别要求：读取文件并回答三个事实；不再读文件、回答负责人；第三次从会话重述三个事实。之后执行真实压缩，再从压缩后的会话回答。Chat 额外在同一 backend/session 中把 medium 改为 high，然后再压缩，检查继承与累计。

正式用户操作会触发权限流程。Chat 的第一 Run 先请求 `skill(using-superpowers)`，检查后只放行这一次只读加载，再正常执行 `read`。没有改为 full-access，也没有替换或跳过 scheduler。

## 2. 怎样判定统计正确

沿用用户确认的定义：

`session hit% = 所有可信主代理 Step 的缓存读取 token 总和 ÷ 这些 Step 的输入 token 总和`

不平均每次百分比，不把缓存写入算读取，不把标题、压缩摘要混入主代理分母，不把模型的推理输出子量再加一次。每个 session 分开核对三个来源：HTTP 原始 usage、SQLite 中唯一 carrier 保存的 accepted Step usage，以及正式 `/status` 的累计。观察器不建立第二个生产 tracker。

| 协议 | 原始输入总量的核对方法 | 缓存读取来源 |
| --- | --- | --- |
| Chat Completions | `prompt_tokens` | `prompt_tokens_details.cached_tokens` |
| Responses | `input_tokens` | `input_tokens_details.cached_tokens` |
| Anthropic | `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` | `cache_read_input_tokens` |

Anthropic 的 `input_tokens` 在这些响应中只表示未缓存部分；直接拿它当全部输入，会把分母算小。这次主请求经常返回未缓存输入 2，但包含缓存的输入实际约 1.5 万。

所有正式主 Step 都有明确缓存读取字段。本次实网覆盖了“明确为 0”和“非零”；没有把它扩写为实网验证了“缺少明细”。缺失明细仍由固定单元和集成样本验证。

## 3. 正式结果

本轮正式矩阵共 **24 次 HTTP：23 次生成请求＋1 次模型元数据查询，均 HTTP 200**；13 个用户 Run 成功，17 个主代理 accepted Step，另有 3 次标题、3 次真实压缩摘要。标题与摘要均不进入以下 hit 分母。

| 正式组合（均经 ZenMux） | 用户 Run | 主 Step | 输入 token | 输出 token | 缓存读取 token | 最终 session hit |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| [Responses · Luna](./evidence/formal-cache/responses.json) | 4 | 5 | 41,593 | 154 | 32,545 | **78.25%** |
| [Anthropic · Sonnet 5](./evidence/formal-cache/anthropic.json) | 4 | 5 | 75,114 | 132 | 44,563 | **59.33%** |
| [Chat · Luna native wire](./evidence/formal-cache/chat.json) | 5 | 7 | 63,405 | 254 | 35,499 | **55.99%** |

这些是各自会话的最终累计，不是接口性能排名。Chat 多了一次 skill 工具调用、一次切档和一个用户 Run，三组经历的步骤并不完全相同。

| 观察点 | Responses | Anthropic | Chat |
| --- | ---: | ---: | ---: |
| 第 1 个用户 Run 结束 | 49.40% | 49.61% | 65.01% |
| 第 2 个用户 Run 结束 | 65.93% | 66.14% | 73.72% |
| 第 3 个用户 Run 结束 | 74.21% | 74.42% | 78.89% |
| medium → high，尚未生成新 Step | 未测 | 未测 | 78.89%，累计原样保持 |
| high 的新用户 Run 结束 | — | — | 64.95% |
| 压缩摘要完成，尚未提交新用户消息 | 74.21%，原样保持 | 74.42%，原样保持 | 64.95%，原样保持 |
| 压缩后的用户 Run 结束 | **78.25%** | **59.33%** | **55.99%** |

三次实际压缩均返回 `compacted/compressed`，压缩后的用户回答均包含 Cedar、17、Lin。局部历史压缩量如下；它们是本地估算的历史材料量，不是供应商账单，也不能直接当成整个窗口减少量。

| 组合 | 被压缩历史估算 | 摘要估算 | 压缩摘要实际请求强度 |
| --- | ---: | ---: | --- |
| Responses | 472 | 131 | medium |
| Anthropic | 429 | 262 | medium |
| Chat | 1,472 | 194 | high |

所有配置初始设置 `maxTokens=4096`、本地窗口 128,000；Chat 切档时走现有 `connectModel`，真实 GET `/api/v1/models` 返回元数据，生产逻辑把窗口更新为 **1,050,000**。这是同一次配置重载的附带行为，已记录在 Chat 的 `effort-config` checkpoint；没有私自固定或伪造探测结果。JSON 顶部的 128,000 表示初始配置。

17 个主 Step 的逐条读数如下（编号是对应证据中的 HTTP sequence；Chat 的 #7 是元数据 GET）：

| 组合 | HTTP # | 用途 | 输入 | 输出 | cache read |
| --- | ---: | --- | ---: | ---: | ---: |
| Responses · Luna | 2 | agent-step / medium | 8,045 | 68 | 0 |
| Responses · Luna | 3 | agent-step / medium | 8,233 | 17 | 8,042 |
| Responses · Luna | 4 | agent-step / medium | 8,402 | 10 | 8,230 |
| Responses · Luna | 5 | agent-step / medium | 8,564 | 17 | 8,399 |
| Responses · Luna | 7 | agent-step / medium | 8,349 | 42 | 7,874 |
| Anthropic · Sonnet 5 | 2 | agent-step / medium | 14,626 | 52 | 0 |
| Anthropic · Sonnet 5 | 3 | agent-step / medium | 14,854 | 21 | 14,624 |
| Anthropic · Sonnet 5 | 4 | agent-step / medium | 15,089 | 11 | 14,852 |
| Anthropic · Sonnet 5 | 5 | agent-step / medium | 15,313 | 24 | 15,087 |
| Anthropic · Sonnet 5 | 7 | agent-step / medium | 15,232 | 24 | 0 |
| Chat · Luna native wire | 2 | agent-step / medium | 8,045 | 111 | 0 |
| Chat · Luna native wire | 3 | agent-step / medium | 8,985 | 51 | 8,042 |
| Chat · Luna native wire | 4 | agent-step / medium | 9,156 | 17 | 8,982 |
| Chat · Luna native wire | 5 | agent-step / medium | 9,325 | 10 | 9,153 |
| Chat · Luna native wire | 6 | agent-step / medium | 9,487 | 17 | 9,322 |
| Chat · Luna native wire | 8 | agent-step / high | 9,657 | 31 | 0 |
| Chat · Luna native wire | 10 | agent-step / high | 8,750 | 17 | 0 |

正式矩阵的 6 次辅助生成合计输入 **2,849**、输出 **875**；主 Step 加辅助生成合计 **184,376 token**。另保留的入口诊断 6 次生成共 **34,699 token**。本次新增的所有 29 次生成合计 **219,075 token**，另有 1 次不产生模型 token 的元数据 GET；全部取自已观察的供应商用量，缓存 token 已包含在输入中，没有重复相加。这不是费用金额，也不包含此前 06 的 23 次请求。

## 4. 怎么理解压缩、切档后的 0

Responses 的压缩后请求继续读取缓存；Anthropic 的压缩后第一条请求明确返回读取 0、写入 15,230。这时历史读取总量仍是 44,563，新增输入使累计比例从 74.42% 降至 59.33%。这是供应商对新请求报告的未命中，生产累计没有清空，也没有被覆盖为 `—`。

缓存按请求前缀复用；压缩改变实际历史内容。本次主请求的 system 和 tools 规范化哈希保持稳定，但不能据此保证整个历史前缀仍命中，更不能从一次未命中反推拼装错误。[ZenMux 缓存文档](https://zenmux.ai/docs/guide/advanced/prompt-cache.html)、[Anthropic 缓存文档](https://platform.claude.com/docs/en/build-with-claude/prompt-caching) 说明了前缀与缓存边界的作用。这里的哈希是规范化结构哈希，不是供应商内部 token 序列的证明。

这批数据已经证明：现有生产拼装能够命中，三协议都能把上游缓存读数送到真实会话统计。它不证明每个网关、每次压缩、每次切换配置后都必然命中，也不衡量省钱比例。

## 5. 单独保留的入口诊断

正式矩阵之前有一组 6 次生成请求，见 [入口诊断](./evidence/formal-cache/responses-entry-diagnostic.json)。第一次 Run 等待 skill 权限时，中断了 REPL 中的等待表达式，以便查看并处理权限；backend 自身继续运行并成功完成。之后一次未带 session ID 的提交创建了另一个 session。它们没有作为“同会话连续三 Run”通过证据，也没有混入正式矩阵的分母。

诊断中的非零命中和实际消耗仍保留。正式 Responses 随后从新进程重新验证，使用异步等待加显式 session ID，四个 Run 在同一个 session 中完成。没有隐藏付费请求，也没有为美化结果删除 0 或失败记录。

## 6. 固定测试与回归

新增测试只位于 `tests/`：

- [交互进程控制器](../../../../tests/smoke/formal-cache-session.ts)：真实 backend、隔离配置/数据库、用途观察、`/status` 和持久化证据。
- [被动 HTTP 观察器](../../../../tests/smoke/formal-cache-observer.ts)：只记录数值、哈希与合法配置摘要；最多 25 次 HTTP/实例，覆盖真实模型元数据查询；不保留请求文本、密文、签名或密钥。
- [14 项观察器单测](../../../../tests/smoke/formal-cache-observer.unit.test.ts)：未知/零/非零、原 Response 不变、脱敏、预算和域名限制、等待响应头/流结束、metadata GET。
- [2 项正式 backend 集成测试](../../../../tests/integration/formal-cache-session.integration.test.ts)：只在外部 HTTP 边界换固定响应，实际执行生产 read、标题、持久化和 `/status`；验证切档不清空累计、下一请求发送 high、无密钥环境可跑，以及请求尚未结束时拒绝保存半份证据。

本轮重新执行 `pnpm test`：**335 个文件通过、5 个文件跳过；3466 项通过、16 项跳过**。其中包括 improve-1～5 的既有回归、新增单测/集成和编译后 CLI/daemon 进程测试。运行日志：`/tmp/improve55-closeout-full-tests.log`。不是复用上一轮的 333/3450 数字。

测试辅助代码的独立 TypeScript 项目检查和 ESLint 均通过。实网证据单独验证了 HTTP → 归一化 usage → SQLite → 每个 `/status` 检查点，未依赖“HTTP 200 就算通过”。

独立子代理对四份 JSON 逐项重算，并复核正式 backend 接线、用途排除、真实压缩及切档行为；结论为 **本次 cache 收尾范围 PASS，无阻断项**。Responses/Anthropic 的较早记录只在结尾补取 SQLite carrier，未在每个 checkpoint 内嵌数据库快照；因此“每个检查点一致”指 raw/provider 累计与当时 `/status` 一致，最终 SQLite 再核对全部 Step。

## 7. 验收边界与下一步

- 本轮新增证据：三协议的正式非零 cache、三个独立用户 Run、真实压缩与压缩后回答、生产 `/status` 对账；Chat 还覆盖同会话切档和摘要继承 high。
- 这轮没有新增推理 UI；切档通过隔离的后端配置及现有 `connectModel` 重建 runtime，backend 与 session 没有重建，cache tracker 因而保持原累计。
- 公开 `connectModel` 暂时不接受 Responses kind；未为测试私开 reset 入口，因此不把 Chat 的切档实网结果代替 Responses 切档验证。
- 仅验证 ZenMux 上的原生 OpenAI / Anthropic 模型路由，并非直连原厂；百炼、智谱的本轮实网复验仍未覆盖。没有把 T29 写成全平台通过。
- 子代理静默记录与继承、重启状态续接、未知缓存明细等沿用既有验收与本轮回归，不冒充这组实网新增覆盖。进程重启后的 hit 历史恢复仍不是本轮承诺。
- Luna Chat generic `reasoning.enabled=false` 的网关行为限制依然成立；本次 Chat 使用已验证的 `wire: openai`，不替其他 wire 背书。

结论：此前“只跑通短续接、未验证生产非零命中”的收尾缺口已补。可以进入 improve-6 的规划和实现准备；供应商覆盖边界继续留在验收表中，不宣称 improve-5.5 全平台、全组合通过。本地提交等待用户审查，不 merge/push。
