# 4. 测试与验收标准

## 4.1 测试策略

本批采用三层证据，任何一层都不能单独替代另外两层：

| 层级 | 证明什么 | 关键约束 |
| --- | --- | --- |
| unit/contract | recorder 必须显式 sink、默认 diagnostic 静默、队列/fail-open/显式注入合同不退化 | 新行为先红后绿 |
| composition | Agent/Server 在 production/test/development 的默认 policy 一致，显式 recorder 仍有效 | 不通过共享对象身份做假证明 |
| process/E2E | 真正的 Node 进程、stdout/stderr、dispose 尾部和用户 surface 干净 | `NODE_ENV=production`、清除 `OHBABY_DEBUG`、隔离环境 |

外部模型 API 不属于本 Bug。E2E 使用可控本地依赖或只执行不需要模型的 slash command，避免网络与账号状态导致不稳定。

## 4.2 TDD 顺序

1. 先修改/新增回归测试，不改产品实现。
2. 运行最小集合，记录旧实现至少在以下命题上失败：缺 sink 未 fail-fast、默认 sink failure 写 stderr、production composition 输出 command JSON、真实子进程 stream 污染。
3. 实施 Phase A，跑 recorder 单测和 lint。
4. 实施 Phase B，跑 Agent/Server composition 与既有 command gateway 合同测试。
5. 实施 Phase C，跑 process、TUI/Web/E2E、全量验证。

## 4.3 Phase A：recorder 用例

| ID | 场景 | 类型 | 预期 |
| --- | --- | --- | --- |
| T-A1 | 公开 factory 缺 sink | unit | 调用时抛清晰 `TypeError`；stdout/stderr 都无写入 |
| T-A2 | 显式 async sink | unit | started/completed 按 FIFO 到达，`flush()` 等待完成 |
| T-A3 | capacity 满 | unit | 保持既有有界/fail-open 行为，不引入 terminal I/O |
| T-A4 | sink reject，未传 diagnostic | unit | `record()`/`flush()` 不破坏业务；stdout/stderr 静默 |
| T-A5 | sink reject，显式 diagnostic | unit | 只调用注入回调，错误对象保留 |
| T-A6 | diagnostic 自身抛错 | unit | 不逃逸到业务命令 |
| T-A7 | 隐式 I/O lint 门 | lint | `command-recorder.ts` 出现 `process.stdout` 或 `process.stderr` 时 lint 失败 |

## 4.4 Phase B：Agent host 用例

| ID | 场景 | 类型 | 预期 |
| --- | --- | --- | --- |
| T-B1 | recorder undefined | unit/composition | 使用本地 no-op，不创建 structured recorder |
| T-B2 | recorder false | unit/composition | 与 undefined 等价 |
| T-B3 | 显式 recorder | contract | started/completed、operationId、correlation、details 保持现有合同 |
| T-B4 | 显式 recorder reject | contract | 命令结果成功；stdout/stderr 无 `ui.command.observation.failure` |
| T-B5 | host dispose | unit | 不调用注入对象的非端口 flush；其他资源释放顺序不变 |
| T-B6 | 环境一致性 | unit | production/test/development 不改变 undefined/false policy |
| T-B7 | process 默认静默 | integration（必需） | 子进程 command + dispose 后 stdout/stderr 均不含 `ui.command.` |

## 4.5 Phase B：Server 用例

| ID | 场景 | 类型 | 预期 |
| --- | --- | --- | --- |
| T-C1 | recorder undefined/false | unit/composition | REST/RPC gateway 使用 Server 本地 no-op |
| T-C2 | 显式 recorder | contract | 现有 REST/RPC command record 合同不变 |
| T-C3 | 显式 recorder reject | contract | HTTP/RPC 业务成功，stdout/stderr 无 command diagnostic |
| T-C4 | app dispose | unit | 不 flush 外部注入 recorder；其他 teardown 不变 |
| T-C5 | 多 scope | integration | scope/session 隔离不变且默认无 record I/O |
| T-C6 | 环境一致性 | unit | NODE_ENV 不改变默认 no-op |
| T-C7 | cleanup reporter | focused regression | 无关 `reportInteractionCleanupFailure()` 行为不被误删 |
| T-C8 | 真实 serve 进程默认静默 | integration（必需） | CLI `serve` 完成 RPC command + shutdown + close 后，stdout/stderr 均不含 `ui.command.` |

## 4.6 进程级回归合同

`tests/integration/cli/command-record-terminal.integration.test.ts` 必须包含两条真实 production 子进程路径：

1. in-process 路径从构建后 Agent 产物执行 `buildCoreAPIImpl()` → `executeCommand()` → `dispose()`；
2. serve 路径从构建后 CLI 产物启动 `ohbaby serve`，通过带 workspace 与 auth 的 HTTP/RPC 调用执行 `/status`，再通过 shutdown endpoint 正常停止；
3. 两条路径都显式设置 `NODE_ENV=production`，并从 env 删除 `OHBABY_DEBUG`；
4. 将 HOME、USERPROFILE、APPDATA、LOCALAPPDATA、XDG 目录、`OHBABY_HOME`、`OHBABY_DB_PATH`、`OHBABY_STORAGE_ROOT`、cwd 与 model 配置全部指向临时根，不读写用户真实数据；
5. 父进程同时捕获完整 stdout/stderr，等待 `close` 而不是只等一次微任务；
6. 断言业务调用成功、退出码为 0，且两个 stream 都不包含稳定的 `ui.command.` 记录类型标识；
7. 清理临时目录。

这两条用例必须在旧实现上失败，并分别覆盖 Agent dispose 与 Server shutdown 的尾部输出。不得降级为可选测试，也不得用 `NODE_ENV=test` 替代。

## 4.7 TUI 与 Web 真实验收

### in-process TUI

1. 用隔离 HOME/cwd 启动当前构建的 `ohbaby` TUI。
2. 连续执行不依赖外部模型的 slash command，例如 `/status`、`/skills`。
3. 操作过程中观察输入框、overlay、历史区。
4. 退出 TUI 并继续观察终端尾部。
5. stdout/stderr 都不得出现 `ui.command.record`、`ui.command.observation.failure` 或 raw `{"record":...}`。
6. slash command 的正常 UI 结果、键盘节奏和退出行为不退化。

### `ohbaby serve` Web

1. 用隔离 HOME/cwd 启动当前构建的 `ohbaby serve`，捕获 daemon stdout/stderr。
2. 启动期间、Web client 连接后、执行命令后分别检查 stream。
3. 通过 Web UI 执行至少一个不依赖外部模型的命令路径；验证 HTTP/RPC 业务结果。
4. 正常停止 Server，继续检查 dispose 尾部。
5. 全过程不得出现 `ui.command.*` JSON；正常启动/错误等产品输出不在本断言中一概禁止。

### E2E

- 运行仓库现有与 CLI/TUI/Server 相关的 E2E/integration suites。
- 对本 Bug 新增的 process integration 作为必需项。
- 如果真实 PTY 自动化受工具能力限制，必须记录具体限制，并用隔离子进程 + 已有 TUI harness 补齐；不能只写“人工看过”。

## 4.8 全量回归清单

- `pnpm lint`
- recorder、Agent host、Server app 目标单测
- command gateway / command record 既有 contract tests
- 新增 process integration
- CLI/TUI/Server 相关 integration/E2E
- `pnpm test`
- `pnpm typecheck`
- `pnpm build`

具体命令以仓库 scripts 和 workspace filter 为准；实施记录中必须列出实际运行命令、结果与任何环境限制。

## 4.9 验收标准

| 发布门 | 通过条件 | 证据 |
| --- | --- | --- |
| 默认终端静默 | TUI 与 serve 操作中、dispose/shutdown 后均无 `ui.command.*` | T-B7 + T-C8 + 真实 surface |
| structured recorder 无隐式 I/O | sink 必填，默认 diagnostic 静默，源码 lint 保护 | T-A1/A4/A7 |
| 默认 policy 环境无关 | undefined/false 在 production/test/development 均 no-op | T-B1/B2/B6 + T-C1/C6 |
| 显式集成能力保留 | 显式 recorder 仍收到完整 record，失败不影响业务 | T-A2/A5/A6 + T-B3/B4 + T-C2/C3 |
| 生命周期清晰 | host/server 不 flush 外部 recorder，权威文档说明 caller-owned | T-B5/T-C4 + docs |
| 回归面受控 | lint/test/typecheck/build 全绿；cleanup reporter 等无关行为未误伤 | 全量回归 |
| 独立审查 | 子代理无未解决的 P0/P1/P2；有效发现已修复并复验 | 审查记录 |

## 4.10 对抗性审查要点

1. 是否只是把 stdout 换成 stderr？——两个 stream 都断言。
2. 是否仍在 `NODE_ENV=test` 下假绿？——子进程强制 production。
3. 是否宿主 `OHBABY_DEBUG` 污染测试？——子进程明确删除。
4. 是否只等待一轮微任务漏掉 late flush？——父进程等待 close，子进程执行 dispose。
5. 是否从 TUI 层过滤表象？——产品改动应集中在 recorder/composition；TUI 无过滤 patch。
6. 是否为测试增加无收益公共 API？——SDK 不新增共享 no-op。
7. 是否增加无调用方配置？——Agent/Server options 无新增 diagnostic 字段。
8. 是否误删 Server 其他 stderr？——只删除 command observation reporter，保留 cleanup reporter。
9. 是否破坏显式 recorder 的 record 合同？——保留既有 contract tests。
10. 是否把“无内部调用方”误当作公开 API 可随意删除？——factory 保持导出，breaking 仅为 sink 必填并有迁移说明。
