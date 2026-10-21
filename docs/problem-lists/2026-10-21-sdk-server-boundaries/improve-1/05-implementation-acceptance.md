# 5. 实施与验收记录

2026-10-21。分支：`codex/sdk-server-boundaries`；基线：`7bc75168`；代码验收提交：`d78fc65f`。

四个阶段已实现并分批提交，尚未合并或推送，等待用户审查。常规测试、构建及真实 Web/TUI 冒烟通过。额外运行的 server E2E 有一项失败，改动前的基线也有同样失败，详见 §5.4。因此不能把本轮结果表述为“全部 E2E 通过”。

## 5.1 提交与实现

| 阶段 | 提交 | 结果 |
|---|---|---|
| 规划 | `3c6ed4cc` | 保存方案与验收标准 |
| Stage 1 | `cc15cb73` | SDK 按职责分目录，`rpc/` 改为 `in-process-rpc/`；271 个导出保持不变 |
| Stage 2 | `f6bcfb5b` | SDK 统一定义 `DaemonStartupIntent`，三端引用；新增 1 个导出 |
| Stage 1b | `cb0e2ed9` | command-record 源码及单测移回 agent，SDK 移除 12 个导出；agent 仅公开 server 需要的 3 个类型 |
| Stage 3 | `d78fc65f` | 拆出 OpenAPI、SSE 生命周期、静态资源、请求 helper 和 8 个业务路由模块；`create-app.ts` 缩减至 396 行 |

Stage 1b 在 Stage 3 提交前完成。`command-record.ts` 和 `command-record.unit.test.ts` 搬移前后内容逐字节一致，类型名未改变；消费者只调整导入，测试断言未改。agent 根入口用 `export type` 导出 `UiCommandCorrelation`、`UiCommandRecord`、`UiCommandRecorder`，三个函数仍是内部实现。

整轮 SDK 导出从 271 个变为 260 个：只新增 `DaemonStartupIntent`，只移除 04 S1-1 列出的 12 个名字，没有其他差异。这是本轮明确允许的公开 API 调整；外部消费者如使用被移除的名字，需要迁移，不能假定 agent 根入口重新导出了全部名字。

Stage 3 保留原路由顺序、鉴权、错误处理与清理顺序。`permissionEpoch` 经 getter 读取，集合仍共享原引用，没有新增跨工作区状态管理。相关 SDK、agent、server 和 Hono 文档已同步。本轮未实施 LLM 抽包、settings 或 Web UI 改版，也未纳入用户另行编写的 LLM 规划文档。

## 5.2 对照 04 的检查结果

| 用例 | 结果与证据 |
|---|---|
| S1-1 | 用 TypeScript compiler API 解析真实导出，整轮差异仅为上述 1 项新增、12 项移除 |
| S1-2、S1-3 | 旧 RPC 导入和 contract 的禁止依赖检索均无命中 |
| S1-4 | SDK 定向测试 184 项通过，包含进程内 RPC 单测 |
| S1b-1、S1b-2 | SDK 无 command-record 残留；相关消费仅在 agent/server；server 不再从 SDK 引入命令记录类型 |
| S1b-3 | 搬移单测及 gateway、recorder、core-api、in-process adapter、create-app 共 6 个文件、321 项测试通过 |
| S2-1、S2-2 | 启动意图只保留一份约定类型定义；server 类型转导出可编译，40 个公开导出保持一致 |
| S2-3、S2-4 | Web 连同依赖构建通过；启动意图相关定向测试 89 项及 CLI daemon 集成测试 2 项通过 |
| S3-1 | 相对 Stage 1b，四个受保护测试文件哈希不变；相关测试通过。整轮只在 Stage 1b 修改 create-app 单测的类型导入 |
| S3-2、S3-3 | 实例化 Hono app 后比对 49 条有序路由完全一致，最后一条为 `GET /*`；`/doc` 的 26 个 OpenAPI 路径及完整 JSON 一致 |
| S3-4 | daemon 的 SSE 重放、过期、清理、重叠连接集成测试通过；Web 完成空闲状态断网恢复及刷新检查。未手工验证断网期间持续生成事件的场景，不能以空闲断网代替该场景 |
| S3-5 | `create-app.ts` 为 396 行，只直接注册 `GET /`、`GET /*` 两条静态资源路由 |
| S3-6、S3-7 | Web 协议模块无 `InstanceStore`，protocols 无反向引用 app |

补充检查对路由注册、搬移函数、OpenAPI、SSE、RPC 分发及生命周期做了 114 项 token 级结构对比。除明确的访问路径替换和格式整理外保持一致；47 条有序路由挂载语句及其中的注册循环保持一致。

## 5.3 测试与实际操作

| 检查 | 实际结果 |
|---|---|
| `pnpm test --no-file-parallelism` | 各阶段均通过；Stage 3 最后一次全量为 577 个文件通过、6 个跳过，6831 项测试通过、17 项跳过，耗时约 537 秒 |
| Stage 3 server/Web 定向回归 | 47 个文件、573 项通过；最后整理 import 后再次通过 |
| CLI daemon 回归 | 2 项通过 |
| `pnpm format:check`、`pnpm lint`、`pnpm typecheck` | 分别通过；lint 有 122 条警告、0 个错误 |
| `pnpm build` | 通过；打包 CLI 的 `--version` 输出 `0.1.16` |
| 独立 server E2E | 5 项通过、4 项跳过、1 项失败；基线结果相同，见 §5.4 |
| 编译产物 Web E2E | 实际浏览器交互和后端验收均通过，见下文 |
| 编译产物 TUI 冒烟 | 实际 PTY 中连接 daemon、提交提示词、收到回复、退出并用 `--continue` 恢复历史，均通过 |

`preflight` 包含的五项命令分别执行并通过，没有额外重复执行整条 `pnpm run preflight`。常规 `pnpm test` 不包含上述独立 E2E，两个结果分开记录。未运行需要真实模型的付费 E2E。构建仍有 bundle 大小提示，没有因此修改打包方案。

Web 使用 `node scripts/run-compiled-web-e2e.mjs` 启动编译后的 daemon 和静态资源，浏览器实际完成以下操作：发送读取 `fixture.txt` 的请求，展开工具面板确认执行结束和文件内容，追加消息，刷新后确认会话不变、两轮回复各出现一次且内部运行时标记不显示。空闲时断网约 2.5 秒后恢复，已有内容未丢失或重复。后端验收确认 session key 稳定、工具结果被消费，退出后进程和端口均释放。断网时出现预期的网络请求错误。

TUI 使用编译后的 CLI 和 HTTP daemon，模型由本地 fixture 提供；真实 PTY 中观察到 `BOUNDARIES_TUI_PROMPT` 和 `BOUNDARIES_TUI_OK`，重启后历史仍在，两次退出码均为 0，daemon 已停止。

04 §4.5 中权限请求、子代理对话的浏览器手工操作本轮未另行执行；对应后端行为由现有测试和结构比对覆盖。不能将这些自动检查记成手工确认。

## 5.4 既有 E2E 失败

复现命令：

```bash
OHBABY_RUN_GOAL_REAL_E2E=0 OHBABY_RUN_IDLE_REAL_E2E=0 pnpm exec vitest run --config vitest.e2e.config.ts packages/ohbaby-server/src/runtime/daemon/goal-execution.e2e.test.ts packages/ohbaby-server/src/runtime/daemon/model-idle.e2e.test.ts --no-file-parallelism
```

`goal-execution.e2e.test.ts:322` 期望最后一条 user 消息包含 `<untrusted_objective>`，实际取到了后面的 `<system-reminder>`。子代理在独立临时 worktree 的原始基线 `7bc75168` 运行相同命令，得到同一用例、同一断言失败；基线 worktree 已清理。

检查请求后确认：目标正文仍在请求里，后面另有一条携带环境提示的 user 消息。测试中的 `lastUserText()` 直接取最后一条 user 消息，与当前 serializer 分离环境提示的格式不一致。该用例后续还有依赖旧格式的断言，需要作为测试维护单独处理。本轮没有为消除失败而修改运行时或放宽测试，也不将该用例计为通过。

## 5.5 子代理复审与证据

各阶段均由独立子代理检查方案符合性与代码质量，最终均通过。Stage 1b 复审发现 SDK 文档仍有命令记录归属的旧描述，修正后已复审。Stage 3 复审确认状态引用、路由顺序、SSE 清理和依赖方向没有新增问题。

整分支复审范围为 `7bc75168..d78fc65f`，结果为 Standards PASS、Spec PASS，无新增发现。E2E 基线调查由另一个子代理独立完成，结论见上节。复审通过不代表 §5.3 中未手工执行的操作已经覆盖。

随文保存的证据：

- [当前分支 server E2E 日志](evidence/2026-10-21/server-e2e-current.log)、[基线日志](evidence/2026-10-21/server-e2e-baseline.log)。
- [编译产物 Web 验收日志](evidence/2026-10-21/compiled-web.log)、[浏览器观察记录](evidence/2026-10-21/browser-observations.json)。
- [真实 PTY TUI 观察记录](evidence/2026-10-21/tui-observations.json)。

完整阶段测试日志、导出清单、路由快照及临时结构比对脚本保存在本机 `/tmp/ohbaby-sdk-server-boundaries-20261021/`，不作为长期留存保证。本轮没有引入额外生产抽象或为单纯搬移增加镜像测试。
