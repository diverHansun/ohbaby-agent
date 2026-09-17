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

## Stage C：能力发现与会话推理选择

第三批实现、测试与独立生产复审已通过。连接先保存，再异步查询当前模型的准确资料；缺失或查询失败时允许按服务默认发送，不猜档位。已确认的档位按原名显示，默认优先 `medium`；当前会话分别保存选择，每条消息在接受时固定选择，队列、运行中请求和 SQLite 重开均保持该快照。Responses 在未知能力且不发强度控制时仍请求加密推理状态，以供续接。已知不兼容的队列消息明确失败，后续兼容消息继续运行。Web 输入框旁增加推理控件；TUI 编辑反馈和真实浏览器操作归 D。

Sonnet 5 的[模型资料](https://zenmux.ai/anthropic/claude-sonnet-5)说明自适应推理始终开启；Luna 的[模型资料](https://zenmux.ai/openai/gpt-5.6-luna)确认档位但没有逐模型确认可关闭。因此这两条精确模型资料均不显示关闭选项，显式关闭也会被后端拒绝。通用协议支持关闭不能替代逐模型证据。

最终定向单元、契约和集成：35 文件 / 646 项通过，含旧 SQLite schema 迁移、分页/超时/迟到探测、能力来源、两会话隔离、重放幂等、队列不兼容与未知服务默认。独立审查又发现并推动修复了远程 JSON-RPC 显式强度丢失、自定义档位顺序不完整、连接页旧异步结果覆盖及 Web 选择回滚；真实本地 HTTP daemon 与 Web 延迟事件回归均已补测。审查第二轮发现的“PATCH 已返回、旧 SSE 迟到”竞态也有先失败再通过的回归，最后定向复审 156 项通过。工作区 TypeScript、修改范围 ESLint/Prettier 通过。两套真实测试脚本的无网络清理/证据测试与观察器 24 项通过；独立脚本复核已关闭原生状态重放、非空工具配对和异常清理问题。

最终代码的真实 API 验收四组通过，均从空模型配置经公开 REST 保存开始。Chat 和 Responses 各 6 条生成请求 HTTP 200，Anthropic 4 条主任务请求 HTTP 200；三者各有 1 条实际元数据请求 HTTP 200，工具调用与结果配对有效，两会话选择、SQLite 重开及原生状态实际进入后续 provider 请求均得到验证。Anthropic 另有 2 条自动标题请求在 HTTP 状态前报 `transport`，不能写成附属标题全绿。能力未知组只用受控元数据缺字段触发分支；4 条 Responses 生成请求都是真实模型 HTTP 200，无未证实的强度控制，仍保留加密状态续接和工具配对。每组最多允许 20 次请求，详见[脱敏证据](./evidence/stage-c-real-summary.json)；完整本地审计位于 `.ohbaby/test-evidence/improve-8/stage-c/`。

```sh
pnpm exec vitest run packages/ohbaby-agent/src/config/llm/__tests__ packages/ohbaby-agent/src/runtime/prompt-scheduler packages/ohbaby-agent/src/services/interface-providers/reasoning.unit.test.ts packages/ohbaby-agent/src/services/interface-providers/reasoning-view.unit.test.ts packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts packages/ohbaby-agent/src/adapters/model-switch.integration.test.ts packages/ohbaby-agent/src/adapters/ui-runtime/reasoning-summary.integration.test.ts packages/ohbaby-server/src/app/create-app.unit.test.ts packages/ohbaby-server/src/protocols/jsonrpc packages/ohbaby-server/src/runtime/daemon/client.integration.test.ts packages/ohbaby-server/src/runtime/daemon/server.integration.test.ts apps/ohbaby-web/src/ui/App.unit.test.tsx apps/ohbaby-web/src/api/daemon
pnpm exec tsc -b --pretty false
node scripts/run-real-session-reasoning.mjs --run --profile=zenmux-gpt56-luna-chat
node scripts/run-real-session-reasoning.mjs --run --profile=zenmux-gpt56-luna-responses
node scripts/run-real-session-reasoning.mjs --run --profile=zenmux-claude-sonnet5-anthropic
node scripts/run-real-session-reasoning.mjs --run --profile=zenmux-gpt56-luna-responses --unknown
```

## Stage D：真实界面与最终回归

Web 推理档位现位于 composer 右侧、发送提示之前，显示后端原名，使用可键盘操作的原生选择器。桌面和 390px 窄屏实际检查了位置、焦点与换行；`/` 命令菜单不会被工具栏遮住。关闭测试服务后，保存失败提示仍能显示在输入框上方。原来仅有未加样式的下拉框，且位于左侧权限按钮旁；这一轮已补齐视觉和交互。独立审查发现的错误提示层级、命令菜单层级问题均已修复并重验。审查还发现排队编辑时长提示会挤压新增按钮；现在提示独占一行，1280px 与 390px 真实浏览器均无横向溢出，截图见 `.ohbaby/test-evidence/improve-8/stage-d/web-control/`。

Web 从空配置经 `/connect` 实际操作 Chat、Responses、Anthropic；各协议都用真实模型读本地 `note.md` 并回答 Cedar / 17 / Lin。Responses 与 Anthropic 后续请求有原生状态，工具调用与结果 ID 配对。Web 选择 `high` 后首次请求与续请求使用 `high`，刷新恢复；旧会话 `high`、新会话默认 `medium`、新会话再选 `low` 后返回旧会话仍为 `high`。第一次 Anthropic 尝试在模型请求前暴露两份 run ledger 的状态竞争，修复后真实重跑通过；失败尝试保留在本地证据，未计为成功。

E3 实际把 Chat 任务停在受控本地文件读取，运行中保存 Responses 并排队一条 `high` 消息，随后把控件改为 `low`。放行后，旧 Chat 两次主请求及排队 Responses 一次主请求均为 HTTP 200；旧任务继续使用 Chat，新请求用 Responses 且保持提交时的 `high`。过程发现保存模型时完整快照与实时流使用不同消息 ID，页面会残留同一工具的 running/completed 两张卡。修复后再实网重跑：任务结束时会话由持久化的最终内容收敛，未刷新页面也只留一张 completed 卡。SQLite 关闭重开后，原会话以已保存的 `low` 继续发出真实 Responses 请求，HTTP 200。运行中的短暂重复仍可能出现，最终完成后会自动消失；统一两套消息 ID 属于后续独立改造。

TUI 从空配置分别经 `/connect` 保存三协议，各有两次真实主请求，均 HTTP 200，生产能力识别得到默认 `medium`，实际 wire 也都是 `medium`；工具 ID 配对与答案均正确。PTY 实测 `/connect`、`/connect-search` 的选字段/Enter 编辑/退格/Enter 提交/Esc 放弃、密钥遮罩、协议选择、主输入恢复，覆盖彩色、无色和 48 列终端。已有 queued-edit Ink 契约测试通过；真实 PTY 未构造运行中队列，故该项不能记作 PTY 通过。单独设置 `NO_COLOR=1` 时旧主题/Chalk 路径仍输出 ANSI；合用 `FORCE_COLOR=0` 后完全无色，`▏ [editing]` 仍可辨认。完整本地帧见 `.ohbaby/test-evidence/improve-8/stage-d/pty/README.md`。

本批单元/集成定向 5 文件 279 项通过，含 Web 93 项、后端持久状态与 ledger 竞态回归。最终完整 `pnpm run preflight` 通过：格式、lint、TypeScript、361 文件 / 3708 项测试、全仓构建，另 6 文件 / 17 项按仓库现有条件跳过；安装后的 CLI 打包测试也通过。独立审查找出并复核了排队编辑底栏溢出修复，其余已审范围无具体回归。脱敏矩阵见 [Stage D 证据](./evidence/stage-d-real-summary.json)；请求级本地证据见 `.ohbaby/test-evidence/improve-8/stage-d/` 和各隔离 Web 临时目录。Web 测试启动器给真实 provider 请求设 20 次上限，不保存 key 或完整推理状态。

## 后续阶段

- B：保存配置与运行准入协调，已完成。
- C：能力发现、会话推理偏好与发送快照，验收通过；见本批提交。
- D：TUI 编辑反馈、真实 Web/TUI 操作、全仓检查和独立审查已完成；见本批提交。

## 保留的验收边界

本轮结果不会自动关闭 improve-6 的真实百万窗口 95% 与真实上游 overflow 缺项。此前 packaging 安装超时也不能由本轮定向测试替代；最终回归时单独记录。

## 2026-09-17 后续修复：开发入口与主动档位探测

根目录 `pnpm run dev` 原来执行 `ohbaby-agent` 的库入口，没有进入 TUI；现改为先构建 CLI 所需工作区包，再从 CLI 源码启动交互终端，真实 PTY 已确认进入主输入界面。

针对模型资料只有 `capabilities.reasoning: true`、没有档位的情况，保存连接后的后台任务会对当前模型和协议发送受限的小请求。先用无效档位作反向对照；若服务连无效值也接受，不采信档位结果。只持久化真实接受的档位及关闭能力，来源记为 `active-probe`；不覆盖用户手工配置，不阻塞连接保存，不将失败误判为不支持推理。未知时 Web 文案为“推理默认”，明确不支持时隐藏控件。

真实 ZenMux `deepseek/deepseek-v4.1-flash` 验证：Chat 保存后的后台探测识别 `minimal/low/medium/high/xhigh/max` 与关闭；Responses 同样识别六档与关闭；Anthropic 识别 `low/medium/high/xhigh/max` 与关闭。无效档位被拒绝。对当前连接按原参数重存并重启本地开发服务后，后端 `/v1/model` 返回 `identified`、默认 `medium`；真实 Web 页面出现档位下拉及对应选项。用户原模型配置的 provider、默认模型、地址、协议、输出参数和 profile 数量均保持一致。

新增反向对照、三协议请求形状、后台持久化与 Web 文案回归；定向 5 文件 / 119 项通过。完整 `pnpm run preflight` 通过：362 文件 / 3714 项测试、6 文件 / 17 项按原条件跳过，格式、lint、类型检查和构建通过。该验证证明服务接受这些控制值；无法单凭短请求证明各档位实际思考深度有稳定差异。
