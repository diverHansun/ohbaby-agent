# 4. 测试与验收标准

沿用仓库 `docs-test/`：`unit / contract / integration / smoke`。不新增第五种默认分类。真实 provider cache E2E 保持 improve-5 的 opt-in，**不是本批发布门**。

## 4.1 测试范围

| 类型 | 覆盖 | 不覆盖 |
|------|------|--------|
| unit | Share 计算；session tracker 累加/跳过/子代理过滤/清理边界；完成回调 exact-once、错误隔离与取消 usage 保留；Web/TUI 文案格式化 | 真实 HTTP、跨进程恢复 |
| contract | `UiPromptCacheUsage` 最终 DTO；旧 `/status` payload 兼容；新字段 optional；`UiContextWindowUsage` 无 cache 键 | snapshot 新增 cache 事件（本批禁止） |
| integration | primary run 完成 → tracker → `handleStatus`；子代理、title、summary 隔离；compact/换模型不清零；删除/归档清理 | 改请求前缀、持久化累计 |
| Web/TUI unit | 缺字段、子代理/null、未知、0%、有效百分比、畸形值六种状态；占用 UI 仍无 Cache | 顶栏环、hover/click 占用详情 |
| 手工 | compiled Web 与 TUI 的 `/status` 位置和文案 | 真实 cache 命中稳定性、成本统计 |

## 4.2 关键场景与用例

| ID | 场景 | 类型 | 验证点 | 02 Phase |
|----|------|------|--------|----------|
| U1 | 无 `observed.cacheRead` / 无 breakdown | unit | 本轮不进入累计；不得伪装为 0% | A |
| U2 | read=0、write>0、read observed | unit | 本轮可信；read 加 0，`accountedInputTokens` 加三桶之和 | A |
| U3 | 两轮可信 run 相加 | unit | A: 1000/200，B: 3000/2200 → 累计 4000/2400/0.6；禁止平均 20% 与 73.3% | A |
| U4 | `usageComplete=false` 或缺 breakdown | unit | 不改两个累计量、不创建额外诊断状态；get 仍返回上一可信态 | A |
| U5 | 分母为 0 | unit | `cacheReadShare === null`，不得返回 0 | A |
| U6 | `observed.cacheWrite=false` 但 read 可信 | unit | **计入**该轮；write 使用已有数值 0 | A |
| U7 | share 派生与取整 | unit | DTO 保留 0–1 原值；UI 0.614 → 61%，恰 0.5 按 `Math.round` | A/C |
| U8 | clear 边界 | unit | compact/换模型不 clear；删除/归档/后端 dispose clear 对应 session 或全部桶 | A/B |
| U9 | 三步工具循环，中间一步无 breakdown | unit | 现有 run aggregate 无 breakdown；tracker 整轮不记，禁止只累计首尾两步 | A |
| I1 | primary run 完成 → `/status` | integration | data 为 `promptCacheUsage`；未先打开占用面板也有累计值 | B |
| I2 | `isSubagent: true` run | integration | 主 session 桶不变；子 session getter 为 `null` | B |
| I3 | 手动/自动 compact | integration | compact 的 summary/title 请求不 record、不 clear；同一 run 或后续 run 中 compact 之后继续发生的可信主代理 agent-step 仍正常累加 | B |
| I4 | title/summary 请求 | integration（可沿用 auxiliary isolation） | 完成回调/record 次数不增加 | B |
| I5 | 同一 run 多次 `waitForCompletion` 或多处等待 | unit/integration | `finalizeRun` 只触发一次完成回调，累计不重复 | B |
| I6 | 完成回调抛错 | unit | run 原本的成功/失败/取消结果不被改变；错误仅作内部诊断 | B |
| I7 | 换模型触发 runtime reset/rebuild | integration | 外层 tracker 实例仍在，同一 session 累计连续 | B |
| I8 | session 删除、UI 归档、后端 dispose | integration/unit | 删除/归档只清目标 session；dispose 清全部；不会误清其它 session；删除/归档后迟到的完成回调不得复活目标桶 | B |
| I9 | provider 已返回完整 usage 后收到取消 / usage 完整前取消 | unit/integration | 前者 completion 保留 usage 并累计，后者无可信 usage、不累计；两者终态和 `terminalReason` 都为 cancelled | B |
| C1 | 无 `promptCacheUsage` 的旧 data | contract | 解析成功；不显示 Cache 行；Context 行仍在 | B/C |
| C2 | 新 DTO 与两个 UI adapter | contract | DTO 仅含 `sessionId/accountedInputTokens/cacheReadTokens/cacheReadShare`；Web/TUI 对正常、零、未知、read>accounted、空 sessionId、非法数值 fixture 得出等价结果 | B/C |
| W1 | Web 主 session 有效值 | unit | 占用块后独立 label `cache` + value `hit 61%`，最终可见文案只有一次 `cache hit 61%`；七类占用块 text 不含 Cache | C |
| W2 | Web 主 session 未有可信轮 | unit | 对象存在且 share=null，显示 label `cache` + value `hit —` | C |
| W3 | Web 兼容与失败关闭 | unit | 缺字段、payload=null、畸形 share 均不显示 Cache 行；不得 clamp | C |
| W4 | Web 零命中 | unit | share=0 明确显示 label `cache` + value `hit 0%`，不显示 `—` | C |
| T1 | TUI 主 session 有效/未知/零命中 | unit | Context 与 Tools 之间分别出现完整行 `Cache hit 61%` / `Cache hit —` / `Cache hit 0%`；不得出现 `Cache Cache hit` | C |
| T2 | TUI 兼容与失败关闭 | unit | 缺字段、子代理/null、畸形 share 不显示 Cache 行；底栏格式不变 | C |

这里的“主代理尚无可信轮”不是缺字段：新后端返回对象 `{ accountedInputTokens: 0, cacheReadTokens: 0, cacheReadShare: null }`，Web/TUI 都显示 `Cache hit —`。缺字段只代表旧协议，`null` 只代表当前 session 不适用或读取失败，两者都不显示行。

## 4.3 集成边界

- `RunManager.finalizeRun` 的窄完成回调是唯一 record 触发点；它只传 `{ sessionId, isSubagent, usage }`，不知道 cache 公式和 tracker 类型。`startRun` 把已完成 outcome 覆盖为 cancelled 时必须保留其中已有 usage。
- session tracker 归 `ui-inprocess` 外层 backend client 所有，不跟随 runtime composition reset；`handleStatus` 只读其投影。
- child guard 与 `getContextWindowUsageInternal` 同层：`isSubagent` session 不展示 cache。
- **禁止** Context 解析 vendor cache 字段；**禁止** llm-client 主动调用 tracker；**禁止**在多个 wait/submit 路径重复 record。
- compact / `context.window.updated` / occupancy total-only 更新 / 换模型 **不得**调用 cache clear。
- 外层 tracker 直接订阅 `SessionEvent.Removed`；session 删除与 UI 归档清目标桶，并把目标 session 置为 retired，拒绝仍在飞行中的 run 迟到回写；backend dispose 取消订阅并清全部桶。进程重启后的归零是本轮明确边界，不做恢复。

## 4.4 回归清单

- occupancy 七类、Web 环、hover/click 详情、TUI 总量行继续只表达当前 context window。
- inclusive `currentTokens` 仍含 provider prompt 侧 cache read，不因新增 Cache hit 行改变旧分母。
- `aggregateTokenUsage` 现有聚合语义不变；session tracker 只消费完成 usage，不反向修改 lifecycle 数据。
- `purpose: "agent-step"` 以外的请求不进入完成 usage（已有 auxiliary isolation 测试保持绿）。
- 配置项 `apiConfig.promptCache` 行为和命名不变；它与状态字段 `promptCacheUsage` 不混用。
- 旧 Web/TUI 收到新字段可忽略；新 Web/TUI 收到旧 payload 可省略 Cache 行。

## 4.5 验收标准（发布门）

| 项 | 标准 | 如何验证 |
|----|------|----------|
| G1 helper/tracker | U1–U9 全绿 | 对应 `*.unit.test.ts` |
| G2 完成折入与生命周期 | I1–I9 全绿；至少覆盖 exact-once、回调错误隔离、取消 usage 保留、runtime reset 不清零 | unit + integration |
| G3 SDK/`/status` | C1 C2 全绿；字段名和 DTO 形状无漂移 | contract + command unit |
| G4 Web/TUI | W1–W4、T1–T2 全绿；手工确认行顺序 | component unit + compiled smoke |
| G5 回归 | context 七类/总量、auxiliary isolation、现有 contract 全绿 | 相关测试矩阵 |
| G6 文档 | Phase D 点名的 architecture、data-model、status-bar、context/lifecycle goals-duty 与 improve-6 README 全部同步 | 人工 diff + 文档审查 |
| G7 真实 cache | 不要求 | 明确 skip，不写进本批 pass |

建议命令（实施时按实际文件名调整）：

```text
pnpm exec vitest run <prompt-cache-usage unit>
pnpm exec vitest run <run-manager completion callback unit>
pnpm exec vitest run packages/ohbaby-agent/src/commands/service.unit.test.ts
pnpm exec vitest run packages/ohbaby-cli/src/tui/render/status-panel.unit.test.ts
pnpm exec vitest run apps/ohbaby-web/src/ui/App.unit.test.tsx
pnpm run test:contract
pnpm run test:integration
pnpm run test:e2e:compiled-web
```

## 4.6 对抗性审查要点

| 攻击面 | 防御 | 残余风险 |
|--------|------|----------|
| 网关不报 cache 字段，UI 显示 0% | U1/U5；未知对象的 null → `—` | 某前端把 0 和 null 都格式化成 0 |
| 把每轮百分比平均，短请求权重被放大 | U3 固定不等权样例 | 实施者只保存 share、不保存原始累计量 |
| 多 step 工具循环只挑有 breakdown 的 step 累计 | U9；只消费 run aggregate，任一步缺字段整轮跳过 | 上游长期缺字段会让样本覆盖率偏低，但不会制造假精度 |
| 同一 run 被多个 waiter 重复累计 | I5；唯一完成回调 | 将来新增终止路径绕过 `finalizeRun` |
| 完成观察器抛错反向破坏 run | I6；回调 catch 隔离 | 错误被吞后缺少内部日志 |
| provider 已报完整 usage，但稍后 cancel 覆盖 result | I9；取消覆盖保留 worker outcome.result | 将来另一个取消入口重建 outcome |
| 子代理与主会话共用 sessionId | I2 看 `isSubagent`，不是只看 sessionId | 将来子代理漏标会混桶 |
| 换模型重建 runtime 时 tracker 被销毁 | I7；tracker 归外层 backend client | 后续重构误把 tracker 移回 runtime composition |
| compact 后占用 total-only 更新顺手清 cache | I3/U8；数据通道分离 | 新 compact 入口忘记隔离 |
| SessionEvent.Removed 只在 runtime composition 内被消费，外层桶泄漏 | I8；外层独立订阅并在 dispose 取消 | 新删除入口不发事件且不走 archive |
| 把 cache 写进 snapshot，旧 TUI 崩 | C1/C2；02 禁止 snapshot 字段 | 实施时图省事复用 `context.window.updated` |
| 状态字段叫 `promptCache`，被当成配置开关 | 最终字段锁定为 `promptCacheUsage` | 文档或 adapter 局部仍残留旧工作名 |
| 畸形 share 被 clamp 成貌似可信数字 | W3/T2；失败关闭、不渲染 | UI adapter 校验器重复实现后漂移 |

最可能失败的集成点不是 tracker 的所有权，而是 record 时机：tracker 必须由外层 `ui-inprocess` 持有，但只由 `RunManager.finalizeRun` 的一次性完成回调触发。这样既能跨 runtime reset 保留 session 累计，又能避免在 submit/wait/bridge 多路径重复计数。
