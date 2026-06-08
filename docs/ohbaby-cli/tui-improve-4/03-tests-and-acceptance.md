# Tests And Acceptance

## 单元测试

- command routing：
  - `/status` 打开 `StatusPanel`，不 append `commandNotices`。
  - `/help` 打开 `HelpPanel`，不 append transcript message。
  - `/mcps` 打开 `McpsPanel`。
  - `/models` 打开 `ModelsPanel`，显示当前模型、provider、interface provider、context window。
  - `/new` 仍走 action command，不打开 OverlayCard。
  - 预留的 interactive command 不影响现有 action/display command 路由。

- OverlayCard：
  - Esc 关闭 panel。
  - 打开新 panel 替换旧 panel。
  - session 切换时 panel 关闭。
  - 窄屏下宽度不越界。
  - 长内容内部滚动，PageUp/PageDown/Home/End 生效。
  - 关闭 panel 后 PromptDock 仍可输入，slash completion 的 Tab/Enter 行为不回归。

- StatusPanel：
  - context window 行显示 `used / contextWindow (percent)`。
  - 缺失字段显示 `Unavailable`，不抛错。

- ModelsPanel：
  - 缺失 `interfaceProvider` 时显示 `Unavailable`。
  - `switching.available = true` 时只显示可切换状态，不执行切换。
  - 不泄露 API key、base_url 中的敏感 query、或 `.env` 内容。
  - 后续 `/connect` 可以复用的列表数据结构有单测覆盖。

- Terminal buffer viewport：
  - 默认 stick-to-bottom。
  - 用户上翻后新 delta 不强制滚到底部。
  - End 后恢复 stick-to-bottom。
  - session 切换重置 scroll state。
  - `/new` 清屏后 scroll state 归零。

## 集成测试

- 执行 `/status` 后显示 panel，发送下一条 prompt 前 panel 已关闭或不污染 transcript。
- 执行 `/help` 后按 Esc，PromptDock 恢复可输入。
- 执行 `/models` 后按 Esc，PromptDock 恢复可输入；不会调用 `executeCommand` 的 print path。
- `/models` panel 和后端 `/models` structured data 的字段口径一致。
- streaming assistant 输出期间，连续 `message.part.delta` 只更新 live item。
- 用户上翻后继续收到 streaming delta，viewport 的 scrollTop 保持稳定。
- action command 的短生命周期 command notice 仍按 improve-3 规则清理。

## E2E

使用真实终端执行：

- PowerShell terminal：
  - `/status`、`/help`、`/mcps`、`/models` 都显示居中卡片。
  - Esc 关闭卡片后可继续输入。
  - streaming 长输出时 PageUp/滚轮查看历史，不被持续拉到底部。
  - End 回到底部后继续跟随输出。

- VS Code terminal：
  - 同样执行上述场景。
  - 验证没有明显闪烁回归。

## 真实 API 场景

- 普通中文问答。
- 长文本流式输出。
- 工具调用输出。
- `/status` 打开期间不影响后台状态刷新。
- `/new` 后卡片和滚动状态都清理。

## /connect 兼容性验收（本阶段不实现）

- improve-4 文档明确 `/connect` 属于后续 interactive panel，不在本分支注册命令。
- `/models` 的 panel 状态不假设多模型并发，不阻碍单模型配置切换。
- OverlayCard/CommandPanelManager 不把 API key、表单草稿或确认态写入 transcript。
- 子代理审查时需检查 `/models` 卡片是否会导致后续 `/connect` 需要重写 UI 外壳。

## Definition Of Done

### Merge Gate

- `pnpm test` 通过。
- `pnpm typecheck` 通过。
- `pnpm build` 通过。
- `pnpm lint` 通过；若存在历史 warning，需记录。
- display command 不再产生 transcript/command notice 输出的测试通过。
- OverlayCard 关闭和内部滚动测试通过。
- `/models` 与后续 `/connect` 的边界测试/文档通过。
- terminal buffer viewport 的 stick-to-bottom 与 user-scroll-away 测试通过。

### Manual Gate

- 用户在 PowerShell terminal 验收 OverlayCard。
- 用户在 PowerShell terminal 验收 streaming 时可滚动历史。
- 用户在 VS Code terminal 验收同样场景。
- 子代理审查无阻塞项。
