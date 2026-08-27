# 5. 实施与验收记录

> 状态：2026-08-27 已实施、已完成两轮子代理审查与 Web/TUI E2E，等待用户最终审核。所有 commit 仅在本地临时分支 `docs/session-cache-hit-plan`；未 push、未 merge `main`。

## 5.1 实际交付

实现保持 02 的职责边界：provider-neutral usage 仍由 llm-client 透传；session 累计器位于外层 UI backend client；`promptCacheUsage` 是 `/status` 的独立投影，不进入 Context composition、snapshot 或压缩控制。

主要行为：

1. `UiPromptCacheUsage` 固定为 `sessionId / accountedInputTokens / cacheReadTokens / cacheReadShare`。
2. 仅累计主代理、`usageComplete=true` 且带可信 `inputBreakdown` 的 agent-step；比例由 session 累计 token 加权计算，不平均每轮百分比。
3. compact、自动 title/summary 与模型切换不清桶；进程重启不恢复。
4. child session 不进入主 session 账本；remove/archive 清桶并拒绝迟到回调复活；dispose 先关闭接收门再清理。
5. Web 与 TUI 均在 Context 后、Tools 前显示独立的 `Cache hit n%`；未知或非法 payload 失败关闭，可信分母尚不存在时显示 `—`。

## 5.2 本地分批 commit

| Commit | 内容 |
|---|---|
| `acc3f43` | `docs(cache): define session cache-hit implementation contract` |
| `14586e3` | `feat(cache): add session prompt-cache accounting` |
| `273b621` | `feat(cache): project session usage through runtime` |
| `eb3a5df` | `feat(ui): show session cache hit in status` |
| `255d771` | `docs(cache): align status and lifecycle boundaries` |
| `4e85bf5` | `fix(cache): guard retired session accounting` |
| `08d38cf` | `fix(tui): preserve cache usage in status overlay` |

文档验收收尾另以独立 commit 提交，便于审核设计、实现、UI 和复核修正的边界。

## 5.3 自动化验证

| 门 | 结果 |
|---|---|
| lint | 通过 |
| typecheck（strict） | 通过 |
| 改动文件 Prettier | 通过；全仓仍有 39 个与本批无关的既存格式告警 |
| build / compiled Web build | 通过 |
| unit | 227 files；2111 passed；2 skipped |
| contract | 15 files；251 passed |
| integration | 49 files 中 48 passed；322 tests 中 321 passed；唯一失败是既存 `packaging-smoke.integration.test.ts` 240 秒超时，与 cache/context 无关 |
| 最终定向回归 | 9 个相关测试文件；376 项通过 |

覆盖重点包括：可信/未知/畸形 usage、加权累计、缺字段整 run 跳过、compact/title/summary 隔离、child 隔离、重复 wait 不重算、早/晚取消、runtime reset、remove/archive、迟到回调、Web/TUI adapter 与显示顺序。

## 5.4 端到端验证

### Web

compiled Web、真实 daemon 与本地 scripted OpenAI-compatible provider 联调通过：

- prompt → tool call → tool result → follow-up 全链完成；
- `/status` 在七类 Context 后显示独立 `cache / hit 58%`；
- 刷新后 session、消息、tool/follow-up 结果与 `hit 58%` 均保持；
- provider 证据为 3 次请求、稳定 session key、tool result 已被后续请求消费；
- 浏览器 console 无 warn/error，daemon、PID 与端口正常清理。

### TUI

真实编译产物的 in-process TUI 与本地 scripted provider 联调通过。provider 报告 `cacheRead=610 / prompt=1000`，交互式 `/status` 显示：

1. Context `7.4K / 32.8K (23%)`
2. Cache `hit 61%`
3. Tools

这次 E2E 发现并修复了真实生产路径缺口：TUI sanitize allowlist 曾丢掉 `promptCacheUsage`，交互式 StatusPanel 也未渲染 Cache 行。`08d38cf` 复用同一个 fail-closed adapter/formatter 补齐，并由回归测试锁定。

远程 TUI 连接同一 daemon 时另观察到既存的 `Cannot read properties of undefined (reading 'rpc')` 方法绑定问题；它发生在 cache 状态读取前，与本批无关，未在本批扩张修复范围。

## 5.5 子代理审查结论

最终 SWE 审查与文档/验收审查均未发现代码 blocker：

- archive 后迟到 usage 不会复活 session 桶；
- late cancel 保留已产生 usage，同时终态仍明确为 cancelled；
- TUI overlay 使用统一校验器，不复制安全边界；
- DTO、累计语义、生命周期、Web/TUI 六态 UI 与文档一致。

审查提出的额外 dispose-late-callback、child 已累计不变与贯穿 `/status` 的 late-cancel 用例属于可选重复护栏。现有生产代码由接收门与 child 过滤防御；分层测试已锁定取消传播、tracker 累计，并为 dispose/child 边界提供间接证据。本轮依 SWE/KISS 不额外引入测试专用钩子或重复场景。

## 5.6 审核门

当前实现可以进入用户审核。用户明确批准前：

- 不 push 本地临时分支；
- 不 merge 到 `main`；
- 不处理下一批 cache 策略、计费、持久化或远程 TUI 绑定问题。
