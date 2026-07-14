# 4. 测试与验收

## 4.1 测试层级

沿用仓库 Vitest 与 co-located `*.unit.test.ts(x)` / `*.integration.test.ts(x)` 约定。

| 层级 | 被测对象 | 目的 |
|---|---|---|
| unit | `DirectoryBrowser` | 平台根目录、目录过滤、排序、路径错误映射 |
| integration | `DaemonHttpServer` 全局 routes | auth、loopback gate、响应契约和不泄露文件 |
| unit/component | `DirectoryPickerDialog` | roots/list 加载、导航、选择、取消、错误、键盘行为 |
| integration | Web transport/runtime | HTTP 请求格式、选择后 workspace switch、取消无副作用 |
| browser/manual | 真 daemon + 浏览器 | Windows 多盘符导航、无 PowerShell、真实项目打开 |

## 4.2 DirectoryBrowser unit cases

| ID | 场景 | 断言 |
|---|---|---|
| DB1 | Windows 有 C/D、无效 A | 仅返回可访问 `C:\`、`D:\`，稳定排序 |
| DB2 | Linux/macOS | 仅返回 `/` |
| DB3 | 普通目录混有文件 | children 只含目录 |
| DB4 | children 名称无序 | 输出按 name locale 排序 |
| DB5 | 根目录 | `parent === null` |
| DB6 | 嵌套目录 | parent 是正确绝对目录 |
| DB7 | 缺失路径 | 结构化 `DIRECTORY_NOT_FOUND` |
| DB8 | 文件作为 list 输入 | 结构化 `DIRECTORY_NOT_A_DIRECTORY` |
| DB9 | 无权限目录 | 结构化 `DIRECTORY_NOT_READABLE`，无底层错误堆栈 |

## 4.3 Daemon integration cases

| ID | 请求 | 预期 |
|---|---|---|
| API1 | 未带 Bearer 的 roots/list | 401，browser 不被调用 |
| API2 | 非 loopback host 的 roots/list | 403 `DIRECTORY_BROWSER_LOOPBACK_ONLY` |
| API3 | roots | 200，返回根元数据，无文件/内容字段 |
| API4 | list 正常目录 | 200，返回当前目录、parent、仅目录 children |
| API5 | list 文件/缺失/不可读目录 | 400 或 403 的结构化 error |
| API6 | `/v1/scopes/open` | 旧成功/失败/canonicalization 测试继续通过 |
| API7 | `/v1/scopes/open-picker` | 路由不再存在，不能意外启动原生 picker |

## 4.4 Web component/runtime cases

| ID | 场景 | 预期 |
|---|---|---|
| UI1 | 点击 rail `+` / 空态 Open project | 打开页面内 dialog，不调用 system picker |
| UI2 | 初次加载 | 显示 roots loading，随后显示根目录 |
| UI3 | 点击 child | 请求并渲染该 child 的 listing，更新 breadcrumb |
| UI4 | 返回上级 | 使用 server 提供的 parent，不拼接 `..` |
| UI5 | 选择此文件夹 | 调用 `runtime.openWorkspace(directory)`，成功后关闭 |
| UI6 | 取消/Escape/关闭 | 不调用 `openWorkspace`，当前 workspace 不变 |
| UI7 | list API error | 可见错误且可取消/返回，不重置当前 workspace |
| UI8 | open 失败 | 复用现有 error banner 与 switch rollback |

## 4.5 真实 Windows 验收

在隔离 HOME、临时数据库和 foreground daemon 下执行：

```powershell
ohbaby serve --port 4097 --db-path <temporary-db>
```

浏览器验收步骤：

1. 打开 rail `+`，确认出现页面内目录树，不出现 PowerShell、CMD 或系统文件对话框。
2. 确认根目录包含当前机器可访问的 `C:\`、`D:\` 等盘符。
3. 从 `D:\` 逐级进入 `Projects\code-cli\ohbaby-agent`，点击“选择此文件夹”。
4. 确认 rail 出现/选中 canonical workspace，URL 与 session/SSE 正常更新。
5. 再次打开 dialog、取消；确认当前项目和 URL 不变。
6. 尝试无权限或已删除目录；确认显示错误且应用仍可用。
7. 监控 daemon 子进程，确认目录浏览期间未启动 `powershell.exe`、`osascript`、`zenity` 或 `kdialog`。

## 4.6 发布门

实施完成前至少运行：

```powershell
pnpm exec vitest run packages/ohbaby-server/src/runtime/directory-browser.unit.test.ts
pnpm exec vitest run packages/ohbaby-server/src/runtime/daemon/global-server.integration.test.ts
pnpm exec vitest run apps/ohbaby-web/src/ui/directory-picker/DirectoryPickerDialog.unit.test.tsx
pnpm exec vitest run apps/ohbaby-web/src/api/daemon/workspace-switch.integration.test.ts
pnpm run typecheck
pnpm run build
```

仓库当前若有与本批无关的全局 lint 基线错误，必须在交付中明确列出；不能用它掩盖新增文件的 lint/typecheck 错误。
