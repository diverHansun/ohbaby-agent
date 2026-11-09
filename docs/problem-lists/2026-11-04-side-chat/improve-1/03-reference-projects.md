# 3. 参考项目

> 2026-11-04 由子代理只读调研，主代理汇总。路径都在 `/Users/hansun025/Projects/code-cli/` 下，行号是调研时的快照。用户要求对照 codex 实现。

## 3.1 调研范围

| 项目 | 看了什么 |
|---|---|
| codex | TUI 的 `/side`、`/btw`：创建、继承、提示、禁用清单、持久化、关闭 |
| ZCode | 选中文字打开 side chat、隐藏子会话、可见性标记 |
| kimi-code | `/btw`：fork 主 agent、只读工具拦截 |
| claude-code | `/btw` 单次提问 |
| opencode | `/btw` 单次生成、Web 侧栏页 |
| deepseek-harness（下称 dsh） | side session 提案、选中文字引用 |

## 3.2 可借鉴点

| 项目 | 做法 | 本项目取舍 |
|---|---|---|
| codex | `/side` 与 `/btw` 是同一个命令，可带首条消息（`codex-rs/tui/src/slash_command.rs:146`、`chatwidget/slash_dispatch.rs:107-118`）。用 `thread/fork` 建一个临时分支，继承最新的完整历史，主线程不被打断（`tui/src/app_server_session.rs:1192`、`app-server/.../thread_processor.rs:5471`）。界面上不显示继承的历史（`tui/src/app/side.rs:708-717`） | **采用**：命令形态、继承完整历史、主会话不被打断、界面不显示继承内容 |
| codex | 两段提示：开发者说明（`side.rs:44-60`，参考而已、不接着做旧任务、不能用子代理、没被要求不改文件和配置）和放在末尾的用户角色“边界”消息（`side.rs:28-42`） | **改造**：两段合成一条边界消息，不改系统提示词，保住提示词缓存 |
| codex | 只放行少数斜杠命令，禁止改名、回溯、fork、归档（`slash_command.rs:203-219`、`side.rs:19, 281`、`app_backtrack.rs:59, 159`） | **采用**：禁用清单 |
| codex | 一个视图同时只有一个 side，再执行 `/side` 回到原来那个（`side.rs:26, 676-684, 759-772`） | **不采用**：用户确认一个主会话可以开多个（2026-11-08，对照 codex app、Claude app；ZCode 也允许多开） |
| codex | 临时分支不写文件、不进列表、不能恢复；关闭、退出、归档父线程时都会丢弃（`thread_processor.rs:5833-5874`、`side.rs:397-418`、`thread_routing.rs:52-75`）；结果不回到主线程 | **采用**：关闭即删、不进列表、不带回。**改造**：本项目运行时依赖数据库，side chat 是一个写进库里的隐藏根会话，靠关闭时删除和启动清理达到同样效果；界面用一个独立的客户端连接去看它，而不是像 codex 那样在同一进程里切换线程视图 |
| codex | 主线程正在运行时，复制的历史末尾加一个“已中止”标记（`core/src/thread_manager.rs:225-232`） | **改造**：本项目只复制已结束的轮次，把正在运行那一轮的用户输入写进边界消息 |
| ZCode | 选中一行里的文字，弹出“在 side chat 里问”；side chat 是隐藏子会话，复用 fork 路径，继承的消息“模型可见、界面隐藏”；工具全开，但 goal、编辑、重试、fork 在界面和协议两层都禁用（`docs/ui/conversation-selection-side-chat.md`、`session-fork.ts:818-862`、`commands/executor.ts:10-50`） | **采用**：选中文字入口、和 fork 共用复制历史的代码（本项目由 side chat 先写，00 P18）、工具全开加禁用清单、协议层拦截。**不采用**：做成子会话。本项目的子会话会被大量“只认主会话”的检查拦住，见 01 §1.3 |
| kimi-code | `/btw` fork 主 agent，保留全部工具定义以保住缓存，执行时拦截非只读工具（`features/btw/btw.ts:16-19`、`btwService.ts:25-38`） | **采用其思路**：工具列表不变、执行时拦截，但本项目只拦截子代理工具 |
| dsh | 提案里 side session 是普通 fork 加一条插件来源的上下文消息，系统提示词不变以保住前缀缓存（`.agents/notes/proposed/feature/2026-07-08-interactive-side-sessions.md`） | **采用**：说明放在消息里、不改系统提示词 |

## 3.3 明确不借鉴

- **单次调用、不用工具**（claude-code `src/utils/sideQuestion.ts:53-102`，opencode `core/src/session/generate.ts:25-67`）：用户要求能做零碎任务，工具要可用。
- **只读工具**（kimi-code）：用户要求工具全部可用。
- **side chat 结果带回主会话**（dsh 提案的“合并回去”）：用户确认不做。
- **选中文字引用到主输入框**（dsh、kimi-code、ZCode 都有）：用户确认本轮只做“在 side chat 里问”。

## 3.4 对 02 的影响

| 02 决策 | 来源 |
|---|---|
| 继承完整历史、主会话不被打断、界面不显示继承内容 | codex、ZCode |
| 边界消息、不改系统提示词 | codex 的边界消息、dsh 的缓存考虑 |
| 禁用清单、关闭即删 | codex |
| 和 fork 共用复制函数 | ZCode、codex（side chat 都建在 fork 之上） |
| 工具列表不变、执行时拦截 | kimi-code |
| 选中文字入口 | ZCode |
