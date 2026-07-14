# 1. 问题分析

## 1.1 当前失败路径

当前实现的请求链路是：

```text
Web “Open project”
  → POST /v1/scopes/open-picker
  → DaemonHttpServer.openScopeFromPicker()
  → NativeDirectoryPicker.pickDirectory()
  → spawn(powershell.exe)
  → Shell.Application.BrowseForFolder()
```

相关代码：

- `packages/ohbaby-server/src/runtime/daemon/server.ts`
- `packages/ohbaby-server/src/runtime/native-directory-picker.ts`
- `apps/ohbaby-web/src/api/daemon/http.ts`
- `apps/ohbaby-web/src/ui/App.tsx`

Windows 上存在不可兼得的约束：

| 子进程配置 | 结果 |
|---|---|
| `windowsHide: true` | PowerShell 的 GUI 调用可能不可见但进程持续等待；第二次请求因 picker lock 返回 `DIRECTORY_PICKER_BUSY` |
| `windowsHide: false` | 对话框可交互，但会暴露 PowerShell 控制台，不是产品级体验 |

因此问题不是某个 PowerShell 参数，而是把 GUI 选择器放进 headless daemon 的进程模型不匹配。

## 1.2 OpenCode 对照

OpenCode 分为两条路径：

| OpenCode 运行形态 | 目录选择策略 |
|---|---|
| Electron Desktop + local server | Electron main process 的 `dialog.showOpenDialog` |
| 浏览器 Web 或 remote server | 页面内 `DialogSelectDirectory`，通过服务端列目录 API 浏览 |

参考实现：

- `D:/Projects/code-cli/opencode/packages/desktop/src/main/ipc.ts`
- `D:/Projects/code-cli/opencode/packages/app/src/components/directory-picker.tsx`
- `D:/Projects/code-cli/opencode/packages/app/src/components/directory-picker-policy.ts`
- `D:/Projects/code-cli/opencode/packages/app/src/components/dialog-select-directory.tsx`

ohbaby 当前是第二种运行形态，因此应采用 OpenCode Web 路径，而不能把 Electron API 或 PowerShell 方案搬入 daemon。

## 1.3 已有承重能力

本批不得重写下列已验证能力：

1. `DaemonHttpServer.openScopeDirectory()`：调用 `resolveWorkspaceScope()` 并更新 workspace registry。
2. `POST /v1/scopes/open`：已有受鉴权的 scope 打开契约。
3. `BrowserOhbabyWebRuntime.switchWorkspace()`：已有 SSE abort、store reset、generation 隔离与失败回滚。
4. 项目 rail / session sidebar / 空状态：只替换 `+` 的打开动作，不改变导航层级。

## 1.4 设计原则

1. **职责边界**：daemon 只负责受控目录元数据与 scope 校验；浏览器只负责显示和选择状态。
2. **最小暴露**：列目录而非文件；单层请求而非整盘扫描；loopback + token 而非依赖 CORS。
3. **单一 canonicalization 边界**：目录树展示路径不是 workspace identity；只有 `resolveWorkspaceScope()` 能决定最终 scope。
4. **可逆迁移**：先新增 Web API/UI，再删除 native picker；不触碰 registry/schema/SSE 协议。
