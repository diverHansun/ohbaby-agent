# Web 目录树项目选择

> 状态：**已实施并通过真实浏览器验收（2026-07-14）。**
>
> 本议题取代“`ohbaby serve` 由 daemon 调用系统原生目录选择器”的实现方向。

## 1. 议题

`ohbaby serve` 是浏览器连接本地 Node daemon 的 Web 产品，不是 Electron
Desktop。将目录选择放在 daemon 的 PowerShell 子进程中，在 Windows 上会在
“隐藏后对话框不可交互”和“显示后暴露 PowerShell 控制台”之间二选一。

本批改为学习 OpenCode 的 **Web 模式**：浏览器渲染目录树，daemon 通过受控
HTTP API 枚举 daemon 所在机器上的目录；用户确认后仍复用既有
`POST /v1/scopes/open` 打开项目。

## 2. 文档地图

| 文档 | 作用 |
|---|---|
| [00-discussion.md](./00-discussion.md) | 已确认的产品、安全和兼容性决策 |
| [01-problem-analysis.md](./01-problem-analysis.md) | 当前 PowerShell picker 的失败原因与 OpenCode 对照 |
| [02-design-and-implementation-plan.md](./02-design-and-implementation-plan.md) | API、UI、模块边界和逐步实施计划 |
| [03-reference-projects.md](./03-reference-projects.md) | OpenCode Desktop/Web 的 adopt / adapt / reject 结论 |
| [04-test-and-acceptance.md](./04-test-and-acceptance.md) | 单测、集成、浏览器验收和安全回归 |

实施以 `02` 与 `04` 为准。若实现中发现与 `00` 冲突，必须先更新文档并重新确认。

## 3. In scope

- 目录根列表与单层目录枚举 API。
- Web 目录选择对话框：根目录、面包屑、逐级进入、返回上级、选择当前目录、取消和错误状态。
- Windows 所有本地可访问路径：从各盘符根目录进入并可递归浏览。
- 复用现有 scope 打开、canonicalization、registry、SSE 切换和失败回滚。
- 移除 `POST /v1/scopes/open-picker` 和 PowerShell/系统 picker 依赖。
- Windows 保持 `windowsHide: true`；目录浏览不再启动任何 GUI 子进程。

## 4. Out of scope

- Electron/Desktop 壳及 Electron `dialog.showOpenDialog`。
- 浏览器访问 daemon 所在机器之外的本机文件系统。
- 文件内容读取、上传、编辑、删除、新建目录或重命名。
- LAN/远程 host 的目录浏览。
- 全盘递归搜索、文件索引、模糊搜索和最近路径历史。
- 更改 workspace registry、session/SSE、项目 rail 或会话恢复的既有语义。

## 5. 关联与 supersession

[`../2026-07-11-opencode-style-web-navigation/`](../2026-07-11-opencode-style-web-navigation/README.md)
仍是项目 rail、registry、workspace 切换和 URL 恢复的权威文档。本目录只取代
其中关于系统原生 picker 的结论：

1. 不再使用 `/v1/scopes/open-picker`。
2. 不再使用 `native-directory-picker.ts`、PowerShell、AppleScript、zenity 或 kdialog。
3. 恢复 Web 目录浏览 API 与页面内对话框，但采用本目录的 loopback/auth/只列目录约束。
