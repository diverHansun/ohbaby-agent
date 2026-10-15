# 第 5 批：测试与验收标准

> 依据 [plan/04](../plan/04-test-and-acceptance.md) §4.7（U1–U13）、§4.8（W1–W7）、§4.9 与 [02](./02-optimization-plan-and-change-scope.md)。
> 本文是**待执行的验收契约**，不是已通过结果。沿用仓库既有 Vitest 与 `docs-test/classification.md` 分类，不新建测试体系；本次文档修订未运行产品验收；此前审查基线测试不代表本方案已实现。

## 4.1 测试范围

- **单元/契约**：criterion 的 trim、空白、UTF-16 边界与 replace 顺序；消息装配（正文/展示值/标题源）；删除轻提示后的引用闭合；`UiGoal` 新字段与 `goal.updated`、session 视图、初始快照的形状。
- **集成**：goal 首轮/续轮的 live 与 replay 一致性；`replace: true` 拒绝后旧目标不变；三路径投影一致；数字刷新不追加 notice。
- **手工**：窄 CLI、窄屏 Web、长 objective、paused/blocked 的停止值。
- **组合**：跨批最终回归（§4.5），本批是收尾批，不再另立纯测试批。

## 4.2 关键场景与用例

| ID | 场景 | 类型 | 通过条件 | 状态 |
| --- | --- | --- | --- | --- |
| U1 | 首轮与续轮：实时与刷新重读 | contract + integration | 气泡只显示 `Goal started` / `Goal auto-continue (turn N)`；模型请求里的正文完整；消息仍是 user origin；live 与 replay 同一文本 | 拟新增（扩展 `ui-inprocess.contract.test.ts` 的 `/goal` 全流程用例与 `ui-persistent.integration.test.ts` 的重开回放） |
| U2 | 同一发起消息附加 runtime context | integration | 环境信息/MCP 菜单不受影响，goal 不占用 runtime kind | 回归既有（context 快照相关测试），并补 goal 场景断言（拟新增） |
| U3 | inactive 或无 goal 时普通输入 | integration | 不出现任何 goal 前缀（含 paused/blocked）；历史消息与显式 GetGoal 内容仍存在；queued 与 steer 两条路径分别验证 | 改写既有：删除 `ui-inprocess.contract.test.ts:7598、7625、7851、7938` 对 `currently paused` 的断言（该用例主体属 improve-2 的用户排队改写） |
| U4 | `/goal` 创建首条会话消息 | contract | 标题来自 objective/正文，不是 `Goal auto-continue`/`Goal started` | 拟新增 |
| U5 | 初始快照、增量事件、重连 | contract + 手工 | blocked、`turnsUsed`、`wallClockMs`、有上限才出现的 `turnBudget` 三路径一致；常驻字段无 token | 拟新增；扩展 `ohbaby-sdk/src/events.contract.test.ts:85-111` |
| U6 | 多次计轮/usage 更新 | contract | 数字更新且不追加生命周期 notice | 拟新增（依赖 improve-2 的静默刷新） |
| U7 | blocked 的普通恢复与调额恢复 | contract + 手工 | 面板与 composer 带参恢复可用；双维/反序/单维不丢参数，非法尾部显示错误，数字不清零 | 回归（improve-3 主测），本批确认与数字显示共存 |
| U8 | 窄 CLI、窄屏 Web、长 objective | 手工 | 数字与操作可读，不加新色相/进度条，无明显溢出 | 手工 |
| U9 | 状态查询与自动提醒 | unit + contract | 查询保留 total/cached 与部分统计标识；自动提醒无 token、有轮次/时长/两轴预算 | 回归（improve-2 主测） |
| U10 | criterion 5999/6000/6001、空白、非 BMP 字符 | unit | trim 后按 UTF-16 length 判定；超限拒绝不截断；空白按未提供 | 拟新增（`goals/store.unit.test.ts`） |
| U11 | `replace: true` 且 criterion 超限 | integration | 原目标、用量与持久记录不变，不产生新 create 记录 | 拟新增（`goals/persistence.integration.test.ts`） |
| U12 | objective/criterion 含 XML 闭合标签 | unit | 既有转义保持，各字段每轮只注入一次 | 回归既有（`goals/injection.unit.test.ts` 转义用例保留） |
| U13 | goal 开关、连续续跑、自动/手动压缩 | integration | 不按状态改写静态前缀；正文仍按通用压缩分组；提醒由 store 重建 | 回归既有（`goals/goal-compact.integration.test.ts`） |
| U14 | 删除闭合 | 静态检索 + 类型检查 | 无 `renderGoalContextNote`、`suppressGoalContextNote`、`promptTextForModel` 残留引用 | 静态检索 + `pnpm typecheck`（不新写镜像实现单测） |

## 4.3 现有测试位置与命令（已核实存在）

可扩展的现存文件（相对仓库根）：

- `packages/ohbaby-agent/src/goals/store.unit.test.ts`（已含 objective 上限用例，`:44` 附近）
- `packages/ohbaby-agent/src/goals/injection.unit.test.ts`（`:76-114` 的轻提示用例按 U3 删除，其余转义/注入用例保留）
- `packages/ohbaby-agent/src/goals/persistence.integration.test.ts`、`goals/goal-compact.integration.test.ts`
- `packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts`（`:7061+` `/goal` 全流程；`:7528+` 含轻提示断言）
- `packages/ohbaby-agent/src/adapters/ui-persistent.integration.test.ts`（持久化客户端，适合补 live/replay 回放断言）
- `packages/ohbaby-cli/src/tui/app.contract.test.tsx`（`:761-823` goal 行；`:780/807/822` 断言现状）
- `apps/ohbaby-web/src/ui/App.unit.test.tsx`（`:3840+` chip 与面板）、`ui/session/selectors.unit.test.ts:392+`
- `packages/ohbaby-sdk/src/events.contract.test.ts`（`:85-111`）、`session-view.unit.test.ts`、`duration.unit.test.ts`

命令（仓库根执行，脚本已在 `package.json` 注册）：

```sh
pnpm exec vitest run packages/ohbaby-agent/src/goals/store.unit.test.ts
pnpm exec vitest run packages/ohbaby-agent/src/goals/injection.unit.test.ts
pnpm exec vitest run packages/ohbaby-agent/src/adapters/ui-inprocess.contract.test.ts
pnpm exec vitest run packages/ohbaby-cli/src/tui/app.contract.test.tsx
pnpm exec vitest run apps/ohbaby-web/src/ui/App.unit.test.tsx
pnpm test:unit && pnpm test:contract && pnpm test:integration
pnpm typecheck
pnpm build
```

`goals/goal-completion.real.e2e.test.ts` 是显式环境开关下的真实模型测试（默认 vitest 配置排除 `*.e2e.test.ts`），不能替代本批竞态与形状验收。

## 4.4 回归清单（改造不能破坏什么）

- **保留**：消息 user 角色与 `getMessageOrigin`；runtime model-context 的位置与去重；历史消息（含旧轻提示记录）可读；`/goal status` 与 GetGoal 输出；base.md 静态规则；压缩分组与缓存身份；转义行为。
- **断言改写而不是整段丢失**：`ui-inprocess.contract.test.ts:7528` 用例里"普通输入打断 goal"的主体由 improve-2 的用户排队改写处置，本批只删其中的轻提示断言（已与 improve-2 作者确认分工：两边不改对方的断言）；`injection.unit.test.ts` 只删轻提示 describe，注入/转义用例保留。
- **前批不动**：watchdog（1）、排队优先与打断分支删除、token 删除与统计（2）、blocked 与恢复（3）、steer 与未消费输入（4）本批只回归，不重做、不回退。

## 4.5 全链组合验收（本批收尾，不设第 6 批）

| 组合 | 引用 | 断言 |
| --- | --- | --- |
| 准入轮号 = 显示轮号 | A3 + U1 | 显示 `turn N` 与正文轮号一致；等待或运行期间实改 objective 后，新 epoch 的下一准入使用新正文，轮号/统计不重置；同文 no-op 不换代（A10） |
| 旧轮迟到不改数字 | A6/A7 + U6 | 同一 goal pause→resume 后，旧轮的已知 usage 仍可结算并更新该目标数字；被 replacement 替代后，旧 usage 不得写入新目标、不改新目标数字与归属 |
| blocked/恢复与数字共存 | B3/B4 + U7 | 面板可恢复且显示轮次/停止时长；composer 带参、反序与非法尾部回归不丢参数，不因恢复重置数字 |
| 完成后无陈旧目标 | C1/C4 + U5 | complete 清理后常驻 UI 不再出现该目标，重连快照一致 |
| steer 与展示不混淆 | S1/S6 + U1/U3 | steer 的输入仍显示用户原文；goal 续跑只显示短提示；两者不互相覆盖；最终 steered 更新到达，队列项消失，completion waiter 结算（S4-20/S4-21） |
| 完成结算失败恢复 | C7 + U5/U6 | 从现有恢复入口补写 usage/clear，数字不重复、complete 不复活，已有 run finalization 恢复不被覆盖 |
| 截止与子代理范围 | D4/D5 + S6 | goal 等待用户工作时到点，只改变 goal；用户主 run 和子代理继续；旧回调不误伤后继 root；正文实改后仍按原累计时长截止，可停止同目标尚在收尾的旧 epoch run |
| 提醒/查询口径 | U9 + improve-2 | token 只出现在查询，常驻 UI 与自动提醒没有 token |
| 请求保护与展示无耦合 | W1–W7 + U1 | watchdog 超时/截止/取消不改变计轮口径：未准入的等待为零轮，已准入后失败或超时仍计且只计一次；视野里不出现多出的轮次或脏数字 |

发布门：a) 本批 U1–U14 全部有测试或手工证据；b) 前批成果未被本批回退（blocked 投影、token 缺席、steer 可见性、完成清理）；c) 类型、构建与生成物同步；d) [02](./02-optimization-plan-and-change-scope.md) §2.7 的模块文档同步清单执行完毕。

## 4.6 对抗性审查要点

| 攻击面 | 防御 | 残余风险 |
| --- | --- | --- |
| 短提示文案漂移或 adapter 二次生成 | 单一生成点；U1 断言 live/replay 一致 | 与前批文案基线的对齐需在实施时核对 |
| 标题被短提示污染 | U4 + 保留 `firstUserMessage = 正文` 的检查 | 标题生成是异步的，需断言实际落库标题 |
| 删除轻提示留死引用或误删共用件 | U14 + 引用链核对；保留清单见 02 §2.3 | `promptTextForModel` 顺带刷新若有隐藏消费者，需在实施时确认 |
| criterion 校验顺序被写成"先替换再校验" | U11 断言无新记录、原目标不变 | 非 BMP 字符的 UTF-16 length 易写错，用 U10 固定 |
| 三路径投影只改一处 | U5 同测初始快照、事件、重连 | 重连快照路径需真实验证，不能只测内存 store |
| 数字更新触发 notice 刷屏 | U6 断言只更新投影 | 需与 improve-2 的静默刷新实现一起核对 |

## 4.7 手工与真实接口（本次不执行）

手工项：CLI 常驻行在窄终端、Web 面板在窄屏的换行；paused/blocked 的停止值；长 objective 的截断与展示；`/goal` 首轮会话标题。

真实接口项：按 plan/04 §4.9 的相关部分，用独立数据目录与测试会话走一轮 goal 首轮 + 续轮，确认显示与请求正文分离、标题正确、无 goal 前缀；凭据不写入参数、日志、文档或审查提示。本次文档修订不执行产品真实请求、不改业务代码；此前独立 Pi 审查不作为产品验收。
