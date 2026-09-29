# serve 工具等待、权限恢复和子代理可见性诊断

诊断日期：2026-09-19；源码 HEAD：`93d4482c`；对照版本：`v0.1.12`（`7cec6bac`，2026-08-30）。本次只诊断，没有修改产品实现。

## 结论与边界

已经用实际 `pnpm --filter ohbaby-cli start serve --port 0 --no-open`、真实模型、浏览器刷新和本地 HTTP 调用，复现两条「后台等待确认，前台只有 Thinking」的路径。它们在 v0.1.12 的相关代码上也失败。当前不能把这些问题归因于 v0.1.12→0.1.13 的模型协议迁移。

另有一个明确的 v0.1.13 UI 回归：`53fae946` 移除了工具状态文字和短错误自动展开。它没有让执行线程停止，但让用户更难分清工具还在运行、已完成还是已失败。

本次未复现普通消息永久丢失、普通 bash 执行死锁或所有子代理均无法派遣。两种测试模型都完成了工具和子代理链路。历史会话记录可以确定「停在哪一步」，但没有保留当时的权限事件/调度阶段，因此不能断言每个历史停顿都只有同一原因。

## 实际测试与环境

- 使用根目录 `.env` 中的凭证，只复制到权限为 0600 的临时测试配置；报告、复现 fixture 不含凭证。
- 两个独立配置/数据库，原始测试资料在 `/tmp/ohbaby-diagnosis-0919/`。
- DeepSeek：`deepseek/deepseek-v4.1-flash`，`openai-compatible`。
- GPT：`openai/gpt-5.6-luna`，`openai-responses`，medium reasoning。
- 浏览器真实操作：输入消息、工具确认、派遣子代理、运行期间发消息、刷新、再次刷新、检查最终回复。
- `start` 的脚本是 `node dist/bin.js`。核对了 CLI sourcemap 的 64 个本地源文件和 agent sourcemap 的 291 个本地源文件，均与当前源码一致。本次没有把「未重新构建」认定为根因；这也不等于对每个前端 bundle 做了全量构建校验。

| 场景 | 实际结果 |
| --- | --- |
| DeepSeek 普通 bash `printf` | 单次批准后成功，返回 `BASH_DIAG_OK` |
| DeepSeek foreground 子代理只回复一句话 | 成功，主代理收到 `CHILD_DIAG_OK` |
| 两个 background 子代理分别 sleep 15 / 2 秒后 printf | 批准受控命令后均完成，主代理查询状态并汇报 A/B 输出 |
| 上述运行期间发送后续消息 | 后端记录 queued，前一轮结束后返回 `QUEUED_DIAG_OK` |
| 主代理加载 using-superpowers 技能 | 出现权限请求；批准后返回 `SKILL_DIAG_OK` |
| 子代理 bash 待确认时刷新 | **失败：弹窗消失，任务仍 running，后台仍有权限请求** |
| GPT 主代理 bash 待确认时刷新 | **失败：首次刷新丢失弹窗；超过旧客户端保留期后再次刷新恢复弹窗** |
| GPT bash → foreground 子代理 → 排队消息 | 经诊断 API 释放原 bash 权限后，依次返回 `GPT_BASH_OK`、`GPT_CHILD_OK`、`GPT_QUEUE_OK` |
| GPT 新一轮 bash，不再刷新 | 浏览器单次批准成功，返回 `GPT_CLICK_CONTROL` |

观察限制：GPT 刷新恢复后的旧弹窗曾出现按钮点击未释放等待的现象；本轮使用正确的 JSON-RPC `respondPermission(id, {choiceId: 'allow_once'})` 释放后完成了链路。尚未为这个额外现象建立独立稳定复现，不将它混同为已经定位的两个缺陷。DeepSeek 刷新复现的清理调用曾传错响应形状，导致该测试命令被拒绝；该轮不是批准成功证据，也不是产品回归结论。

## 1. 子代理权限请求在恢复快照时丢失：已复现

真实顺序：

1. 主代理调用 foreground `subagent_run`。
2. 子代理请求执行 `printf 'CHILD_RELOAD_OK\n'`。
3. 浏览器收到实时事件，能显示 Allow once 等按钮。
4. 刷新页面，恢复同一个父会话。
5. 弹窗消失，页面仍显示 Thinking；后台仍有一条未处理的权限请求。

快照证据：

```json
{
  "backendPermissions": 1,
  "resumedPermissions": 0,
  "permissionMatchesKnownRun": false,
  "resumedStatus": "running"
}
```

原因：`permission-projection.ts:81` 使用 `getActiveRunId(info.sessionId) ?? info.callId` 构造 UI 权限的 runId。子代理没有对应的主会话 active run，于是这里装入了**工具调用 ID**。`client-view.ts:123` 的快照过滤却把它当成**运行 ID**，在 snapshot.runs 中查不到，就过滤掉该权限。

实时事件与快照的规则也不一致：`DaemonClientViewCoordinator.routeEventForClient` 对没有 sessionId 的 permission 事件会放行，所以实时弹窗可出现；恢复快照则按 runId/主会话关系过滤。这正是「开始能看到，刷新后看不到」的原因。

普通工具默认 120 秒的超时在真正执行工具时才启动，权限确认发生在这之前；不能指望该超时救回隐藏的权限等待。foreground 子代理的默认期限是两小时，父代理又在等这次工具调用结束，所以可能表现为长时间无响应。

代码锚点：

- `packages/ohbaby-agent/src/adapters/app-events/permission-projection.ts:81`
- `packages/ohbaby-server/src/coordination/client-view.ts:123`
- `packages/ohbaby-server/src/coordination/client-view.ts:483`
- `packages/ohbaby-agent/src/core/tool-scheduler/scheduler.ts:885`、`:1740`、`:745`
- `packages/ohbaby-agent/src/agents/subagent-host.ts:86`

## 2. 主代理权限在刷新时因客户端身份变化暂时被隐藏，随后不恢复：已复现

HTML 每次加载都注入新的随机 clientId；旧客户端断线后，服务端默认保留其权限归属 5000ms。新页面立即取快照时，PermissionRouter 认为权限属于旧客户端，把它过滤掉。

五秒后旧归属被清理，但清理流程没有发出让新页面恢复权限的事件；页面拿着之前的空权限列表继续显示 Thinking。GPT 的主代理 bash 场景复现了这个现象，超过五秒后再次刷新能重新看见弹窗。

最小回放结果：

```text
v0.1.12: oldPage=1 newPage=0 afterOwnerCleanup=1
HEAD:    oldPage=1 newPage=0 afterOwnerCleanup=1
```

代码锚点：

- `packages/ohbaby-server/src/app/create-app.ts:65`：断线保留期 5000ms。
- `packages/ohbaby-server/src/app/create-app.ts:2133`：HTML bootstrap 每次生成 clientId。
- `packages/ohbaby-server/src/app/create-app.ts:2254`：断线清理，不发布权限恢复事件。
- `packages/ohbaby-server/src/coordination/permission-router.ts:122`、`:167`：按旧 run owner 过滤。
- `apps/ohbaby-web/src/api/daemon/client.ts:135`：重新连接时获取快照。

## 3. 工具状态与子代理活动缺少可见性：新回归和旧缺口叠加

`53fae946`（2026-09-19 12:26，`fix(web): fine tuned session ui`）删除了 ToolCard 的 `status` / `meta={status}`，也删除了短错误的默认展开和失败后自动展开。现在正常运行与已完成卡片可以显示同样的工具名、摘要、颜色，必须展开并理解输出才能判断。

当前 SDK 的 UiSnapshot 没有独立子代理列表；Web 也没有子代理进度视图。持久化 UI 会隐藏子会话（`persistent-store.ts:287`），子代理内部工具/等待原因没有作为父会话中的子代理状态展示出来。完成的 `subagent_run` 卡片在 background 模式下只代表「派遣调用已返回」，不代表子代理工作已完成；即使恢复工具状态标签，也仍需独立的子代理状态模型。

批量工具还有等待放大：`Lifecycle` 在 `await executeToolCalls(...)` 全部返回后才逐项更新结果；`executeBatch` 先顺序处理整批权限，再运行工具。一个权限未回答，可能让同批其他工具也迟迟没有结果。这个行为不是本次版本新加的，属于需要改进的执行/展示边界，不宜仅凭「所有卡片 running」就断言所有工具都已经执行。

## 4. 历史数据库证据

只读查询了本机 `~/Library/Application Support/ohbaby/ohbaby.db`，没有修改原会话。

| 时间（台北时间） | 数据库事实 | 能说明什么 |
| --- | --- | --- |
| 19:03:33–19:09:55，「测试 Bash 命令能力」 | GPT 约 4.5 秒返回 `skill(using-superpowers)`；唯一工具最终为 aborted | 此轮尚未执行 bash，不能称为 bash 进程运行六分钟；停在技能工具阶段 |
| 19:03:46–19:05:24，「测试子代理能力」 | 唯一工具也是 `skill(using-superpowers)`，取消后 aborted | 此轮尚未调用 subagent_run |
| 18:40:51 的高校搜索批次 | 四个 background 派遣调用均 completed；一个子代理 18:45:06 completed，输出长度 6829 | 派遣和部分子代理执行确实成功；不属于「完全无法派遣」 |
| 同批主代理 18:41:05 后 | 停在一批 bash/Firecrawl 搜索工具，直到 18:47:48 取消 | 主代理当时也有自己的未结束工具，不能直接认定它在等待已完成子代理的通知 |
| 18:55:49 的 GPT 批次 | 四个 background 派遣成功；主代理查询了一次 status，18:56:00 后停在 mcp_resource；子代理有未结束 Firecrawl 工具 | 停点已定位到具体工具；缺少当时的 permission/queue/execution 阶段事件，不能仅凭 running 分辨权限等待、排队还是远端执行 |
| 19:10:29 恢复后 | run_ledger 已 interrupted，但四条 subagent_instance 仍 running | 存在状态恢复不一致的历史证据；未在本次另建进程重启复现，不能断言仍有四个进程实际运行 |

另有 18:49、18:54 的 provider timeout / connection error 记录。这只证明这些单独请求曾失败，不能据此解释全部卡住，更不能推断用户当前网络有问题。

## 5. 引入时间：确定到什么程度

| 问题 | Git 证据 | 结论强度 |
| --- | --- | --- |
| 工具状态文字、短错误展开消失 | `53fae946`，2026-09-19 | **明确的新 UI 回归**，删除内容可直接从 diff 确认 |
| 客户端权限归属过滤 | `a72c6d46`，2026-06-12 | 过滤机制的引入提交，不单独等同完整刷新 bug 的首次出现 |
| 快照按 runId→session 过滤权限 | `89f45013`，2026-06-18 | 子代理恢复缺陷的关键旧代码来源 |
| 断线延迟清理 | `927c04c1`，2026-06-18 | 主代理刷新缺陷的另一旧组件 |
| Web HTML 随机 clientId | `0c70fbe7`，2026-06-21 | 刷新后身份变化的引入提交，与前两项组合产生缺口 |
| 当前子代理权限 runId fallback | `7157ba4a`，2026-07-12 | 当前相关写法的来源；旧版本也有类似 fallback，不能只把责任归给此提交 |
| 默认子代理两小时期限 | `fdef1ddc`，2026-07-10 | 放大隐藏等待的旧默认值 |

两个最小回放都实际跑过 v0.1.12 与 HEAD 的生产类代码，均失败。这里没有宣称完成全仓逐提交 bisect；能够确定的是：权限恢复缺陷**最迟在 v0.1.12 已存在**，UI 状态丢失则明确发生在本次 v0.1.13 改动期间。不能把九月的 native replay / reasoning 迁移笼统列为根因。

## 6. 建议修复顺序

1. **先修权限身份与恢复。** 权限结构显式携带 sessionId、父 sessionId、runId、contextScopeId、callId；不再把 callId 装成 runId。快照与实时事件使用同一份父子归属规则，保证子代理请求在父会话可见且可回答，同时维持会话隔离。
2. **修同一浏览器页刷新后的客户端恢复。** 使用有明确作用域的可恢复页面身份，或提供受控的归属接管机制；旧身份到期时发送重新同步/权限归属变化事件。不能为了修复而直接取消所有客户端隔离，也不能自动批准隐藏请求。
3. **恢复准确的状态展示。** 恢复工具 pending/running/completed/failed 等标签、可见错误；将 Thinking 区分为模型生成、等待权限、工具排队、工具执行、等待子代理。状态必须来自实际调度阶段。
4. **按你的方向增加子代理视图。** 展示角色、任务摘要、当前阶段/工具、最近进展时间、等待原因、完成/失败摘要；允许进入详情或停止指定子代理。后台派遣的工具完成与子代理任务完成要分别显示。
5. **补充等待与完成交付机制。** foreground 批次允许逐项持久化/推送已完成结果；background 提供 completion 事件、有限等待/唤醒接口，避免模型用 bash sleep 自行轮询。权限等待显示明确提示；执行/排队超时分别管理，避免把等待批准误报成网络故障。重启恢复时核对子代理表与 run ledger，清理陈旧 running 状态。
6. **补上跨层回归测试与诊断字段。** 核心用例包括主/子代理等待权限时刷新、断线重连、切换会话、多个客户端、同批快慢工具、取消和重启。日志只记 request/run/call/scope ID、阶段、耗时和结果码，不记录密钥或完整输入。

优先完成 1–3，再做子代理面板；否则新增面板仍会展示错误或陈旧的状态。

## 7. 可运行证据与已有测试缺口

在仓库根目录运行以下脚本。它们从本次真实快照的最小 fixture 回放生产代码，无需 API key、无需启动服务，约一秒完成。当前退出码为 1，表示已确认缺陷仍存在，不是修复验收通过。

```sh
pnpm exec tsx .ohbaby/diagnostics/2026-09-19-stalled-tools/check-projection.mts
pnpm exec tsx .ohbaby/diagnostics/2026-09-19-stalled-tools/check-reload-owner.mts
```

该目录在 `.ohbaby` 下，是明确标记的本地诊断资料，不进入产品代码。保留了 `child-permission-fixture.json`、`primary-permission-fixture.json`；生成的旧版本临时模块已自动删除。

本次现有测试结果：

- bash 调度、goal/subagent 生命周期、context 并发：3 文件，18 项通过。
- permission router、client view、permission projection：3 文件，31 项通过。

共 49 项通过，但两个真实组合场景仍然失败。已有单元测试验证了局部过滤/归属行为，没有覆盖「真实子代理权限信息→父会话快照→浏览器刷新」和「随机新 clientId→旧 owner 保留期→页面自动恢复」的完整契约。
