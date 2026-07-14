# 3. 优秀项目借鉴

## 3.1 调研来源

| 来源 | 位置/方式 | 调研范围 |
|------|-----------|----------|
| OpenCode Desktop | 本机 `/Applications/OpenCode.app`；2026-07-11 使用 Computer Use 实际操作；用户提供界面截图 | 项目 rail、项目切换、session 列表、新建会话、打开项目原生目录选择器、选中态 |
| VS Code / Cursor | 成熟 workspace/editor 产品的通用信息架构 | workspace 身份、路径可见性、折叠式辅助栏 |
| Slack / Discord | 成熟多工作区信息架构 | 一级 rail → 二级 scoped list → 三级内容区的层次表达 |

本文不声称复刻 OpenCode 源码；结论来自可观察交互与本项目约束。借鉴的是因果关系，不是像素或内部实现猜测。

## 3.2 OpenCode 的可观察行为

### 项目 rail

- 最左侧窄栏为项目一级导航。
- 项目以根目录名称首字母和稳定颜色呈现。
- 当前项目有明显边框/背景选中态。
- `+` 位于项目列表后，语义是“打开项目”。
- 设置/帮助在底部，与项目导航分区。

### 项目与 session 侧栏

- 顶部同时显示项目 basename 和缩短后的根目录路径。
- 新建会话是当前项目上下文中的主要动作。
- session list 在项目切换后整体替换；项目选择和 session 选择是两层独立状态。
- session 行提供 archive 等局部动作。

### 对话区

- 主内容区独立于项目/会话导航。
- 切换项目后可以暂时没有选中 session，对话区展示空/就绪状态，而不是把项目切换伪装成 session 切换。

### 打开项目

- Desktop 使用系统原生文件夹选择器。
- 这依赖桌面壳获取绝对路径，普通 Web 不能无损照搬。

## 3.3 Adopt：直接借鉴

| 做法 | 为什么适合 ohbaby | 进入 02 的决策 |
|------|-------------------|------------------|
| 项目 rail 是一级导航 | 全局单 daemon 天然宿主多个 project root | `ProjectRail` 固定第一栏 |
| 项目名 + 路径同时可见 | 同名 repo 常见，路径是最终辨识信息 | 第二栏 header 展示 basename + `~` 路径 |
| session list 随 project scope 切换 | 与 `x-ohbaby-directory` 和 per-scope snapshot 对齐 | 第二栏只消费当前 workspace snapshot |
| 项目选择与 session 选择分离 | 避免无 session 项目被迫造 session | runtime 允许 selected project + null session |
| 新建会话属于当前项目 | 动作作用域明确 | SessionSidebar 的主动作 |
| project item 有选中态和 tooltip | 降低误操作和重名歧义 | rail 双重视觉信号 + accessible name |

## 3.4 Adapt：按 Web/daemon 约束改造

| OpenCode 做法 | ohbaby 适配 | 原因 |
|---------------|-------------|------|
| 原生系统目录选择器 | daemon 调用系统选择器；Web 只处理结果 | 浏览器 directory handle 不能提供 daemon 可访问的绝对路径 |
| Desktop 本地项目存储 | 共享 SQLite registry | ohbaby 面板由全局 daemon 服务，多个浏览器应看到同一可见项目集 |
| Desktop 当前窗口状态 | URL hint + localStorage per-client preference | `ohbaby serve` cwd 必须优先，同时不能让多个 Web client 争 active session |
| 项目删除/关闭交互 | “从项目栏移除”= hidden tombstone | session 与文件继续保留，且历史 discovery 不得自动复活 |
| Desktop 文件系统权限 | loopback + Bearer + directories-only | Web API 暴露面更大，必须显式安全收口 |

## 3.5 Reject：明确不照搬

- 不复制 OpenCode 顶部搜索框、Review、状态控件。
- 不复制设置/帮助图标占位；没有功能就不渲染假入口。
- 不复制其模型选择、composer 视觉或消息排版；ohbaby 已有独立命令/权限/goal 设计。
- 不为了“像 Desktop”在 Node daemon 中调用 macOS 专用 dialog API。
- 不引入 Electron/Tauri 壳。
- 不扫描 Home 或磁盘自动找 Git repo。
- 不按 OpenCode 的未知内部数据模型设计 registry。
- 不把项目首字母当唯一身份；canonical directory 才是 identity。

## 3.6 其他成熟模式的辅助结论

### VS Code / Cursor

- workspace 路径是重要上下文，不应藏在下拉选项里。
- 辅助侧栏可以折叠，但一级项目身份需要保持可见。
- 借鉴层级和可恢复性，不把文件 Explorer 纳入本批。

### Slack / Discord

- 多工作区产品长期使用“窄 rail + scoped list + content”结构，说明它能有效降低跨 scope 误操作。
- rail 顺序需要稳定；如果每次打开都重排，用户的空间记忆会失效。
- 右键不是唯一入口，context menu 动作也应有普通菜单/键盘路径。

## 3.7 对实施方案的直接影响

1. OpenCode 项目 rail → `ProjectRail` 与三栏 `AppShell`。
2. 原生 picker 的产品语义 → daemon 调用 OS 原生目录选择器，Web 只请求并接收取消/选中结果。
3. 项目是第一等实体 → SQLite `workspace_registry`，不再只从 session 反推。
4. project/session 两层选择 → server visible/hidden 与 browser last-session 分离。
5. 稳定空间记忆 → registry `position`，不按 `last_opened_at` 每次跳动。
6. Desktop 能力边界 → directory picker loopback-only，不假装支持 LAN。
