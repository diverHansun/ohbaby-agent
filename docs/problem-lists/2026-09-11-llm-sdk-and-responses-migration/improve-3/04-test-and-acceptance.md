# 4. 本轮测试与验收

> 2026-09-13精确契约已批准；真实E2E模型/协议矩阵见§4.6。A/B/C测试已提交，最终preflight与独立审查通过。三协议各有本轮成功证据；原偶发失败未定因，不冒充一次全矩阵全绿。本轮技术验收通过，等待用户审核，实际证据与历史失败见[05](./05-implementation-acceptance.md)。

## 4.1 范围与执行

沿用根package.json和scripts/run-vitest-by-type.mjs规则。每批运行定向测试、`pnpm run test:unit`、`pnpm run test:integration`，并覆盖相关contract；子代理独立审查，修复复测后commit。最终`pnpm preflight`。真实凭据测试单独运行并记账，禁止skip当通过。

## 4.2 风险矩阵

| ID | 场景 / 阶段 | 测试与通过标准 |
| --- | --- | --- |
| T1 | 请求映射 A | 三provider unit与prompt-cache-wire.contract：固定历史system顺序、tools/schema/strict、callId、参数文本、控制字段deepEqual基线 |
| T2 | 内容支持 A | §5角色/内容闭集每类正反例；null/缺失/空串/空数组、nested cacheControl、prompt_cache_breakpoint、reasoningText；Responses支持不放宽；Anthropic tool空数组、单个空text、空text携缓存字段的JSON fallback与旧wire逐字相同 |
| T3 | 估算 A/C | token-estimation/context-scope测试：批准生产基线的旧新总量、七桶每值及composition有无等价；空tools、tail、MCP、active reasoning、不修改冻结request；仅键序不同的匹配边界另测§6批准行为，不笼统声称任意输入等价 |
| T4 | 工具与流 B | llm-client及Responses integration：多工具分片、JSON错误、缺终态、收到终态后但EOF前仍有异常/不支持事件、abort、retry；不得提前执行或重复调用 |
| T5 | SQLite B/C | message/database-store.integration及ui-persistent.integration：旧fixture close/reopen、新投影、新回复落旧JSON，再reopen；usage每step既有放置规则不变 |
| T6 | 观察与传输 B | manager.unit、stream-bridge-run-event-source.unit、token-usage-roundtrip.integration：wire不变；观察缺快照不是空输出；禁止用其授权工具 |
| T7 | 公开接口 C | 根发布包编译消费者：新入口可导入、旧名称应编译失败；AgentRun间接类型同步；SDK events.contract保持 |
| T8 | 辅助/隔离 A–C | summary/title及auxiliary-token-usage-isolation、subagent-scope：purpose/scope/usage无旁路 |
| T9 | 本地请求E2E C | 构建产物经生产入口、可控HTTP/SSE端点、无副作用工具，完成请求→工具→结果回传；记录三协议请求，不只mock单函数 |
| T10 | 真实LLM E2E C | Chat/Anthropic/受限Responses各选适用模型，固定端点/预算/凭据来源；文本与普通工具往返、已有usage；不要求随机回复逐字一致 |
| T11 | A/B交界多轮回传 A | 用可控流复现goal-completion.real.e2e.test.ts中回复加入下一次messages的模式；新请求与必要回复适配同批，不能强转部分结果，不能等B才修复；真实fixture同时更新 |

精确fixture以design/data-model.md §5–6为准：A即覆盖最小快照五种状态及全部内层读取；B复测外层更名、reasoning唯一来源、观察complete缺快照和旧usage公开别名移除。字段删除测试仅按最终批准的U1/U6执行。当前improve-2的preflight通过只是迁移前基线，不是这些新合同测试已通过。

## 4.3 集成与回归

主/子代理、工具快照、summary/title、SQLite、worker→raw consumer与独立event重建都覆盖。T6不要求当前wire不存在的完整snapshot无损回传。T10不证明原生续接、真实cache命中提升或整个迁移完成。

## 4.4 发布/合入门

设计决定已批准；improve-2按自身最新04/05补证并合入集成分支；三批测试审查提交完成；preflight全部步骤有exit结果；T9/T10证据与未执行项如实记录；实施后新写05。即使技术验收全过，improve-3也必须停在临时分支，等用户审查、确认improve-4计划并明确同意后才合回集成分支，更不能main。

## 4.5 对抗性审查

- 仅改名却漏多模态：用U1正反例防护；未知外部消费者仍需迁移说明。
- 类型转换把null变空文本：请求和估算基线双检，不自动修复。
- isComplete被当成功：取消/失败工具副作用计数必须为零。
- 观察事件占位冒充模型事实：缺失快照有明确契约，不能写历史或授权工具。
- 数据库表不变却JSON改名：直接检查原持久键与reopen，而非只检查migration数量。

## 4.6 ZenMux真实请求矩阵（2026-09-13用户指定）

凭据只从仓库根.env的ZENMUX_API_KEY加载，可用Node的--env-file传给测试进程。不得打印、提交密钥或.env；只发送合成测试fixture，不发送真实会话/仓库正文。OpenAI协议baseURL为https://zenmux.ai/api/v1，Anthropic为https://zenmux.ai/api/anthropic，已对照[ZenMux快速开始](https://zenmux.ai/docs/guide/quickstart)核对。

| 模型 | interfaceProvider / 出站路径 | 用途 |
| --- | --- | --- |
| x-ai/grok-4.2-fast-non-reasoning | openai-responses / /api/v1/responses | improve-2生产Lifecycle T12已通过；improve-3改造后的T10必须重新执行 |
| deepseek/deepseek-v4.1-flash | openai-compatible / /api/v1/chat/completions | Chat兼容回归、本轮T10 |
| [qwen/qwen3.8-flash](https://zenmux.ai/qwen/qwen3.8-flash) | anthropic / /api/anthropic/v1/messages | Anthropic兼容回归、本轮T10 |

同日用户明确批准“在ZenMux中另选Responses验收模型，先预检确认符合要求，再调整测试矩阵”。据此用Grok替换原先两条必过Responses行；这是覆盖三种协议的受限迁移验收，不再承诺本轮验证OpenAI原生模型。原Luna与DeepSeek Responses的失败证据保留在improve-2/05 §5.9–5.10，后续原生状态能力阶段再评估；未将它们标为通过，也未改成Chat来冒充原路径。候选筛选及Grok预检见同文§5.11；模型名称或列表中的reasoning=false本身不是通过依据。

逐行执行标准：

1. 先用生产adapter做单个受限文本请求，确认实际路由、参数与输出兼容；这只是预检，不是完整E2E。
2. 预检成功后经生产LLM/lifecycle链运行独立文本和普通工具往返：合成输入，最多两步工具循环，一个无外部副作用的固定结果工具；检查callId对应、工具只执行一次、结果进入下一请求及最后正常停止。Responses显式kind、store=false，不能回落Chat。
3. 记录模型/协议/时间、请求次数、结束原因、规范化usage及结果，不要求随机回答逐字相同；固定标记文本探测可严格匹配。缺usage或工具链缺证不能伪装成全链路通过，cache真实命中不是本轮成功条件。
4. 对temperature 400、不支持reasoning/phase、拒绝、超时等失败立即停止该路径；不得改测试参数/过滤事件绕过生产边界。即使另外两条兼容协议通过，也不能补足Responses缺口。

成本与执行约束：原4条文本预检及最小参数诊断已完成，见improve-2/05 §5.9–5.10；后续授权的替代模型筛选单独记账在§5.11（11个逻辑生成请求，SDK/llm-client重试关闭）。不继续扩大候选搜索。当前三行完整验收每行文本1次、工具循环最多2次，单轮最多9个逻辑请求；Responses沿用通过预检的temperature=0.2、maxTokens=512、45秒abort，另外两行沿用temperature=0.2、maxTokens=2048、60秒abort。自动重试须关闭或计入总请求上限，失败不无限重跑，超出小批次先报告。输出上限不是精确账单预算。improve-2前置T12只跑Responses一行，不能借用它的结果冒充improve-3改造后的T10已通过。

key-gated runner已在improve-2收尾时新增：tests/smoke/responses-migration.real.e2e.test.ts，使用OHBABY_RUN_REAL_RESPONSES_MIGRATION=1显式启用，缺凭据时明确失败。普通CI默认排除.e2e，现有vitest.e2e.config.ts也只包含packages；因此采用以下已验证能发现此文件的命令。完整三协议不设置OHBABY_REAL_MIGRATION_PROTOCOL；前置T12单独设置为openai-responses。improve-3改造后须同步该runner并重新运行，不沿用improve-2结果。

```sh
OHBABY_RUN_REAL_RESPONSES_MIGRATION=1 node --env-file=.env --input-type=module <<'JS'
import { startVitest } from 'vitest/node';
const files = ['tests/smoke/responses-migration.real.e2e.test.ts'];
const ctx = await startVitest('test', files, {
  include: files, exclude: ['**/node_modules/**', '**/dist/**'], watch: false,
});
if (!ctx) process.exitCode = 1;
JS
```

runner关闭SDK重试，并在每行第4次实际HTTP请求前拒绝发送；失败路径停止新网络请求。Lifecycle未开放llm-client retry配置，不为测试新增生产开关；额外重试尝试仍受HTTP预算保护。输出区分provider调用次数与实际HTTP次数。

预检失败与生产兼容问题记入improve-2/05或本轮实施后的05，不能为了开工把fail-closed边界挪进improve-4后就宣布本轮真实可用。ZenMux证据不等于直连OpenAI/Anthropic官方API证据。
