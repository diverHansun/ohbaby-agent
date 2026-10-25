# improve-3 · 4. 验收

> 行为验收依据 [08](../08-test-and-acceptance.md) 的 UC-SEARCH-01、UC-PROJECT-01/02、UC-SESSION-01，以及[无工作区议题 improve-1](../../../problem-lists/2026-10-20-workspaceless-sessions-and-settings/improve-1/04-test-and-acceptance.md) 的 T21、T22。

## 必须通过

| ID | 检查 | 方式 |
|---|---|---|
| C1 | 空闲和运行中都能移入、换项目；运行中当前回复不中断，下一轮在新目录运行，界面不额外提示 | integration + 真实 daemon 走查 |
| C2 | 移出项目后会话在 No project，工作目录不变 | integration |
| C3 | 改归属失败时行留在原处，右上角错误通知写明原因 | integration |
| C4 | 搜索能找到侧栏没加载的旧会话；标题命中在前；快速输入只显示最后一次结果 | integration（`many`、`search` 场景） |
| C5 | 无结果显示 `No chats match "<关键词>".`；失败时可重试、关键词保留 | integration |
| C6 | 菜单和搜索全部能用键盘完成，关闭后焦点回到触发元素；Esc 一次只关一层，不抢输入框的 Esc | unit |
| C7 | 归档后行立即消失、无成功提示；当前会话仅成功后回草稿，失败恢复行并保持主区；归档/导出其他目录会话不影响当前 SSE | integration |
| C8 | 项目菜单 Hide project 生效，隐藏项目的会话仍能搜到；`Cmd/Ctrl + K` 打开搜索；右键会话行打开菜单；Export… 的二级列表能导出；项目超过 8 个时项目列表出现过滤框 | integration + unit |
| C9 | 搜索片段按纯文本渲染，片段里的 HTML 不会被执行 | unit |
| C10 | `pnpm typecheck`、`pnpm lint`、`pnpm build` 通过 | 命令 |
| C11 | Hide project 后项目和其缓存会话行一起消失，当前主区仍可使用，搜索仍能找到该项目会话 | integration |
