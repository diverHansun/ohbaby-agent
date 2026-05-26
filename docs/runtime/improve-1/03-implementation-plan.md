# Runtime MVP Cleanup and Hardening Plan

> 本文取代前一版「4 个 Phase / 7 周」计划。当前 MVP 先按 pi、opencode、kimi-code 这类交互式编程 CLI agent 的产品形态推进；Hermes 式 24/7 后台助手能力暂时不进入 MVP。

## 1. 当前决策

MVP runtime 的职责是把一次由用户发起的 agent run 做扎实：

- 接收用户触发的 run。
- 持久化 run、message、event、terminal state。
- 稳定地把 worker event 转换为 stream 和 ledger projection。
- 在失败、取消、权限拒绝、资源清理路径上保持一致。
- 保留 `permissionProfileId` 作为 run record / hook metadata；runtime 不解释 profile 语义，也不把它下钻到 lifecycle、tool scheduler 或 policy。

MVP 不做 scheduler、heartbeat、background task、follow-up、channel trigger。这些设计可以保留为 post-MVP 参考，但不应该继续以 NOOP、空 store、空 schema、空 policy 配置的方式停留在运行时代码里。

判断标准：

- 如果一个 runtime surface 没有用户路径、没有消费者、没有闭环测试，它就不属于 MVP。
- 如果一个能力只有 schema 或类型，没有真实执行者，它就是 zombie surface，MVP 应该移除。
- 如果一个功能会影响 run 的可靠性、可观测性、权限安全或测试确定性，它属于 runtime MVP。

## 2. MVP 范围

### 必做

1. Runtime 代码卫生
   - 清除 NOOP lifecycle component。
   - 删除未被真实使用的 scheduler / heartbeat / task manager runtime 入口。
   - 收窄 `TriggerSource` 到当前真实用户路径。
   - 从默认 policy 中移除 scheduler、heartbeat、channel、follow-up 等未触发来源。
   - 从当前 schema 移除 `scheduler_job`，并提供旧库升级时的 drop migration。

2. Run backend 加固
   - 明确 run 状态机和 terminal state。
   - 统一错误序列化、limit normalize、时间戳、projection 行为。
   - 覆盖 sandbox acquire/release、worker failure、ledger failure、stream publish failure、cancel/interrupt cleanup 等路径。
   - 保证 in-memory backend 和 persistent backend 的行为一致。

3. Permission profile 边界校准
   - runtime 只保存 opaque `permissionProfileId`，并只把它暴露为 run record / hook metadata。
   - profile registry、builtin profile、profile-aware policy wrapper 不放在 runtime。
   - `allow / ask / deny`、审批模式、规则匹配、profile 语义后续进入 `permission` 领域设计。
   - 本轮不扩大 `policy` / `permission` 改动面；后续再评估把 `policy` 合并进 `permission` 的规则 / policy 插件体系。

4. 测试和审核
   - 单元测试覆盖状态机、`permissionProfileId` metadata 边界、policy gate、错误归一化。
   - 集成测试覆盖 RunManager + RunWorker + RunLedger + StreamBridge。
   - persistent backend 测试必须使用真实 sqlite store。
   - 真实 API e2e 作为 release gate，不用 mock provider 替代。
   - 实现完成后进行子代理审核，重点审查 runtime 边界、权限语义、测试是否真实。

### 不做

- scheduler engine / reminder / cron / min-heap。
- heartbeat tick loop / sleep / resume。
- daemon background task manager。
- hook 责任链重构。
- context improve-2。
- ohbaby-tui 到 ohbaby-cli 的重命名和架构重组。
- Hermes 型后台助手产品闭环。

## 3. Deferred 决策

`docs/runtime/scheduler/`、`docs/runtime/heartbeat/`、`docs/runtime/tasks/` 的设计不是技术上错误，而是默认了更宏大的产品场景。MVP 暂时不实现，也不保留运行时代码骨架。

后续重新评估的触发条件：

- 产品明确要求 24/7 后台助手。
- 用户需要自然语言 reminder / follow-up / scheduled job。
- daemon 需要在没有当前交互 run 的情况下主动发起工作。
- 有真实 CLI 或 UI 入口消费 scheduler/heartbeat 数据。

如果这些条件没有出现，runtime 不应该维护相关 schema、policy、生命周期入口。

## 4. 实施顺序

### Phase A - 文档和边界确认

目标：把 MVP 决策写清楚，避免开发时继续按旧的 7 周大计划扩散。

验收标准：

- improve-1 文档明确写出 MVP 做什么、不做什么、为什么。
- scheduler / heartbeat / tasks 被标记为 post-MVP deferred，而不是 MVP backlog。
- 测试验收标准包含单元、集成、persistent backend、真实 API e2e、子代理审核。
- 后续开发分支从该文档边界出发，不先改 context 和 ohbaby-cli。

### Phase B - 清除 zombie runtime surface

目标：让 runtime 当前代码只暴露真实可执行路径。

预计修改点：

- `packages/ohbaby-agent/src/runtime/daemon/bootstrap.ts`
- `packages/ohbaby-agent/src/runtime/daemon/types.ts`
- `packages/ohbaby-agent/src/runtime/run-ledger/types.ts`
- `packages/ohbaby-agent/src/runtime/run-manager/policy.ts`
- `packages/ohbaby-agent/src/services/database/migrations.ts`
- `packages/ohbaby-agent/src/services/database/schema.ts`
- 相关测试和导出文件

验收标准：

- 代码中不再存在 runtime NOOP lifecycle component。
- `TriggerSource` 只包含当前真实路径。
- `DEFAULT_POLICY` 不再声明 scheduler、heartbeat、channel、follow-up。
- 当前 schema 中没有 `scheduler_job` 表；升级迁移会删除旧库里已经存在的遗留 `scheduler_job` 表。
- 类型检查能阻止创建 scheduler / heartbeat / channel / follow-up 来源的 run。
- 现有 run、message、event、session 持久化测试仍通过。

### Phase C - Run backend 加固

目标：让 run 生命周期在成功、失败、取消和资源清理路径上可预测、可测试。

建议改造：

- 抽出 run 状态机，集中定义合法状态迁移。
- 抽出 runtime shared utility：错误归一化、JSON 安全序列化、limit normalize。
- 明确 worker event 到 ledger event / stream event 的映射。
- 明确 sandbox acquire/release 的 finally 语义。
- 明确 stream publish 失败是否影响 run terminal state，并用测试固定行为。

验收标准：

- run 成功时：
  - ledger 记录 terminal state。
  - stream 完整发布开始、增量、结束事件。
  - active run 被清理。
  - sandbox 被释放。

- run 失败时：
  - 原始错误被归一化为稳定 message / code / cause。
  - ledger 记录 failed terminal state。
  - stream 发布 failure 事件。
  - active run 被清理。
  - sandbox 被释放。

- run 取消时：
  - cancel 请求可以到达 worker。
  - ledger terminal state 与 stream terminal event 一致。
  - 重复 cancel 不产生脏状态。

- backend 一致性：
  - in-memory backend 和 sqlite-backed backend 在 projection、排序、limit、terminal state 上表现一致。
  - createdAt / updatedAt / completedAt 不出现倒序或缺失。

### Phase D - Permission profile 边界清理

目标：让 runtime 不拥有 permission / policy 语义。MVP 阶段 runtime 只保留 run defaults
中的 `permissionProfileId` 字符串作为记录字段和 hook metadata；不解释、不校验、不向 policy
注入 profile 语义。

明确不做：

```text
packages/ohbaby-agent/src/runtime/permission-profiles/
```

建议边界：

- `RunManager` 合并默认值后得到 `permissionProfileId` 字符串。
- `RunManager` 的 `RunRecord` 可以记录这个 id，用于当前进程内可观测性和后续迁移。
- `RunHookContext` 可以暴露这个 id，便于未来外层组合。
- `RunWorker` 不把它继续下钻到 lifecycle / tool scheduler。
- profile 真实语义后续进入 `permission` 领域，并考虑把现有 `policy` 合并进 permission 的规则 / policy 插件体系。

验收标准：

- `runtime` 目录下不再存在 permission profile registry / builtin / wrapper。
- runtime 类型不导出 `PermissionProfile` 或 `ProfileRegistry`。
- runtime tests 不 mock profile registry。
- `policy` 本轮不新增 `permissionProfileId` 字段或 profile 判断逻辑。
- profile 真实语义的实现文档和测试后续落在 `permission` 模块，而不是 runtime 或本轮 `policy` 改造。

## 5. 测试矩阵

### 快速本地门禁

每次 runtime 修改后至少执行：

```text
pnpm typecheck
pnpm test
```

如果仓库已有更细分脚本，优先使用现有脚本名，但不能用「没有脚本」作为跳过测试的理由；需要在文档或提交说明里记录实际执行的替代命令。

### 单元测试

必须覆盖：

- run 状态机合法 / 非法迁移。
- error normalize。
- safe JSON serialization。
- ledger projection limit / ordering。
- `permissionProfileId` 只作为 run record / hook metadata 保留。
- runtime 目录边界测试防止重新引入 `runtime/permission-profiles`、`ProfileRegistry` 或 profile-aware policy wrapper。

### 集成测试

必须覆盖：

- RunManager 创建 run。
- RunWorker 正常完成。
- RunWorker 抛错。
- cancel / interrupt。
- stream subscriber 接收 terminal event。
- sqlite-backed backend 的 reload / projection。
- sandbox acquire / release 的成功与失败路径。

### 真实 API e2e

真实 API e2e 不默认运行，但在 MVP merge / release 前必须运行。不能用 fake provider、mock LLM、snapshot 文本替代。

建议开关：

```text
OHBABY_REAL_API_E2E=1
```

前置条件：

- 使用真实 provider API key。
- 使用真实模型调用。
- 使用临时 workspace。
- 使用 sqlite-backed persistent backend。
- 测试完成后保留可检查的 run ledger / event 日志。

最小验收用例：

1. Simple run
   - 输入一个无工具需求的短任务。
   - 断言 run 进入 completed terminal state。
   - 断言至少产生一条 assistant message。
   - 断言 ledger 和 stream terminal event 一致。

2. Read-only workspace run
   - 临时 workspace 内创建包含固定 sentinel 的文件。
   - prompt 要求 agent 读取该文件并只回答 sentinel。
   - MVP 阶段使用现有 permission / policy gate；如果 post-MVP 已实现 profile 语义，再追加 `read-only` profile 覆盖。
   - 断言最终 assistant message 包含精确 sentinel。
   - 断言 workspace 没有新增、删除、修改文件。
   - 断言没有 write / destructive shell / git mutation 权限被批准。

3. Permission denial run
   - 使用现有 permission / policy gate 构造拒绝路径；如果 post-MVP 已实现 profile 语义，再追加 profile 拒绝路径。
   - prompt 明确要求修改文件。
   - 断言修改被拒绝。
   - 断言 workspace 文件内容未变化。
   - 断言 run 不因为权限拒绝导致 backend 崩溃；terminal state 必须可解释。

4. Persistent reload
   - e2e 完成后重新打开 sqlite backend。
   - 断言 session、run、message、event 可以恢复。
   - 断言 terminal state、timestamps 保持一致。
   - 当前 MVP 不要求 sqlite ledger 持久化 `permissionProfileId`；若后续 permission 重构需要持久化 profile metadata，必须先补 schema / migration / reload 测试。

通过标准：

- 上述用例全部通过。
- 没有为了适配模型不稳定而降低断言，只允许对自然语言措辞做宽松匹配；权限、文件副作用、terminal state、持久化必须精确断言。
- 失败时必须保留 provider request id、run id、ledger event、workspace diff 供排查。

## 6. 子代理审核

实现和测试通过后，进入 commit 前必须做一次独立审核。审核不替代测试，也不允许只看 diff 摘要。

审核重点：

- 是否仍有 scheduler / heartbeat / task manager zombie surface。
- run terminal state 是否存在分叉或吞错。
- `permissionProfileId` 是否只停留在 runtime run record / hook metadata；后续 profile 真实语义是否已记录到 `permission/improve-1`。
- 测试是否覆盖失败路径和 persistent backend。
- 真实 API e2e 是否有明确前置条件、日志、失败证据。
- 是否误动 context improve-2 或 ohbaby-cli refactor 范围。

审核结论需要写入开发总结：发现的问题、处理结果、剩余风险。

## 7. 分支和提交策略

建议新分支：

```text
codex/runtime-mvp-hardening
```

策略：

- 先提交文档边界。
- 再按 Phase B / C / D 开发。
- 每个阶段完成后跑对应测试，不把测试债留到最后。
- 全部本地门禁、真实 API e2e、子代理审核完成后再做实现提交。
- 本轮只提交，不 merge。
