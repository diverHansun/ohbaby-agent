# improve-2 · 2. 方案与改动面：会话中心运行时、草稿与全局侧栏

> 依据：[02 §3.2](../02-frontend-architecture.md)（运行时两层）、[06 §1–§3](../06-data-api-and-state.md)（接口、ViewModel、刷新、草稿、置顶）、[01](../01-use-cases-and-user-flows.md) 的 UC-DRAFT、UC-SIDEBAR。现状见 [01](01-current-state.md)，验收见 [04](04-test-and-acceptance.md)。

## 目标

从“当前目录”改成“当前会话”：侧栏跨项目显示全部会话，点新对话先进草稿，第一次发送才创建会话，打开会话时按它的执行目录连接实例。

## 范围

做：

1. **全局会话客户端**：新增 `api/daemon/global-sessions.ts`，提供列表（分页）、改归属的调用（搜索的调用一并写好，界面在 improve-3）。只依赖 SDK 类型，不依赖 React。
   同批提供 `GET /v1/settings/models` 的最小全局只读调用，用于无实例草稿的发送前检查；全局 HTTP 方法仍放 Web，不新增 SDK HTTP 客户端。共用传输保留 `SESSION_MOVED.targetDirectory`。
2. **运行时两层**（02 §3.2）：
   - 全局层：项目列表（含 `defaultWorkspace`）、会话列表，不依赖任何实例。
   - 实例层：同一时间只连一个目录，按打开的会话的请求目录（有待生效目录时用它）切换；草稿不建实例，第一次发送时按所选项目或默认目录建实例并创建会话。
   - `SESSION_MOVED`：runtime 统一换目录重发并切换 SSE，最多自动重发 2 次（加首次共 3 次），保留原 `clientRequestId` 和冻结正文；超时走现有未知结果恢复，不盲目重放。
   - 运行中的当前会话改归属只更新下一轮目录，本轮 client、SSE、审批和停止操作保持原绑定。归档、导出其他目录会话用对应目录的短期 HTTP 请求，不切走当前流。
   - 草稿里的斜杠命令按草稿目录建实例后执行；需要会话的命令按 02 §3.2 的要求处理。
3. **草稿首发**：本地草稿状态（文字 + 所选项目），草稿 key 改为固定的 `new` 和会话 ID（06 §3.5），同步调整租约 key 和输入框重挂载的 key；`ProjectPicker` 取代 improve-1 的选择条占位，接上项目列表和 Open folder…；没有目录时也能直接发送（默认工作区），去掉 improve-1 的临时 `Open folder…` 行为。New chat 总是从 No project 开始，项目分组的 `[+]` 预选该项目。
4. **全局侧栏**：Pinned → Projects → No project；按 `projectDirectory` 分组，每组 6 条、Pinned 8 条、Show more 每次多 20 条；折叠状态本地保存；行尾相对时间（照 Cursor），当前实例里运行中、等待审批的会话行显示转圈和琥珀点（06 §3.4）。置顶改为全局 key，并迁移旧的按目录 key（06 §3.6）。
5. **刷新策略**：创建、窗口重新激活、SSE 重连时按 06 §3.2 校验已加载范围，替换旧分页游标，移除已归档或隐藏的旧行；刷新中保留可见内容，失败时保留旧数据、不提示。Show more 串行翻页直到该组足够或游标耗尽，不把已加载条数显示成总数。
6. **拆大文件**（行为不变）：

| 原文件 | 拆成 |
|---|---|
| `runtime.ts` | `runtime/index.ts`（façade）、`runtime/global-layer.ts`（项目与会话列表）、`runtime/instance-layer.ts`（实例 client 切换、`SESSION_MOVED` 重发）、`runtime/draft.ts`（草稿首发） |
| `api/daemon/client.ts` | 按职责拆成 `client.ts`（类的组装与 `UiBackendClient` 实现入口）、`client-sync.ts`（连接、SSE、历史分页）、`client-prompts.ts`（提交、插话、排队、租约）、`client-commands.ts`（命令、模型、导出、归档），其余调用保持原接口 |

不做：会话菜单的改归属、搜索界面（improve-3）；设置页（improve-4）；不改服务端。

执行目录不可用时，本批先保留错误与 Retry；`Move to project…` 引导随 improve-3 的项目菜单一起启用，不放无作用的按钮。

## 改动面

| 目录 | 新增 | 修改 | 删除 |
|---|---|---|---|
| `runtime/` | 上表四个文件 | — | 原 `runtime.ts` |
| `api/daemon/` | `global-sessions.ts`、最小 `settings-client.ts`、拆出的 `client-*.ts` | `client.ts`、`http.ts`、`navigation-state.ts`（不再记 `selectedDirectory` 作为草稿预选） | — |
| `store/` | 全局目录、草稿切片与纯选择器 | `store.ts` 接线，避免继续堆业务 | — |
| `ui/sidebar/` | `Sidebar`、`ProjectGroup`、`SessionRow`（由 `ui/session/` 迁入并改写） | — | `ui/session/SessionSidebar.tsx` |
| `ui/session/`、`ui/composer/` | `ProjectPicker` | 草稿 key、首发流程 | — |

## 风险

| 风险 | 应对 |
|---|---|
| 运行时改动牵连大量集成测试 | 先拆文件、保持接口，再改行为；目录切换相关测试逐个迁移到“按会话目录连接”的写法，不删场景 |
| 旧链接、旧置顶、旧草稿丢失 | 会话 hash 格式不变（improve-1 T20）；置顶迁移保留旧 key；草稿按 06 §3.5 迁移可唯一定位的数据，保留有歧义的旧数据；租约不跨会话误绑定 |
| 会话创建成功但首条 prompt 失败 | 保留已创建的会话 ID，只重试 prompt；切换页面后晚到结果不抢回选择或清空其他草稿 |
| 冷门项目的旧会话要翻多页才出现 | 06 §3.1 已接受；搜索在 improve-3 补上 |
