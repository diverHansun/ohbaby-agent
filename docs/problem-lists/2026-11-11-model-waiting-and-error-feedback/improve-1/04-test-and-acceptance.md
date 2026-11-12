# 测试与验收标准

本文约束后续实施，不代表修复已完成。规划期只核对源码和已有走查证据；真实验证结果在实施后的 05 中记录。

## 1. 测试策略

沿用项目已有 Vitest 分类和就近测试文件。本轮没有发现独立的项目级 test-blueprint 文件，不因此新增一套测试规范。

优先扩展现有测试，把连续状态变化放在一个有意义的场景里。下表是七组验收目标，其中 T7 对应用户补充的 daemon 断线反馈；不要求拆成大量单独用例，也不要求对每个字段写镜像测试。真实 E2E 用命令、内置浏览器和 TUI 操作，不新增长期维护的 E2E 脚本。

## 2. 七组关键验证

| ID                          | 场景和关键断言                                                                                                                                                                                                                                                                                                                                                       | 首选落点                                                                                                                                              | 对应阶段 |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| T1 重试连续与恢复           | 第一次失败且安排重试后，首次 request-ended 已带安排；退避中从数据库重建 snapshot 仍为 retrying；下一次请求开始时同一等待行和计时不重置；有进展或终态后清理。实时、持久快照、source projection 和 legacy getSnapshot 一致；流中 reasoning 的覆盖不能让快照退回旧阶段。                                                                                                | LLM `request-observation.unit.test.ts`；agent `model-recovery.integration.test.ts`、`execution-projection.unit.test.ts`及已有快照测试                 | S1、S3   |
| T2 终态与取消不能复活旧等待 | 取消先于封口、安排后取消、后续请求成功/失败、旧事件迟到、daemon 恢复判定为终态；均不启动额外请求、不复活旧 retry。安排和实际使用的 delay 相同。观测保存失败仍优先阻断。                                                                                                                                                                                              | 复用请求观测、stream idle/重试和运行恢复测试中的可控 promise/时钟                                                                                     | S1       |
| T3 等待语义与输出保护       | 当前步骤已有正文、可见 Thought 或工具进度时不叠加 Waiting；空白 reasoning 不结束等待，非空但隐藏的 reasoning 让请求恢复为 requesting，保留普通 Thinking；推理更新实时触发该投影，不靠下一次请求事件或刷新。上一步内容不能遮掉下一步等待。审批、工具、排队、压缩和连接恢复各用自身反馈。正文/reasoning/tool fragment 后的异常及用户取消仍不自动重放。                 | Web `App.unit.test.tsx`；TUI `working-spinner.unit.test.tsx`；agent 现有流/推理投影测试；LLM 现有流中断测试                                           | S1、S3   |
| T4 原因一致及诊断收窄       | 重点覆盖包装后的 429、认证/连接错误和流中断；prompt/run/message 的原因一致。旧数据缺字段可读。逐次失败可按 requestId 关联，诊断不含测试用密钥、认证头、原始请求或响应。`retryable` 不会触发 UI 或自动重发。保存失败包装 503、工具交付失败包装 ECONNRESET 时，直接和 lifecycle 映射均保留 runtime 来源、terminalReason，且不附 providerId/statusCode。                | agent `error-detail.unit.test.ts`、现有 lifecycle 测试及相关日志边界                                                                                  | S2       |
| T5 轮次错误归属           | 主会话、Side Chat 各自在失败轮次末尾显示一条错误行（安全说明 + 可选 `HTTP 状态码`），没有卡片和关闭按钮；重复事件/重载不重复，刷新后仍在所属轮次。旧失败随历史保留，新提问不把它顶到输入区。无 prompt 的可见轮次用 run.error；Rewind 后不残留该轮错误行。主动停止不显示错误行。 | Web `App.unit.test.tsx`；SDK 轮次/错误选择；TUI transcript 现有测试                                                                                   | S2、S3   |
| T6 真实操作与视觉           | 实际模型成功；失败可由可控 provider 经真实 HTTP、daemon 和 UI 链路构造，不要求再次触发上游限流。等待没有整行闪退；重试显示 `Retrying #n`，无倒计时；错误行只带 `HTTP 状态码`，不显示 providerId 和错误码。部分回答与停止反馈可区分。1024px 主区加侧聊不溢出，减少动态效果时不持续旋转，编辑和输入保持可用。                                                                                                                        | 直接命令、内置浏览器、真实 TUI                                                                                                                        | S4       |
| T7 daemon 断线与静默重连    | 短断线恢复；连续失联约 10 秒后全页静态遮罩（原页面 `inert`，草稿与滚动位置保留但不可编辑，文案不出现 `ohbaby`），后台尝试仍在进行，重复失败或短暂 hello 不重置显示期限。只有当前恢复周期就绪才清除；同步失败静态显示。Web 401 及 `/v1/events` 注册失效的 409 停止无效循环且不泄漏状态细节，不把普通 403 当凭据过期。主会话、侧聊、composer 和 daemon TUI 的显示含义一致，历史及当前页草稿保留，旧模型 spinner 停止，未知提交不重发。 | 扩展 Web `events.unit.test.ts`、已有 session recovery integration / `App.unit.test.tsx`，TUI `session-recovery.unit.test.ts` 与现有 app contract 测试 | S3、S4   |

T5 原有的关闭记忆检查随 00 §13 F2 取消；改为检查错误行没有关闭按钮、刷新后仍在所属轮次且只出现一次。

T7 优先把连续失败、再次尝试、hello、同步恢复串在一个可控时钟场景里；超过显示期限后即使 transport 恢复、正在同步也保持静态，不要求新增同步文案，完全恢复后才清除。另用一个失败分类场景覆盖认证/注册失效与普通错误，不为每个状态复制一套测试。须覆盖 Web 重连建立/hello 卡住时取消本次尝试后仍继续重连、连接 owner 关闭后停止循环及忽略迟到计时器，以及正常连接安静超过 10 秒不被判定断开；初次加载失败仍保留原有启动错误处理。显示期限与单次建立连接期限不能误杀正常 SSE。

## 3. 可直接执行的检查

实施者按实际改动选择以下已有测试入口，复用和调整现有断言；不要机械添加全部文件的新测试。

```sh
pnpm exec vitest run packages/ohbaby-llm/src/client/request-observation.unit.test.ts packages/ohbaby-llm/src/client/retry.unit.test.ts packages/ohbaby-agent/src/runtime/run-manager/error-detail.unit.test.ts
pnpm exec vitest run packages/ohbaby-agent/src/adapters/ui-state/model-recovery.integration.test.ts packages/ohbaby-agent/src/adapters/ui-state/execution-projection.unit.test.ts packages/ohbaby-agent/src/adapters/ui-runtime/run-stream-adapter.unit.test.ts
pnpm exec vitest run apps/ohbaby-web/src/ui/App.unit.test.tsx packages/ohbaby-cli/src/tui/components/working-spinner.unit.test.tsx packages/ohbaby-cli/src/tui/components/transcript/prompt-duration.contract.test.tsx
pnpm exec vitest run apps/ohbaby-web/src/api/daemon/events.unit.test.ts packages/ohbaby-cli/src/tui/session-recovery.unit.test.ts
pnpm typecheck
pnpm lint
pnpm format:check
```

阶段检查通过后再跑一次本轮需要的全量回归与构建；只有新增改动或失败需要重跑时才重复。纯规划文档不运行这些代码测试，不把历史测试数量记作本轮修复通过。

## 4. 直接操作 E2E

确认服务对应实施后的构建，避免拿旧 daemon 或旧 Web bundle 验收：

```sh
pnpm --filter ohbaby-cli build
node packages/ohbaby-cli/dist/bin.js serve status
```

根据 status 决定是否需要重启和打开 URL；不要为了测试直接中断用户正在运行的会话。真实模型可使用用户已授权的配置及 `tests/models-4-tests.md`，不输出 `.env` 密钥。

用一个测试主会话及其 Side Chat 完成两条核心流程：

1. **重试后恢复。** 用现有可控 provider fixture 或终端一次性命令构造先失败再成功；退避中刷新页面，再观察成功输出。确认同一等待行持续存在，未提前出现红色错误。真实 provider 是否限流不可控，不能把自然出现 429 作为唯一验证方式。
2. **最终失败。** 构造确定的连续失败，主会话与侧聊各测一次。检查轮次位置和文案，刷新、切换会话、开始新轮次，确认错误行只出现一次且留在所属轮次。只读核对后台终态记录仍在。

同一测试会话再做短回归：成功回答后 Fork，Edit 重发后刷新，Side Chat 中停止生成。部分输出中断和复杂取消顺序主要交给现有可控测试，不通过反复撞真实 provider 扩大请求量。

**连接补充验收不需要模型请求。** 使用独立测试 daemon 的 scope 和端口，先在 Web 打开主会话与 Side Chat 并输入草稿，再直接用命令停止测试 daemon。观察约 10 秒后出现全页静态遮罩、后台仍重连、页面内容保留且不可操作。自动恢复场景要求凭据与客户端注册仍有效，可用同一 daemon 的可控断流验证；重新启动 daemon 后，凭据变化或注册丢失应静态提示刷新，不能要求旧连接自动成功。刷新后的会话数据应正确；Side Chat 整页刷新草稿持久化不在本条承诺内。不要停用户正在使用的 daemon，也不要为了制造故障反复发送真实模型请求。

TUI 用实施后的 `node packages/ohbaby-cli/dist/bin.js` 打开测试会话，确认重试期间活动提示持续、终态原因出现在该轮附近、主动停止不显示 provider 失败；断线提示另在其现有 daemon 连接模式验证。不得仅凭源码或 Web 结果记为 TUI 验收通过。避免让独立 TUI 和 daemon 同时写入同一个测试会话。

保留关键截图和脱敏的状态/请求摘要到验收记录，写明版本、实际命令与未覆盖项；不把一次性测试命令变成新仓库脚本。

## 5. 集成边界与回归约束

- 请求失败、观测保存失败和用户取消有不同含义；诊断日志失败不能覆盖真实请求结果。
- 新可选字段经过持久存储、事件 schema、SDK、实时/快照/source projection 均不丢失；legacy 快照按最终消息视图重算；旧记录和旧字段仍可读。
- Side Chat、Fork 的历史复制以及 Rewind 的可见性过滤不变。历史 retry 安排、旧错误和其他会话事件不能成为当前活动。
- prompt/run/message 中的同一失败只呈现一次；普通工具失败不等于整轮失败，审批不等于模型思考。
- 时间取后端事实，同一请求链不按 React 挂载重置；不修改首正文指标定义或现有重试预算。
- 连接显示期限只改变提示，不终止普通后台重连，不修改 run 终态或自动重发 prompt；连接恢复与会话同步就绪分别判断。

## 6. 验收门槛与审查重点

T1～T5 和 T7 的适用自动化验证通过，T6 及连接补充走查完成，相关类型/格式/静态检查和本轮回归通过，子代理审查没有未解决的阻断问题，才可在 05 写本轮通过。

审查重点为四处：

1. **事件顺序**：安排必须随首次结束保存；残余风险是旧服务没有这份事实，只能保守降级。
2. **取消与迟到事件**：终态不得恢复等待；持续断线显示静态状态而非无限恢复动画。连接不可用时仍不能承诺立即知道服务端结果，旧定时器不得覆盖新连接。
3. **归属**：按稳定会话/轮次身份去重，错误不能出现在错误的侧聊或新轮次里。（关闭功能已随 00 §13 F2 取消。）
4. **信息泄露和重试边界**：只输出安全原因，不搬参考项目的原始诊断或部分输出重放；未知上游细节宁可保留未知。

后续收窄验证：复用错误分类测试，确认正常 SDK 认证和常见原因不变；4 种上游编号字段完全不读取，逐次日志不含 upstreamId，本地请求关联仍在；已识别 SDK、wrapper 或普通 HTTP provider 对象遇到坏字段只返回固定安全说明。只保留总兜底，不要求畸形对象仍保持精确认证分类。
