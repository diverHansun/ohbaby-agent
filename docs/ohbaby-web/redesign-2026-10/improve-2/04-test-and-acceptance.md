# improve-2 · 4. 验收

> 行为验收依据 [08](../08-test-and-acceptance.md) 的 UC-DRAFT-01/02、UC-SIDEBAR-01/02，以及[无工作区议题 improve-1](../../../problem-lists/2026-10-20-workspaceless-sessions-and-settings/improve-1/04-test-and-acceptance.md) 的 T18–T20、T24。

## 必须通过

| ID | 检查 | 方式 |
|---|---|---|
| B1 | 点新对话不产生服务端会话；不选项目发送时在默认目录创建；选项目发送时在该目录创建；默认模型读取失败不误判成未配置 | 真实 runtime + 假 HTTP/SSE；真实 daemon 走查 |
| B2 | 换项目不清空草稿文字；刷新页面后草稿和所选项目还在 | unit |
| B3 | 侧栏跨项目显示全部未归档根会话，按项目归属分组；移出项目的会话在 No project，且打开时连接原执行目录而不是默认目录 | integration |
| B4 | Show more 可跨多页凑齐该组，空组/未加载置顶也有继续入口；计数不冒充总数；刷新时重新校验已加载范围，展开数量不丢，外部归档/隐藏的旧行会移除 | runtime integration |
| B5 | HTTP 保留 `SESSION_MOVED.targetDirectory`；最多自动重发 2 次，仍失败后显示错误；重发保留 clientRequestId 和正文，不重复接纳；未知超时走原恢复路径 | runtime integration |
| B6 | 旧的按目录置顶迁移到全局 key，旧 key 保留 | unit |
| B7 | 旧的会话链接仍能恢复原会话 | integration |
| B8 | 拆分后 `runtime/`、`client-*.ts` 各自职责单一，不依赖 React；现有测试迁移后全部通过 | 代码检查 + 测试 |
| B9 | 窗口重新激活、SSE 重连时刷新；刷新失败保留旧数据、不提示 | integration |
| B10 | 每组 6 条、Pinned 8 条、Show more 每次 20 条；折叠状态刷新后保持；行尾相对时间 | unit + 走查 |
| B11 | New chat 从 No project 开始，项目分组的 `[+]` 预选该项目；选择条里的 Open folder… 打开目录选择，新项目被选中且文字保留 | integration |
| B12 | 草稿里的斜杠命令按草稿目录执行；需要会话的命令不出现在候选里或执行时说明原因，不静默失败 | integration |
| B13 | 改了草稿 key 后，插话租约和输入框重挂载行为不变 | integration |
| B14 | `pnpm typecheck`、`pnpm lint`、`pnpm build` 通过 | 命令 |
| B15 | 创建成功但 prompt 失败，重试不再创建会话；提交中切到其他会话/草稿，晚到响应不抢回选择或清空新输入 | runtime integration |
| B16 | 外部触发运行中换项目，本轮 SSE、审批和停止绑定不变；下一轮用新目录；跨目录归档/导出不切换当前连接 | integration + 真实 daemon |
| B17 | 可唯一定位的旧草稿迁移；多个旧草稿不误合并，旧 key 保留；store 新状态按切片组织，无 UI 反向依赖 | unit + 代码检查 |

## 走查

用 06 §5 的 `fresh`、`typical`、`many`、`pending-move` 场景，再用真实 daemon 按无工作区议题 improve-1 的 04 §4.5 顺序走一遍：无项目首发、项目首发、打开旧会话、运行中换项目（换项目操作本身在 improve-3，这里先用接口或 TUI 触发）。
