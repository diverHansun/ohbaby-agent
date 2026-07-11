# 1. 问题分析与当前状态

> 分析时间：2026-07-11。
>
> 历史分析基线：分支 `codex/global-single-daemon-phase1b`；全局单 daemon 三个提交 `d3670087`、`04d98cfb`、`ca800fa5` 已存在。以下“当前状态”记录的是本议题实施前的证据；实施结果以 README 与 04 §4.10 为准。

## 1.1 核心矛盾

| ID | 当前问题 | 用户影响 | 技术影响 |
|----|----------|----------|----------|
| P1 | workspace 被放进会话侧栏的 `<select>` | 无法一眼看出有哪些项目，项目与 session 层级混乱 | 一个 `SessionSidebar` 同时承担品牌、项目选择和 session 导航，职责不内聚 |
| P2 | known scopes 只来自 session 历史与 loaded runtime | 无 session 的新导入项目无法跨 daemon 重启保留 | 没有持久 registry，也没有 visible/hidden tombstone |
| P3 | 没有服务端目录浏览 API | Web 的 `+` 无法完成“选择本机项目根目录” | 浏览器目录 handle 不能替代 daemon 所需的绝对路径 |
| P4 | 启动 hint 只读一次，没有完整导航恢复模型 | 刷新、切回项目、直接打开 URL 的体验不稳定 | 没有 per-project last session、hash 同步和明确优先级 |
| P5 | `App.tsx` 与 `styles.css` 已成为神文件 | 改导航容易误伤命令、权限、Composer | 2619 行 TSX + 2035 行 CSS，导航继续堆入会放大偶然复杂度 |
| P6 | “从项目栏移除”缺少可表达的数据状态 | 项目会因历史 session 立即重新出现 | `GET /v1/scopes` 对 session roots 和 loaded scopes 只做并集 |
| P7 | 现有测试证明“能切 workspace”，未证明目标产品闭环 | 临时 `<select>` 通过测试也不代表三栏可用 | 缺目录弹窗、隐藏/恢复、启动优先级和真实浏览器交互覆盖 |
| P8 | 旧 UI 文档仍把 claude.ai 单屏稿与最小 selector 当目标 | 继续开发时会出现两个 source of truth | `docs/ohbaby-web/ui/*` 与本轮 OpenCode 三栏目标发生漂移 |

## 1.2 已经正确、不得回退的基线

本轮不是推翻 Web runtime。以下承重能力已经落地并有测试，应视为安全底座：

1. `packages/ohbaby-server/src/runtime/workspace-scope.ts::resolveWorkspaceScope()`：绝对路径、存在性、可读性、目录类型、Git root/canonical directory 规则。
2. `packages/ohbaby-server/src/runtime/daemon/server.ts::dispatchWorkspaceRequest()`：workspace 请求必须显式携带 `x-ohbaby-directory`，非法目录返回结构化 400。
3. `apps/ohbaby-web/src/api/daemon/client.ts::BrowserOhbabyWebRuntime`：workspace 切换时关闭旧 client/SSE、reset store、创建新 client，失败恢复旧 workspace。
4. `apps/ohbaby-web/src/api/daemon/workspace-switch.integration.test.ts`：断言旧 SSE 被 abort、新请求使用新 directory 和新 clientId、失败后恢复。
5. `packages/ohbaby-server/src/runtime/daemon/main.ts::urlWithWorkspaceHint()`：任意 cwd 执行 `ohbaby serve` 都复用同一 origin，并把 canonical cwd 放进 URL fragment。
6. `packages/ohbaby-server/src/runtime/daemon/global-single-serve.integration.test.ts`：真实双进程证明第二次 serve 复用全局 server，同时保留新 cwd hint。

P1–P8 的解决方案必须建立在这些能力之上，不能通过整体 revert 退回单 workspace 或 cwd fallback。

## 1.3 goals-duty 诊断

### 文档现状

`docs/ohbaby-web/goals-duty.md` 正确规定：

- Web 是 daemon 状态的投影和 adapter，不是 session 事实源。
- REST/SSE 连接层与 React 视图层应分离。
- Web 可以管理 selected directory，但 canonicalization 与 scope identity 属于 server。

### 代码现状

- `apps/ohbaby-web/src/api/daemon/` 与 `apps/ohbaby-web/src/store/` 基本保持连接/投影职责。
- `apps/ohbaby-web/src/ui/App.tsx::OhbabyWebApp()` 直接订阅 workspace runtime，并把选择回调交给 `SessionSidebar`。
- `SessionSidebar` 又同时包含 OHBABY 品牌、折叠逻辑、新建 session、workspace selector、session list 和 footer。

### Gap

- 项目导航是全局 Web shell 职责，不应是 session sidebar 中的一个表单字段（P1）。
- 持久项目 registry 是 server/共享 DB 职责，不应塞进 React localStorage；但 selected project/session 是 UI 偏好，也不应写成 backend 会话真相。当前文档没有把这两个“持久化”分开（P2/P4）。
- 服务端目录浏览属于本地 daemon 的受保护基础设施，不属于 agent 领域，也不能由浏览器自行猜路径（P3）。

## 1.4 architecture 诊断

### 当前结构

```text
OhbabyWebApp
  ├─ SessionSidebar
  │    ├─ brand / collapse
  │    ├─ New session
  │    ├─ WorkspaceSelector <select>
  │    └─ Session list
  └─ Content
       ├─ StatusBar / ConversationStream
       ├─ PermissionModal / overlays
       └─ Composer
```

代码锚点：

- `apps/ohbaby-web/src/ui/App.tsx::OhbabyWebApp`
- `apps/ohbaby-web/src/ui/App.tsx::SessionSidebar`
- `apps/ohbaby-web/src/ui/App.tsx::WorkspaceSelector`
- `apps/ohbaby-web/src/ui/styles.css::.ohb-sidebar`
- `apps/ohbaby-web/src/ui/styles.css::.ohb-workspace-selector`

### 问题

1. **层级错误**：project 和 session 是父子导航，却被渲染成 selector + list 的同栏兄弟（P1）。
2. **神文件风险**：`App.tsx` 2619 行、`styles.css` 2035 行；继续加入 rail、context menu、dialog、navigation persistence 会让一个文件同时承担领域编排与复杂交互（P5）。
3. **接口 seam 已存在但未利用**：`OhbabyWebRuntime` 已经是 workspace 切换 seam，视图完全可以替换而无需重写 REST/SSE。
4. **全局路由缺扩展点**：`DaemonHttpServer.mountRoutes()` 目前只有 `/v1/scopes`、`/v1/connections` 两个全局路由，其余 `/v1/*` 全部按 workspace dispatch。registry 和 directory picker 必须在 dispatch 前明确挂载，否则会错误要求 directory header。

### SWE 判断

- 不是为了“组件化而组件化”，而是把三个变化原因分开：项目导航、session 导航、对话业务。这里拆边界是降低耦合，不是机械套 SOLID。
- 不重写 Conversation/Composer；它们与导航目标无直接因果。克制范围比追求整洁的全量重构更重要。

## 1.5 data-model 诊断

### 当前 Web 类型

`apps/ohbaby-web/src/api/daemon/wire.ts`：

```ts
interface WorkspaceScopeSummary {
  directory: string;
  loaded: boolean;
}

interface WorkspaceSnapshot {
  scopes: readonly WorkspaceScopeSummary[];
  selectedDirectory: string;
}
```

它只能回答“有哪些候选目录、哪些已加载、当前选谁”，不能表达：

- 用户显式导入过项目；
- 项目是否被用户隐藏；
- 项目是否仍可访问；
- 项目排序/最近打开信息；
- 无 session 项目为何仍应存在。

### 当前 server 来源

- `packages/ohbaby-agent/src/services/session/database-store.ts::listKnownSessionProjectRoots()` 从 session 表按 `project_root` 聚合。
- `packages/ohbaby-server/src/runtime/daemon/server.ts::listScopes()` 将历史 roots 和 `InstanceStore.loadedScopeKeys()` 合并。
- 无 registry schema；`packages/ohbaby-agent/src/services/database/migrations.ts` 当前最新迁移为 `012_subagent_instance_current_input`。

### 关键后果

1. 无 session 项目只能靠当前进程“loaded”暂存，重启丢失（P2）。
2. 删除/隐藏候选目录后，session roots 下一次 list 又会把它加回来（P6）。
3. 把项目列表只放 localStorage 虽然改动小，但会造成不同浏览器看到不同“全局项目”，也绕过 server canonicalization，因此不满足用户确认的永久项目栏。

## 1.6 dfd-interface 诊断

### 当前切换流

```text
<select> change
  → runtime.switchWorkspace(directory)
  → close old SSE/client
  → reset Web store
  → create client(directory header)
  → connect + snapshot + SSE
  → refresh /v1/scopes
```

这条数据流正确，但入口与导航状态过于贫弱。

### 缺失数据流

1. **添加项目**：`+ → 浏览目录 → 选择 → server canonicalize → registry visible → rail → switch`。
2. **隐藏项目**：context menu → registry hidden → rail 移除 → fallback project；session 和 runtime 不变。
3. **显式恢复**：`ohbaby serve` hash 或 picker 重新选择 → registry visible → selected。
4. **导航恢复**：hash/local preference → 校验 visible scope → connect → 恢复 session。
5. **目录浏览**：浏览器不能直接给 daemon 绝对路径，当前 server 无 roots/list-directories 契约（P3）。

### 安全缺口

目录枚举比普通 workspace API 更敏感：它能暴露本机目录名称。如果只依赖“将来可能正确配置的 CORS”，风险不可接受。当前 server 默认 loopback 且有 token，但新 API 仍需显式执行 loopback gate、Bearer 鉴权、目录-only 返回和错误收敛。

## 1.7 use-case 诊断

| 用例 | 当前可用性 | Gap |
|------|------------|-----|
| 从 repo B 执行 `ohbaby serve` 并选中 B | 部分可用 | hash 能选 directory，但没有 hidden 恢复和 session 恢复 |
| 在 rail 切换项目 | 不可用 | 只有 `<select>`，没有一级项目导航 |
| 导入无 session 项目 | 不可用 | 无 picker、无 registry |
| 右键移除项目但保留会话 | 不可用 | 无 hidden tombstone，历史 session 会重新发现 |
| 重新 serve hidden 项目 | 不可用 | 无 open/unhide 命令 |
| 切回项目恢复最后 session | 不可用 | 无 per-project navigation preference |
| 目录失效后仍可管理入口 | 不可用 | listScopes 当前直接忽略无法 resolve 的 known root |

## 1.8 non-functional 诊断

### 可维护性

- P5 已是现实趋势，不是抽象洁癖。新导航应做有限组件拆分，并保持 runtime seam 不变。

### 安全

- 新目录浏览 API 必须只允许 loopback、必须鉴权、不得返回文件内容或读取文件。
- open 继续调用 `resolveWorkspaceScope()`，不得在 UI 或 registry store 复制 canonicalization。
- hide 只能操作已知 canonical scope key，不把任意用户字符串当删除条件。

### 可靠性

- 项目切换失败必须维持当前 rollback 语义。
- hidden 仅影响导航可见性，不能破坏正在运行的 session 或 backend。
- registry DB 写入需要沿用现有 WAL/busy retry/transaction 约定。

### 可访问性

- 不能只靠右键；同一“从项目栏移除”动作必须可从 `…` 菜单和键盘触发。
- rail item、dialog、breadcrumb、loading/error 状态需要语义化 label、focus 管理和 Escape 关闭。

### 性能

- 不扫描磁盘寻找 Git 仓库；目录只在用户打开 picker 后按当前层级懒列举。
- `GET /v1/scopes` 不能递归 stat 全盘。
- 项目规模预计是个位到几十个，不引入虚拟列表、缓存服务或独立进程。

## 1.9 test 诊断

### 已有覆盖

- `apps/ohbaby-web/src/ui/App.unit.test.tsx`：当前 selector 调用 `switchWorkspace`。
- `apps/ohbaby-web/src/api/daemon/workspace-switch.integration.test.ts`：SSE/client generation 隔离与失败回滚。
- `packages/ohbaby-server/src/runtime/daemon/global-server.integration.test.ts`：known/loaded scopes 和 workspace dispatch。
- `packages/ohbaby-server/src/runtime/daemon/main.unit.test.ts`、`global-single-serve.integration.test.ts`：cwd hash hint。
- `docs/ohbaby-web/test.md` 已把 Playwright MCP 真实浏览器检查列为集成点，但仓库没有 Playwright config 或自动浏览器套件。

### 缺口

- registry migration/store 的 visible/hidden/upsert/并发行为。
- session discovery 与 hidden tombstone 的优先级。
- directory picker loopback/auth/path/error/目录-only 契约。
- bootstrap/hash/local preference/session restore 的优先级。
- rail、context menu、dialog、fallback project 的组件行为。
- 真 daemon + 真浏览器下的三栏布局、焦点、右键、切换和恢复。

测试目标应围绕这些风险，而不是用 CSS selector 数量或覆盖率百分比替代产品验收。

## 1.10 文档与实现对照

| 文档说法 | 当前实现 | Gap / 本批处理 |
|----------|----------|----------------|
| `docs/ohbaby-web/ui/README.md` 以 claude.ai 单屏稿为交互权威 | 代码已加入左侧 session sidebar 和 workspace selector | 本批把 OpenCode 三栏导航设为 Web Phase 2 权威，旧稿只保留 Conversation/Composer 参考 |
| `docs/ohbaby-web/README.md` 称可视化切换器已落地 | `<select>` 技术闭环确已落地 | 改为“runtime 纵切已落地，目标导航待本批实施” |
| 全局单 daemon 文档规定 known/loaded/selected | server 与 runtime 已支持三态的一部分 | 新增 registered/hidden/available 导航语义，不改变 scope identity |
| `docs/ohbaby-web/test.md` 要求 Playwright MCP E2E | 仅有历史手工记录 | 本批把真实浏览器调试列为发布门，并明确自动/手工证据 |

## 1.11 改动影响面

| 模块 | 预计影响 |
|------|----------|
| `packages/ohbaby-agent` | SQLite migration、workspace registry store/public export |
| `packages/ohbaby-server` | 全局 registry 与 directory picker 路由、列表合并、loopback gate |
| `apps/ohbaby-web/src/api/daemon` | 新全局 API client、workspace summary、startup/open/hide 流 |
| `apps/ohbaby-web/src/ui` | 三栏 shell、rail、session sidebar、目录 dialog、context menu、导航偏好 |
| `packages/ohbaby-cli` | 原则上不改命令；保留现有 `urlWithWorkspaceHint` 契约，补回归测试即可 |
| 文档 | 本 problem-list 与 `docs/ohbaby-web`、全局单 daemon 的进度/交叉链接 |

## 1.12 SWE 原则审视摘要

1. **管理复杂度**：真正复杂的是“项目可见性、选择与 session 恢复”，不能把它伪装成更花哨的 `<select>`。
2. **高内聚**：ProjectRail、ProjectSessions、Conversation 是三个不同变化轴，应在 UI 边界分开。
3. **信息隐藏**：浏览器只请求目录导航与 open/hide；canonicalization 和持久 registry 隐藏在 server/store 后面。
4. **单一事实源**：session 真相留在 backend；registry 可见性留在共享 DB；当前选择留在浏览器偏好，各自只存自己拥有的状态。
5. **YAGNI**：不做文件搜索、拖拽排序、头像上传、全盘扫描或新桌面壳。
6. **演进 seam**：保留 `OhbabyWebRuntime` 作为连接 seam，仅替换导航 UI；若未来有 App，可复用协议而不是当前 React 组件。
