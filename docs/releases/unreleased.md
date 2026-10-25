# 下一次发布（未发布）

状态：发布准备中，尚未发布。本文件不指定下一次发布的版本号或日期；本轮源码版本保持 `0.1.16`。

## LLM 包提取

- 新增独立公开包 `ohbaby-llm`，包含 LLM client、三种协议 provider，以及纯配置类型、校验和模型 profile 函数；包不依赖其他 workspace 包，唯一公开入口为 `ohbaby-llm`。
- 独立使用者通过 `createLLMClientFromConfig` 提供已解析、已校验的配置，并用 `streamResponse` 消费流式响应。配置文件与环境变量 IO、日志接线、模型探测、系统代理和 UI 能力视图仍由 `ohbaby-agent` 负责。
- `ohbaby-agent` 继续提供原有 `createLLMClient` 和其他既有公开导出。提取不改变模型请求、重试、缓存键或 token 统计行为，不需要数据迁移。

## 包与发布准备

公开包由四个增加为五个。统一版本并按 `ohbaby-sdk` → `ohbaby-llm` → `ohbaby-agent` → `ohbaby-server` → `ohbaby-cli` 顺序发布；用户继续只安装 `ohbaby-cli`。Node.js 要求仍为 >= 24。

发布前使用五包 `pnpm pack` 产物，核对没有残留 `workspace:`，agent 的 `ohbaby-llm` 依赖为具体版本，再从临时 registry 和独立目录安装 CLI，验证 `ohbaby --version`。实际验证结果见 [实施与验收记录](../problem-lists/2026-10-21-llm-package-extraction/improve-1/05-implementation-acceptance.md)；本文件不代表已经完成 npm 发布。

## Workspace 与运行目录命名

这是 `ohbaby-sdk` 和 `ohbaby-agent` 在 0.x 内的不兼容改动。会话归属的文件夹统一叫 workspace，实际执行目录叫 working directory；Git 仓库身份仍叫 project。

| 原接口 | 新接口 |
|---|---|
| `Session.projectDirectory`、`UiGlobalSession.projectDirectory` | `workspaceDirectory` |
| `Session.projectRoot`、`UiSession.projectRoot`、`UiSessionIndexEntry.projectRoot` | `workingDirectory` |
| `Session.pendingProjectRoot` | `pendingWorkingDirectory` |
| `SessionExecutionRootInput`、`EnsureRootSessionInput.projectRoot` | `SessionWorkingDirectoryInput`、`EnsureRootSessionInput.workingDirectory` |
| `listByProjectRoot`、`recordExecutionRoot` | `listByWorkingDirectory`、`recordWorkingDirectory` |
| `sessionTargetProjectRoot`、`withSessionExecutionRoot`、`isSessionInProjectRoot` | `sessionTargetWorkingDirectory`、`withSessionWorkingDirectory`、`isSessionInWorkingDirectory` |
| `sameSessionProjectRoot`、`normalizeSessionProjectRoot`、`SessionProjectRootCompareOptions`、`isSessionProjectRootCaseInsensitivePlatform` | `sameSessionDirectory`、`normalizeSessionDirectory`、`SessionDirectoryCompareOptions`、`isSessionDirectoryCaseInsensitivePlatform` |
| `SessionProjectMove*`、`planSessionProjectMove`、`commitSessionProjectMove`、`adoptSessionProjectMove` | `SessionWorkspaceMove*`、`planSessionWorkspaceMove`、`commitSessionWorkspaceMove`、`adoptSessionWorkspaceMove` |
| `SessionProjectBinding`、`resolveSessionProjectBinding`、`writeSessionProjectBinding` | `SessionWorkspaceBinding`、`resolveSessionWorkspaceBinding`、`writeSessionWorkspaceBinding` |
| `listKnownSessionProjectRoots`、`clearDefaultWorkspaceProjectBindings` | `listKnownSessionWorkingDirectories`、`clearDefaultDirectoryWorkspaceBindings` |
| `UiSessionProjectUpdate`、`UiDefaultWorkspace` | `UiSessionWorkspaceUpdate`、`UiDefaultDirectory` |
| `defaultWorkspace`（scopes、about 响应） | `defaultDirectory` |
| `WORKSPACE_DIRECTORY_*`、`workspaceDirectoryHeaders` | `REQUEST_DIRECTORY_*`、`requestDirectoryHeaders` |
| `resolveDefaultWorkspaceDirectory`、`ensureDefaultWorkspaceDirectory`、`isDefaultWorkspaceDirectory`、`defaultWorkspaceBoundary`、`DEFAULT_WORKSPACE_DIR_MODE` | `resolveDefaultDirectory`、`ensureDefaultDirectory`、`isDefaultDirectory`、`defaultDirectoryBoundary`、`DEFAULT_DIRECTORY_MODE` |
| `POST /v1/sessions/:sessionId/project`，请求体 `{ projectDirectory }` | `POST /v1/sessions/:sessionId/workspace`，请求体 `{ workspaceDirectory }`；`null` 表示移出工作区 |
| `DEFAULT_WORKSPACE_NOT_PROJECT` | `DEFAULT_DIRECTORY_NOT_WORKSPACE` |

不保留旧字段或导出别名。旧移动路径返回 404，新路径收到仅含旧字段的请求体返回 400。请求头取值仍为 `x-ohbaby-directory`、`x-ohbaby-directory-encoding`，编码仍为 `percent-utf8`。导出文件仍是 version 1，保留其中的 `session.projectRoot`。

升级前请退出所有 ohbaby 进程，包括 daemon、TUI、serve 和 SDK 宿主。迁移 026 会把数据库列改为 `workspace_directory`、`working_directory`、`pending_working_directory`，升级前自动保存 `<数据库路径>.before-retained-<uuid>.backup`。存活的其他 daemon 会阻止升级；空闲旧 TUI 无法全部被检测到，因此仍需主动退出。

升级后的数据库不支持直接降级。要回退，先停掉所有进程，使用升级前备份恢复数据库，再启动旧版本；备份之后新增的数据不会出现在恢复后的数据库中。默认目录的磁盘路径 `<OHBABY_HOME>/workspace/default` 不变，不搬动用户文件。

Web 与 daemon、远程 TUI 应使用同版本。升级后刷新所有已打开的 Web 页面。前后端命名已统一，联调记录见 [实施与验收记录](../problem-lists/2026-10-25-workspace-naming/improve-1/05-implementation-acceptance.md)。侧栏 Recents 汇总全部可见活跃会话，含工作区与置顶会话，按更新时间倒序；工作区分组仍保留，移动或置顶不会把会话从 Recents 排除。
