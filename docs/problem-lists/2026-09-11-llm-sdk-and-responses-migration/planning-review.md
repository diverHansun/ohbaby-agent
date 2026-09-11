# 规划文档一致性与可实施性检查

## 检查结论

- 文档一致性：通过。
- 方案可实施性：有条件通过。
- 条件：实施时必须完成 function-tool 类型边界收窄和 Anthropic usage fixture 适配，并以完整 `pnpm preflight` 为验收门禁。
- 当前状态：仅完成调查与规划，不代表 SDK 升级已经验收。

## 1. 文档一致性检查

已核对全部规划文件：

- `investigation/` 与 `improve-1/` 的职责没有交叉；
- 目标版本统一为 OpenAI `7.13.0`、Anthropic `0.124.0`；
- 所有文档都明确 `improve-1` 不实施 Responses；
- lifecycle、context/cache 和 SQLite 的影响判断一致；
- 调查中的未来架构建议没有被写成当前实施步骤；
- README 导航与相对链接有效；
- 全部 Markdown 通过 Prettier 检查。

## 2. 源码对应检查

已对照当前源码确认：

- provider 工厂当前只有 `openai-compatible` 与 `anthropic`；
- OpenAI adapter 使用 `chat.completions.create()`；
- Anthropic adapter 使用 `messages.stream()`；
- 没有 `/v1/completions` 或 `/v1/responses` provider；
- `ChatCompletionCreateParams["tools"]` 确实泄漏到 agents、lifecycle、context、llm-client 和 provider 类型；
- SQLite 持久化不保存官方 SDK response 原对象；
- 计划列出的主要文件与实际耦合点相符。

## 3. 隔离升级验证

临时副本中的实验结论：

| 检查 | 结果 | 含义 |
| --- | --- | --- |
| 当前仓库 baseline lint | 通过 | 升级后的 lint 问题不是既有基线失败 |
| 新 SDK 下定向运行测试 | 5 文件、78 项通过 | 现有 Chat/Messages 主行为未立即失效 |
| 新 SDK 下全量 Vitest | 大部分通过，最终失败 | packaging smoke 内部 build 暴露类型错误 |
| 新 SDK 下 build | 失败 | 必须适配 tool 联合与 Anthropic usage 类型 |
| 新 SDK 下 preflight | 失败 | 当前不能只改依赖后直接合入 |

普通增量 `tsc -b` 曾因复用构建状态表现为通过；`tsc -b --force`（由正式 build 执行）暴露了真实错误。因此实施验收不得用单次增量 typecheck 代替强制 build。

## 4. 方案可实施性判断

方案在当前边界内可实施，理由是：

- Node.js engine 满足两套目标 SDK 的 runtime 要求；
- 当前 API 调用在新 SDK 中仍存在；
- 运行测试表明主要 stream 行为没有整体断裂；
- 编译失败点集中且能通过项目自有窄类型、provider 边界收窄和 fixture 更新解决；
- 不需要数据库 migration，也不需要更改 agent loop 控制流。

尚未证明的部分：

- 两家真实服务在目标 SDK 下的端到端连接；
- 用户使用的各 OpenAI-compatible 中转站对现有扩展字段的兼容性；
- 修复完成后的完整 preflight。

这些未证明项已进入测试验收门禁，不作为规划阶段“已通过”处理。

## 5. 范围守卫

实施中若出现以下任一条件，方案应退回审核：

- 必须改变内部消息历史或 SQLite schema；
- 必须修改 lifecycle 双循环、context 压缩或 cache key 行为；
- 必须新增 Responses/provider kind 才能完成 SDK 升级；
- 需要广泛接受 OpenAI/Anthropic 的所有 tool 联合成员，而不是维持本项目 function-tool 能力边界；
- 目标 SDK 版本在实施前发生变化且带来新的迁移要求。
