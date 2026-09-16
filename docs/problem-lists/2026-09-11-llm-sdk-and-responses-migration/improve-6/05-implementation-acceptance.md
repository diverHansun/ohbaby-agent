# 05 · 实施与验收

日期：2026-09-16。分支：`codex/improve-6-context-migration`。基线：`5a76738a8f93a2685cf1e4406f16b0917bb09ed2`。本地分批提交，不合并、不推送。

## 1. 实施结果

| 批次 | 改动                                                                                                     | 提交／状态     |
| ---- | -------------------------------------------------------------------------------------------------------- | -------------- |
| A/B  | 删除内部旧 Chat 估算转换；直接使用自有消息／扁平工具；原生子代理分类和完整来源核对；三协议契约与实网设施 | `61e890e9`     |
| C    | 摘要必须正常 stop、流耗尽、非空；摘要专用工具语义；失败不退休历史，已提交 prune 保留                     | `8d7532b5`     |
| D    | 自动摘要使用完整模型窗口 95%；删除 4096 提前触发；当前模块文档与总验收                                   | 本文件所在提交 |

没有新增消息结构体系、三套计量器或预算服务。`ModelMessage`／`ModelToolCall`／`ModelState` 已能承载本轮需求，沿用现有类型。Chat Completions 适配器仍支持该协议，删除的是 Context 内部估算桥。

文件范围：A/B 为 `core/context/token-estimation.ts`、删除的 `legacy-estimation.ts` 和对应 contract/native 测试；C 为 `adapters/ui-runtime/prompt-context.ts`、`core/context/serialization.ts`、摘要／原子提交测试及评分语义注释；D 为 `compaction-policy.ts`、`constants.ts`、出口与阈值测试。实网复用 `tests/smoke/formal-cache-session.ts`，薄入口为 `scripts/run-real-context-e2e.mjs`。

## 2. 统计与行为边界

固定样例的旧材料为 1453 字符／372 个估算 token，新材料为 1269 字符／326 个估算 token。删除重复协议包装减少 184 个 ASCII 字符，对应 46 个估算 token。此处没有改 ASCII／非 ASCII 权重，也没有调整阈值去贴旧数字。

新材料改变估算数字，因此实际触发摘要的轮次可能改变。另有用户明确授权的口径修正：自动摘要使用 `currentTokens / contextLimit >= 0.95`，与 UI 完整窗口占用一致；删除剩余输入预算 <4096 的提前触发。输入预算公式及 mask／thrash 用途保持原样。

窗口在连接模型时通过 metadata 检测，并沿用既有配置与默认回退。实网门必须检测成功，不能拿固定窗口充当检测结果。本次覆盖的窗口为 DeepSeek／Claude 1,000,000，GPT 1,050,000。

以下规则保持：普通历史评分、prune／mask 材料、保留比例、合法切点、已有摘要累积、overflow 缩小摘要输入后仍退休原选段、原子提交、scope 隔离、EMA 与最后 prepare／compact 快照。丰富工具信息只用于摘要输入；overflow 进度中的 `estimatedHistoryTokens` 仍是原可读历史评分。

## 3. 本地验证

- 摘要定向：4 文件／26 项通过。
- Context、摘要、agent instance 联测：19 文件通过、1 文件跳过；197 项通过、2 项默认实网跳过。
- metadata 到窗口占用与自动摘要的三协议集成，加连接配置优先级：2 文件／20 项通过。
- 实网设施 fixture：2 文件／11 项通过；独立 smoke tsconfig 编译、ESLint 通过。
- 独立最终审查：10 文件／170 项通过，未发现阻断缺陷。
- `pnpm run preflight`：通过，339 文件通过、5 文件跳过；3499 项通过、16 项跳过。格式、lint、类型检查和所有 workspace 构建通过。最新实网 fixture 增加的合法空集用例另经上述 11 项定向验证。

主要命令：

```sh
pnpm exec vitest run packages/ohbaby-agent/src/core/context packages/ohbaby-agent/src/core/agents/instance.integration.test.ts packages/ohbaby-agent/src/adapters/ui-runtime/prompt-context.unit.test.ts packages/ohbaby-agent/src/adapters/ui-runtime/summary-completion.integration.test.ts
pnpm exec vitest run packages/ohbaby-agent/src/core/context/context-window-policy.integration.test.ts packages/ohbaby-agent/src/config/llm/__tests__/apply-active-model-config.unit.test.ts
pnpm exec vitest run tests/smoke/formal-cache-live-context.unit.test.ts tests/integration/formal-cache-session.integration.test.ts
pnpm exec tsc -p tests/smoke/formal-cache.tsconfig.json
pnpm run preflight
```

本地测试覆盖 T1～T16；T8／T11 按最新完整窗口 95% 要求校准，其余矩阵沿用 04。真实越过百万窗口 95% 和真实上游 overflow 未执行，使用确定性本地测试覆盖，不能由下面 force 压缩声称已实测。

## 4. 真实 API 验证（T17）

凭证来自 `.env`，不写入报告。模型来自用户提供的 `tests/models-4-tests.md`。每次使用指定模型，不自动更换；每次运行限制 20 次 HTTP（包括 metadata、标题与摘要）。所有生成都经过生产 persistent backend、provider 与真实 SQLite。

| 协议／模型                              | baseline HTTP | baseline 结果 | compaction 结果 |
| --------------------------------------- | ------------- | ------------- | --------------- |
| Chat · `deepseek/deepseek-v4.1-flash`   | 6             | 通过          | 通过，9 HTTP    |
| Responses · `openai/gpt-5.6-luna`       | 7             | 通过          | 通过，10 HTTP   |
| Anthropic · `anthropic/claude-sonnet-5` | 6             | 通过          | 通过，9 HTTP    |

baseline 要求：真实 read → 不新增工具的续聊 → SQLite 重开 → 不新增工具的续聊。窗口与生产 snapshot 一致；重开前后原生状态指纹一致；请求回放的状态 hash 精确等于活动状态。

compaction 另外要求真实摘要 HTTP、`compressed`、摘要持久化、至少一个原生状态退休，随后两次请求都不重放退休状态。使用受控重复历史提供可压缩材料，force 只启动现有流程，不替换摘要模型或跳过实际提交。

证据保存在本机 `.ohbaby/test-evidence/improve-6/live-context/`（不提交含运行细节的产物）。已通过的 baseline：

- Chat：`zenmux-deepseek-v41-chat-baseline-1789519161151.json`
- Responses：`zenmux-gpt56-luna-responses-context-baseline-1789519285397.json`
- Anthropic：`zenmux-claude-sonnet5-anthropic-context-baseline-1789519162340.json`
- Chat 压缩：`zenmux-deepseek-v41-chat-compaction-1789519586564.json`
- Responses 压缩：`zenmux-gpt56-luna-responses-context-compaction-1789519818190.json`
- Anthropic 压缩：`zenmux-claude-sonnet5-anthropic-context-compaction-1789519821776.json`

真实压缩的数字如下。主请求前后是已校准估算，不是计费 usage；摘要 usage 独立列出，包含缓存输入：

| 协议      | 主上下文估算：压缩前 → 后 | 摘要实际 input / output | 原生状态：压缩前活动 → 压缩后活动／退休 |
| --------- | ------------------------- | ----------------------- | --------------------------------------- |
| Chat      | 13,453 → 10,331           | 3,893 / 507             | 2 → 1 / 1                               |
| Responses | 11,808 → 8,925            | 3,819 / 308             | 5 → 2 / 3                               |
| Anthropic | 19,758 → 15,255           | 5,613 / 568             | 1 → 0 / 1                               |

Anthropic 覆盖了全部原生状态退休后的合法空集，重开与续聊仍成功。另两条路由覆盖保留部分活动原生状态的情况。

运行方法：

```sh
node scripts/run-real-context-e2e.mjs --run --profile=zenmux-deepseek-v41-chat --mode=baseline
node scripts/run-real-context-e2e.mjs --run --profile=zenmux-gpt56-luna-responses-context --mode=baseline
node scripts/run-real-context-e2e.mjs --run --profile=zenmux-claude-sonnet5-anthropic-context --mode=baseline
# 各 profile 再使用 --mode=compaction 验证真实压缩。
```

失败证据保留：首次 Responses 等待未处理工具权限而超时；加入受控权限处理后完成全程，但旧测试又把正确拒绝额外 skill 判失败，已修正为只批准受控 read、允许安全否决。首次 Responses／Anthropic 压缩确实成功，但短夹具只退休首条用户消息，未覆盖原生状态退休，仍按失败记录并补足夹具。另一次 Anthropic 已退休全部原生状态并成功续聊，但测试错误要求重开前非空；修正为 compaction 允许合法空集，并加确定性空集重开测试。另一次 Responses 第三轮 HTTP 200 后流中断，无完整结果或 usage，记录为上游失败后对同模型有界复测成功。没有把任何失败尝试记为 T17 通过。

首次 preflight 的 3 项失败分别是旧数字快照、两个依赖 4096 提前触发的并发预期。新结构下字符计量 231／449 → 201／389，配套 EMA 结果 144 → 127；保持 actual usage 配对与串行断言，16 项相关回归已通过。

## 5. 审查与限制

估算/native 审查、摘要原子性审查、95% 口径审查、独立完整 diff 审查均已执行。审查要求补足混合 native 分桶、proxy 只计一次、真实窗口与持久化 hash 断言、摘要评分语义注释，已落实。

不承诺三协议估算误差一致。单一 estimator 仍是近似值，原生可读推理按文本估算，不透明部分保留既有 token 代理估算；七类分桶为未校准解释值。旧摘要累积及既有有损 overflow 恢复留待后续算法轮次。
