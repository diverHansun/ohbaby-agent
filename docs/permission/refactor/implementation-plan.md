# Permission 重构实施计划（已决策版）

本文档是后续代码实施的执行清单。实施前必须新建临时分支；本文档本身只描述计划，不代表已经创建分支或改动代码。本文使用 UTF-8 编码。

---

## 一、实施原则

1. 严格按阶段推进，先纯逻辑和测试，再切主链路。
2. 每个阶段都保留可验证状态，避免“大爆炸式”不可定位失败。
3. 不保留旧 `policy` 兼容层；Phase 4 一次性切契约，避免 SDK/UI 编译断裂。
4. 测试先行：每个新模块先写行为矩阵测试，再实现。
5. 真实数据流必须覆盖 e2e，使用根目录 [ohbaby-e2e-test.md](../../../ohbaby-e2e-test.md) 的本地配置说明，但不得在日志、提交或总结中输出真实 API key。

建议实施分支：

```bash
git switch -c codex/permission-policy-refactor
```

---

## 二、文件改动清单

### 2.1 新增

| 文件 | 责任 |
|------|------|
| `packages/ohbaby-agent/src/permission/state.ts` | `PermissionState` 单例、mode/level setters、sessionRules Map、事件发布 |
| `packages/ohbaby-agent/src/permission/rule.ts` | lowercase Pattern DSL parser/formatter、rule 构造 |
| `packages/ohbaby-agent/src/permission/classifier.ts` | ToolCall 分类，区分 memory-read/write、bash 子类、skill/subagent |
| `packages/ohbaby-agent/src/permission/evaluator.ts` | 唯一纯函数判定入口 |
| `packages/ohbaby-agent/src/permission/state.unit.test.ts` | state 行为与事件测试 |
| `packages/ohbaby-agent/src/permission/rule.unit.test.ts` | DSL parser/formatter 测试 |
| `packages/ohbaby-agent/src/permission/classifier.unit.test.ts` | tool 分类测试 |
| `packages/ohbaby-agent/src/permission/evaluator.unit.test.ts` | mode/level/rule/bash/memory/skill/subagent 矩阵测试 |
| `packages/ohbaby-cli/src/tui/dialogs/permission-selector.tsx` | level 选择器 |
| `packages/ohbaby-cli/src/tui/dialogs/permission-selector.unit.test.tsx` | selector 测试 |

### 2.2 修改

| 文件 | 改动 |
|------|------|
| `packages/ohbaby-agent/src/permission/types.ts` | 新增 `Mode`、`Level`、`Decision`、`PermissionRule`、`PermissionState` 等类型 |
| `packages/ohbaby-agent/src/permission/manager.ts` | 删除 approval Set / auto resolve 真相；always 写 `state.addSessionRule(sessionId, rule)`；`drainQueue(sessionId)` 重新 evaluate |
| `packages/ohbaby-agent/src/permission/matcher.ts` | 支持 typed `PermissionRule` 匹配，canonical lowercase |
| `packages/ohbaby-agent/src/permission/events.ts` | 删除 `AutoEditRequested`；新增 `ModeChanged`、`LevelChanged`、`RuleAdded` |
| `packages/ohbaby-agent/src/permission/index.ts` | 统一导出 state/rule/classifier/evaluator/types |
| `packages/ohbaby-agent/src/shell/preflight.ts` | 保留运行前路径解析、destructive root check、download-and-execute 安全检查 |
| `packages/ohbaby-agent/src/shell/command-classifier.ts` | 提供 `classifyShellCommand(parsed)`，输出 readonly/mutating/dangerous |
| `packages/ohbaby-agent/src/core/tool-scheduler/registry.ts` | 移除按 mode 过滤工具列表逻辑 |
| `packages/ohbaby-agent/src/core/tool-scheduler/constants.ts` | 移除或废弃 mode allowed categories |
| `packages/ohbaby-agent/src/core/tool-scheduler/scheduler.ts` | 改调 evaluator；保留 externalWrite/untrustedMcp 强制 ask |
| `packages/ohbaby-agent/src/core/system-prompt/*` | plan 模式注入约束提示；删除旧 ask/agentState 语义 |
| `packages/ohbaby-agent/src/adapters/ui-inprocess.ts` | 注入 permission state/evaluator；删除 policy manager 与 PolicyEvent 订阅 |
| `packages/ohbaby-agent/src/adapters/ui-runtime/composition.ts` | 根据 `permission.mode` 决定 prompt task kind / runtime 注入 |
| `packages/ohbaby-agent/src/commands/catalog.ts` | 删除 `/mode`；重写 `/permission` 为 level-only |
| `packages/ohbaby-sdk/src/snapshot.ts` | `policy` 字段改为 `permission` |
| `packages/ohbaby-sdk/src/events.ts` | 事件契约切到 PermissionEvent |
| `packages/ohbaby-cli/src/tui/store/*` | 读取 `snapshot.permission`，状态栏渲染 mode/level/rules |
| `packages/ohbaby-cli/src/tui/command/*` | Shift+Tab 二态切换；slash 补全与 hints 更新 |
| `docs/permission/*.md` | 实施完成后同步旧文档 |
| `docs/ohbaby-cli/tui-productization/policy-mode.md` | 废弃或替换为 permission-mode 文档 |

### 2.3 删除

| 文件/目录 | 删除原因 |
|-----------|----------|
| `packages/ohbaby-agent/src/policy/` | 职责全部迁移到 permission |
| `PolicyEvent.*` | policy 模块删除 |
| `PermissionEvent.AutoEditRequested` | 反向耦合删除 |
| `/mode` 命令实现 | 命令面严格分轴 |

---

## 三、目标接口草案

### 3.1 State

```ts
export interface PermissionStateStore {
  getState(): PermissionState;
  getMode(): Mode;
  setMode(mode: Mode): void;
  toggleMode(): Mode;
  getLevel(): Level;
  setLevel(level: Level): void;
  getSessionRules(sessionId: string): readonly PermissionRule[];
  addSessionRule(sessionId: string, rule: PermissionRule): void;
  clearSession(sessionId: string): void;
  toSnapshot(): UiPermissionState;
}
```

### 3.2 Evaluator

```ts
export interface PermissionCall {
  readonly sessionId: string;
  readonly callId: string;
  readonly toolName: string; // lowercase registered name
  readonly args: unknown;
  readonly category?: ToolCategory;
}

export function evaluate(call: PermissionCall, state: PermissionState): Decision;
```

### 3.3 Manager

```ts
export interface PermissionManager {
  requestApproval(info: PermissionApprovalInfo): Promise<SchedulerPermissionResponse>;
  respond(id: string, response: PermissionResponse): void;
  clearSession(sessionId: string): void;
}
```

`requestApproval()` 在进入 UI 前必须再次通过 evaluator 检查 sessionRule 命中；`respond(always)` 写 rule 后调用 `drainQueue(sessionId)`。

---

## 四、Phase 顺序

### Phase 0：类型骨架

目标：新增类型，不改变运行路径。

步骤：

1. 在 `permission/types.ts` 增加 `Mode`、`Level`、`Decision`、`PermissionRule`、`PermissionState`、`PermissionCall`。
2. 明确 `toolName` 为 lowercase canonical。
3. 补充 type-level 或 compile-only 测试。

验收：

- `@ohbaby/agent` TypeScript 编译通过。
- 无运行时代码接入。

### Phase 1：Evaluator + Classifier + Rule + 单测

目标：完成纯逻辑核心。

步骤：

1. 新建 `permission/rule.ts`，实现 lowercase DSL parse/format。
2. 新建 `permission/classifier.ts`，先支持非 bash 分类，并预留 `classifyBash`。
3. 新建 `permission/evaluator.ts`，实现 mode -> sessionRules -> level 三层。
4. 写表驱动单测覆盖 subagent、memory、skill、rules 优先级。

验收：

- `rule/classifier/evaluator` 单测全绿。
- evaluator 无副作用，不依赖 manager。

### Phase 2：Shell command-classifier 拆分 + 单测

目标：落实 bash readonly/mutating/dangerous 分类。

步骤：

1. 将旧 `shell/command-policy.ts` 拆分为 `shell/preflight.ts` 与 `shell/command-classifier.ts`。
2. `preflight.ts` 保留运行时 path 解析、destructive root check、workspace preflight 相关逻辑。
3. `command-classifier.ts` 提供 `classifyShellCommand(parsed)`，只暴露三档命令分类，不泄漏 shell 细节到 `permission/`。
4. 补充命令分类单测。
5. 接通 `permission/classifier.ts` 的 bash 子分类。

验收：

- readonly/mutating/dangerous 示例全部覆盖。
- 复合命令按最危险子命令计。
- 未知命令、`bash -c`、`xargs` 保守归 mutating，走 ask。

### Phase 3：State + Manager 改造

目标：把 always 真相迁移到 state。

步骤：

1. 新建 `permission/state.ts`，内部字段为：

   ```ts
   { mode, level, sessionRules: Map<string, readonly PermissionRule[]> }
   ```

2. 修改 `permission/manager.ts`：
   - 删除内部 `approvedFor` / approval Set 真相；
   - 删除 `AutoEditRequested` 发布；
   - `always` -> `state.addSessionRule(sessionId, rule)`；
   - `drainQueue(sessionId)` 对 pending 请求逐个调用 evaluator，命中才 resolve `"always"`。
3. `clearSession(sessionId)` 同时清理 pending UI 与 sessionRules。
4. 更新 events/index/matcher。

验收：

- state 单测覆盖 mode/level 正交、sessionId 隔离、事件 payload。
- manager 单测覆盖 once/always/reject/suggest/cancel。
- `always` 不触发任何模式/level 切换。

### Phase 4：契约层一次切换 + 删除 policy + Scheduler/SDK 同步

目标：避免 SDK 类型与 UI 编译断裂，主链路一次性切到 permission。

步骤：

1. 在 scheduler 中把 `policy.check` 改为 `permission.evaluate`。
2. 保留并验证：

   ```ts
   if (decision.type === "allow" && context.externalWrite) -> ask
   if (decision.type === "allow" && context.untrustedMcp) -> ask
   ```

3. registry 停止按 mode 过滤工具列表。
4. `UiSnapshot.policy` 改为 `UiSnapshot.permission`。
5. SDK event/snapshot contract 同步。
6. `adapters/ui-inprocess.ts`、`ui-runtime/composition.ts` 删除 policy manager 注入。
7. 删除 `packages/ohbaby-agent/src/policy/`。
8. 全仓搜索修复 `PolicyEvent`、`agentState`、`AutoEditRequested`。

验收：

- 编译通过。
- 业务代码无 `PolicyEvent`、`AutoEditRequested`、`agentState` 残留。
- `packages/ohbaby-agent/src/policy/` 不存在。
- plan/auto 工具列表一致。

### Phase 5：UI / 命令面

目标：TUI 与命令严格分轴。

步骤：

1. 删除 `/mode` 命令。
2. `/permission` 无参打开 selector；参数仅允许 `default` / `full-access`。
3. `Shift+Tab` 只切 `plan <-> auto`。
4. 状态栏显示：

   ```text
   mode: <plan|auto> · level: <default|full-access>
   ```

5. 有 session rule 时可追加：

   ```text
   · +N rules
   ```

6. Permission ask dialog 的 always 文案改为 pattern 粒度。
7. CLI flags 支持初始：

   ```text
   --mode plan|auto
   --permission default|full-access
   ```

验收：

- `/mode` unknown。
- `/permission plan`、`/permission auto` 报参数错误。
- headless 中途不支持动态切 mode。

### Phase 6：文档同步

目标：旧文档不再讲 policy 双模块。

步骤：

1. 更新 `docs/permission/goals-duty.md`、`architecture.md`、`data-model.md`、`dfd-interface.md`、`test.md`。
2. 废弃或替换 `docs/ohbaby-cli/tui-productization/policy-mode.md`。
3. 在 changelog 或 README 中说明用户面变化。

验收：

- 文档中旧 policy 表述被清理或明确标记为历史背景。
- 新模型与代码一致。

---

## 五、测试计划

### 5.1 单测

| 模块 | 必测内容 |
|------|----------|
| `rule` | DSL 小写解析、格式化、非法语法 |
| `matcher` | bash pattern、path glob、无 pattern、deny/allow 共存 |
| `classifier` | 工具名分类、memory read/write、skill/subagent、未知工具保守处理 |
| `evaluator` | mode/level 全矩阵、sessionRules、reason、full-access 不压 plan |
| `state` | mode/level 正交、sessionId 隔离、事件 payload、clearSession |
| `manager` | ask 队列、always 写 rule、drainQueue、无 AutoEditRequested |
| `command-classifier` | shell 分类表、复合命令、sudo wrapper、未知命令 |
| `preflight` | workspace path 解析、destructive root check、download-and-execute 防护 |

### 5.2 集成测试

| 场景 | 断言 |
|------|------|
| scheduler + evaluator | allow/ask/deny 流向正确 |
| scheduler safety gate | full-access 下 externalWrite/untrustedMcp 仍 ask |
| registry | plan/auto 工具列表完全相同 |
| snapshot | `permission` 字段存在，`policy` 字段不存在 |
| command surface | `/permission` level-only，`/mode` 不存在 |

### 5.3 E2E / 真实数据流

使用 [ohbaby-e2e-test.md](../../../ohbaby-e2e-test.md) 的本地 provider/model 配置执行，不输出密钥。

必跑真实场景：

1. 默认 `auto + default`：读工具直接执行，写工具 ask。
2. 写工具点 once：只本次通过。
3. 写工具点 always：生成当前 session rule；相同 pattern 通过；不同 pattern 仍 ask。
4. `Shift+Tab` 到 plan：写、memory-write、bash-mutating、subagent 被 deny；read、memory-read 通过；skill 走 ask。
5. `/permission full-access`：auto 下写、skill、bash-dangerous 由 evaluator allow。
6. full-access + external workspace write：scheduler 仍强制 ask。
7. full-access + untrusted MCP：scheduler 仍强制 ask。
8. 重启或新 session：旧 sessionRules 不泄漏。

记录数据流：

```text
ToolCall -> classify -> evaluate -> scheduler gate -> manager/requestApproval -> response -> state/sessionRules -> drainQueue -> execute/deny
```

### 5.4 子代理审查

代码实现和测试通过后，至少让子代理独立审查：

| 审查方向 | 重点 |
|----------|------|
| 安全/权限 | full-access 是否绕过安全闸；deny/allow 优先级；session 隔离 |
| 架构/API | policy 残留、SDK/UI 契约一致性、manager 是否重新持有真相 |
| 测试质量 | 是否存在 mock 套 mock、弱断言、矩阵遗漏 |

---

## 六、残留检查

Phase 4 后必须执行等价检查：

```text
rg "PolicyEvent|AutoEditRequested|agentState" packages
rg "from .*policy|/policy|src/policy" packages
rg "MODE_ALLOWED_CATEGORIES|allowedCategories" packages/ohbaby-agent/src/core/tool-scheduler
rg "\"ask\"|\"agent\"" packages/ohbaby-agent/src/permission packages/ohbaby-sdk/src packages/ohbaby-cli/src
```

说明：

- `"ask"` 仍可能作为 `Decision.type` 或 response 文案出现，检查时需人工区分。
- 文档中的历史背景可以保留，但实施完成后的正式 docs 需要同步。

---

## 七、风险与应对

| 风险 | 应对 |
|------|------|
| Plan deny 循环 | system prompt 注入约束；e2e 观察连续 deny 次数 |
| Bash 分类漏判 | 未知保守 mutating；dangerous case 单测覆盖；保留原 preflight |
| Scheduler 安全闸被误删 | Phase 4 单测和 e2e 专门覆盖 |
| Snapshot Map 不可序列化 | 内部 Map，snapshot 显式转数组 |
| `/permission` 与 mode 混用 | 命令测试覆盖非法参数 |
| 旧 policy import 残留 | rg 残留检查作为合并门槛 |

---

## 八、完成定义

只有同时满足以下条件，才算本轮完成：

- 代码删除 `policy` 模块，且编译/测试通过。
- evaluator 是唯一 permission 判定入口。
- manager 不持有 approval 真相。
- TUI/SDK/snapshot/commands 全部使用 `permission` 语义。
- 单测、集成测试、e2e、真实数据流检查通过。
- 子代理审查完成并处理阻塞意见。
- 文档同步完成。
