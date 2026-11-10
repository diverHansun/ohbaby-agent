# Side Chat 后端实施与验收

2026-11-10 · Stage 1 · 本地分支 `codex/side-chat-backend` · 起点 `605d3fb7`

## 可交付行为

| 操作 | 后端行为 |
|---|---|
| 打开 | 在同一 SQLite 事务中复制到最近一个有历史消息的已结束主 run，写入边界消息。如果首条 prompt 已被接收而首轮仍在排队或执行，边界会带上当前请求。空会话返回 `409 SIDE_CHAT_UNSUPPORTED`。 |
| 提问 | 新的 prompt、run、审批属于侧聊。已加载的 MCP 工具按复制的历史重建。模型请求和自动压缩沿用主会话的缓存身份，文件工具使用主会话的 scratch。侧聊创建时复制已有会话审批规则，之后各自更新。 |
| 发现与恢复 | 普通会话列表、搜索和自动继续隐藏侧聊。恢复列表按创建顺序返回当前进程的侧聊，每条包含 `sideChatId`、`title`、`createdAt`、`boundaryMessageId` 和 `workingDirectory`。 |
| 移动主会话 | 已有侧聊继续使用原工作区。新开侧聊继承主会话此前各工作区的完整历史，并在目标工作区接受新问题。恢复客户端按列表里的目录重新绑定。 |
| 关闭与归档 | 关闭时取消排队、中止运行、清理审批并删除侧聊，重复关闭返回 `204`。主会话归档前检查运行状态，再到每个侧聊的工作区完成清理。启动时回收创建进程已退出的侧聊。 |

手动压缩、模型或 reasoning 切换、goal、改名、归档、移动、导出及嵌套侧聊走禁用检查。模型在侧聊里调用子代理工具会收到说明，其余工具继续按既有权限运行。共享复制函数及切点查询可供下一轮 Fork 使用。接口见 [02 §2.5](02-optimization-plan-and-change-scope.md#25-接口)。

## 后端验证

端到端验收直接启动构建后的 CLI，用 `curl` 调用 daemon，并用 `sqlite3` 核对落库结果。工作区、数据库和本地 OpenAI 兼容模型端点均为临时实例。

| 实际操作 | 观察结果 |
|---|---|
| 在空主会话开侧聊，然后提交第一轮再打开 | 首次返回 409 和 “Send a message first”。第一轮成功后，打开和恢复接口返回同一个侧聊及边界 ID。 |
| 分别绑定主客户端和侧聊客户端并提问，随后手动压缩并连续关闭侧聊两次 | 两边各自的 prompt 均成功且记录在各自会话下。手动压缩返回 409，两次关闭均返回 204，SQLite 中该侧聊的会话行已删除。 |
| 从工作区 A 打开侧聊，将主会话移动到 B，再在 B 打开第二个侧聊 | 从 B 查询恢复列表得到 A、B 两个目录。主会话已有的两条 prompt 保留在 A，新侧聊的两条历史副本位于 B。 |
| 按恢复列表的目录重新绑定 A 的侧聊并提问，随后从 B 归档主会话 | 提问在原侧聊成功完成。主会话状态变为 `archived`，两处侧聊均已删除。 |

已有回归用例按 [04 的 Stage 1 场景](04-test-and-acceptance.md) 验证历史切点、同毫秒消息排序、steer、压缩、模型原生状态、缓存与工具、客户端隔离、归档竞态和启动清理。其中跨目录归档用例让旧侧聊同时有一个待审批的工具调用和一条排队消息，归档后分别得到 `interrupted` 和 `cancelled`，待审批列表为空。模型请求的前缀和缓存键在请求边界比对，供应商的线上缓存命中率未实测。

聚焦检查可直接运行：

```sh
pnpm exec vitest run packages/ohbaby-agent/src/services/session/copy-history.integration.test.ts \
  packages/ohbaby-agent/src/adapters/ui-inprocess/side-chat.integration.test.ts \
  packages/ohbaby-agent/src/adapters/side-chat-runtime.integration.test.ts \
  packages/ohbaby-server/src/runtime/daemon/main.unit.test.ts
```

上述 4 个文件中的 38 项测试通过。`pnpm build`、`pnpm typecheck` 和 `pnpm format:check` 通过，`pnpm lint` 报告 0 个错误、119 个警告。

在代码提交 `a0bc0695` 上运行 `pnpm exec vitest run --maxWorkers=3 --minWorkers=1`，7,860 项通过、17 项跳过、0 项失败。先前一次四 worker 运行中，已有的 SQLite 写入预算用例得到另一条 busy 错误文案。该文件独立复测三次，每次 4 项均通过，随后也通过了上述全量回归。本轮没有修改数据库写入预算和重试逻辑。

## 审查确定的边界

- 当前进程持有侧聊才能关闭它。侧聊由另一活进程持有，或本地运行在 5 秒内无法停止时，返回 `409 SESSION_RUNNING` 并保留该侧聊。归档前会检查是否存在其他进程持有的侧聊。多个侧聊逐个关闭，若其中一个超时，主会话保持活跃，此次已成功关闭的侧聊保持关闭。可重试归档以完成剩余清理。
- 如果切点消息的时间晚于当前系统时间，打开操作回滚并给出可重试时间，避免后续问题落在边界之前。
- 此轮交付持久化进程内后端、daemon 和 SDK。Web 面板、TUI `/btw` 及其界面验收留到三个后端阶段之后。Fork 和 Rewind 分别在后续阶段加入自身入口的侧聊禁用检查。
