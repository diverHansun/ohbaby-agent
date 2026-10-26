# 后端实施与验收

状态：后端 Stage 1、2 完成，待用户检查与前端实施；尚未合并 main。

日期：2026-10-26。实施分支：`codex/session-model-backend`，基线：`18eb1f04`。

## 分工与范围

按本次会话更新：agent 完成 Stage 1、2 的后端、测试、子代理审查；用户检查后端并实施 Web/TUI。全部完成后再合并 main。本次不合并、不推送。

Web 仅同步 SDK 所要求的传输方法、开发 mock 和测试夹具；聊天菜单、Settings、reasoning 控件以及 TUI 交互仍由后续前端实施完成。

## 实施记录

| 批次 | 内容 | 状态 |
| --- | --- | --- |
| 0 | 六份规划文档纳入分支，更新分工和可选 key 文案 | 已提交 `59f1dff1` |
| 1 | 每模型参数、旧文件迁移与备份、条目解析与配置加载 | 已提交 `e6d0ae6c` |
| 2 | 会话与提交快照、迁移 027、SDK/HTTP/RPC、RunModel 与适配器整合 | 已提交 `09e33438` |
| 3 | 跨层场景与竞态验收测试 | 已提交 `d94c9812` |
| 4 | 全量检查、审查修复、交接记录 | 已完成；本文件与 README 随最终文档提交归档 |

## 语义与兼容

- 提交记录有条目 id 时按该条目执行；留空时使用执行时的全局默认，不回读会话选择。
- 首条提交可以持久化预选模型；之后单条提交覆盖不改会话。首条判断同时检查历史消息和已接受的提交记录。
- 运行中切换仅影响后续轮次；标题、摘要和子代理沿用父轮捕获的客户端。
- 模型文件修改不重建运行时；env 等其他域的重建规则保留。
- 模型文件只写 `activeProfileId`、`models`。旧文件读取只在内存中迁移，首次覆盖前备份原始字节。
- key 可以为空；缺地址、协议或显式标记未完成才属于配置不完整。
- 不兼容的 reasoning 在执行前回退至条目默认并提示。

## 审查记录

| 发现 | 处理 |
| --- | --- |
| 已设 reasoning 的空会话首条提交可能漏存模型 | 首条判断与 reasoning 是否已有值分开，保留既有 reasoning 的单次覆盖语义 |
| 提交模型与 reasoning 分别读取会话，可能读到不同版本 | 一次提交复用同一个会话快照 |
| 第一条仍排队时，第二条覆盖可能被误认成首条并改写会话 | 增加提交记录存在性检查，新增失败后通过的回归测试 |
| 删除全部模型或条目变不完整后，刷新失败保留旧窗口 | 刷新失败也清理会话用量及缓存统计 |
| 旧轮完成后或排队旧轮启动时覆盖切换后的窗口及统计 | 显示跟随当前会话选择，按捕获的模型身份过滤旧轮用量；两类竞态回归通过 |
| 查看新模型窗口时，旧轮迟到的 calibration / compaction floor 污染新模型 | 上下文 scope 内按模型对象保存状态；检查模型与执行模型分离，迟到反馈写回所属模型 |
| 能力探测后保留与输出上限冲突的 reasoning 默认预算 | 按条目输出上限重新验证，不兼容默认清除，保留已探测能力 |
| 同请求 ID 并发重试时派生模型或 reasoning 不同，原子存储误报冲突 | 区分显式覆盖与派生快照；内存 / SQLite、单 / 双调度器八个回归通过，显式覆盖冲突仍保留 |

三名子代理完成配置、运行时、存储及接口的交叉审查；上述发现均已修复，最终只读复查无新增问题。

## 验证记录

- 修改前 `pnpm typecheck` 通过；提交钩子 lint 为 0 错误、122 条已有警告。
- 配置专项：22 文件、229 测试通过。
- 存储及接口专项：28 文件、507 测试通过；追加传输验证 7 文件、241 测试通过。
- 独立适配器验收：7 场景通过，覆盖标题/自动及手动摘要、reasoning、项目环境变量隔离、排队删除回退。
- 独立子代理继承测试直接使用生产 composition；旧单模型测试通过仅测试工具适配新接口。
- goal 自动续跑切换模型、当前轮 steer 保持原模型：2 个实际 goal 场景通过。
- 真实用户格式文件的临时副本迁移通过：读取不写盘、首次备份字节一致、二次写入不重复备份、用户原文件未变化。
- 全仓 `pnpm typecheck`、改动 TypeScript 文件 Prettier 检查通过。提交 hook 的 lint 0 错误、117 警告（基线为 122 警告）。
- `pnpm test:contract`：37 文件、571 测试通过。
- `pnpm test:unit`：378 文件、4706 测试通过，2 条既有跳过。
- `pnpm test:integration`：202 文件、1892 测试通过（448.43 秒）。
- 未运行真实 provider 请求；自动化的 HTTP/SDK/CLI 测试使用本地假服务。Web/TUI 界面验收仍待前端实施。

## 前端交接

- `updateSessionModel({ sessionId, modelEntryId: string | null })`：更新会话并发布 `session.updated`。
- `getCurrentModel({ sessionId? })`：返回解析后的条目 `id`、`source` 和能力；无参数返回默认。
- 首次提交可以携带 `modelEntryId`。普通会话切换应调用会话接口。
- Settings 条目带 `reasoningDefault`，创建/修改接受 `reasoning`，全局 `params` 删除。
- `selectDefaultModel(entryId)` 供 TUI 后续接线，返回 `{ ok: true, ...models }`。
- 前端发布门仍为 04 中 T19–T27；本次后端完成不等于这些界面场景已验收。

## 测试定位

| 验收范围 | 主要测试 |
| --- | --- |
| T1–T3、T14b、T18b 配置、迁移与自动默认 | `config/llm/__tests__/session-model-config.integration.test.ts` 与既有 model-document / settings 测试 |
| T4–T8、T12、T12b 解析、删除回退、配置更新与排队 | `adapters/session-model.integration.test.ts`、`model-switch.integration.test.ts` |
| T9–T10 窗口、校准与摘要 | `core/context/run-model.integration.test.ts`、`adapters/session-model-acceptance.integration.test.ts`、`session-model-usage.integration.test.ts`，以及既有压缩 / 溢出恢复测试 |
| T11 子代理继承 | `adapters/ui-runtime/session-model.integration.test.ts`，以及既有 subagent / permission / goal 生命周期测试 |
| T12c goal 与 steer | `adapters/session-model-goal.integration.test.ts` |
| T13–T14 reasoning 兼容与默认 | `adapters/session-model-acceptance.integration.test.ts` |
| T15–T18 持久化、HTTP、RPC、幂等 | `runtime/prompt-scheduler/model-persistence.integration.test.ts`、`model-replay-review.unit.test.ts`、server 的 create-app / daemon / settings-global 测试 |

表内 `config/`、`adapters/`、`core/`、`runtime/` 均以 `packages/ohbaby-agent/src/` 为根。D4（模型配置数据模型）已同步；D1–D3 的 Web 文档应随前端实现同步，不提前描述尚未完成的 UI。

## 改动面质量评估

`RunModel` 将模型客户端、预算和摘要能力明确绑到一次运行，减少了 Lifecycle 对全局配置的隐式依赖；客户端池独立在 `ui-inprocess/model-client-pool.ts`，读取与创建分开，查询当前模型不触发客户端工厂。生产接口要求显式传入运行模型，旧夹具的默认模型便利函数只留在 `core/testing/`。

本轮保留了既有适配器、调度器和 store 边界，没有额外引入通用配置框架。主要维护代价仍在较大的 `ui-inprocess.ts`：选择、回退和缓存通知跨多个入口，需要保留本轮的并发验收测试。未为形式上的分层另做大范围拆分；后续前端接线应使用 SDK 方法，不直接操作配置或运行时。
