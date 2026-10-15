# goals 第 3 批测试入口

> 通过数量、真实 API 与人工检查结论统一见 [实施验收](../../problem-lists/2026-10-13-goals-upgrade/improve-3/05-implementation-acceptance.md)。本文件给维护者提供定位和复跑入口，不把源码存在当作测试已通过。

| 路径（仓库根相对） | 验证内容 |
| --- | --- |
| packages/ohbaby-agent/src/goals/budget-input.unit.test.ts | 严格双维解析、单位与边界、非法清除 |
| packages/ohbaby-agent/src/goals/budget.unit.test.ts | 合并预算、所有耗尽维度、安全阀 |
| packages/ohbaby-agent/src/goals/blocked-audit.unit.test.ts | 相邻轮、同轮去重、原因归一、第三次写失败重试 |
| packages/ohbaby-agent/src/goals/goal-lifecycle.integration.test.ts | 真实 service/store：审计资格/重置/隔离、双轴失败零修改、deferred 并发合并与 append 失败 |
| packages/ohbaby-agent/src/goals/goal-deadline.integration.test.ts | 真实 service/store：累计截止、旧 token、早到回调、预算变化、停止清理、保存期间不丢 active 用量 |
| packages/ohbaby-agent/src/adapters/goal-stopping.integration.test.ts | 真实 adapter/runtime：绑定前、启动前、runReady 交接截止；用户等待不中断；production watchdog 与 deadline 两种顺序 |
| packages/ohbaby-agent/src/adapters/goal-child-stopping.integration.test.ts | 真实 child host、signal 与存储：当前/旧 epoch goal 子树定点停止，用户子树保持，模型 blocked 主 run 收尾 |
| packages/ohbaby-agent/src/adapters/goal-blocked.contract.test.ts | blocked 在 session view、快照和事件中的一致投影 |
| apps/ohbaby-web/src/ui/goal-resume.integration.test.tsx | 渲染 App→真实 Web runtime→HTTP daemon→命令后端；参数顺序、非法尾部、空字段、错误保留、session 校验 |
| packages/ohbaby-server/src/runtime/daemon/goal-execution.e2e.test.ts | HTTP/SSE、SQLite、production tools/runtime：三轮门禁、重复报告、收尾、双维恢复重置；opt-in 真实 DeepSeek 完成 |

```bash
pnpm test:unit
pnpm test:contract
pnpm test:integration
pnpm --filter ohbaby-agent prompt:check
pnpm typecheck
pnpm exec vitest run --config vitest.e2e.config.ts packages/ohbaby-server/src/runtime/daemon/goal-execution.e2e.test.ts packages/ohbaby-server/src/runtime/daemon/model-idle.e2e.test.ts
# 明确付费测试：读取本机 .env，不输出 key 或请求正文
OHBABY_RUN_GOAL_REAL_E2E=1 pnpm exec vitest run --config vitest.e2e.config.ts packages/ohbaby-server/src/runtime/daemon/goal-execution.e2e.test.ts
```

历史关于 blocked 非常驻的设计记录继续保留原文；本批四态契约取代其对应结论。真实 provider 证据不能替代确定性竞态测试；关闭后的统计结算继续回归 improve-2 用例。
