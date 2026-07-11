# OpenCode 风格 Web 项目导航改造

> 状态：**Phase A–D 已实施；自动化与真实 daemon + Playwright 核心闭环已通过（2026-07-11）。**
>
> 本目录既是全局单 daemon 完成后的 Web Phase 2 实施契约，也是本批实现与验收记录。

## 1. 议题

现有 Web 已经具备全局单 daemon、多 workspace 路由和安全切换能力，但界面仍是技术验证版本：workspace 被压进会话侧栏里的 `<select>`，没有 OpenCode 式的“项目栏 → 项目会话栏 → 对话面板”信息架构，也没有可持久导入、隐藏和恢复项目的产品闭环。

本批在**保留已有 workspace runtime 与 SSE 隔离机制**的前提下，重做 Web 导航外壳，并补齐它真正需要的少量服务端能力：持久化 workspace registry 和受保护的服务端目录浏览 API。

## 2. 文档地图

| 文档 | 作用 |
|------|------|
| [00-discussion.md](./00-discussion.md) | 冻结用户已经确认的产品行为、边界与术语 |
| [01-problem-analysis-and-current-state.md](./01-problem-analysis-and-current-state.md) | 以当前代码为基线，说明为什么旧 UI 不能继续扩展 |
| [02-optimization-plan-and-change-scope.md](./02-optimization-plan-and-change-scope.md) | 后续开发会话的实施契约：架构、数据、API、文件改动面和顺序 |
| [03-reference-projects.md](./03-reference-projects.md) | OpenCode 等成熟产品的 adopt / adapt / reject 结论 |
| [04-test-and-acceptance.md](./04-test-and-acceptance.md) | 单测、集成、真实浏览器调试和发布门 |

推荐阅读顺序：`00 → 01 → 02 → 03 → 04`。实施时以 `02 + 04` 为准；若与 `00` 冲突，先回到文档阶段修正，不能自行解释。

## 3. In scope

- OpenCode 风格三层导航：项目 rail、按需展开的当前项目/会话侧栏、对话面板。会话栏默认零宽收起，展开按钮固定在项目 rail 顶部。
- 项目根目录首字母入口、选中态、完整路径提示和稳定顺序。
- `+` 打开服务端目录浏览弹窗；不提供路径输入框。
- 导入项目持久化；即使没有 session，重启后也继续显示。
- 项目右键/更多菜单“从项目栏移除”；不删除 session、不删除文件、不停止 runtime。
- hidden tombstone 覆盖 session 历史自动发现，防止项目被移除后立即重新出现。
- 从 hidden 项目再次执行 `ohbaby serve`，或在 `+` 中再次选择它，自动恢复项目栏入口。
- 启动 workspace hint、URL hash、当前项目和每项目最后 session 的选择优先级。
- 保留当前 `x-ohbaby-directory`、SSE generation 隔离、失败回滚和 fail-closed。
- 导航组件从当前超大 `App.tsx` / `styles.css` 中做有限拆分。
- 实施阶段必须用 Playwright 驱动真实浏览器做视觉与交互调试。

## 4. Out of scope

- OpenCode 顶部全局搜索、Review、状态中心。
- 设置中心、帮助中心、自定义项目头像。
- 项目拖拽排序；本批只保证稳定顺序。
- 删除项目目录、删除或批量归档 session。
- per-scope runtime 自动 dispose；隐藏项目不等于卸载 runtime。
- TUI attach serve、默认 CLI 改走 daemon。
- LAN/CORS/App 鉴权设计；目录浏览能力在非 loopback host 上必须禁用。
- 像素级照搬 OpenCode、完整移动端重设计、重型截图基线系统。
- `/loop`、Scheduler、Heartbeat、`scheduler_job`。

## 5. 与现有文档的关系

| 文档 | 权威范围 |
|------|----------|
| [全局单 daemon](../2026-07-11-global-single-daemon/README.md) | 进程模型、workspace header、InstanceStore、版本和 legacy 策略仍是权威；本目录不重新设计 daemon |
| [ohbaby-web](../../ohbaby-web/README.md) | REST/SSE、状态投影、命令/权限/Composer 等基础能力仍是权威；本目录取代其中“workspace `<select>` 是目标 UI”的表述 |
| [terminal-daemon](../terminal-daemon/README.md) | 默认 CLI/TUI in-process 边界仍有效 |

本目录只 supersede 以下旧结论：

1. `WorkspaceSelector` `<select>` 是 Web 全局项目切换的最终呈现。
2. `DB project_root + loaded scopes` 足以充当可编辑项目栏的全部真相源。
3. 当前 `App.tsx` 单文件侧栏结构可直接承载下一阶段导航。

## 6. 开发闸门

1. [x] 用户审阅并确认本目录 00–04。
2. [x] 按 02 完成 registry、全局 API、Web runtime 与导航 UI。
3. [x] 按 04 完成 unit / contract / integration、typecheck、lint 与 build 回归。
4. [x] 启动隔离 HOME、临时 DB 和真实 foreground daemon，使用 Playwright 验证目录弹窗、无 session 导入、项目/会话切换、隐藏与 `serve` 恢复、收起/展开布局。
5. [ ] 独立实现审查会话按 02/04 出具最终验收结论。

## 7. 实施结果摘要

- `workspace_registry` migration/store 已成为项目栏可见性真相源；hidden tombstone 不会被 session 历史自动冲掉。
- daemon 提供鉴权的 scopes open/hide 与 loopback-only 目录浏览 API；目录弹窗只列文件夹，不读取文件内容、不提供路径输入。
- `ohbaby serve` 的 cwd 会显式 reopen hidden 项目；复用既有 daemon 时也在返回 URL 前完成恢复。
- Web runtime 已实现启动优先级、canonical hash、每项目最后 session、SSE/client 重绑与失败回滚。
- 旧 workspace `<select>` 已删除。项目 rail 永久显示导入项目；会话栏默认收起，点击 rail 顶部按钮后才显示当前根目录的 sessions。
- 真实浏览器在 1280×720 下验证：收起态 rail 62px、主内容 1218px；展开态 sidebar 300px、主内容 918px；两态均无水平溢出，console 无 warning/error。
