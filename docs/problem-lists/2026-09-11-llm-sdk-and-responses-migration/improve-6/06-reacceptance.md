# 06 · 独立复验

日期：2026-09-16。用户要求再次测试并由子代理验收。复验起点为 `ecbb8c0583841181c578c03f291b2f6f6d99e490`，继续使用本地分支 `codex/improve-6-context-migration`，不合并、不推送。

## 1. 本地结果

- 重新执行 `pnpm run preflight`：339 文件通过、5 文件跳过；**3500 项通过、16 项默认跳过**。格式、lint、类型检查、全部 workspace 构建通过。
- 生产代码子代理独立执行 Context／摘要／provider contract／native-state 测试：21 文件、213 项通过；2 项默认实网跳过。
- 同一子代理通过 stdin 的 `tsx` 探针验证 18 个边界场景，包括完成帧后取消／异常、终态被 length／content_filter 覆盖、空摘要重试上限、原生状态细字段变化、跨源代理清理、95%／thrash／force。
- E2E 子代理独立执行相关 fixture 与 smoke tsconfig 编译；本轮增强后的定向单元／集成测试 11 项通过，scoped TypeScript／ESLint 通过。

全仓检查在测试补强前完成，之后仅改动三个测试文件，并重新执行上述定向检查与三协议真实 E2E。生产代码未改变。

## 2. 本轮发现与修复

未发现生产 Context 的阻断缺陷。发现一处测试证据缺口：生产权限规则会直接允许普通只读操作，这些操作不产生 `permission.requested`。因此，仅检查权限回调的批准记录不能证明实际 read 的参数是指定文件。

本轮仅修改以下测试文件：

- `tests/smoke/formal-cache-session.ts`：从 SQLite 读取全部已完成工具的名称与参数，包括已退休工具；只在证据中保存受控路径判定、参数键和 hash，不保存原始参数。
- `tests/smoke/formal-cache-live-context.real.e2e.test.ts`：首轮至少有一个已完成工具，所有已完成工具必须是精确指定路径的 read；重开后的证据必须完全一致。既有全工具 ID 集合、原生状态 hash 和退休状态不重放的断言保留。
- `tests/smoke/formal-cache-live-context.unit.test.ts`：验证即使没有权限询问，也能得到上述持久化证据。新增断言先出现两项失败，再由实现修复为通过。

这是执行后的验收检查，不是新增工具执行沙箱；失败或被拒绝的 skill 调用仍单独保留。

## 3. 新的真实 API 证据

本轮读取 `.env` 的凭证，固定使用 Chat／DeepSeek v4.1 Flash、Responses／GPT-5.6 Luna、Anthropic／Claude Sonnet 5。每次运行最多 20 次 HTTP，包含 metadata、标题和摘要；没有切换模型刷结果。

第一轮三协议均通过完整链路，HTTP 次数为 9／10／9。子代理独立核对了 metadata、真实摘要请求、五次成功 completion、压缩与重开前后的原生状态 hash，以及退休状态未重放。摘要与标题 usage 没有计入主请求缓存用量。

加强工具参数断言后，三协议再次全部通过。所有已完成工具均被持久化证据确认是指定路径的 read，压缩和重开后核验结果不变。

| 协议      | 最终 HTTP 次数 | 检测窗口  | 结果 |
| --------- | -------------- | --------- | ---- |
| Chat      | 9              | 1,000,000 | 通过 |
| Responses | 10             | 1,050,000 | 通过 |
| Anthropic | 9              | 1,000,000 | 通过 |

本机证据目录：`.ohbaby/test-evidence/improve-6/reacceptance/`。全仓日志为 `preflight.log`；增强断言前后日志为 `tool-evidence-red.log`／`tool-evidence-green.log`；三协议最终日志为 `*-e2e-strengthened.log`。

最终证据文件：

- `zenmux-deepseek-v41-chat-compaction-1789522359155.json`
- `zenmux-gpt56-luna-responses-context-compaction-1789522348185.json`
- `zenmux-claude-sonnet5-anthropic-context-compaction-1789522353772.json`

可复现命令：

```sh
pnpm run preflight
pnpm exec vitest run tests/smoke/formal-cache-live-context.unit.test.ts tests/integration/formal-cache-session.integration.test.ts
pnpm exec tsc -p tests/smoke/formal-cache.tsconfig.json
OHBABY_REAL_CONTEXT_EVIDENCE_DIR=.ohbaby/test-evidence/improve-6/reacceptance node scripts/run-real-context-e2e.mjs --run --profile=zenmux-deepseek-v41-chat --mode=compaction
OHBABY_REAL_CONTEXT_EVIDENCE_DIR=.ohbaby/test-evidence/improve-6/reacceptance node scripts/run-real-context-e2e.mjs --run --profile=zenmux-gpt56-luna-responses-context --mode=compaction
OHBABY_REAL_CONTEXT_EVIDENCE_DIR=.ohbaby/test-evidence/improve-6/reacceptance node scripts/run-real-context-e2e.mjs --run --profile=zenmux-claude-sonnet5-anthropic-context --mode=compaction
```

## 4. 验收边界

实网证明读取、续接、真实摘要、退休、重开和再次续接；摘要文本通过关键事实问答验证，没有另做逐句人工审读。持久化原生 hash 与 provider 入参精确比较；HTTP 编码层字段保真由三协议 contract 测试承担。实网报告使用校准后上下文估算和实际 usage，没有逐项输出原始估算与不透明状态代理来源。

真实百万窗口达到 95% 和真实上游 overflow 未实测；自动触发边界由确定性测试覆盖。实网使用 force 启动现有压缩流程，不据此宣称已验证真实自动越阈值。
