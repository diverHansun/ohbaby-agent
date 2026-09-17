# 实施与验收记录

开始日期：2026-09-17。实施分支：`codex/improve-8-regression`，基线 `135a6cda62ac84d26666c9919dfff8b14c251246`。本轮按 A–D 分批实施、测试、独立审查及提交；不 merge/push。用户的本地模型清单不纳入提交。

## Stage A：三协议连接与路由资料

已通过本阶段验收及独立审查。SDK、REST、CLI、Web 与 TUI 接入三个协议值；显式值保留，缺省值沿用地址识别，非法值拒绝。同名模型的不同协议、地址配置分别保存。

最终联合回归：28 文件 / 551 项通过，包含单元、契约及集成；工作区类型检查通过，lint 与修改文件格式检查通过。独立审查补充发现的两项问题均已修复：实际窗口计量也按当前路由选取 profile；旧配置仅缺协议字段时按 URL 推断。补测验证 200,000 窗口不再被另一条 10,000 的资料覆盖。审查结论：规格与代码质量通过。

真实测试经过 REST 保存连接、真实模型工具往返和 SQLite 重开续聊。阶段 A 使用前序已验证的能力 profile，这是方案允许的过渡基线；不能把它作为空配置能力发现、热切换或实际浏览器操作的证据。最终真实结果：Chat 5 次 HTTP、Responses 6 次、Anthropic 5 次，三个主任务链路均通过。窗口分别为服务检测到的 1,050,000 / 1,050,000 / 1,000,000，已核对公开快照中的窗口值。首次试跑 Chat/Responses 各 6 次也通过；原始摘要已被复跑覆盖，只能由工具执行记录追溯，不能宣称原始文件保留。后续运行已增加自动归档。结果摘要见 [脱敏证据](./evidence/stage-a-real-summary.json)。

Anthropic 复跑有一项附属限制：自动生成标题的请求记录为 `transport`，没有 HTTP 状态；两个用户任务、工具续答和重开续聊均成功。生产标题有 5 秒超时并回退临时标题，但现有观测不能区分本次是超时还是上游失败，因此不宣称标题请求通过。初次复跑因测试把标题也要求为 HTTP 200 而失败，已归档；调整为主任务必须 HTTP 200，所有请求仍须使用选定协议和路径，复跑通过。没有修改生产重试或标题逻辑。

执行命令：

```sh
pnpm exec vitest run packages/ohbaby-sdk/src/connect-model.contract.test.ts packages/ohbaby-server/src/app/create-app.unit.test.ts packages/ohbaby-agent/src/commands packages/ohbaby-agent/src/config/llm/__tests__ packages/ohbaby-agent/src/services/interface-providers/reasoning.unit.test.ts packages/ohbaby-agent/src/services/llm-model packages/ohbaby-agent/src/adapters/ui-runtime/composition.unit.test.ts apps/ohbaby-web/src/api/daemon/model-protocol.contract.test.ts apps/ohbaby-web/src/api/daemon/client.integration.test.ts apps/ohbaby-web/src/ui/App.unit.test.tsx packages/ohbaby-cli/src/tui/components/dialog/connect-panel.unit.test.tsx packages/ohbaby-cli/src/tui/app.contract.test.tsx
pnpm run typecheck
pnpm run lint
node scripts/run-real-connect-protocol.mjs --run --profile=zenmux-gpt56-luna-chat
node scripts/run-real-connect-protocol.mjs --run --profile=zenmux-gpt56-luna-responses
node scripts/run-real-connect-protocol.mjs --run --profile=zenmux-claude-sonnet5-anthropic
```

完整本地日志和每次请求摘要：`.ohbaby/test-evidence/improve-8/stage-a/`；独立审查记录：`.superpowers/sdd/improve-8-regression/stage-a-review.md`。

## Stage B：保存与运行切换

本阶段实施、测试及独立审查均已通过。保存模型不再中断旧 Run；新任务先持久进入队列，在旧环境的主任务、子任务、工具和后台 shell 实际结束后，绑定最新配置。配置文件与密钥写入在同一进程内协调，捕获写入失败时恢复；恢复也失败则报告部分保存并阻止新准入，直到修复保存。跨独立进程同时写入和进程崩溃后的双文件事务不在本轮保证内。

单元、契约和集成联合验证：20 文件 / 352 项通过；TUI `/connect` 定向 10 项通过、79 项不相关测试跳过；最终 scheduler 23 项复查通过。工作区类型检查、修改源码 lint 通过。独立审查发现并修复了两项问题，均有先失败再通过的回归：环境释放期间并发初始化造成配置锁死锁；外部更新全局 `.env` 后旧进程缓存遮蔽新密钥。显式调用方环境覆盖仍保留。

修复后重新完成三组真实切换：Chat → Responses（8 次 HTTP）、Responses → Anthropic（7 次）、Anthropic → Chat（7 次）。每组均确认：旧工具执行中保存成功、新会话接收后等待、旧任务续答仍用旧协议、新任务改用新协议、SQLite 重开后原会话改用新模型。续聊逐条检查模型、协议和路径，首个请求不携带旧 native 状态，后续请求不含旧状态哈希，并正确回答 Cedar / 17 / Lin 三项事实。每组 9 项无网络断言测试和 1 项实网测试通过。见 [脱敏证据](./evidence/stage-b-real-summary.json)。

测试仅控制本地 `read.execute` 的等待时机，放行后执行原工具；模型请求和响应均为实网。使用阶段 A 同样的已验证 profile 过渡基线。本阶段证明后端切换，实际 UI 操作仍待 D。T13 另补了真实本地后台 shell 与手工摘要的组合集成：仅 shell 活跃时摘要等待，释放后摘要用 B，摘要中保存 C 也不会释放 B；2 项集成测试及独立审查通过。

首次 Chat 尝试用了不成立的测试前提：默认只读工具不会等待权限，任务正常完成而未进入测试屏障。这次 4 次 HTTP 的失败已保留。修正本地工具屏障后的首次完整矩阵为 7 / 8 / 7 次 HTTP，已归档。最终 Responses 组有一条标题 `response_stream`（HTTP 200 后读流失败）和一条标题 `transport`；Anthropic 组有一条标题 `transport`。主任务请求均成功，不把这些辅助失败写成全绿。现有观测不能确定它们是标题超时还是上游故障。

```sh
pnpm exec vitest run packages/ohbaby-agent/src/config/llm/__tests__ packages/ohbaby-agent/src/utils/project-env.unit.test.ts packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts packages/ohbaby-agent/src/adapters/ui-inprocess/runtime-admission.unit.test.ts packages/ohbaby-agent/src/adapters/ui-inprocess/runtime-controller.unit.test.ts packages/ohbaby-agent/src/adapters/model-switch.integration.test.ts packages/ohbaby-agent/src/runtime/prompt-scheduler/scheduler.unit.test.ts packages/ohbaby-agent/src/agents/subagent-host.unit.test.ts packages/ohbaby-agent/src/tools/shell-job-registry.unit.test.ts
pnpm exec vitest run packages/ohbaby-cli/src/tui/app.contract.test.tsx -t '/connect'
pnpm exec tsc -b --pretty false
node scripts/run-real-model-switch.mjs --run --from=zenmux-gpt56-luna-chat
node scripts/run-real-model-switch.mjs --run --from=zenmux-gpt56-luna-responses
node scripts/run-real-model-switch.mjs --run --from=zenmux-claude-sonnet5-anthropic
```

本地完整证据：`.ohbaby/test-evidence/improve-8/stage-b/`；独立生产审查和测试脚本审查均保存在 `.superpowers/sdd/improve-8-regression/`。

## 后续阶段

- B：保存配置与运行准入协调，已完成。
- C：能力发现、会话推理偏好与发送快照，尚未实施。
- D：TUI 编辑反馈、真实 Web/TUI 操作与全仓回归，尚未实施。

## 保留的验收边界

本轮结果不会自动关闭 improve-6 的真实百万窗口 95% 与真实上游 overflow 缺项。此前 packaging 安装超时也不能由本轮定向测试替代；最终回归时单独记录。
