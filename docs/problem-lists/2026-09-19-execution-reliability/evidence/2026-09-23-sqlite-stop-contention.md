# SQLite 写锁竞争下的真实 serve Stop 计时诊断

2026-09-23，当前本地源码构建后运行。**这是改造前的诊断，不是 1 秒目标已通过的验收。**测试使用新建临时 OHBABY_HOME、数据库、工作区和本机假模型 HTTP 服务；没有读取 `.env` 或原有 ohbaby 数据库，没有真实模型和外部网络请求。每次运行结束删除临时目录、停止自己启动的进程。可重跑脚本见[`tests/diagnostics/sqlite-stop-contention.mjs`](../../../../tests/diagnostics/sqlite-stop-contention.mjs)。

## 反馈环

仓库根目录先运行 `pnpm --filter ohbaby-cli build`，随后：

```sh
node --no-warnings tests/diagnostics/sqlite-stop-contention.mjs --no-lock
node --no-warnings tests/diagnostics/sqlite-stop-contention.mjs --lock-without-queued-write --idle-ms=1000
node --no-warnings tests/diagnostics/sqlite-stop-contention.mjs --idle-ms=1000 --hold-ms=500
node --no-warnings tests/diagnostics/sqlite-stop-contention.mjs --idle-ms=1000
```

脚本真正启动 `pnpm --filter ohbaby-cli start serve --port 0 --no-open`，通过真实 JSON-RPC 提交一条 prompt，让本机假模型保持流连接；从另一 SQLite 连接持有 `BEGIN IMMEDIATE` 写锁，再调用真实 `abortRun`。有排队写入的变体，会在 Stop 前通过 RPC 提交同会话第二条 prompt，制造服务器正在同步等锁的时刻。脚本在写锁持有期结束后回滚并清理。最后一条在当前代码下退出码为 1，表示取消信号外部观察点超过 1 秒目标；修复后应变绿。

| 场景 | Stop 后仍持锁 | 假模型流关闭（取消信号的外部观察点） | Stop RPC 回复 | 结论 |
|---|---:|---:|---:|---|
| 无锁对照 | 0 ms | 7 ms | 10 ms | 正常快 |
| 仅持锁，模型请求已稳定 1 秒 | 2500 ms | 10 ms | 2544 ms | 取消先发，RPC 后续步骤仍等数据库；不能把慢回复直接说成取消信号晚发 |
| 持锁＋前面有一笔 prompt 写入 | 500 ms | 538 ms | 545 ms | 延迟随锁持有时间缩短 |
| 持锁＋前面有一笔 prompt 写入 | 2500 ms | 2603 ms、2581 ms（两次） | 2610 ms、2588 ms | 两次均超过 1 秒；Stop 请求在同步写入等待期间无法及时处理 |

另一轮未等待模型稳定的“仅持锁”也看到约 2.56 秒后流才关闭，说明刚启动模型流时还可能存在其他未完成写入；上表采用等待 1 秒后的对照，避免把它误当成 Stop 自身必然先查库。模型连接关闭**不是**内部 `AbortController.abort()` 的精确时间戳，可能稍晚；正式 T08 应在后端记录 Stop handler 进入、受理和取消信号发出的时刻，同时记录外部客户端发出请求与 RPC 回复时刻。外部延迟与持锁时间同步变化，加上源码中的同步 `DatabaseSync`、5 秒 `busy_timeout` 和 `Atomics.wait`，足以确定本 fixture 有事件循环阻塞路径；尚不能推出所有历史停顿的唯一原因。

本轮还有一次测试进程在 `serve` 准备阶段超过脚本的 30 秒启动上限；下一次同路径无锁对照正常，约 8 毫秒关闭模型流、10 毫秒回复 Stop。启动超时发生在锁与 Stop 计时之前，单独保留为测试环境波动，不计入上表的因果结论。

## 假设与区分证据

| 假设 | 可检验预测 | 本次结果 |
|---|---|---|
| H1：前一笔同步 SQLite 写入占住服务器事件循环 | Stop 与模型连接关闭延迟应随另一连接持锁时间增长 | 500ms 持锁对应约538ms关闭，2500ms对应约2.6秒；支持 |
| H2：取消已发出，但 Stop RPC 还在等数据库步骤 | 去掉前置写入、让模型流先稳定，关闭应很快，RPC仍可能慢 | 关闭约10ms，RPC约2544ms；支持，两段时间不能混称“取消延迟” |
| H3：模型连接本身或外部网络造成主要延迟 | 无锁、本机假模型场景也应很慢 | 无锁关闭约7–8ms、RPC约10ms；本 fixture 不支持 |

## 两个不同的问题

1. **Stop 连处理机会都拿不到。** 前一笔 prompt 写入在 `BEGIN IMMEDIATE` 上同步等锁，后端事件循环无法处理刚到的 Stop；这直接违反第二轮 D33 的 1 秒取消响应目标。`runtime/prompt-scheduler/database-store.ts:754` 的事务入口及共享连接的 `busy_timeout=5000` 是该 fixture 的主要代码路径。
2. **取消已发，但 Stop RPC 回复仍慢。** 没有前置写入时，假模型流约 10 毫秒关闭，RPC 却等到锁释放才回复。当前 `abortRun → runtimeController.abortPromptRun → interruptRunTree` 路径会继续等待子代理/存储相关收尾；这与“已受理”“已登记”“已清理”应分开表达的第四轮契约有关。本测试不能仅凭 RPC 回复时间确定其中哪一步在等锁；实施时应定点记录阶段，不据此改写停止顺序。

## 修复与验收边界

先保证同步等锁不会使 Stop 请求失去处理机会，并检验缩短全局 busy 等待后是否让正常短暂争用变成保存失败。若需引入异步重试，只在事务开始前等待且保留同连接写入顺序；关键结果与 Stop 登记不能因用户 Stop 被静默丢弃。只有这些小范围做法在真实 `serve` 测试仍不达标，再评估专用数据库 worker。1 秒目标是本地客户端发出 Stop 到后端受理并发出取消信号，不要求关键记录落盘或进程退出在 1 秒内完成。后续用户已按第二轮D34确认：Stop原按钮提供等待反馈，可靠本轮终态到达后结束；RPC和按钮不受1秒完成期限约束。本段更新解释边界，以上诊断数据未重跑，也不代表产品已修复。
