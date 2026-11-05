# 会话存储区与子代理输出：后端实施记录

2026-11-05。用户确认的全部后端范围已实现，自动化测试和子代理审查通过，等待用户做后端手工验收。Files 前端留到后续。本记录不替代子代理议题的正式 `05-implementation-acceptance.md`，也不代表其中的手工发布门已通过。

## 分支与实施顺序

两个分支均从本地 `main` 的 `dedbd80f` 开始：

- 主题分支：`codex/session-storage-subagent-output`，保留已确认方案所在的基点。
- 后端分支：`codex/session-storage-subagent-output-backend`，从主题分支建立，包含以下实现与测试提交。

本轮没有合并或推送。第一期完成定向测试、整库单元测试、集成回归及独立审查后，才开始子代理结果搬迁；随后依次实施工具输出存盘、文件 API。

| 提交 | 内容 |
| --- | --- |
| `8ec5f173` | 根会话共享 scratch、初始化、生命周期、主子代理提示词、两项权限修正 |
| `6b655103` | 同步集成测试中的读、写、Shell 审批身份期望 |
| `d0c700f5` | 同步 Bash 集成测试的 Shell 审批模式期望 |
| `81933fb0` | 子代理报告搬到根会话存储区，删除专用读取通道及无调用参数 |
| `07ed0880` | 工具长输出存盘、Bash 原始流捕获、有界写入及失败状态 |
| `7e387733` | 绑定当前根会话的 scratch 文件列表与内容 API |

## 已落地的行为

**项目操作仍用用户 workspace，cwd 不变。** 会话运行初始化时准备 `<OHBABY_HOME>/sessions/<ownerId>/scratch/`；当前归属沿用 `parentId ?? sessionId`，主代理及同根子代理共用一份 scratch，不强制创建子代理目录。固定规则分别写入主、子代理基础提示词，环境提醒提供实际准备成功的绝对路径。准备失败则明确提示不可用，不伪造路径。

默认权限模式下，scratch 可读写，系统报告和工具原文默认只读。两项权限修正均在第一期完成：系统文件规则优先于普通 workspace 或上级可信目录的自动放行；读取授权不能变成写入或 Shell 授权。审批仍用已有 PermissionManager，区分 `external_directory_read`、`external_directory_write`、`external_directory_shell`。保留旧 deny，不把旧的模糊 allow 扩大解释为新写入权限。

子代理报告放在 `sessions/<rootSessionId>/subagents/<subagentId>/<executionId>.output`。不超过 51,200 字节的报告继续内联，超过时返回路径、大小与 token 信息，不带预览。保留原子保存、重试、删除后的失效保护和缺失文件再导出；移除 `authorizeInternalRead`、`forceFile` 等旧分支。旧目录不迁移，数据库正文可在下次准备报告时导出到新路径。

list、glob、web_search、web_fetch 在最终显示截断处保存本次已经取得的内容，不扩大原扫描或 provider 返回范围。Bash 在内存截断前捕获原始 stdout/stderr，写入 `tool-results/<jobId>.log`。单文件上限为 10 MiB，截断标记也计入上限；完整、部分、运行中、保存失败分开表达。只有实际 stdio 关闭并成功结束写入后才宣称完整；取消、强制排空、dispose 和 prune 会正确结束捕获。保存失败不返回成功路径，也不改变命令本身的退出结果。

文件随根会话保留，永久删除根会话时一起清理。结束任务、归档、移动 workspace 不清理；没有新增定时清理、数据库表或产物索引。

## Files 后端接口

接口约定详见 [dfd-interface](dfd-interface.md)。两个 GET 路由都复用现有 bearer/client 注册与当前会话绑定校验，需要 `runtimeEpoch` 和 `bindingGeneration`：

| 路由 | 返回 |
| --- | --- |
| `/v1/sessions/:id/files` | `{ ok: true, files: [...] }`，递归列出当前根会话 scratch 中的普通文件，按相对路径排序；`modifiedAt` 仍为 ISO 字符串 |
| `/v1/sessions/:id/files/content`，另传 `path` | 原始文本或图片字节，带 `no-store`、`nosniff` |

文本读取上限为 1 MiB，图片为 10 MiB；按内容签名支持 PNG/JPEG/GIF/WebP，HTML/SVG 按纯文本返回。读取实际字节有上限，打开后核查普通文件与文件身份，读取结束后再次检查路径和会话绑定。路径越界、符号链接与非普通文件不能借此访问 scratch 外部文件。错误分别使用 `INVALID_PATH`、`FILE_NOT_FOUND`、`FILE_TOO_LARGE`、`UNSUPPORTED_FILE_TYPE`；未知 I/O 错误不伪装成空列表或空文件成功。

## 参考项目与取舍

以下均参考实施时 `code-cli/` 下的本地检出代码，不代表对应产品最新官方行为。原设计的完整参考见[参考项目记录](../../problem-lists/2026-11-05-subagent-results-location/improve-1/03-reference-projects.md)。

| 项目与源码位置 | 本轮借鉴 |
| --- | --- |
| Claude：`src/entrypoints/init.ts`、`src/utils/permissions/filesystem.ts`、`src/utils/sessionStorage.ts` | 初始化准备 scratch；系统路径规则先于普通工作区放行；按会话组织 subagents |
| Kimi：`packages/agent-core-v2/src/agent/toolResultTruncation/toolResultTruncationService.ts`、`agent/task/persist.ts`、`agent/tools/os/bash/bashTool.ts` | 在显示截断处存盘；如实报告保存失败；命令执行结果与文件是否完整分开 |
| DeepSeek Harness：`packages/subprocess/subprocess-local/src/output.ts` | 先捕获原始 Buffer，再裁剪内存输出；独占创建文件；封口时关闭句柄 |
| ZCode：`packages/services/src/file/fileService.ts`；Claude：`packages/builtin-tools/src/tools/FileReadTool/FileReadTool.ts` | 文件读取有字节上限，图片从内容识别；复用现有服务结构 |

没有复制参考项目的通用 spill 插件、完整 task 服务、媒体转换或 RPC 框架。DeepSeek 超限后丢弃 spill 的处理也未照搬：本项目按已确认方案保留部分文件并注明不完整。

## 自动化验证与审查

最终测试冻结在 `7e387733`，后续提交只更新文档。以下命令退出码均为 0：

| 检查 | 结果 |
| --- | --- |
| `pnpm test:unit` | 395 个文件；4,927 项通过、2 项跳过 |
| `pnpm test:integration` | 220 个文件；2,117 项全部通过，包含 CLI 打包安装测试 |
| `pnpm test:contract` | 37 个文件；581 项全部通过 |
| `pnpm typecheck` | 通过，在完整集成测试结束后执行 |
| `pnpm lint` | 0 个错误；107 条既有警告 |
| 变更源码的 Prettier 检查 | 通过 |
| `pnpm -C packages/ohbaby-agent prompt:check`、`git diff --check` | 通过 |

集成测试使用已安装的项目指定 pnpm 9.15.0，并复用 npm 缓存。首次基线的冷缓存打包安装曾因外部 registry 请求过慢超时；最终重跑没有删测试、放宽断言或关闭签名验证，完整通过。可按下面方式复现本机环境设置，再执行 `pnpm test:integration`：

```sh
export PATH="/Users/hansun025/Library/pnpm/store/v11/links/@/pnpm/9.15.0/dabcd8222099706e9d5613e2bbde82a6ffe5e77c8ba18b78fcd77c3eac869433/bin:$PATH"
export OHBABY_PACKAGING_NPM_CACHE="/Users/hansun025/.npm"
export npm_config_prefer_offline=true
pnpm test:integration
```

这些绝对路径只是本机测试环境，不是产品运行配置。最终运行日志暂存于 `/tmp/ohbaby-backend-final-{unit,integration,contract,typecheck,lint,format}.log`。

四个实施批次分别经过独立子代理的规格与代码质量审查，均通过。最终再对 `dedbd80f..7e387733` 做整条分支审查，覆盖权限、路径边界、文件生命周期、输出完整性和绑定鉴权，未确认待修复问题。最终审查没有自行重跑测试，测试结果由主代理执行并核对。过程中发现的 scratch 符号链接、合法 `..notes` 文件名误判、短读和图片签名等问题已在最终提交前修正并加入回归。

## 留给后续验收的事项

- **T17 真实运行尚未完成**：用本机 daemon 和真实 provider 派 `generic` 子代理生成日志及超过 50 KiB 的报告，确认日志在根会话 scratch、父代理收到新报告路径并能读全文。自动化请求、SQLite、scheduler 和进程测试不能替代这项手工验收。
- 建议同时手工核对 default 模式下系统文件改写会审批、读取授权不能放行写入/Shell，以及永久删除根会话后的目录清理。自动化已覆盖这些行为，手工验收记录由后续验收会话补充。
- Files 前端、S17 浏览器验收尚未实施。文件 API 的 HTTP 测试使用真实鉴权、绑定与文件系统，以及受控后端 fixture，不声称完成了浏览器联调。
- side chat/fork 的条件场景留在各自议题，本次没有提前增加归属框架。仅在 macOS 验证，未做 Windows 实机测试。

权限规则属于模型工具与文件 API 的访问控制，不是操作系统级隔离；文件读取也不提供内容快照保证。输出写入没有新增 fsync 崩溃一致性承诺。
