# Design

## 设计目标

Improve-4 解决两个用户可见问题：

1. 展示型 slash command 的结果不再直接打印到终端 transcript。
2. 流式输出期间，用户可以稳定滚动查看历史，不被每一帧输出拉回底部。

## 范围

纳入：

- `/status`、`/help`、`/mcps`、`/models` 的居中 OverlayCard。
- OverlayCard 的 Esc 关闭、焦点恢复、内部滚动。
- Slash command route：展示型命令打开 panel，动作型命令保持原行为。
- `/models` panel 按可升级为选择器的结构设计，给后续 `/connect` 复用。
- transcript 级滚动状态：stick-to-bottom、用户主动滚动、End 回到底部。
- PowerShell 和 VS Code terminal 的人工验收。

不纳入：

- 不改 SDK 协议字段。
- 不改 message/tool/reasoning 数据结构。
- 不引入 opencode 的 `@opentui/solid` 或 kimi-code 的 pi-tui。
- 不把所有 command 都变成 panel；`/new`、`/exit` 等动作型命令继续走动作链路。
- 不实现 `/connect`，不写入 `model.json` / `.env`，不处理 API key 输入。
- 不在 `/models` 第一版执行模型切换；只保留 UI/状态结构和后续 hook 落点。
- 不在 improve-4 同时重做主题系统。

## Command 分类

第一版把 slash command 明确分成三类：

| 类型 | 示例 | 行为 |
|------|------|------|
| display panel | `/status`、`/help`、`/mcps`、`/models` | 在 TUI 打开 OverlayCard，不进入 transcript，不生成 command notice |
| action command | `/new`、`/exit`、会话操作 | 继续调用后端 command lifecycle，按时间线产生必要 notice 或状态 |
| interactive panel | 后续 `/connect`、模型切换确认 | 多步骤 panel/wizard，拥有焦点和局部状态，确认后才调用后端动作 |

`interactive panel` 本阶段只做设计预留，不实现 `/connect`。这样 `/models` 先以 display panel 落地，但组件和状态不会阻断后续升级。

## OverlayCard

建议组件结构：

```text
AppShell
  Header
  TranscriptBufferViewport 或 TranscriptViewport
  DialogManager
    OverlayCard
      StatusPanel | HelpPanel | McpsPanel | ModelsPanel
  PromptDock
```

第一版用单个 active panel：

```ts
interface CommandPanelState {
  readonly kind: "status" | "help" | "mcps" | "models";
  readonly mode: "display";
  readonly openedAt: number;
  readonly sessionId: string | null;
}
```

行为：

- 展示型 slash command 不 append `commandNotices`。
- 打开新 panel 时替换旧 panel。
- Esc 关闭 panel 并把焦点还给 PromptDock。
- Panel 内部可以捕获 Up/Down/PageUp/PageDown/Home/End。
- Panel 关闭不写 transcript。
- session 切换时关闭 session-scoped panel；全局 help 可选择保留，但第一版统一关闭，避免错觉。
- 后续 interactive panel 可以扩展为 `{ mode: "interactive"; kind: "connect" | "model-select"; step: ... }`，但不把该状态塞进 transcript。

视觉：

- 居中卡片，轻边框，背景使用 theme surface。
- 标题左侧为 panel 名称，右侧为 `esc`。
- 宽度按 terminal columns 计算，建议 `min(88, columns - 8)`，窄屏下最小 44。
- 高度按 terminal rows 计算，内容超出时面板内部滚动。
- 不使用过亮颜色；沿用 improve-1/2 的克制绿、金、灰、淡蓝语义。

Ink 限制：

- Ink 没有 opencode absolute overlay 的同等能力。第一版可以通过 DialogManager 在 transcript 与 PromptDock 之间渲染居中面板，或在 AppShell 内部渲染一个占据可用高度的 panel band。
- 设计目标是“交互上像 overlay”：独立焦点、Esc 退出、不进入 transcript；不要求第一版遮罩整个历史内容。

## Panel 类型

### StatusPanel

显示：

- runtime status
- session id/name
- mode 和 permission
- model
- context window usage
- tools summary
- MCP summary
- project root

要求：

- context 行继续使用 improve-1 的统一口径：`used / contextWindow (percent)`。
- 不显示旧字段 `context` 作为主字段；兼容输出只在后端契约层处理。

### HelpPanel

显示：

- keyboard shortcuts
- slash commands
- skills/agents 入口提示

要求：

- 长列表内部滚动。
- Esc/Enter/q 可关闭。
- 不输出到 transcript。

### McpsPanel

显示：

- MCP server name
- connected/failed/disabled/auth 状态
- 简短错误或 auth hint

要求：

- 状态色使用 success/warning/error，但不要用图标堆叠。
- 第一版只读展示，不做启用/禁用交互。

### ModelsPanel

显示：

- 当前 provider/model
- 可用模型列表
- context window
- interface provider（如 `openai-compatible` / `anthropic`，缺失显示 `Unavailable`）

要求：

- 第一版只读展示，不切换模型。
- 组件结构要按列表/选中态设计，避免后续 `/connect` 接入时重写。
- 如果后端返回 `switching.available = true`，第一版只显示“Switch available”，不触发写配置。
- 后续 `/connect` 成功后应能复用 ModelsPanel 的列表/选择器部分，而不是另做一套 ModelDialog。

## /models 与后续 /connect 的接口边界

`docs\problem-lists\connect-command-model-switch\` 定义了后续 `/connect`：

- provider 类型选择；
- base_url / api_key / model_name 输入；
- API key mask；
- 写入 `model.json` + `.env`；
- `reloadLLMConfig()`；
- 连接成功后模型选择或状态展示。

Improve-4 只负责 UI 基础设施：

- `OverlayCard`：所有 command panel 的外壳。
- `CommandPanelManager`：统一焦点、Esc、打开/替换/关闭生命周期。
- `ModelsPanel`：只读模型状态和列表，可被未来 `ConnectPanel` 复用。
- `DisplayCommandRouter`：在 TUI 内把 display command 短路为 panel。

不在 improve-4 中调用 `setActiveLLMConfig()`、不实现 `switchModel()`，也不引入 API key 表单。这样 `/models` 卡片可以先稳定落地，`/connect` 后续接入时只扩展 panel 类型和后端 action。

## Slash Command 路由

命令分两类：

- display command：打开 panel，不产生 command notice，不写 transcript。
- interactive command：打开 wizard/panel，确认前不调用后端动作。
- action command：继续走现有 command lifecycle，例如 `/new`、`/exit`、session 操作。

建议：

- 在 CLI TUI 层建立 `displayCommandIds = new Set(["status", "help", "mcps", "models"])`。
- 预留 `interactiveCommandIds = new Set(["connect"])`，但 improve-4 不注册 `/connect`。
- Prompt submit 发现 display command 时，直接 dispatch/open panel，不调用后端 command output print path。
- 如果 display command 需要后端数据，优先请求 structured data，再交给 panel 渲染；不要让后端返回预格式化文本。
- 第一版如果 structured data 不齐，可在 panel 内临时读取现有 store/catalog/snapshot 数据，缺失项显示 `Unavailable`。
- stdout/headless 仍使用后端 command output；TUI 的 panel route 是 UI surface 特化，不删除后端兼容输出。

## Terminal Buffer / Virtual Scroll

Improve-3 已有 committed/live split 和 Windows TTY guarded Static。Improve-4 不继续堆 patch，而是引入可切换的 transcript viewport 路径。

建议状态：

```ts
interface TranscriptScrollState {
  readonly scrollTop: number;
  readonly stickToBottom: boolean;
  readonly viewportHeight: number;
  readonly contentHeight: number;
}
```

行为：

- 默认 stick-to-bottom。
- 用户 PageUp/scroll up 后 `stickToBottom = false`。
- 新 token 到来时，如果不 stick-to-bottom，只更新内容，不强制跳到底部。
- 用户 End 或显式 scroll-to-bottom 后恢复 stick-to-bottom。
- run 完成后不自动重置用户滚动位置，除非用户已在底部。
- session 切换或 `/new` 清屏后重置 scroll state。

实现策略：

- 第一阶段加 feature flag，例如 `OHBABY_TUI_BUFFER_VIEWPORT=1`。
- 新增 `TranscriptBufferViewport`，输入是已经拆好的 `committedMessages`、`liveMessage`、`notices`。
- 用 item model 管理 transcript rows：header/message/live/notice/panel 不混在一起。
- 先做固定估高或按 render 后高度缓存；不要在第一版承诺像 gemini 一样完整稳定 scrollback。
- 如果 feature flag 关闭，继续走 improve-3 的 `TranscriptViewport`。

实施分批：

- Batch 4A：OverlayCard + display command route。
- Batch 4B：ModelsPanel 结构对齐 `/connect`，保持只读。
- Batch 4C：Terminal buffer / virtual scroll feature flag。

滚动批次不可阻塞 `/models`/`/status` 卡片落地；二者测试和验收分开。

## Notice 与错误

- `NoticeLane` 继续只放全局/后端 UI notice。
- `commandNotices` 在 improve-3 被收短生命周期；improve-4 对展示型命令不再产生 command notice。
- 命令执行错误如果来自 display command，优先显示在 OverlayCard 内；如果来自 action command，可短暂显示为 command notice，但下一轮操作清除。

## 风险

- Ink overlay 能力有限：需要以“焦点/生命周期/居中卡片”定义成功，而不是以绝对遮罩定义成功。
- terminal buffer 管理会影响 PowerShell 与 VS Code terminal 行为，必须保留 feature flag 和回退路径。
- 展示型命令如果仍依赖后端预格式化 output，会让 panel 只是“换了容器的 print”。后续应逐步改为 structured data。
- `/models` 如果在 improve-4 里直接实现切换，会和 `/connect` 的单模型配置写入方案冲突；本阶段保持只读，避免提前固化错误交互。
