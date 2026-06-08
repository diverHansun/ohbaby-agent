# Tests And Acceptance

## 单元测试

- command routing：
  - `/status` 打开 `StatusPanel`，不 append `commandNotices`。
  - `/help` 打开 `HelpPanel`，不 append transcript message。
  - `/mcps` 打开 `McpsPanel`。
  - `/models` 打开 `ModelsPanel`。
  - `/new` 仍走 action command，不打开 OverlayCard。

- OverlayCard：
  - Esc 关闭 panel。
  - 打开新 panel 替换旧 panel。
  - session 切换时 panel 关闭。
  - 窄屏下宽度不越界。
  - 长内容内部滚动，PageUp/PageDown/Home/End 生效。

- StatusPanel：
  - context window 行显示 `used / contextWindow (percent)`。
  - 缺失字段显示 `Unavailable`，不抛错。

- Terminal buffer viewport：
  - 默认 stick-to-bottom。
  - 用户上翻后新 delta 不强制滚到底部。
  - End 后恢复 stick-to-bottom。
  - session 切换重置 scroll state。
  - `/new` 清屏后 scroll state 归零。

## 集成测试

- 执行 `/status` 后显示 panel，发送下一条 prompt 前 panel 已关闭或不污染 transcript。
- 执行 `/help` 后按 Esc，PromptDock 恢复可输入。
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

## Definition Of Done

### Merge Gate

- `pnpm test` 通过。
- `pnpm typecheck` 通过。
- `pnpm build` 通过。
- `pnpm lint` 通过；若存在历史 warning，需记录。
- display command 不再产生 transcript/command notice 输出的测试通过。
- OverlayCard 关闭和内部滚动测试通过。
- terminal buffer viewport 的 stick-to-bottom 与 user-scroll-away 测试通过。

### Manual Gate

- 用户在 PowerShell terminal 验收 OverlayCard。
- 用户在 PowerShell terminal 验收 streaming 时可滚动历史。
- 用户在 VS Code terminal 验收同样场景。
- 子代理审查无阻塞项。
