# 2. 设计与实施计划

## 2.1 目标架构

```text
React Web UI
  ProjectRail / Empty state
    → DirectoryPickerDialog
      → roots / list (Bearer, same-origin)
        → Global DaemonHttpServer
          → DirectoryBrowser (single-directory metadata only)
      → scopes/open (existing canonicalization and registry)
```

目录树的选择状态属于 React 本地状态；目录信息不持久化。最终项目 identity、Git root
向上归并和 workspace registry 更新继续只发生在 `openScopeDirectory()`。

## 2.2 服务端模块与 API

新增 `packages/ohbaby-server/src/runtime/directory-browser.ts`，使文件系统访问从 HTTP
路由与 PowerShell picker 中脱离。

```ts
interface DirectoryBrowser {
  listRoots(): Promise<readonly DirectoryBrowserRoot[]>;
  list(directory: string): Promise<DirectoryBrowserListing>;
}

interface DirectoryBrowserRoot {
  readonly directory: string;
  readonly name: string;
}

interface DirectoryBrowserListing {
  readonly children: readonly DirectoryBrowserEntry[];
  readonly directory: string;
  readonly parent: string | null;
}

interface DirectoryBrowserEntry {
  readonly directory: string;
  readonly name: string;
}
```

实现规则：

- `win32`：检查 `A:\` 至 `Z:\`，只返回实际存在且可访问的盘符根目录；不得假设只有 `C:\`。
- 非 Windows：唯一根目录为 `/`。
- `list()` 要求绝对、存在、可读且为目录；只读取直接子项，筛掉文件后按名称稳定排序。
- 父目录到根时为 `null`，不得让浏览器构造 `..` 路径。
- 系统错误映射为 `DIRECTORY_NOT_FOUND`、`DIRECTORY_NOT_READABLE`、`DIRECTORY_NOT_A_DIRECTORY` 或 `INVALID_DIRECTORY`；响应中不包含 stack/cause。

新增全局路由，必须在 workspace dispatch 前注册：

| 方法/路径 | 请求 | 成功响应 |
|---|---|---|
| `GET /v1/directory-picker/roots` | 无 body | `{ ok: true, roots: DirectoryBrowserRoot[] }` |
| `POST /v1/directory-picker/list` | `{ directory: string }` | `{ ok: true, directory, parent, children }` |

两条路由均要求 Bearer 鉴权与明确的 loopback IP 字面量（`127.0.0.0/8` 或 `::1`）；hostname（包括 `localhost`）不会启用目录浏览。非 loopback 返回：

```json
{
  "ok": false,
  "error": {
    "code": "DIRECTORY_BROWSER_LOOPBACK_ONLY",
    "message": "Directory browsing is available only on loopback hosts"
  }
}
```

`POST /v1/scopes/open-picker`、`nativeDirectoryPickerActive`、`nativeDirectoryPicker`
option 和 `native-directory-picker.ts` 在本批删除；`/v1/scopes/open` 保持不变。

## 2.3 Web client、runtime 与 UI

### HTTP/wire

在 `apps/ohbaby-web/src/api/daemon/wire.ts` 新增目录浏览 response 类型；在
`http.ts` 新增：

```ts
getDirectoryPickerRoots(): Promise<DirectoryPickerRootsResponse>;
listDirectoryPicker(directory: string): Promise<DirectoryPickerListResponse>;
```

它们和 `listWorkspaceScopes()` 一样使用 `includeDirectory: false`，因为是全局 API。

### Runtime

从 `OhbabyWebRuntime` 和 `BrowserOhbabyWebRuntime` 删除
`openWorkspaceFromSystemPicker()`；保留已有 `openWorkspace(directory)`。目录 dialog
成功选择时由 UI 调用该现有方法，因此不会复制 workspace switch / rollback 逻辑。

### React

新增 `apps/ohbaby-web/src/ui/directory-picker/DirectoryPickerDialog.tsx` 及单测：

- 初始加载 roots；
- 点击 root/子目录后请求 list；
- 渲染 breadcrumb、当前目录与只含文件夹的目录列表；
- “选择此文件夹”将当前目录回调给 caller；
- Escape、关闭按钮、取消回调只关闭 dialog；
- loading、空目录、受限目录和网络错误独立呈现；
- 同一时间只允许一个 dialog 实例，防止重复请求而不是复刻 server picker lock。

`App.tsx` 的两处 add action（正常项目 shell 与空状态）都改为
`setDirectoryPickerOpen(true)`。选择回调调用现有 `runtime.openWorkspace(directory)`，
成功后关闭 dialog；失败沿用已有 `ErrorBanner`。

为控制 `App.tsx` 继续膨胀，目录树 JSX、请求状态和目录导航 reducer 不得直接内联其中。
样式可先在现有 `styles.css` 以 `.ohb-directory-picker-*` 集中声明；只在该对话框有稳定边界时
再拆专属 stylesheet。

## 2.4 迁移顺序

### Task 1：撤销临时 Windows workaround

**Files**
- Modify: `packages/ohbaby-server/src/runtime/native-directory-picker.ts`
- Modify: `packages/ohbaby-server/src/runtime/native-directory-picker.unit.test.ts`

1. 删除未提交的 `windowsHide: false` command 属性和断言，恢复默认 `windowsHide: true`。
2. 不提交此回退为独立产品变更；它属于后续删除 native picker 前的工作树清理。

### Task 2：先以 TDD 实现 DirectoryBrowser

**Files**
- Create: `packages/ohbaby-server/src/runtime/directory-browser.ts`
- Create: `packages/ohbaby-server/src/runtime/directory-browser.unit.test.ts`

1. 写失败测试：Windows 盘符过滤、Unix 根目录、非目录/不可读错误、子目录过滤、排序、根目录 parent。
2. 运行单测验证 RED。
3. 用可注入 `platform` / `readdir` / `stat` 依赖完成最小实现。
4. 运行单测验证 GREEN。

### Task 3：替换全局 daemon 路由

**Files**
- Modify: `packages/ohbaby-server/src/runtime/daemon/server.ts`
- Modify: `packages/ohbaby-server/src/runtime/daemon/global-server.integration.test.ts`
- Delete: `packages/ohbaby-server/src/runtime/native-directory-picker.ts`
- Delete: `packages/ohbaby-server/src/runtime/native-directory-picker.unit.test.ts`

1. 先写 roots/list 的 auth、loopback、list 成功、无效路径和无文件泄露集成测试。
2. 删除 `open-picker` 路由、锁和注入 option。
3. 注入 `DirectoryBrowser` 并在 global routes 注册 roots/list。
4. 确认既有 `scopes/open` 行为未变。

### Task 4：更新 Web transport 与 runtime

**Files**
- Modify: `apps/ohbaby-web/src/api/daemon/wire.ts`
- Modify: `apps/ohbaby-web/src/api/daemon/http.ts`
- Modify: `apps/ohbaby-web/src/api/daemon/client.ts`
- Modify: `apps/ohbaby-web/src/api/daemon/workspace-switch.integration.test.ts`

1. 先删除/替换 system-picker transport 用例，写 roots/list request 契约测试。
2. 定义 wire 类型和 HTTP methods。
3. 删除 system-picker runtime method；保留 `openWorkspace(directory)`。
4. 验证取消不触发 workspace switch、选择后仍走原有 switch 闭环。

### Task 5：实现 Web 对话框与接线

**Files**
- Create: `apps/ohbaby-web/src/ui/directory-picker/DirectoryPickerDialog.tsx`
- Create: `apps/ohbaby-web/src/ui/directory-picker/DirectoryPickerDialog.unit.test.tsx`
- Modify: `apps/ohbaby-web/src/ui/App.tsx`
- Modify: `apps/ohbaby-web/src/ui/App.unit.test.tsx`
- Modify: `apps/ohbaby-web/src/ui/styles.css`

1. 写失败 component tests：roots、进入子目录、返回 parent、选择、取消、错误。
2. 实现 dialog；不引入文件内容/路径编辑能力。
3. 正常 shell 和空状态共用同一 dialog。
4. 更新 “Open project” 行为断言，删除对 `openWorkspaceFromSystemPicker` 的 mock/断言。

### Task 6：文档、构建和真实验收

1. 更新旧 problem-list 中 native picker 的 supersession 标记，指向本目录。
2. 按 `04-test-and-acceptance.md` 运行定向测试、typecheck、build。
3. 用隔离 HOME/DB 启动 `ohbaby serve`，在真实浏览器从 `D:\` 进入项目目录并选择。
4. 验证不会启动 `powershell.exe`，且取消、受限目录、重复打开均不改变当前 workspace。
