# improve-5 收尾：首轮目标内容与输入区状态条

2026-10-15 开始，2026-10-16 验收。基线 `5e23b518`，继续在 `codex/goals-upgrade-improve-5` 完成用户截图反馈，不另开实施批次。此前交付和测试事实保留在 [05](./05-implementation-acceptance.md)。本次要求覆盖原方案中首轮 `Goal started` 与 Web header goal chip 的选择。

## 用户要求与代码核对

1. 创建并启动 goal 后，聊天中的首条 prompt 应显示用户目标内容。
2. Web header 不再显示 goal chip 及其状态点。参考用户提供的 Codex 截图，在输入框上沿放置轻量目标条：单色靶心、状态、目标摘要、暂停/恢复与编辑入口。长目标可在这一行省略；整体保持简约，减少独立卡片。

真实模型正文没有被替换成 `Goal started`。`GoalService.admitTurnInBoundary` 已分别生成完整 `modelText` 与 `displayText`，问题是首轮显示值使用固定字符串。adapter 的 live 事件、runner 持久化 metadata 和 SQLite 回放已消费同一显示值，所以只需在准入处把首轮显示改为同次快照的 objective。模型正文、criterion、runtime context、标题来源和续轮短提示沿用既有逻辑。

Web 的旧入口位于 `SessionStatus` 的 header 与 empty state，调用 `GoalStatusChip`。`GoalOverlayBody` 已具备暂停、恢复、预算调整、取消和中途修改 objective 的能力；`/goal replace` 修改现有目标及执行 epoch，不新建目标、不归零累计。因此新条应复用命令和编辑面板，避免新增后端协议或第二份目标状态。

浏览器基线检查另复现了多行目标丢失：创建面板提交两行文字，SDK 已把后续行解析为 invocation.body，但 `/goal` handler 只使用 argv，导致创建和修改时丢掉后续内容。该问题影响本次“展示用户目标内容”的完整性，纳入收尾修复；不改全局 slash parser，不重设计命令协议。

## 实施与验证边界

- 首轮气泡展示完整目标原文；状态条仅做视觉省略，不截断保存或模型正文。旧消息 metadata 不迁移，历史 `Goal started` 保持原样。
- header 保留原有连接、运行、模型和 context usage 信息，只移除 goal 展示。状态条位于 queued/steer 提示下方，始终紧邻输入框，不替代 TodoDock。
- 复用后端轮次/活跃时长快照，不新增前端计时器。编辑回到既有面板；恢复仍遵守 blocked 和预算校验。
- 验证 live/持久化/重连展示、目标原文与模型转义、暂停与恢复、编辑后摘要、header 移除、手机宽度省略和键盘可达；通过真实 daemon/SQLite 与浏览器执行端到端流程。
- 用户指定 Pi `google/gemini-4-argon` 协助 Web 实施，主代理负责整合、审查与最终验收。


## 实际实现与审查修复

- 首轮 `displayText` 使用同次准入快照的 objective。live、SQLite 回放与 HTTP 重连都通过既有投影链路；模型正文和续轮文案不变。
- `/goal` 和 `/goal replace` 合并 SDK 已解析的 `body`，修复多行目标只保存第一行；回归覆盖 CRLF、引号参数、空行、正文缩进、中文与 XML 特殊字符。
- `GoalComposerStrip` 使用现有 slash command 与 Goal 面板，不增加 SDK 协议或目标副本。状态条为单色图标与单行文本，只有暂停/恢复和编辑两个常驻按钮。blocked 打开恢复面板，paused 直接恢复失败时带入后端错误。
- Pi `google/gemini-4-argon` 完成前端主体和对应测试。独立子代理复现同会话目标更换时旧请求污染，补充目标正文/清空的代次隔离；先红 4 项，再绿 7 项。另修复输入框层级遮住子代理只读提示的问题。撤回无产品必要性的 overlay JSX 移位，测试显式限定面板范围；删除仅镜像 CSS 声明的新增测试。
- 内置浏览器在 390px 验收发现附加数字挤占摘要，480px 以下隐藏状态条的轮次/时长；面板保留完整统计。状态、目标摘要与两个图标始终单行可见，页面无横向溢出。

## 验证记录

| 检查 | 本轮结果 |
| --- | --- |
| 全仓 unit | 340 文件；4245 通过，2 跳过 |
| 全仓 contract | 37 文件；550 通过 |
| Web goal resume + persistent UI + goal context integration | 3 文件；50 通过 |
| HTTP daemon goal E2E | 5 通过；1 项付费真实模型测试保持 opt-in，未运行 |
| 最后两份 UI 测试复核 | 205 通过（包含在全仓 unit 内） |
| 构建与静态检查 | 全仓 build、Web 最终 rebuild、CLI 资源重新打包、typecheck、改动文件格式及 diff 检查通过；lint 为 0 errors / 122 既有 warnings |

单元回归覆盖 header 移除、strip 与输入框相邻、queue/steer 位于其上、编辑预填、暂停/恢复、后端失败、断线禁用、跨会话/目标旧操作隔离。真实 HTTP E2E 通过实际 slash parser 创建多行目标，验证 live/replay/reconnect、完整模型正文、计轮与恢复行为。

内置浏览器使用隔离 OHBABY_HOME、临时工作区和真实 daemon/SQLite，模型端为确定性 provider，不读取用户 API key。通过 UI 创建、暂停、恢复、运行中编辑多行目标、预算耗尽、恢复失败保留错误、追加两轴预算恢复、刷新后保留原文与统计；移动端验证 390×844、操作按钮可达、摘要省略和键盘打开编辑面板。首条用户消息 DOM 中保留换行与 `<台北> & 東京`，旧历史消息不做迁移。


额外的持久化布局 fixture 同时放入 paused goal（3/20 turns、24s）、两条 retained prompt 和一条 unconsumed steer；1280×850 与 390×844 内置浏览器截图确认顺序。桌面 queue 和 goal 同为 784px，goal 窄条总高 41px、底部叠入输入框 6px；手机二者同宽且页面 scrollWidth=390。展开恢复区不会把 goal 与输入框分开，页面控制台无 warning/error。子代理记录 fixture 用于视觉验证，只读标签实际可见；它未执行真实子代理生命周期，不作为该生命周期的端到端证明。

本轮没有改变 goal 调度、预算算法或存储 schema；没有运行付费模型请求。之前 improve-5 的真实 API 结果继续作为历史记录，不冒充本轮复测。临时浏览器 fixture 与截图不进入产品仓库。

## 提交与合并

- `2fc27343`：首轮展示目标原文、创建/修改保留多行内容，以及对应 live/replay/HTTP 回归。
- `20f22e89`：输入框上沿目标状态条、交互与竞态保护、响应式布局和回归测试。
- 本收尾文档同步当前模块行为，随后将 improve-5 分支本地 fast-forward 合并至 `codex/goals-upgrade` 与 `main`；不 push。

两次代码提交均通过仓库 pre-commit 的全仓 lint 与 typecheck。临时测试服务已停止、隔离数据目录已清理，内置浏览器 viewport 已恢复；已有 `.playwright-mcp/` 未纳入提交。

用户随后要求精简 steer 输入恢复区，后续实现及独立验收见 [07-steer-recovery-polish](./07-steer-recovery-polish.md)。
