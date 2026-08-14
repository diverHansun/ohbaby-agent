# TUI 全局快捷键行为

> 文档状态：当前行为说明。历史文件名保留为 `use-keyboard.md`，但实现不是独立 `useKeyboard` Hook；权威代码位于 `packages/ohbaby-cli/src/tui/app.tsx`，总导航见 [../README.md](../README.md)。

## 快捷键合同

| 输入 | 当前状态 | 行为 |
|------|----------|------|
| `Ctrl+C` | 有待处理 permission | 立即按 permission 的 `runId` 调用 `abortRun(runId)` |
| `Ctrl+C` | runtime 正在运行 | 立即按 runtime 的 `runId` 调用 `abortRun(runId)` |
| `Ctrl+C` | 没有可中断 run | 退出 TUI |
| `Esc` 第一次 | runtime 正在运行、没有 permission | 显示再次按键提示，并在 1500ms 后解除 armed 状态 |
| `Esc` 第二次 | 同一 run 且仍在 1500ms 窗口内 | 调用 `abortRun(runId)` |
| `Esc` | 有 permission 或 runtime 未运行 | 不中断；清除已有 armed 状态 |
| `Shift+Tab` | 没有 permission | 通过命令 catalog 构造并执行下一种 permission mode 命令 |
| `Ctrl+T` | todo 超过折叠阈值且没有 dialog | 切换 todo 展开状态 |

## 语义边界

- `abortRun` 只接收明确的 `UiRun.id`，不猜“当前运行”。
- command/slash interaction 的取消不复用 `abortRun`，只通过 `respondInteraction()` 表达。
- 快捷键发起写操作后不自行伪造终态；结果继续由 SDK 事件更新 store。
- 输入处理在 interaction 或 command panel 占用键盘时暂停，避免多个消费者同时处理同一按键。

上述行为由 `packages/ohbaby-cli/src/tui/app.contract.test.tsx` 锁定；若本文与测试或当前 SDK 类型冲突，以测试和 SDK 类型为准并修正文档。
