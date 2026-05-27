# Permission 重构设计目标（已决策版）

本文档定义最终模型、判定矩阵、模块责任和关键 ADR。本文使用 UTF-8 编码。

---

## 一、核心目标

| 编号 | 目标 | 说明 |
|------|------|------|
| G1 | 单一判定入口 | 所有工具调用都先经 `permission.evaluator.evaluate(call, state)` |
| G2 | 二轴正交 | `mode` 表示能力层；`level` 表示审批层，互不诱导改变 |
| G3 | 会话级规则 | `always` 只写入当前 `sessionId` 下的 `sessionRules` |
| G4 | 删除 policy | `policy` 模块、`PolicyEvent`、`agentState`、`AutoEditRequested` 全部移除 |
| G5 | 工具列表稳定 | plan / auto 下 LLM 看到完全相同工具列表 |
| G6 | 安全闸分层 | external write 与 untrusted MCP 由 scheduler 保留强制 ask |
| G7 | 用户面简单 | `Shift+Tab` 只切 mode；`/permission` 只切 level |

---

## 二、最终领域模型

### 2.1 内部状态

```ts
export type Mode = "plan" | "auto";
export type Level = "default" | "full-access";

export type Decision =
  | { type: "allow"; reason?: string }
  | { type: "ask"; reason?: string; rememberable?: boolean }
  | { type: "deny"; reason: string };

export type RuleDecision = "allow" | "deny";
export type RuleScope = "session";

export interface PermissionRule {
  readonly tool: string;          // canonical lowercase registered tool name
  readonly pattern?: string;      // lowercase DSL payload or normalized path glob
  readonly decision: RuleDecision;
  readonly scope: RuleScope;      // MVP: "session"
  readonly reason?: string;
}

export interface PermissionState {
  readonly mode: Mode;   // global UI state
  readonly level: Level; // global UI state
  readonly sessionRules: Map<string, readonly PermissionRule[]>; // sessionId -> rules
}
```

约束：

- `mode` / `level` 是 CLI 全局 UI 状态，不按 session 隔离。
- `sessionRules` 按 `sessionId` 隔离。
- `clearSession(sessionId)` 删除对应 session 的全部 rules。
- evaluator 使用 `state.sessionRules.get(call.sessionId) ?? []`。
- SDK / UI snapshot 不暴露 `Map`，需要序列化为 JSON 友好的结构：

```ts
export interface UiPermissionState {
  readonly mode: Mode;
  readonly level: Level;
  readonly sessionRules: readonly {
    readonly sessionId: string;
    readonly rules: readonly PermissionRule[];
  }[];
}
```

### 2.2 Pattern DSL

内部 canonical 全小写，并匹配真实注册工具名：

```text
bash(git *)
edit(src/**)
write(path)
read(path)
```

UI 展示时再 prettify，例如 `bash(git *)` 显示为 `Bash(git *)`。

规则：

- `tool` 名使用注册表中的小写名，例如 `bash`、`edit`、`write`、`read`、`tool/agent-task.ts`。
- `bash(pattern)` 对命令做前缀 / glob 匹配。
- `edit/write/read(pattern)` 对路径做 glob 匹配。
- 无 pattern 表示匹配该 tool 的全部调用。
- session rule 不存 `ask`，只存 `allow` / `deny`。

---

## 三、判定职责分层

```text
permission/evaluator
  1. 读取当前 session rules
  2. 分类工具调用
  3. 按 mode / sessionRules / level 返回 allow|ask|deny

permission/manager
  1. 只在 ask 时进入
  2. 展示/更新 UI 队列
  3. 处理 once / always / reject / suggest / cancel
  4. always -> state.addSessionRule(sessionId, rule)
  5. drainQueue(sessionId) -> 对 pending 请求重新 evaluate

core/tool-scheduler
  1. 调 evaluator
  2. allow 后仍检查 externalWrite / untrustedMcp
  3. 执行工具或强制 ask
```

manager 不持有任何 approval 状态。所有“已允许”事实都来自 `state.sessionRules`。

---

## 四、分类模型

### 4.1 顶层分类

顶层 `ToolCategory` 不因 memory/bash 子语义膨胀。分类器内部可以返回更细的语义给 evaluator：

| 顶层/子语义 | 示例 | 行为 |
|-------------|------|------|
| `readonly` | read/list/grep 类 | 默认 allow |
| `write` | edit/write | plan deny；auto default ask；auto full-access allow |
| `dangerous` | 高风险工具 | plan deny；auto default ask；auto full-access allow |
| `network` | web fetch/search | 默认 allow，若已有现状风险闸则保留 |
| `memory-read` | `memory_read`、`memory_list` | 所有 mode/level allow |
| `memory-write` | `memory_add`、`memory_update`、`memory_remove` | plan deny；auto allow，不看 level |
| `skill` | skill tool | plan/auto default ask；full-access allow |
| `subagent` | agent task tool | plan deny；auto allow，不看 level |
| `bash-readonly` | `ls`、`cat`、`git status` | 同 readonly |
| `bash-mutating` | `mkdir`、`npm install`、未知命令 | plan deny；auto default ask；auto full-access allow |
| `bash-dangerous` | `rm -rf`、`sudo`、`chmod 777` | 同 mutating，但 ask reason 强调 dangerous |

### 4.2 Bash 分类规则

由 `shell/command-classifier.classifyShellCommand(parsed)` 提供：

```ts
type ShellCommandClass = "readonly" | "mutating" | "dangerous";
```

要求：

- readonly：`cat`、`ls`、`pwd`、`find`、`grep`、`head`、`tail`、`git status`、`git log`、`git diff`。
- mutating：`mv`、`cp`、`mkdir`、`touch`、`echo > foo`、`git commit`、`npm install`、`bash -c "..."`、`xargs`、未知命令。
- dangerous：`rm -rf`、`sudo`、`chmod 777`、`chown`、`dd`。
- 复合命令（管道、`&&`、`;`）按最危险的子命令计。
- 保留现有 destructive root check 与 workspace preflight。
- 注意现有 parser 可能把 `sudo` 当 wrapper 处理，分类时必须检查原始 token/rootIndex，不能只看最终 root。

---

## 五、判定矩阵

### 5.1 Mode 能力层

| Mode | 允许能力 | 被拒能力 |
|------|----------|----------|
| `plan` | readonly、network、memory-read、skill 进入审批层、bash-readonly | write、dangerous、subagent、memory-write、bash-mutating、bash-dangerous |
| `auto` | 全部能力进入后续层 | 无 mode-level deny |

Plan 下 deny reason 必须明确：

```text
You are in plan mode. Write/Edit/Bash mutations and memory writes will be denied. Use read tools or ask the user to switch to auto mode.
```

### 5.2 Level 审批层

| 类别 | default | full-access |
|------|---------|-------------|
| readonly / network / memory-read / bash-readonly | allow | allow |
| write / dangerous / bash-mutating / bash-dangerous | ask | allow |
| skill | ask，reason 含 skill name | allow |
| memory-write | auto 下 allow | auto 下 allow |
| subagent | auto 下 allow | auto 下 allow |

### 5.3 Subagent

| Mode | Level | Decision |
|------|-------|----------|
| plan | 任意 | deny |
| auto | default | allow |
| auto | full-access | allow |

### 5.4 Memory

| 子类 | 工具示例 | Decision |
|------|----------|----------|
| memory-read | `memory_read`、`memory_list` | 所有 mode/level allow |
| memory-write | `memory_add`、`memory_update`、`memory_remove` | plan deny；auto allow |

### 5.5 Skill

| Mode | Level | Decision |
|------|-------|----------|
| plan | default | ask |
| plan | full-access | allow |
| auto | default | ask |
| auto | full-access | allow |

Skill 不被 plan 能力层拦截。`ask.reason` 必须包含 skill name。

### 5.6 Scheduler 安全闸

即使 evaluator 返回 allow，scheduler 仍可强制 ask：

| 条件 | 处理 |
|------|------|
| `context.externalWrite === true` | ask |
| `context.untrustedMcp === true` | ask |

这类 ask 建议设置为不可记忆或隐藏 `always`，因为 sessionRule 不能绕过安全闸。

---

## 六、Evaluator 算法

```ts
export function evaluate(call: PermissionCall, state: PermissionState): Decision {
  const sessionRules = state.sessionRules.get(call.sessionId) ?? [];
  const classification = classifyToolCall(call);

  const modeDecision = evaluateModeGate(call, classification, state.mode);
  if (modeDecision.type === "deny") return modeDecision;

  const ruleDecision = evaluateSessionRules(call, sessionRules);
  if (ruleDecision) return ruleDecision;

  return evaluateLevelFallback(call, classification, state.level);
}
```

顺序不可调换：

1. `mode` 能力层先于 session rule。Plan 下被禁止的写操作，不能被 sessionRule 打开。
2. session rule 中 `deny` 优先于 `allow`。
3. `level` 是兜底审批策略。
4. scheduler 安全闸在 evaluator 之后执行。

---

## 七、模块责任

| 文件 | 职责 |
|------|------|
| `permission/types.ts` | `Mode`、`Level`、`PermissionRule`、`PermissionState`、`Decision`、manager 输入输出类型 |
| `permission/state.ts` | 持有全局 `mode/level` 与 `sessionRules` Map；发布 permission 状态事件 |
| `permission/rule.ts` | parse/format lowercase Pattern DSL，生成 remember rule |
| `permission/matcher.ts` | `matchesRule(call, rule)`，支持 bash command 与 path glob |
| `permission/classifier.ts` | `classifyToolCall(call)`，区分 memory/bash/skill/subagent |
| `permission/evaluator.ts` | 纯函数判定入口，无副作用 |
| `permission/manager.ts` | ask 队列、UI 请求、用户响应、always 写 rule、drain queue |
| `permission/events.ts` | `ModeChanged`、`LevelChanged`、`RuleAdded`、`Updated`、`Replied` |
| `shell/command-classifier.ts` | 提供 `classifyShellCommand(parsed)`，只负责 readonly/mutating/dangerous 三档分类 |
| `shell/preflight.ts` | 保留 workspace path 解析、destructive root check 与 download-and-execute 防护 |
| `core/tool-scheduler/*` | 改调 evaluator；保留 externalWrite/untrustedMcp 安全闸 |

---

## 八、UI / 命令语义

### 8.1 TUI

| 触发 | 行为 |
|------|------|
| `Shift+Tab` | 切 `mode: plan <-> auto` |
| 状态栏 | `mode: <plan|auto> · level: <default|full-access>`，有规则时可追加 `· +N rules` |
| `/permission` | 打开 PermissionSelector，只选择 default / full-access |
| `/permission default` | 直接切 level 为 default |
| `/permission full-access` | 直接切 level 为 full-access |

严格约束：

- 不存在 `/mode`。
- 不存在 `/permission plan` 或 `/permission auto`。
- 不存在一个 slash 命令同时操作 mode 和 level。

### 8.2 Headless / SDK / 启动参数

启动时支持初始值：

```text
--mode plan | --mode auto                # 默认 auto
--permission default | --permission full-access  # 默认 default
```

MVP 不支持 headless 中途动态切 mode；未来如果需要，另起 `/mode` 或 SDK API 设计，不混入 `/permission`。

---

## 九、系统 prompt 约束

Plan 模式下，工具列表不变，但 system prompt 需要注入简短约束：

```text
You are in plan mode. Write/Edit/Bash mutations and memory writes will be denied. Use read tools or ask the user to switch to auto mode.
```

这条提示用于降低 deny 循环概率；真正安全边界仍由 evaluator 执行。

---

## 十、ADR

### ADR-1：为什么用 `mode + level` 二轴

决策：使用 `mode: plan|auto` 与 `level: default|full-access`。

理由：

- 能力与审批是两个不同问题；
- 旧 `mode + agentState` 存在非法组合；
- 用户操作可以严格分轴；
- 与 Codex/Kimi 的优秀设计一致。

### ADR-2：为什么删除 `policy`

决策：删除整个 `packages/ohbaby-agent/src/policy/`。

理由：

- policy 与 permission 同时判定，造成双真相源；
- `AutoEditRequested` 形成反向耦合；
- SDK/UI 术语继续叫 policy 会让未来维护者误判职责。

### ADR-3：为什么 session rule 不持久化

决策：MVP 只保存在内存。

理由：

- 持久化涉及 scope merge、schema version、安全审计；
- 当前需求只要求对齐旧 `approvals: Map<sessionId, Set<string>>` 行为；
- `PermissionRule.scope` 先保留扩展位。

### ADR-4：为什么 plan 下不隐藏工具

决策：registry 不按 mode 过滤工具。

理由：

- LLM 的工具 schema 稳定；
- deny reason 能教会 LLM 当前限制；
- 切回 auto 时不需要重新发现工具。

### ADR-5：为什么 full-access 不绕过 scheduler 安全闸

决策：full-access 只影响 evaluator 的审批层，不影响 scheduler 的外部写和不可信 MCP gate。

理由：

- 这是用户偏好，不是环境信任证明；
- 安全闸职责属于运行环境，不属于 permission mode/level；
- 与 Codex/DeepSeek-TUI 的 layered safety 思路一致。
