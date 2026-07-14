# 讨论记录与已确认要点

> 2026-07-11 与用户多轮讨论定稿。本文只保留有效结论，不保留被否决的早期前端方案或工具噪音。

## 1. 背景与动机

1. 全局单 daemon 后端已经完成，Web workspace 切换也已有一条最小纵切。
2. 当前 Web 把 workspace 放进会话侧栏的 `<select>`，只能证明“能切”，不能表达“全局项目面板”的产品结构。
3. 用户明确认为现有前端设计不合格，要求撤销临时 UI，学习 OpenCode App 的三级导航。
4. 本轮先写文档，用户检查后才开始开发；开发阶段要求使用 Playwright 打开真实浏览器调试。

## 2. 已确认：目标信息架构

```text
┌──────────┬────────────────────────┬─────────────────────────────┐
│ Project  │ Current project        │ Conversation                │
│ rail     │ + sessions             │                             │
│          │                        │                             │
│ C        │ ohbaby-agent           │ session header              │
│ A        │ ~/Projects/...         │ message stream              │
│ O active │                        │ composer                    │
│          │ New session            │                             │
│ +        │ session list           │                             │
└──────────┴────────────────────────┴─────────────────────────────┘
```

| 决策项 | 已确认结论 |
|--------|------------|
| 第一栏 | 显示项目根目录 basename 的首字母；当前项目有明确选中态 |
| 第二栏 | 显示当前项目名、缩短后的根目录路径、新建会话按钮和该项目 sessions |
| 第三栏 | 沿用现有对话流、权限、命令和 Composer 能力 |
| `+` | 打开**系统原生文件夹选择器**（macOS 访达 / Windows 文件夹对话框 / Linux zenity|kdialog）；不提供手工路径输入或 Web 目录树 |
| 导入持久性 | 新导入项目即使没有 session，也永久显示在项目栏 |
| 移除项目 | 右键或 `…` 菜单“从项目栏移除”；不删除 session，不删除文件 |
| 恢复项目 | hidden 项目再次被 `ohbaby serve` 显式打开，或在系统选择器中再次选择时，自动恢复项目栏入口 |
| 项目切换 | 切换项目后，第二栏只呈现该 scope 的 sessions；不得出现跨 scope 串扰 |
| session 恢复 | 切回项目时恢复该项目最后选中的 session |
| 借鉴范围 | 只学习 OpenCode 的三栏导航；不做顶部搜索、设置、Review |

## 3. 已确认：启动与选择优先级

### 3.1 当前项目

1. `ohbaby serve` 从某个目录执行时，CLI/server 生成的 `#directory=<canonical-root>` 优先级最高。
2. `ohbaby serve` start/reuse 本身先对当前 canonical root 执行幂等 open，使 hidden→visible；随后 URL hint 必须让浏览器选中该项目。恢复 registry 不依赖系统浏览器是否成功打开。
3. 没有显式 hint 时，使用浏览器上次选中的、仍然 visible 的项目。
4. 再没有则选择最近打开的 visible 项目；没有打开时间时选择最近添加/发现的项目。该选择不改变 rail 的稳定顺序。
5. 没有任何 visible 项目时，展示全局空状态和“添加项目”入口。

### 3.2 当前 session

1. URL 中合法且属于当前项目的 `session` hint 优先。
2. 否则恢复浏览器为该项目记录的最后 selected session。
3. 记录已失效、已归档或不属于当前项目时，回退到最近活跃 session。
4. 项目没有 session 时保持项目级空状态，不偷偷创建 session。

当前项目和每项目最后 session 是 Web 导航偏好，不是 session 领域真相；它们可由浏览器本地持久化，不能让不同 Web client 争抢 backend 的全局选择状态。

## 4. 已确认：项目 registry 语义

- registry 存在于现有共享 SQLite，不新建 lock 文件或独立 registry JSON。
- registry 至少区分 `visible` 与 `hidden`。
- hidden 是 tombstone：即使 session 表仍存在该 `project_root`，项目也不能被历史发现逻辑重新加入 rail。
- 历史 session 和当前 loaded scopes 仍是兼容发现来源，但 registry hidden 优先于它们。
- 显式 open/import 将项目 upsert 为 visible，并更新打开时间。
- 从项目栏移除只修改导航可见性；不触发 session 删除、归档或 InstanceStore dispose。
- 目录缺失或不可读时不静默删 registry；rail 保留不可用状态，用户可移除或修复路径。

## 5. 已确认：系统原生目录选择

> **2026-07-14 supersession**：不再使用 Web 弹窗枚举目录；改为 daemon 调 OS 原生文件夹选择器。

- 普通浏览器不能像 Electron/OpenCode Desktop 一样可靠取得 server 可访问的绝对路径，因此不使用 `<input webkitdirectory>` 冒充本机项目选择器。
- `Open project` / rail `+` 请求 `POST /v1/scopes/open-picker`；页面不渲染 modal、breadcrumb、路径输入或目录树。
- macOS 使用访达 `choose folder`；Windows 使用 PowerShell `FolderBrowserDialog`（`-STA`，可跨盘符）；Linux 优先 `zenity`，回退 `kdialog`。
- 用户取消返回 `{ cancelled: true }`，不改变 workspace；成功路径仍经 `resolveWorkspaceScope()` canonicalize。
- 选择 Git 仓库内子目录时仍 canonicalize 为 Git root；非 Git 使用 canonical directory。
- 重复选择同一 canonical root 时去重并直接选中。
- open-picker / open / hide 都必须 Bearer 鉴权。
- 系统目录选择只允许 loopback host；非 loopback serve 返回明确禁用错误，不把本机选择器能力暴露到 LAN。
- 并发二次 open-picker 返回 409 `DIRECTORY_PICKER_BUSY`；选择结果在 open 时 fail-closed，不回退 cwd/query。

## 6. 已确认：选择性撤销旧前端

### 替换

- `WorkspaceSelector` `<select>` 及其样式和 UI 测试。
- 当前侧栏顶部以 OHBABY 品牌为主、workspace 身份不突出的问题结构。
- 把 workspace 切换器视为最终产品闭环的旧文档表述。

### 保留

- `GET /v1/scopes` 的全局发现入口。
- `x-ohbaby-directory` fail-closed 路由。
- `BrowserOhbabyWebRuntime.switchWorkspace()`。
- 关闭旧 SSE、reset store、创建新 client、旧 generation 隔离和失败回滚。
- `#directory` 启动提示。

因此不能整体 `git revert 04d98cfb`；该提交同时包含正确的 runtime/协议能力和临时 UI。

## 7. 明确不在本批

- OpenCode 顶部搜索、Review、设置和帮助。
- 项目拖拽排序、自定义头像、复杂主题系统。
- 删除项目目录或删除 session。
- hidden 项目自动卸载 runtime。
- TUI attach serve、LAN 文件浏览、CORS/App 长期鉴权。
- `/loop` 与调度系统。

## 8. 关联契约

- 全局单 daemon 的进程、版本、legacy、路由与 fail-closed 决策继续以 [`../2026-07-11-global-single-daemon/`](../2026-07-11-global-single-daemon/README.md) 为准。
- Web 的 REST/SSE、状态投影、权限与命令职责继续以 [`../../ohbaby-web/`](../../ohbaby-web/README.md) 为准。
- 本目录只接管 Web Phase 2 的项目导航、registry、系统目录选择和浏览器验收。
