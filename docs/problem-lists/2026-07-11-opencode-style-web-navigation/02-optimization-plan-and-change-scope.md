# 2. 优化方案与改动面

> 本文是实施契约。2026-07-11 已按 Phase A–D 落地；经用户确认，会话侧栏最终采用“默认零宽收起、rail 顶部按钮展开”的呈现。
>
> **2026-07-14 supersession**：本文关于 `directory-picker roots/list`、
> `DirectoryPickerDialog` 与 Web 目录枚举的细节已废止。目录选择改为
> `POST /v1/scopes/open-picker`：daemon 在 loopback + Bearer 鉴权后调用系统
> 原生文件夹选择器，并将取消或 canonical scope 作为单个响应返回。

## 2.1 目标架构

```text
Browser / React
┌─────────────────────────────────────────────────────────────────┐
│ AppShell                                                        │
│  ├─ ProjectRail ───── visible projects / open / hide            │
│  ├─ SessionSidebar ── selected project sessions                 │
│  └─ ConversationPane ─ existing stream / permission / composer  │
│                                                                 │
│ NavigationPreferences (localStorage)                            │
│  └─ last selected project + last session per project            │
└───────────────────────────┬─────────────────────────────────────┘
                            │ Bearer-authenticated same-origin API
Global daemon               ▼
┌─────────────────────────────────────────────────────────────────┐
│ Global routes (no workspace header)                             │
│  ├─ scopes list/open/hide                                       │
│  └─ scopes/open-picker (loopback only → OS folder dialog)       │
│                                                                 │
│ Workspace dispatcher (x-ohbaby-directory required)              │
│  └─ existing InstanceStore → per-scope app/backend/SSE          │
└───────────────────────────┬─────────────────────────────────────┘
                            │
Shared SQLite               ▼
┌─────────────────────────────────────────────────────────────────┐
│ session/project_root (domain history; unchanged)                │
│ workspace_registry (navigation visibility/order)                │
└─────────────────────────────────────────────────────────────────┘
```

三种状态的所有权必须分离：

| 状态 | 真相源 | 原因 |
|------|--------|------|
| session、message、run | agent/backend SQLite 与 runtime | 领域真相，已有契约 |
| 项目是否在 rail visible/hidden、稳定顺序 | 共享 SQLite `workspace_registry` | 全局面板导航应跨 daemon/浏览器存在 |
| 当前项目、每项目最后 session | 浏览器 `localStorage` + URL hint | 每个 Web client 的 UI 偏好，不能互相抢 |
| workspace identity | server `resolveWorkspaceScope()` | 唯一 canonicalization 边界 |
| loaded runtime | `InstanceStore` | 运行时资源状态，不等于项目可见性 |

## 2.2 设计决策与取舍

| 决策 | 选择 | 理由 | 放弃的选项 | 已知代价 |
|------|------|------|------------|----------|
| 撤销范围 | 选择性替换 selector/UI，保留 runtime | 当前切换隔离是正确承重能力 | 整体 revert `04d98cfb` | 需要细分旧测试和样式，而不是一键回退 |
| 导航结构 | 固定 project rail + project sessions + conversation | 正确表达项目→session→内容层级 | 更漂亮的下拉框、单栏折叠树 | 桌面宽度占用增加，需要响应式降级 |
| 项目持久化 | 现有共享 SQLite 新表 | 跨 daemon/浏览器一致，沿用备份/迁移机制 | localStorage、独立 JSON | 增加 additive migration 和小型 store |
| 移除语义 | visible/hidden tombstone | session 不删且项目不会被历史重新发现 | 删除 registry row | 需要合并 discovered/loaded 时执行优先级 |
| 目录选择 | daemon 调用 OS 原生文件夹选择器 | 返回 server 可访问的绝对目录，覆盖 macOS/Windows/Linux | 路径输入、browser file handle、Web 目录树 | 需要平台适配和原生 dialog 生命周期管理 |
| 目录安全 | Bearer + loopback-only + 无路径树 | 浏览器不再读取本机目录；选择结果仍经 server 校验 | 仅靠 CORS/token | 显式 LAN serve 时该功能不可用 |
| 当前选择持久化 | versioned localStorage | UI 偏好不污染 backend truth | server 全局 active session | 不同浏览器不会共享最后选中 session（这是刻意的） |
| URL | `directory` + 可选 `session` hash | 可复现、serve hint 优先、刷新可恢复 | 只存内存 | 必须处理 stale/跨 scope session hint |
| UI 拆分 | 只拆导航边界 | 缓解神文件且控制范围 | 全量重写 App/样式系统 | 旧 `App.tsx` 仍较大，后续再按真实痛点演进 |
| rail 顺序 | registry position 稳定，新发现追加 | 入口不因 last opened 跳动 | 按最近打开实时排序、拖拽 | 需要持久 position；本批无手工重排 |
| 浏览器 E2E | 实施时必须 Playwright 真浏览器调试；暂不引入完整截图基线 | 直接验证交互与布局，不先建设重型基础设施 | 只跑 jsdom；本批新建完整视觉回归平台 | 需要保留可复现步骤与验收记录 |

## 2.3 数据模型

### 2.3.1 migration

在 `packages/ohbaby-agent/src/services/database/migrations.ts` 增加 additive migration：

```text
013_workspace_registry
```

目标表：

```sql
CREATE TABLE workspace_registry (
  scope_key TEXT PRIMARY KEY,
  visibility TEXT NOT NULL CHECK (visibility IN ('visible', 'hidden')),
  position INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_opened_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX idx_workspace_registry_position
  ON workspace_registry(position);
```

约束：

- `scope_key` 是最后一次成功 open 时由 `resolveWorkspaceScope()` 产生的 canonical absolute directory。历史 session discovery 只有在仍可解析时才补入 registry；已经登记后才变得不可用的目录保留原 canonical key 并派生 `available=false`。
- `visibility` 是导航状态，不是目录存在状态。
- `position` 只保证稳定顺序；本批不提供 reorder API。
- `last_opened_at` 用于无浏览器偏好时的 fallback，不用于实时重排 rail。
- 不级联到 session；隐藏/删除 registry 记录都不能删除 session。
- migration 只建表，不在 SQL 中粗暴 canonicalize 旧 `project_root`。

### 2.3.2 registry store

建议新增：

```text
packages/ohbaby-agent/src/services/workspace-registry/
  database-store.ts
  database-store.unit.test.ts
  types.ts
  index.ts
```

最小接口语义：

```ts
interface WorkspaceRegistryStore {
  list(): readonly WorkspaceRegistryEntry[];
  ensureDiscovered(scopeKeys: readonly string[], now?: number): void;
  open(scopeKey: string, now?: number): WorkspaceRegistryEntry;
  hide(scopeKey: string, now?: number): WorkspaceRegistryEntry;
}
```

- `ensureDiscovered` 只插入缺失项，不能把 hidden 改回 visible。
- `open` upsert visible；这是唯一能显式恢复 hidden 的 store 操作。
- `hide` 只接受已知 canonical key；不存在返回 not-found，不做模糊 path 匹配。
- 新 position 在 transaction 内分配，沿用 shared DB busy retry/事务规则。
- 启动/列举时，server 先对历史 `listKnownSessionProjectRoots()` 和 loaded scopes 做现有 scope 解析，再把成功得到的 canonical keys 交给 `ensureDiscovered`。解析失败且从未登记的历史路径不新建 registry；已经登记后才变得不可用的项目保留记录并标 `available=false`。

### 2.3.3 API summary

扩展 Web/server 类型：

```ts
interface WorkspaceScopeSummary {
  readonly directory: string;
  readonly loaded: boolean;
  readonly available: boolean;
  readonly position: number;
  readonly lastOpenedAt: number;
}

interface WorkspaceSnapshot {
  readonly scopes: readonly WorkspaceScopeSummary[];
  readonly selectedDirectory: string | null;
}
```

`GET /v1/scopes` 只返回 visible 项目。hidden 项目保留在 DB，但不发给 rail；显式 open 成功后才重新出现。

`OhbabyWebRuntime` 必须显式支持“没有 visible project”的全局空态：active workspace client 改为 nullable（或提供等价的 `getActiveClient(): OhbabyWebClient | null`），`ready` 在无项目时也能正常 resolve。禁止用一个假的 cwd client 或 NullClient 偷偷发送 workspace 请求；App 在 client=null 时禁用 prompt/session/command 动作，只保留项目添加与全局导航。

## 2.4 全局 daemon API

这些路由全部挂在 `DaemonHttpServer.mountRoutes()` 的 workspace wildcard dispatch **之前**，只使用 Bearer token，不要求 `x-ohbaby-directory`。

### 2.4.1 列出 visible projects

```http
GET /v1/scopes
Authorization: Bearer <token>
```

响应保持 `ok + scopes` 外形，增加 `available/position/lastOpenedAt`。处理顺序：

1. 读取 registry。
2. 解析可用的 session discovered roots 与 loaded scope keys，调用 `ensureDiscovered`；hidden 不得被覆盖，已登记但当前不可用的 entry 不得被删除。
3. 对 visible entries 做轻量 availability 检查，不递归扫描。
4. 按 `position` 排序返回。

### 2.4.2 显式打开/恢复项目

```http
POST /v1/scopes/open
Content-Type: application/json

{ "directory": "/absolute/path" }
```

1. `resolveWorkspaceScope(directory)` fail-closed。
2. registry `open(canonicalScope)`：新增或 hidden→visible，更新 `last_opened_at`，position 保持不变。
3. 返回 canonical summary。
4. 不因 open 立即创建 session；是否加载 runtime 由随后 workspace connect 决定。

用途：picker 选择、Web `#directory` 启动 hint、hidden 项目显式恢复。

`startDaemonServer()` 也必须把每次 `ohbaby serve` 的 canonical cwd 显式 open：

- 新 server：启动 registry 后本地 open 初始 scope。
- 复用存活 server：使用 state 中的 URL/token 调用该 server 的 `POST /v1/scopes/open`，成功后再返回带 hash URL。
- open 失败必须报告可解释错误，不把“浏览器稍后可能打开”当作恢复机制。
- 浏览器收到 hash 后再次 open 是允许的幂等校验，不改变 position。

### 2.4.3 从项目栏移除

```http
POST /v1/scopes/hide
Content-Type: application/json

{ "directory": "/canonical/scope" }
```

- 精确匹配 registry scope key 并标 hidden。
- 不 delete session，不归档，不停止 run，不 dispose InstanceStore。
- 404 表示项目未登记；400 表示输入不合法；401 表示未授权。

### 2.4.4 系统目录选择

```http
POST /v1/scopes/open-picker
```

安全与行为：

- `isAuthorized()` 失败返回 401。
- server host 非 loopback 时返回 403 `DIRECTORY_PICKER_LOOPBACK_ONLY`。
- macOS 通过 AppleScript、Windows 通过 PowerShell `FolderBrowserDialog`、Linux 通过 `zenity` 后备 `kdialog` 调用原生文件夹选择器。
- 用户取消返回 `{ ok: true, cancelled: true }`；选择成功返回 `{ ok: true, cancelled: false, scope }`。
- 选中的路径必须经 `resolveWorkspaceScope()` canonicalize；文件、失效路径或不可访问路径返回结构化 400。
- 原生 chooser 同时只允许一个；并发请求返回 409 `DIRECTORY_PICKER_BUSY`。
- 浏览器从不枚举目录、接收目录树或提交任意路径。

## 2.5 Web runtime 与导航状态

### 2.5.1 全局 API client

修改 `apps/ohbaby-web/src/api/daemon/http.ts` 与 `client.ts`：

- 全局 scopes/picker 请求显式 `includeDirectory: false`。
- workspace snapshot/events/commands 继续带 selected `x-ohbaby-directory`。
- 增加 `openWorkspace`、`openWorkspaceFromSystemPicker`、`hideWorkspace` 门面。
- rail 点击、picker 选择和 startup hint 都先走 `openWorkspace`，由 server 更新 `last_opened_at` 并返回 canonical key，再调用现有内部 switch；普通 `GET /v1/scopes` 不产生打开副作用。
- 不让 React 组件直接拼 fetch、token 或 header。

### 2.5.2 versioned navigation preferences

新增 `apps/ohbaby-web/src/navigation/preferences.ts`（或同等清晰位置）：

```ts
interface NavigationPreferencesV1 {
  readonly selectedDirectory?: string;
  readonly lastSessionByDirectory: Readonly<Record<string, string>>;
  readonly version: 1;
}
```

要求：

- 解析失败、旧版本、字段类型错误时安全回到空偏好，不影响 daemon connect。
- 切换成功后才更新 `selectedDirectory`。
- session 选择成功后才更新对应 map。
- hide 项目时删除本地 selected/last-session 引用，但不修改 backend session。
- localStorage 不保存 token、消息、目录列表或 registry 全量副本。

### 2.5.3 startup 选择算法

将 `bootstrap.ts` 的“一次性读 hash 后立刻构造 runtime”改为显式启动编排：

```text
parse #directory/#session
  → fetch visible scopes
  → if explicit directory:
       POST scopes/open (also unhide)
       select canonical response
    else if local selected is visible/available:
       select local
    else if registry has a most-recently-opened visible/available project:
       select it (rail position does not change)
    else:
       select null
  → create/connect workspace client if selected != null
  → validate session hint / lastSessionByDirectory / recent active fallback
  → publish navigation snapshot
```

约束：

- 有效 `#directory` 永远压过 local preference，保证“从哪个 repo 执行 serve 就打开哪个 repo”。
- 显式 directory 无效时显示可见错误，不静默换到其他 cwd/scope；rail 仍可用于恢复操作。
- 手工打开无 hint URL 时才使用 local preference/fallback。
- daemon 注入的 `window.__OHBABY__.directory` 不再作为无 hint 时的隐式选中来源；全局面板不能重新绑定到首次启动 daemon 的 cwd。
- hash session 不属于 selected scope 时忽略并清理，不跨 scope select。

### 2.5.4 URL 同步

成功状态使用：

```text
#directory=<canonical-directory>&session=<session-id>
```

- workspace 切换成功后更新 directory；session 尚未确定时移除 session。
- session 选择成功后更新 session。
- 使用 `history.replaceState`，不触发页面 reload 或新增浏览历史风暴。
- CLI/server 继续只负责写 directory hint，不需要知道 session 偏好。

### 2.5.5 hide selected project

- 隐藏非当前项目：直接 hide + refresh rail。
- 隐藏当前项目且存在其他 visible 项目：先成功切换 fallback，再 hide 原项目；避免 hide 成功但 fallback connect 失败造成无意中断。
- 隐藏唯一项目：hide 后关闭 active client、reset store、selectedDirectory→null，进入全局空状态。
- hidden 项目的后台 run 不停止；再次 open 后仍由正常 snapshot 反映真实状态。

## 2.6 React UI

### 2.6.1 文件结构

建议最小拆分：

```text
apps/ohbaby-web/src/ui/
  App.tsx                         # 保留顶层业务编排、Conversation/overlay
  shell/AppShell.tsx              # 三栏布局与响应式壳
  projects/ProjectRail.tsx        # 项目 glyph、选中态、+、context menu
  sessions/SessionSidebar.tsx     # 当前项目 header + session list
  navigation.css                  # 新导航样式
```

允许根据现有 lint/import 习惯微调命名，但不得把所有新组件继续内联进 `App.tsx`。

### 2.6.2 ProjectRail

- 宽 56–64px，桌面态始终可见。
- glyph = basename 首个可显示 Unicode 字符的大写形式；为空时使用 folder icon。
- 颜色由 canonical directory 做稳定 hash，使用受控浅色 palette；不持久化颜色。
- selected 使用边框 + 背景双重信号，不只靠颜色。
- tooltip/accessible name 包含 basename 与完整路径。
- 新项目追加到稳定 position；本批无拖拽。
- `+` 调用系统原生目录选择器。
- pointer contextmenu 和键盘/`…` 菜单共享同一 action model。

### 2.6.3 Project/Session sidebar

- 顶部显示 basename 与 `~` 缩短路径；title 保留完整路径。
- 提供“新建会话”。
- 只渲染当前 scope snapshot 的 sessions。
- 恢复 last session；失效时选择最近 active；无 session 显示空态。
- 保留 archive 行为，但“从项目栏移除”不能复用 Archive 文案或图标。
- 侧栏允许折叠；折叠不影响 project rail。

### 2.6.4 SystemDirectoryPicker

- Web 端不渲染 modal、breadcrumb、路径输入或目录树；`+` 直接请求 `scopes/open-picker`。
- 取消后保持当前 workspace，不刷新、不切换，也不显示错误。
- 成功后刷新 rail、选中 canonical scope 并执行既有 workspace switch。
- 原生 dialog 的 focus、键盘、权限提示和路径导航由 OS 管理；Web 仅展示服务端返回的可解释错误。

### 2.6.5 Conversation pane

- 复用现有 StatusBar、ConversationStream、PermissionModal、Composer 和 structured overlays。
- 本批只调整容器尺寸、sticky/scroll 边界和空态上下文。
- 不借导航改版重写 markdown、slash、goal、model、permission 逻辑。

### 2.6.6 响应式

- 桌面：rail + session sidebar + conversation。
- 中窄宽度：rail 保留，session sidebar 可折叠为 drawer/隐藏态。
- 本批不承诺完整手机产品重设计，但 720px 以下不得让 rail、`+` 或 Composer 无法操作。

## 2.7 分阶段实施

### Phase A：registry 与全局 API

目标：先让项目持久可见、可隐藏、可显式恢复，并能安全调用系统目录选择器。

改动：

- `packages/ohbaby-agent/src/services/database/migrations.ts`
- `packages/ohbaby-agent/src/services/database/schema.ts`
- `packages/ohbaby-agent/src/services/workspace-registry/*`
- `packages/ohbaby-agent/src/index.ts`
- `packages/ohbaby-server/src/runtime/daemon/server.ts`
- `packages/ohbaby-server/src/runtime/daemon/main.ts`
- 新增 `packages/ohbaby-server/src/runtime/native-directory-picker.ts`
- 对应 unit/integration tests。

DoD：04 中 A 系列测试通过；旧 `/v1/scopes`、workspace dispatch、版本/legacy 测试不回归。

### Phase B：Web navigation runtime

目标：把 startup/open/hide/hash/local preference/session restore 做成 UI 无关状态机。

改动：

- `apps/ohbaby-web/src/api/daemon/http.ts`
- `apps/ohbaby-web/src/api/daemon/client.ts`
- `apps/ohbaby-web/src/api/daemon/wire.ts`
- `apps/ohbaby-web/src/bootstrap.ts`
- 新增 `apps/ohbaby-web/src/navigation/*`
- 对应 unit/integration tests。

DoD：04 中 B 系列通过；旧 SSE generation 隔离与 fail-closed rollback 继续通过。

### Phase C：三栏 UI

目标：替换 `<select>`，完成 rail、project sessions、系统目录选择入口和 remove/restore 交互。项目 rail 始终存在；会话栏默认不占宽度，点击 rail 顶部按钮后展开并只显示 selected project 的 sessions。

改动：

- `apps/ohbaby-web/src/ui/App.tsx`
- 删除 `WorkspaceSelector` 及 `.ohb-workspace-selector`。
- 新增 `ui/shell`、`ui/projects`、`ui/sessions` 导航组件。
- `apps/ohbaby-web/src/ui/styles.css` 只删除旧规则/保留对话规则。
- 新增 `apps/ohbaby-web/src/ui/navigation.css`。
- 更新 `App.unit.test.tsx` 并新增针对性 component tests。

DoD：04 中 C 系列通过；键盘、右键、空态、不可用项目和折叠行为可用。

### Phase D：真实浏览器调试与文档对齐

目标：使用 Playwright 打开真实 `ohbaby serve`，完成视觉/交互调试并更新权威文档。

改动/动作：

- 构建 Web assets，启动真实 daemon。
- 准备两个 temp Git repo、一个无 session repo、一个 hidden/reopen 场景。
- 用 Playwright 逐项执行 04 §4.5。
- 更新 `docs/ohbaby-web/{README,goals-duty,architecture,data-model,dfd-interface,use-case,test}.md`。
- 更新 `docs/ohbaby-web/ui/{README,components,states}.md`，将 OpenCode 三栏设为 Phase 2 导航权威；旧 claude.ai 稿只保留 Conversation/Composer provenance。
- 更新全局单 daemon 文档中的 Web Phase 状态与本目录链接。

DoD：04 发布门全部满足，用户再进行实现审查。

## 2.8 按包/目录的改动面

| 包/目录 | 新增 | 修改 | 删除/替换 |
|---------|------|------|-----------|
| `packages/ohbaby-agent/src/services/database` | migration 013 schema | migrations/schema | 无破坏性 migration |
| `packages/ohbaby-agent/src/services/workspace-registry` | store/types/tests | — | — |
| `packages/ohbaby-server/src/runtime` | native directory picker helper/tests | daemon server/main wiring | 旧 Web directory listing 由原生选择器替代 |
| `apps/ohbaby-web/src/navigation` | preferences、selection helpers/tests | — | — |
| `apps/ohbaby-web/src/api/daemon` | 新 DTO/方法/集成测 | runtime startup/open/hide | 不删除 workspace switch 隔离 |
| `apps/ohbaby-web/src/ui` | shell/rail/dialog/sidebar/CSS/tests | App orchestration | `WorkspaceSelector` 与旧 selector CSS |
| `docs/ohbaby-web` | — | 导航/数据/API/测试权威文档 | 旧 selector 最终态表述 |

## 2.9 兼容与迁移

1. migration 013 additive；旧版本忽略新表，新版本启动后创建。
2. 现有 session roots 在 registry 缺项时被兼容发现并追加；hidden tombstone 永远优先。
3. `GET /v1/scopes` 保持原 URL 和 `ok/scopes` 外形；新增字段对当前 Web 是向前扩展。
4. `x-ohbaby-directory` 与所有 workspace API 不改。
5. CLI `ohbaby serve` 不新增参数；server start/reuse 先 open 当前 canonical root，再继续生成 directory hash。
6. localStorage 使用 version 字段；坏数据可丢弃，不做复杂迁移。
7. 不删除现有 session/project_root 数据，也不把 registry FK 绑到 session。

## 2.10 风险与回滚

| 风险 | 防护 | 回滚 |
|------|------|------|
| hidden 被 session discovery 覆盖 | store 明确 `ensureDiscovered` 不改 hidden；集成测 | UI 可暂时只读 registry，表数据保留 |
| system directory picker 被非本机调用 | loopback gate + Bearer + 单实例互斥；浏览器不接触路径树 | 禁用 picker route，不影响手工 serve/historical projects |
| startup hint 与 local preference 打架 | 固定优先级与纯函数测试 | 保留 hash directory，关闭 session/local restore |
| hide 当前项目造成断连 | 有 fallback 先 switch 后 hide；唯一项目进入 null state | hide 失败不改变 selection；可 `open` 恢复 |
| registry position 并发冲突 | SQLite transaction + unique index + busy retry | 重试；不做 silent overwrite |
| UI 重构误伤 Composer/overlay | 只拆导航，跑现有 Web 全套回归 | 可回退 C 层组件，A/B additive 能保留 |
| migration 回退 | migration 只加表，不 drop/alter session | 旧代码继续工作；不需要删除表 |

## 2.11 明确禁止的实现捷径

- 不用 localStorage 充当全局项目 registry。
- 不用 `<input type=file webkitdirectory>` 伪造 server path picker。
- 不让 Web canonicalize Git root。
- 不把 directory 放进 server query/cwd fallback。
- 不因 hide 删除、归档 session 或停止 run。
- 不因 loaded=true 强制覆盖 hidden。
- 不在 GET scopes 中递归扫描 Home/磁盘寻找仓库。
- 不让 React component 直接读取 SQLite、token 或 Node filesystem。
- 不整体 revert `04d98cfb`。
- 不顺手重写 Conversation/Composer/Slash/Permission。
- 不在本批恢复 scheduler 或做 per-scope dispose。

## 2.12 与 00 对齐

- 系统原生目录选择（`scopes/open-picker`）、无路径输入/Web 目录树：已覆盖。
- 无 session 项目永久显示：registry visible 已覆盖。
- 右键移除但不删 session：hidden tombstone 已覆盖。
- hidden 项目被 `ohbaby serve` 显式恢复：startup `scopes/open` 已覆盖。
- 每项目恢复最后 session，serve cwd 优先：preferences + priority 已覆盖。
- 只学习三栏，不做顶部搜索/设置/Review：UI scope 与禁止项已覆盖。
- 开发后 Playwright 真浏览器调试：Phase D 与 04 发布门覆盖。

## 2.13 问题追踪矩阵

| 01 问题 | 02 回应 | 04 验证 |
|---------|---------|---------|
| P1 项目/session 层级错误 | §2.1、§2.6 三栏 shell | C1–C5、PW1/PW5 |
| P2 无持久 registry | §2.3 migration/store | A1–A3 |
| P3 无系统目录选择 | §2.4.4、§2.6.4 | A9–A13、C9/C10、PW2/PW3 |
| P4 无导航恢复模型 | §2.5.2–§2.5.4 | B1–B7、PW1/PW6/PW9 |
| P5 App/CSS 神文件 | §2.6.1、Phase C | C1/C14 + review |
| P6 remove 后被历史复活 | §2.3 hidden tombstone、§2.4.3 | A4/A5/A14、B10–B13、PW7–PW9 |
| P7 测试只证明 `<select>` | §2.7 Phase D | 04 全矩阵与 Playwright PW1–PW14 |
| P8 文档双重 source of truth | Phase D 文档更新 | 发布门最后一项 |
