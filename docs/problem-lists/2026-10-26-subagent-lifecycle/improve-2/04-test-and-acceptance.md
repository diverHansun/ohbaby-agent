# 4. 测试与验收：子代理实例的读取与控制后端

> 实施验收要求，不是已通过的测试报告。测试分层和方法沿用 [improve-1/04](../improve-1/04-test-and-acceptance.md) 的 4.1。"来源"一列是拆分前在 improve-1 里的编号。

## 4.1 验收项

| ID | 来源 | 场景 | 必须观察到的结果 | 主要层级 |
| --- | --- | --- | --- | --- |
| I2-01 | 原 A27（SDK 部分） | 同一实例跨多个主轮次 send 多次；会话里保留超过 50 个实例；列表刷新失败 | 一实例一行，不丢旧实例；刷新失败不清空、不推断关闭；状态是真实状态，带任务说明、时间、是否等审批、是否收尾中和未处理消息条数；core 枚举没有 Active/Done | SDK contract + integration |
| I2-02 | 原 A29（server/SDK 部分） | close 一个正在运行的实例，以及一个已完成、之后没有新 execution 事件的实例 | 两种情况列表都移除，旧列表合并后也不会再出现；UI 详情接口拒读；主模型 monitor 仍能读历史 | server + SDK integration |
| I2-03 | 原 A26（停止部分） | 主代理空闲时停止某个子执行；主代理正在前台等待时停止；带旧 execution 身份的迟到停止；跨会话停止 | 不依赖主执行，不调用主会话 abort；迟到请求返回实际状态，不停新执行；回执区分已受理和已确认；跨会话被拒 | SDK contract + integration |
| I2-04 | 原 A28（SDK 部分） | 带 `anchorExecutionId` 读取一个已经续跑过的实例 | 定位到历史位置；当前状态不被旧事件覆盖；之后的实时消息能收到 | SDK integration |
| I2-05 | 原 A30（SDK 部分） | 释放 watch；切换主会话 | 子执行继续，结果照常交付；旧 watch 和迟到响应不污染新会话；重新订阅读到的是真实的当前状态 | SDK integration |
| I2-06 | 原 A32（CLI 部分） | CLI 使用旧的 execution reader | 照常工作 | regression |

## 4.2 复用的测试

优先扩展现有测试，不另造目录：

- `packages/ohbaby-agent/src/adapters/ui-inprocess/subagent-*.integration.test.ts`：实例投影、历史、watch、分页。
- SDK readers 和 server `subagents` 路由的现有测试：契约、权限、关闭后拒读。
- 保留现有的分页、迟到事件、revision 测试，只改被新契约替代的断言。

定向命令示例（新增或改名测试文件时相应调整）：

```sh
pnpm exec vitest run packages/ohbaby-agent/src/adapters/ui-inprocess/subagent-views.integration.test.ts packages/ohbaby-agent/src/adapters/ui-inprocess/subagent-conversation-history.integration.test.ts
```

## 4.3 合并门槛

1. I2-01 到 I2-06 都有对应证据。
2. `pnpm typecheck`、`pnpm lint`、受影响的 unit/contract/integration 测试和 `pnpm test:smoke` 通过。
3. 后端接口没有接任何 UI；Web 现有行为（旧浮层）不变。

实施完成后在本目录写 `05-implementation-acceptance.md`。
