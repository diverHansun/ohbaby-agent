# 第 1 批：实施与验收记录

## 1. 范围与结论

| 项目 | 记录 |
| --- | --- |
| 议题 | goals 升级 / improve-1：通用模型请求空闲保护 |
| 规划 | 本目录 00–04，2026-10-15 定稿；规划代码基线 `018a5c96` |
| 实施基线 | main / `62d99d14`；与规划基线相比仅文档和指令文件变化 |
| 分支 | `main → codex/goals-upgrade → codex/goals-upgrade-improve-1` |
| 验收日期 | 2026-10-15 |
| 结论 | 通过：本批 04 验收项、全量单元/集成、服务故障与三协议实网端到端均通过 |
| Git 状态 | 按实现、测试、文档分三批提交到 improve-1 分支；尚未合并或推送，开发分支和 main 未改 |

本批交付请求层的空闲保护，普通对话、摘要、标题和 goal 续跑共用。没有修改 goals 状态、预算、执行准入、用户插话或界面。原始 00–04 保持为实施契约；本文记录实现事实和偏差。

用户询问看门狗放在 llm-client 是否合适，随后同意本批位置并要求回看。决定、五个参考项目的源码对照和 improve-5 回看条件已记入 [06](./06-request-idle-placement-review.md)。共享 ChatGPT 链接未返回可读正文，本批以仓库已有讨论和规划为依据，不声称已读到分享页内容。

### 分批提交

| 批次 | Commit | 内容 |
| --- | --- | --- |
| 1 | `947dcbdb` | 看门狗、四处等待守卫、provider 活动接线、基础单测及既有断言适配 |
| 2 | `cc34f496` | 取消与迟到集成、SDK 重试、失败历史投影、daemon 故障与实网端到端测试 |
| 3 | 本文所在文档提交 | 模块文档、验收结果、参考项目调研和目录位置回看记录 |

提交前复跑相关 6 个测试文件，142 项全部通过；提交钩子正常执行全仓 lint 与 typecheck。未修改产品行为，也未重复发起付费实网测试。

## 2. 实施对照

| 02 项目 | 结果 | 实际落点 |
| --- | --- | --- |
| S1 看门狗 | 完成 | `idle-watchdog.ts`：600,000 ms 默认值、正有限值校验、独立超时错误、wait/next/pulse/expired/dispose |
| S2 四处等待 | 完成 | `streaming.ts`：opening 单独守卫；首个 next、usage-only 后 next 和主循环 next 共用 `nextEvent` |
| 取消与隔离 | 完成 | 每 attempt 一个子 controller；用户取消优先；原始 opening 先检查 retired 再绑定 iterator；next 先经过守卫再进入 observer |
| 重试与 partial | 完成 | `retry.ts` 增加分类和 `stream_idle_timeout`；沿用原有退避、重试上限和 partial 不重放规则 |
| S3 原始活动 | 完成 | 三种 provider 的 SDK 原始事件循环调用可选 `onActivity`；不把 SDK 隐藏的心跳当作已观察活动 |
| 模块文档 | 完成 | llm-client architecture/test 同步职责、分类和测试；没有顺手改写历史命名 |

### 与规划的具体差异

| 维度 | 实际调整 | 原因与影响 |
| --- | --- | --- |
| 数据结构、错误、配置 | 与规划一致 | 不新增环境配置、持久化字段、依赖或第二层重试 |
| 集成测试组织 | 新建 `stream-idle.integration.test.ts` | 将较多取消/迟到竞争用例集中放在独立文件，沿用既有 Vitest 分类 |
| 活动测试 | 扩展 `sdk-retry.integration.test.ts` 的真实 SDK + fetch stub | 同时验证原始空事件能续时、实际 HTTP 次数等于应用层尝试数 |
| 既有测试适配 | signal 身份断言改为取消行为断言；model-snapshot 克隆请求时排除回调 | 新 signal 合成与不可序列化的 onActivity 均为预期接口变化；生产快照逻辑未改 |
| 上层分类回归 | 补 lifecycle failed-history 用例 | 固定 partial idle 的落库与历史投影行为，回应 Pi 审查；未改 lifecycle/context 产品实现 |
| 端到端 | 新增 server daemon E2E | 用户要求：真实 HTTP/SQLite/goal driver 故障链路，以及三种协议的真实 API 请求 |
| 留档 | 新增 06，更新议题 README | 用户明确要求保留位置疑问和后续回看条件 |

## 3. 验收证据

### 04 的行为验收

| 项目 | 结果 | 证据 |
| --- | --- | --- |
| W1、W2：四个等待点 | 通过 | opening、首个 next、usage-only 后 next、主循环 next 均有永不 settle 的独立用例；无 partial 时重试并耗尽 |
| W3：partial 不重放 | 通过 | 正文、reasoning、工具片段和 finish 场景断言只调用一次 provider；摘要 idle 不进入额外 transport 重试 |
| W4：取消与 goal 暂停 | 通过本批范围 | 用户 abort 先到、同 tick、超时后退避期间到达；caller signal 不被超时 abort；既有 driver paused 守卫回归，HTTP E2E 验证失败后 goal 暂停 |
| W5：迟到与不合作清理 | 通过 | opening 在 backoff/finally 后迟到，分别 resolve/reject、eager/lazy；next 迟到不改首字时间；return 永不返回也不阻塞退出 |
| W6：只计未完成等待 | 通过 | 慢消费者/持久化不误报；累计流时长超过阈值仍可成功；opening 与首个 next 各有完整时限 |
| W7：共用保护与资源 | 通过 | 普通请求与 goal 链路；三协议 HTTP 次数验证无 SDK 隐藏重试；timer 清零；重复 demand 和 dispose 后 abort listener 归零 |
| 默认与非法阈值 | 通过 | 默认 600,000 ms 与注入 100 ms 均验证差 1 ms 不触发、到点触发；非法值在 provider 调用前拒绝 |
| SDK 原始活动 | 通过 | 三协议没有归一化输出的事件连续到达时，不会被误判为空闲 |
| partial 的历史投影 | 通过 | `APIError`，正文仍存在于存储，没有 interruption fact，两种历史 serializer 排除正文，工具未执行 |

W4 中 goal 活跃时间截止、blocked 与迟到失败竞争仍属于 improve-3；本批不声称已通过这部分。

### 实际执行的命令与结果

以下命令在仓库根执行。日志保存在本机 `/tmp/ohbaby-improve1-*`，不包含凭据；临时日志不作为持久交付依赖。

| 命令 / 范围 | 结果 |
| --- | --- |
| 实施前定向基线 | 5 文件、103 项通过 |
| llm-client、providers、goals driver 定向回归 | 26 文件、667 项通过；后续新增的资源清理和历史投影用例另有验证 |
| 最终专项：watchdog、stream-idle、SDK retry、failed-history | 4 文件、100 项通过 |
| `pnpm test:unit`，最终轮 | 336 文件，4,127 通过、2 跳过 |
| `pnpm test:integration`，最终轮 | 155 文件、1,389 项全部通过；含 CLI/Web/server/agent 构建及 CLI 进程级验收 |
| `pnpm typecheck` | 通过；最终端到端配置调整后已再次复核 |
| `pnpm lint` | 通过：0 error、109 个存量 warning；本批新增文件无 warning |
| 改动源码 `prettier --check`、`git diff --check` | 通过 |
| daemon 故障注入 + DeepSeek 实网 E2E | 1 文件、4 项通过；3 项实网分别为 Chat、Responses、Anthropic |

端到端可复现命令：

```sh
# 不触外网：1 个故障注入用例，3 个实网用例显式跳过
pnpm exec vitest run --config vitest.e2e.config.ts \
  packages/ohbaby-server/src/runtime/daemon/model-idle.e2e.test.ts

# 用户授权的付费实网测试：DEEPSEEK_API_KEY 从环境或 .env 读取
OHBABY_RUN_IDLE_REAL_E2E=1 pnpm exec vitest run \
  --config vitest.e2e.config.ts \
  packages/ohbaby-server/src/runtime/daemon/model-idle.e2e.test.ts
```

故障测试只将 watchdog 默认定时器加速到 30 ms；HTTP、SQLite、lifecycle、goals driver 使用真实实现。断言有 partial 的请求只发一次、provider signal 被 abort、run 失败、goal 暂停，随后创建会话仍成功。测试使用临时数据库、临时工作区和临时端口，结束后清理。

实网使用 `deepseek-flash`，每协议最多 4 次 provider 调用，显式关闭 thinking；断言返回约定正文和成功状态。这证明正常真实请求可通过新增保护，不代表测过 10 分钟真实静默分布，也不替代确定性故障测试。没有做浏览器视觉验收，留给包含展示变更的 improve-5。

### 测试过程中修正的问题与外部限制

- 首轮集成的 153 个文件通过，2 个 CLI 打包测试因新增 E2E 引用根目录测试 helper 超出 server 的 TypeScript rootDir，以及误读 UI run status 类型，在 beforeAll 构建时失败。已将 E2E profile 放回本文件，改用 `run.status.kind`；两套打包测试定点复跑 4/4 通过，最终全量集成也已全部通过。
- fake timer 测试最初受现有随机退避影响，已固定测试中的 `Math.random`，生产退避未改。新增代码的 TS/ESLint 问题已修复。
- 首选 Zenmux 实网失败，诊断请求明确返回 HTTP 402 计费失败，随后换用用户测试清单授权的 DeepSeek 官方接口。
- DeepSeek Responses 默认 thinking 返回 `response.content_part.added` / `reasoning_text`，现有 parser 只接受 message 的 output_text part，因此失败。直接调用 API 并把事件交给 parser（完全绕过 watchdog）复现同一错误；显式关闭 reasoning 后正常。修正测试的 reasoning capability 配置后，三协议全部成功。此项为既有协议兼容性限制，本批不扩展 parser。接口地址依据 [Responses 文档](https://api-docs.deepseek.com/guides/responses_api/) 和 [Anthropic 文档](https://api-docs.deepseek.com/guides/anthropic_api/)。

## 4. 独立审查与工程取舍

### 审查结果

- 实现审查子代理核查四个等待点、partial、取消、迟到结果、资源清理、活动回调，独立运行 87 项通过；没有发现可确证的产品阻塞问题。
- 参考项目子代理核查 ZCode、kimi-code、deepseek-harness、CCB、Codex，证据与适用边界见 [06](./06-request-idle-placement-review.md)。没有将 CCB 复原扩展实现称为 Anthropic 官方源码。
- 按用户要求只调用一次 Pi，实际可用模型 ID 为 `opencode/claude-opus-5-5`，thinking medium；独立复跑 87 项通过，结论无阻塞，认可当前目录归属。完整原文已在会话呈现。
- Pi 提出两点：partial idle 的历史投影后果，以及 SDK 自带建流 timeout。主代理检查代码后确认，补了历史投影测试并更新模块文档。它引用规划小节有误，实际契约为 02 §6 第 3 条。
- 补测后再次请实现审查子代理定点核对分类、测试及越界范围；未发现阻塞或越界，独立运行当时的 failed-history 两文件 28/28 通过。

### SWE 评估

计时器和取消资源归一个 attempt 持有，重试仍由原有循环决定；provider 只报告活动，不知道 goals。这沿着现有所有权加保护，新增复杂度主要来自必须处理的异步取消和迟到结果，没有引入通用 timeout 包、全局调度器或冗余配置层。`nextEvent` 把读取守卫放在 observer 之前，避免迟到数据污染持久化统计；这种顺序比事后过滤更容易验证。

| 取舍 / 边界 | 判断与后续动作 |
| --- | --- |
| 放在 llm-client | 本批合理但不是永久架构结论；improve-5 回看，若 attempt 所有权迁移或出现多个独立调用方再评估提取 |
| partial idle 不进入历史 | 按现有 source 分类落地；正文存储不丢失。后续如需独立 idle 来源，应同时讨论恢复体验和摘要重试，不能只改一个错误枚举 |
| SDK 建流 timeout | 安装的 OpenAI/Anthropic SDK 默认均为 600,000 ms，收到 HTTP 响应后清除。建流阶段可能先报 SDK timeout 或 watchdog timeout；上调 idle 常量时必须复查这一层 |
| 10 分钟默认值 | 工程兜底，未由真实静默分布标定；最多 6 次完全静默尝试约 60 分钟加退避，并非请求总时长上限。goal 总预算由 improve-3 实现 |
| 不合作 provider | 调用方可有界退出；底层未 settle 的 Promise 无法由 JS 强制销毁。已挂异常处理、发 abort、detach return；不把资源回收保证写成底层必然立即停止 |

本批无数据库迁移、无依赖变更。回滚应只撤本批 guard/活动接线，保留原有取消、重试和 partial 防重放规则。

## 5. 重要文件

| 文件 | 修改 |
| --- | --- |
| [idle-watchdog.ts](../../../../packages/ohbaby-agent/src/core/llm-client/idle-watchdog.ts) | 新增计时、活动、取消与清理实现 |
| [streaming.ts](../../../../packages/ohbaby-agent/src/core/llm-client/streaming.ts)、[retry.ts](../../../../packages/ohbaby-agent/src/core/llm-client/retry.ts) | 接入四个等待点、迟到隔离、超时分类 |
| [providers](../../../../packages/ohbaby-agent/src/services/interface-providers/) | 可选活动回调与三协议接线 |
| [idle-watchdog.unit.test.ts](../../../../packages/ohbaby-agent/src/core/llm-client/idle-watchdog.unit.test.ts)、[stream-idle.integration.test.ts](../../../../packages/ohbaby-agent/src/core/llm-client/stream-idle.integration.test.ts) | 计时边界、资源、取消和迟到竞争 |
| [sdk-retry.integration.test.ts](../../../../packages/ohbaby-agent/src/core/llm-client/sdk-retry.integration.test.ts) | 真实 SDK 活动与 HTTP 次数 |
| [failed-history.integration.test.ts](../../../../packages/ohbaby-agent/src/core/lifecycle/failed-history.integration.test.ts) | partial idle 存储与历史投影 |
| [model-idle.e2e.test.ts](../../../../packages/ohbaby-server/src/runtime/daemon/model-idle.e2e.test.ts) | 真实服务故障链路与 opt-in 实网验收 |
| [architecture.md](../../../core/llm-client/architecture.md)、[test.md](../../../core/llm-client/test.md) | 同步模块现状与已验行为 |
| [06](./06-request-idle-placement-review.md) | 用户的位置疑问、参考项目证据与回看条件 |
