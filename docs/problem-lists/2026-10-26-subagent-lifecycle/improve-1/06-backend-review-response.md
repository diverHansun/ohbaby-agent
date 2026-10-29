# 后端修复与交接（2026-10-29）

本记录由 Codex 撰写，对应 Claude 的 improve-1/05 和 improve-2/05。它记录实现、证据和待复验边界，不替代 Claude 的验收结论。本轮沿用 `subagent/backend`，只改 agent、SDK、server 和权威文档；前端由 Claude 实施。

## improve-1 审查意见的处理

| 项 | 处理与证据 |
| --- | --- |
| 1 sandbox release 失败 | 保留 `unconfirmed`，修正误导注释，新增真实 `SandboxManager` 与 `ShellJobRegistry` 的失败测试。详见下节；未把释放失败当成功。 |
| 2 Goal 预算阻断普通唤醒 | 按实际 Goal 所属 root run 筛选候选结果/监督。普通后台工作继续；超预算 Goal 的旧结果不会混入普通自动轮次，手动用户轮次仍可读取。真实 in-process 测试覆盖普通结果和普通监督两条路径。 |
| 3 临时表泄漏 | Host 的 root/parent 取消屏障只保留到相关准入及执行收尾；删除未处理消息的内存缓存，改读持久输入。监督器审批集合每次替换为当前集合。测试检查 16 张 Host 临时表归零。 |
| 4 monitor 原文 | 附上未处理输入的原文、关闭时间和原因，共用原有 16 KiB 输出预算，保留截断标志；SQLite 与单元测试覆盖 closed 历史。 |
| 5 监督器扫描 | 周期核对只覆盖仍有后台执行的会话，其他状态靠事件/显式 observe。准入阶段的临时读取/领取错误单独按 5/10/20 秒有界退避，成功或耗尽后停止；已 claim 的结果不重启模型轮次。保留漏终态事件与准入恢复测试。 |
| 6 runtimeInput | 原 `MessageManager.prepareMessage` 已补来源标记，未证实消息实际被当作用户输入；仍抽出 `buildRuntimeInputMessage`，composition、coordinator、输入通道共用，增加输入边界断言。 |
| 7 旧排队项 | 保留原文，以 `closedAt`/`closeReason` 关闭并归档；恢复不会重播，也不会重复修改已关闭记录。 |
| 8 死代码 | 删除 `appendPendingQueue`、旧 `status`/`recoverInterrupted` 及无消费者的 artifact 回调；启动入口收为必需 execution 的参数对象。有效测试迁移到当前 list/store/Host 行为。 |
| 9 Web 派遣行 | 交由 Claude 在 improve-3/4 修复：拒绝的 spawn 不显示派遣行，启动执行的 send 使用正确标题。本轮遵照用户指示未改 Web/TUI 文件。 |
| 10 常量 | 集中六个执行名额与三十分钟上限，工具提示和 Host 共用。 |
| 11 调度器特判 | 改成受信任的 ToolAdmission 能力；通用 scheduler 不再按 bash 名称和模型参数授予后台清理豁免。 |
| 12 唤醒逻辑 | 移入现有 `ui-inprocess/subagent-wakeup.ts`，仍经过原 SessionExecutionGate 和 Goal admission。 |
| 13 重复代码 | 合并 requester 校验、结果来源 ID 构造/解析、清理状态类型、Goal 预算与归属判断。 |
| 14 布尔参数 | Goal 私有停止/暂停方法改用选项对象。 |

### 第 1 项为什么不能直接归还名额

`SandboxManager` 的 lease release 是一次性的引用释放。它在等待 adapter 的物理 destroy 前，已经标记该引用为已释放。如果 destroy reject，再调用同一个 release 会直接完成，并不会再执行 destroy。把第二次调用的完成当成物理清理证据，会错误归还仍未确认回收的资源名额。

`tools/shell-job-cleanup.unit.test.ts` 中的真实 SandboxManager 用例验证了：进程已退出、adapter destroy 失败、再次调用 release 不重试 destroy，registry 的 cleanup 仍是 `unconfirmed`。因此本轮保留名额直到获得真实清理证据，未引入新的 sandbox 重试/恢复框架。**适配器销毁失败后可能持续占用名额这一限制仍存在**，这是按 05 复验门槛给出的有证据不修理由，需 Claude 复验确认。

## 补齐的测试证据

路径均相对仓库根；描述可在对应文件内搜索。

| 验收项 | 证据 |
| --- | --- |
| A01、A02、A06、A09 | `agents/subagent-execution.integration.test.ts`：前后台混合六槽、两个主会话共十二执行、部分启动拒绝、满额 idle send、单独 stop 不影响兄弟。真实 UI stop 另见 `adapters/ui-inprocess/subagent-instance-control.integration.test.ts`。 |
| A03 | 同 Host 集成：真实 ShellJobRegistry 的自然完成归还名额、旧 execution 禁止新 shell、close 回收实例全部 shell，并保留兄弟资源。 |
| A04 | 同 Host 集成：旧调用的 abort 与重复迟到清理不能归还更新 execution 的名额；物理清理未确认前不能还名额。 |
| A05 | `subagent-instance-control.integration.test.ts`：父 prompt 已 succeeded 后，后台 child 新建 bash 审批，授权后执行成功。 |
| A08 | Host 的 failed/timed_out/主 UI stop 参数化测试，以及 stop 未消费消息原文/no replay；`agents/subagents/monitor.unit.test.ts` 和 `monitor.integration.test.ts` 验证原文、原因、预算及只读。 |
| A10 | Host 集成：临时表归零、重建 Host 后旧实例 ID 可续跑、closed ID 保持终态。 |
| A11 | `core/system-prompt/__tests__/prompt-assets.unit.test.ts` 和 `tools/subagent.unit.test.ts`：D41/D43/D47/D48 及旧名字/旧等待说法消失。 |
| A13 | `subagent-supervision.integration.test.ts`：用户输入、到期监督、两个终态结果竞争真实执行门，活动主执行始终最多一个。 |
| A19 | 同监督集成：Stop 禁止旧 timer；新结果和新用户输入分别恢复工作，后续重新从两分钟计时。 |
| A20b | 同监督集成：持续真实 read 工具进度，2/7/12 分钟监督后停；Host 30 分钟超时交付结果；真实审批等待 35 分钟不计入执行预算。 |
| A22 | Host、memory/SQLite store、execution-recovery 测试：旧队列关闭留档、恢复通知只一次、已完成父轮次仍允许后台执行；A05 同时覆盖跨父轮次存活。真实 instance-control 集成注入 child 的终态持久化失败，父 prompt 已 succeeded 仍向客户端发出错误 notice。 |
| A23 | Host 集成：运行中 send 保持捕获的模型；idle send 读取新的会话模型。原 wake/resolveRunModel 回归保留。 |
| A24 | 原 Web/TUI 新旧工具兼容测试保留；本轮重新运行 smoke 与 compiled-web 流程，最终结果见验证记录。第 9 项视觉修复交由 Claude。 |

## improve-2 后端交接

- B1：SDK 快照提供 `runtimeEpoch`、`bindingGeneration?`、按主会话递增的 `revision`、`complete: true`。`UiQueryClient`、`UiCommandClient` 与 `UiEvent` 已接类型。SDK 的 `createSubagentInstanceReader` 只安装完整且更新的同绑定快照，失败保留旧列表，换会话及重叠响应有 generation/abort 防护。
- B1：实例枚举不使用执行历史默认五十条限制；close 由 instance store 提交后订阅触发失效，执行、审批、收尾及未处理输入变化复用现有 UiEvent。首次读取期间的输入变化也有回归测试，防止同 revision 内容不同。
- B2：in-process、持久 client、JSON-RPC、远程 SDK 与 HTTP 共用 Host stop。请求必须带 `expectedExecutionId`；不调用主会话 abort；旧身份返回实际状态。`accepted` 表示已受理，`settling` 持续到真实清理确认。
- 远程 SDK 的两个新方法在等待 HTTP headers/body 时均保留 `AbortError`，取消读取不会被误报为断网或无效 JSON。
- B3：沿用详情 anchor、watch、revision、分页；close 立即释放投影并返回 `SUBAGENT_CLOSED`，SDK 终止读取并释放 watch。主模型 monitor 历史和 CLI 旧 execution reader 保留。
- 语义：详情标题当前状态取实例快照；pending/cancelled 的分组由前端决定。缺失或外部实例为 `SUBAGENT_NOT_FOUND`；传输绑定变化复用 `SESSION_SCOPE_CHANGED`；closed 为终态 UI 错误。

HTTP 接口：

```text
GET  /v1/sessions/:id/subagent-instances
POST /v1/sessions/:id/subagents/:subagentId/stop
```

查询带现有 runtime/binding 信息；stop body 另带 `expectedExecutionId`。JSON-RPC 方法为 `listSubagentInstances` 和 `stopSubagent`。接口均使用现有认证及 selected-root 校验。

**Claude 仍需处理前端 glue**：`apps/ohbaby-web/src/api/daemon/client.ts` 的新方法及 UI 接线由前端批次添加。本轮未修改该文件。后端没有新建面板服务或保存 Tab 布局。

| 验收项 | 对应测试 |
| --- | --- |
| I2-01 | `subagent-instances.integration.test.ts`：61 实例、同实例跨五个 root run 仅一行；SDK instance-reader 的失败/乱序/换会话用例。真实 stop 测试验证 settling、审批与回执状态。 |
| I2-02 | 实例列表 close 无 execution 事件仍失效；running/completed 详情关闭、读取中 close、防旧响应复活；真实 UI close 后 monitor 可读。 |
| I2-03 | `subagent-instance-control.integration.test.ts`：idle 与 foreground stop、旧身份、延迟真实资源释放；server `session-recovery.integration.test.ts` 验证 REST/RPC、跨 root、closed 错误。 |
| I2-04 | 原 conversation/history 的 anchor、跨执行分页、稳定标题、实时 scoped 消息测试保留。 |
| I2-05 | conversation 与 SDK reader 的 watch 释放、换会话、迟到响应、close 后不重连测试；取消仅停止读取。 |
| I2-06 | 原 `subagent-views.integration.test.ts` 与 SDK `subagent-reader.unit.test.ts` 通过；CLI execution reader 未删除。 |

## 权威文档与文件保护

已补回 `docs/agents/dfd-interface.md` 的 claim/finishRun CAS、primary `IS NULL` 范围、reset 顺序与 scope 锁；补回 context-isolation 的不继承父 memory 和 finally/finalization 清理；恢复 architecture 的禁止依赖方向。Goal 归属仅存在当前进程及其预算隔离边界也已说明。

本轮开始时将 Claude 的 14 份规划/验收文件备份到 `/tmp/ohbaby-lifecycle-docs-20261029-110007/` 并保存 SHA256 清单。确认 14 份内容未变后，已单独提交保存这份文档基线。未改 README、00、01–04 或任何 05；本文件只记录 Codex 的修复回复。

## 子代理交叉复审

三名子代理分别复审其他实施者负责的代码：B1/B2 快照与传输、Host/持久 store/monitor/B3、Goal/监督/唤醒。发现并修复三项 P2，全部有先红后绿及复审确认：首次快照输入变化未增 revision、远程取消语义丢失、最后一个结果准入瞬时失败后不再恢复。最终未发现其余可复现的 P1/P2。第 1 项的物理销毁失败边界单独保留，未冒充已经修复。

## 最终验证记录

| 检查 | 实际结果 |
| --- | --- |
| `pnpm test` | 640 文件通过、6 文件跳过；7484 项通过、17 项跳过，0 失败。包含 CLI 打包安装、实际进程、现有 Web/TUI 回归。日志 `/tmp/ohbaby-backend-final-tests2.log`。 |
| `pnpm lint` | 0 errors、110 warnings；提交钩子重复检查通过。保留原有返回类型等 warning，不扩展到前端整理。 |
| `pnpm typecheck` | 通过；最终生产代码的提交钩子再次通过。构建与 typecheck 串行执行。 |
| `pnpm build` | 最终代码构建通过，含 CLI 打包及 Web 静态资源。日志 `/tmp/ohbaby-backend-final-build.log`。 |
| `pnpm test:smoke` | 命令正常退出；4 文件、12 项全部因真实服务条件未启用而跳过，不能据此声称真实 provider 已通过。 |
| compiled-web | 先完成 `pnpm build`，再执行 `node scripts/run-compiled-web-e2e.mjs`，与项目脚本相同步骤。实际浏览器 E01–E05、后台 3 次请求、工具结果消费、稳定 cache key、消息刷新去重、PID/端口释放与 diagnostics 均 PASS，退出码 0。 |
| 格式与改动检查 | 本轮 71 个 TypeScript 文件 Prettier 检查通过，`git diff --check` 通过；本轮相对 `3d704ffc` 的 `apps/` 与 `packages/ohbaby-cli/` 文件改动为零。 |

浏览器截图保存在 `/Users/hansun025/.codex/visualizations/2026/10/29/01a18540-7825-7d60-b25c-dc273956a70c/backend-review-compiled-web.png`。测试使用独立临时工作区和本地 scripted model，不依赖线上模型凭据。

## 本地提交与复验入口

| 提交 | 内容 |
| --- | --- |
| `1eb981d3` | improve-2 类型反馈：快照版本、client/event 类型接入与语义 |
| `25534107` | 原样保存 Claude 的 14 份规划/验收稿 |
| `c990b0ee` | lifecycle 资源、持久输入、监督与 Goal 底层修复及回归 |
| `4ed9f980` | 实例快照、stop、详情关闭、SDK/server 通道与真实组合测试 |

本记录与权威文档补充另作最后一个文档提交。未 merge、未 push；停在 `subagent/backend` 供 Claude 重新验收。复验重点是第 1 项物理销毁失败的保留边界，其余后端修复和 improve-2 实现均已完成本地测试与交叉复审。
