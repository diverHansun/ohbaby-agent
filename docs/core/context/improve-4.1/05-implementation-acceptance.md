# 5. 实施验收

> 验收日期：2026-08-22
>
> 基线：`main@6436c15`
>
> 实施分支：`codex/context-improve-4-1`
>
> 结论：**通过（自动化；仓库级 Prettier 基线例外已记录）**

---

## 5.1 实施结果

improve-4.1 已关闭 improve-4 遗留的 tools-aware 静态/手动计量缺口，并将主代理 `/status` 与手动 compact 后的 window projection 收敛为单一数据源。

| 规划阶段 | 状态 | 实际结果 |
|----------|------|----------|
| Phase 1：measurement / prompt / provider 工具流 | 完成 | `ContextMeasurementPayload` 显式携带 `messages + tools`；Lifecycle 每步只解析一次工具集合并派生 names/schemas；SystemPromptProvider 只消费 `toolNames` |
| Phase 2：primary static/manual 与 subagent 边界 | 完成 | 主代理静态查询和手动 compact 使用当前 agent 的完整 schemas；child 公开查询 unavailable；子代理实时 prepare/calibration/自动压缩继续按 scope 隔离 |
| Phase 3：status/window 单源 | 完成 | 删除内部 status 旧 `context` 字段和重复查询；manual compact 用 `usageAfter` 更新 tracker 并发布既有 `context.window.updated` |
| 审查修复：final request 一致性 | 完成 | finalization message 在 `prepareTurn` 前作为仅请求期消息进入所有阈值与压缩重测；`PreparedTurn.messages`、provider payload 与 calibration 分母一致且不污染 history |

本批没有新增 cache 命中/计数、context breakdown/UI、子代理 UI、memory hooks、存储迁移，也没有修改 prune/summary/mask 算法或生产压缩阈值。

## 5.2 分批提交

| 批次 | Commit | 内容 |
|------|--------|------|
| 1 | `97e02eb` | `docs(context): finalize improve-4.1 contracts` |
| 2 | `fb67033` | `refactor(context): unify measurement and prompt tool flow` |
| 3 | `3f0886d` | `fix(context): close primary static and manual usage paths` |
| 4 | `190a284` | `fix(context): unify status and compacted window usage` |
| 5 | `b222d45` | `fix(context): align final request measurement` |
| 6 | 本文提交 | 验收记录与审查后文档收尾 |

所有 commit 均位于临时分支；未 merge、未 push。

## 5.3 规划与实际差异

| 差异 | 原因 | 结果 |
|------|------|------|
| `PrepareTurnInput` 追加可选 `additionalMessages` | 独立审查发现旧 finalization message 在测量完成后才追加，导致真实 provider payload 与 calibration 分母不一致 | 该消息现在贯穿初始、mask 后、prune 后、summary projection、commit 后和最终 reduction 重测；不持久化 |
| 加强 I-2 / TC-10 / TC-8 / TC-1 测试证据 | 首轮用例存在间接断言或未真实命中 cache 的问题 | 改为历史突变后验证 tracker、真实 primary→child cache hit、精确四条 compact schema measurement、同 messages 只改变 schemas |
| 修正 `architecture.md` 的 0.85/85% 陈述 | 文档与现有 `COMPRESSION_THRESHOLD = 0.95` 冲突 | 只修文档为 0.95/95%，未修改生产策略 |

上述差异均用于闭合既定 measurement 契约，没有扩展 improve-4.1 产品范围。

## 5.4 TC-1 至 TC-16

| ID | 结果 | 自动化证据 |
|----|------|------------|
| TC-1 | 通过 | ContextManager 在完全相同 messages/toolNames 下，非空 schemas 的 heuristic/currentTokens 严格更大 |
| TC-2 | 通过 | manager calibration 用例验证 factor 作用于完整 `messages + tools` heuristic，未重复加算 schemas |
| TC-3 | 通过 | system prompt provider/assembler 测试；production 全仓无 `toolsProvider` |
| TC-4 | 通过 | Lifecycle unit + I-1 验证非最终步 names、measurement schemas、provider schemas 同源 |
| TC-5 | 通过 | final step 仍解析 names，measurement/provider `tools=[]`；finalization message 已在测量前加入 |
| TC-6 | 通过 | ContextManager scoped calibration 用例验证同 session 的不同 `contextScopeId` factor 隔离 |
| TC-7 | 通过 | `context-subagent-scope.integration.test.ts` 验证 child scope A 自动压缩不污染 scope B |
| TC-8 | 通过 | manual compact 精确观测四次 measurement，四次均携带同一 schema，且 `usageAfter < usageBefore` |
| TC-9 | 通过 | composition unit 验证 primary Session 的自定义 agentName 决定 names/schemas，并分别传给 assemble/getUsage/compact |
| TC-10 | 通过 | UI contract 先以 primary 身份真实写入 tracker，再把同 session 解析为 child；查询仍返回 `null` |
| TC-11 | 通过 | SDK contract 与静态 guard：公开 window 参数未新增 agentName/isSubagent/contextScopeId |
| TC-12 | 通过 | command service 只读取 `getContextWindowUsage`；status data 无旧 `context` |
| TC-13 | 通过 | I-2 在 compact 后追加大量未测历史，随后 `/status` 仍返回 compact tracker 值 |
| TC-14 | 通过 | compact contract/I-2 验证 tracker 的 token/model/limit 来自 `usageAfter` |
| TC-15 | 通过 | compact 发布 `context.window.updated`，event、tracker 与后续 status 值一致 |
| TC-16 | 通过 | rg + 双 reviewer：无 cache/breakdown/public subagent identity/storage/策略越界 |

## 5.5 自动化测试与发布门

| 命令 | 结果 |
|------|------|
| 受影响的 4 个测试文件 | **4 files / 191 tests passed** |
| `pnpm run test:integration` | **44 files / 290 tests passed**；I-1、I-2、I-3 均包含 |
| `pnpm test` | **280 files passed，3 skipped；2515 tests passed，13 skipped** |
| `pnpm run lint` | 通过 |
| `pnpm run typecheck` | 通过 |
| `pnpm run build` | 通过；SDK、agent、server、CLI、Web 全部构建成功 |
| `git diff main..HEAD --name-only -z \| xargs -0 pnpm exec prettier --check` | 分支改动文件全部通过 |
| `git diff --check` | 通过 |
| `pnpm run preflight` | 在首项 `format:check` 停止：43 个既有、未改文件不符合 Prettier；后续各门已按上表独立通过 |

Prettier 基线例外已做集合核对：`prettier --list-different` 返回 43 个文件；它们与 `git diff main --name-only` 的交集为 **0**，因此这些文件内容来自 main 基线而非本批。为避免污染用户工作树，本批没有批量格式化无关文件。

真实 provider/TUI 手工 smoke 未执行；本批没有新增展示 UI，关键闭环已由真实模块接线的 I-1/I-2/I-3 与全量回归覆盖。

## 5.6 独立子代理审查

### Reviewer A：correctness / data flow

首轮发现一个 Major：finalization message 在 `prepareTurn` 后追加，使 provider prompt_tokens 包含该消息，而 calibration denominator 不包含。`b222d45` 将其改为仅请求期 `additionalMessages` 并贯穿全部重测。复核结果：**Critical none / Major none / Minor none**，旧 finding 与 TC-10 cache 证据均关闭。

### Reviewer B：SWE / scope / tests

首轮发现两个 Major（同一 final payload 问题、I-2 证据不足）与三个测试/文档 Minor。`b222d45` 加强生产契约和测试后，复核确认所有行为 finding 关闭；仅剩架构示例中的 `0.85` 文档 Minor，现已改为 `0.95`。最终状态：**无未处理 Critical/Major/Minor**。

审查同时确认：没有新 transport/measurement 双抽象、ContextManager 未反向依赖 registry、status 旧双源已删除、没有混入 cache/breakdown/UI/memory/storage 或压缩策略修改。

## 5.7 后续顺序

1. 单独启动第一次 context 检查/压缩闭环：从数据结构、数据流检查手动压缩、自动压缩、剪裁与 prune，并对照 pi/opencode/kimi-code。
2. improve-5 独立分析并实施 prompt/cache 命中与 cache 计数。
3. cache 完成后再次复核 context 检查/压缩闭环。
4. 再进入主代理 context 占用监测、占比与 UI；子代理只保留内部自动压缩保护，不做用户展示。
5. 最后规划 memory / 长期记忆调用机制。

当前分支保持待用户审查状态，不合并 main、不推送远程。
