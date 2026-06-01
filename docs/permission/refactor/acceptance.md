# Permission 重构验收与测试标准（已决策版）

本文档定义后续代码实施的验收门槛。所有测试必须验证真实行为，禁止只验证 mock 自己。本文使用 UTF-8 编码。

---

## 一、测试真实性规则

| 类型 | 不接受 | 接受 |
|------|--------|------|
| 返回值 | `expect(result).toBeDefined()` | 断言完整 `Decision` 结构与 reason |
| mock | stub evaluator 后断言 stub 被调用 | 用真实 evaluator 跑真实 call/state |
| 事件 | 只断言“被调用过” | 断言事件名与 payload |
| 状态 | 直接改内部字段 | 通过公开 API 修改，再从 getter/snapshot 验证 |
| 集成 | 所有依赖全 mock | 用真实 in-memory bus/state/manager |
| 失败路径 | 只测 happy path | deny、非法参数、未知工具、空规则都覆盖 |

强制要求：

- evaluator 测试不得 mock classifier 之外的业务决策；更推荐用真实 classifier。
- manager 测试不得重新引入 approval Set 真相。
- 所有 deny 必须断言 reason。
- 所有事件测试必须断言 payload。

---

## 二、Phase 验收

### Phase 0：类型骨架

- [ ] `Mode = "plan" | "auto"`。
- [ ] `Level = "default" | "full-access"`。
- [ ] `PermissionState.sessionRules` 为 `Map<string, readonly PermissionRule[]>`。
- [ ] 类型从 `permission/index.ts` 导出。
- [ ] 编译通过。

### Phase 1：Rule / Classifier / Evaluator

#### rule

- [ ] `parsePermissionPattern("bash(git *)")` 返回 `{ tool: "bash", pattern: "git *" }`。
- [ ] `parsePermissionPattern("edit(src/**)")` 返回 `{ tool: "edit", pattern: "src/**" }`。
- [ ] `parsePermissionPattern("read")` 返回 `{ tool: "read" }`。
- [ ] 大写输入可被 normalize 或明确报错；最终内部 canonical 必须小写。
- [ ] 非法 DSL 抛出明确错误。

#### classifier

- [ ] `read` -> readonly。
- [ ] `edit` / `write` -> write。
- [ ] `memory_read` / `memory_list` -> memory-read。
- [ ] `memory_add` / `memory_update` / `memory_remove` -> memory-write。
- [ ] `tool/agent-task.ts` 或当前注册的 subagent 工具名 -> subagent。
- [ ] skill tool -> skill，ask reason 含 skill name。
- [ ] 未知工具保守归 write 或 askable mutating 语义。

#### evaluator 核心矩阵

| # | mode | level | call | sessionRules | 期望 |
|---|------|-------|------|--------------|------|
| 1 | plan | default | read | [] | allow |
| 2 | plan | full-access | write/edit | [] | allow |
| 3 | plan | default | bash `ls` | [] | ask |
| 4 | plan | full-access | bash `mkdir a` | [] | allow |
| 5 | plan | default | memory_read | [] | allow |
| 6 | plan | full-access | memory_add | [] | allow |
| 7 | plan | default | subagent | [] | allow |
| 8 | plan | default | skill `foo` | [] | ask，reason 含 `foo` |
| 9 | plan | full-access | skill `foo` | [] | allow |
| 10 | auto | default | read | [] | allow |
| 11 | auto | default | write/edit | [] | ask |
| 12 | auto | full-access | write/edit | [] | allow |
| 13 | auto | default | bash `git status` | [] | ask |
| 14 | auto | default | bash `npm install` | [] | ask |
| 15 | auto | default | bash `rm -rf foo` | [] | ask，reason 含 dangerous |
| 16 | auto | full-access | bash `rm -rf foo` | [] | allow |
| 17 | auto | default | memory_add | [] | allow |
| 18 | auto | default | subagent | [] | allow |
| 19 | auto | default | skill `foo` | [] | ask，reason 含 `foo` |
| 20 | auto | full-access | skill `foo` | [] | allow |
| 21 | auto | default | edit `src/a.ts` | allow `edit(src/**)` | allow |
| 22 | auto | default | edit `lib/a.ts` | allow `edit(src/**)` | ask |
| 23 | auto | full-access | bash `rm -rf foo` | deny `bash(rm *)` | deny，deny rule 优先 |
| 24 | plan | full-access | edit `src/a.ts` | allow `edit(src/**)` | allow |

额外要求：

- [ ] sessionRules 按 `sessionId` 读取，不同 session 不互相命中。
- [ ] allow 与 deny 同时匹配时 deny 优先。
- [ ] evaluator 不发布事件、不改 state。

### Phase 2：Shell command-classifier / preflight

#### readonly

- [ ] `ls`
- [ ] `cat foo.txt`
- [ ] `pwd`
- [ ] `find . -name *.ts`
- [ ] `grep foo file`
- [ ] `head -n 10 file`
- [ ] `tail -n 10 file`
- [ ] `git status`
- [ ] `git log`
- [ ] `git diff`

#### mutating

- [ ] `mv a b`
- [ ] `cp a b`
- [ ] `mkdir foo`
- [ ] `touch foo`
- [ ] `echo hi > foo`
- [ ] `git commit -m x`
- [ ] `npm install`
- [ ] 未知命令
- [ ] `bash -c "..."` 保守 mutating
- [ ] `xargs` 保守 mutating

#### dangerous

- [ ] `rm -rf foo`
- [ ] `sudo ls`
- [ ] `chmod 777 foo`
- [ ] `chown root foo`
- [ ] `dd if=a of=b`

#### 复合命令

- [ ] `cat a | tee b` -> mutating。
- [ ] `git status && rm -rf foo` -> dangerous。
- [ ] `ls; mkdir foo` -> mutating。

### Phase 3：State + Manager

#### state

- [ ] 初始 `mode="auto"`。
- [ ] 初始 `level="default"`。
- [ ] 初始 `sessionRules` 为空 Map。
- [ ] `setMode("plan")` 发布 `PermissionEvent.ModeChanged`，payload 含 previous/current。
- [ ] `setLevel("full-access")` 发布 `PermissionEvent.LevelChanged`。
- [ ] 重复设置相同值不重复发布事件。
- [ ] `setMode` 不改变 `level`。
- [ ] `setLevel` 不改变 `mode`。
- [ ] `addSessionRule(sessionId, rule)` 只影响该 session。
- [ ] `clearSession(sessionId)` 只删除该 session rules。
- [ ] `toSnapshot()` 输出 JSON 友好结构，不暴露 Map。

#### manager

- [ ] once -> 当前请求 resolve once，不写 sessionRules。
- [ ] always -> 写入 `state.sessionRules.get(sessionId)`。
- [ ] always -> 发布 `RuleAdded`。
- [ ] always -> 不发布 `AutoEditRequested`。
- [ ] always -> 不改变 mode/level。
- [ ] 相同 session + 相同 pattern pending 请求经 `drainQueue` resolve `"always"`。
- [ ] 相同 session + 不同 pattern 仍等待 UI。
- [ ] 不同 session 不命中 rule。
- [ ] reject / cancel / suggest 行为保持。

### Phase 4：主链与契约切换

- [ ] scheduler 调 `permission.evaluate`，不再调 `policy.check`。
- [ ] registry 在 plan / auto 下返回完全相同工具列表。
- [ ] externalWrite 下，即使 evaluator allow，scheduler 仍 ask。
- [ ] untrustedMcp 下，即使 evaluator allow，scheduler 仍 ask。
- [ ] SDK `UiSnapshot.permission` 存在。
- [ ] SDK `UiSnapshot.policy` 不存在。
- [ ] `packages/ohbaby-agent/src/policy/` 已删除。
- [ ] 无业务代码残留 `PolicyEvent`。
- [ ] 无业务代码残留 `AutoEditRequested`。
- [ ] 无业务代码残留 `agentState`。

### Phase 5：UI / 命令

- [ ] 默认状态栏为 `mode: auto · level: default`。
- [ ] `Shift+Tab` 在 `plan` 与 `auto` 间切换。
- [ ] `Shift+Tab` 不改变 `level`。
- [ ] `/permission` 打开 selector。
- [ ] selector 只有 `default` 与 `full-access`。
- [ ] `/permission default` 生效。
- [ ] `/permission full-access` 生效。
- [ ] `/permission plan` 报参数错误。
- [ ] `/permission auto` 报参数错误。
- [ ] `/mode` 是 unknown command。
- [ ] Permission ask dialog 的 always 文案包含具体 pattern。
- [ ] 有 session rules 时状态栏可显示 `+N rules`。
- [ ] 启动参数 `--mode plan|auto` 生效。
- [ ] 启动参数 `--permission default|full-access` 生效。
- [ ] headless MVP 不支持中途动态切 mode。

### Phase 6：文档同步

- [ ] `docs/permission/goals-duty.md` 不再把 permission 描述为 policy 执行层。
- [ ] `docs/permission/architecture.md` 不再包含 policy 节点。
- [ ] `docs/permission/data-model.md` 更新 Mode/Level/Rule/State。
- [ ] `docs/permission/dfd-interface.md` 使用 scheduler -> evaluator -> manager 数据流。
- [ ] `docs/permission/test.md` 增加 evaluator/state/classifier。
- [ ] `docs/ohbaby-cli/tui-productization/policy-mode.md` 废弃或替换。

---

## 三、E2E 验收脚本

使用根目录 [ohbaby-e2e-test.md](../../../ohbaby-e2e-test.md) 的本地配置。执行和记录时必须隐藏 API key。

### E2E-1：默认读写

1. 启动：`mode=auto`、`permission=default`。
2. 触发 read/list 类工具。
3. 触发 edit/write。

期望：

- read/list 直接执行。
- edit/write 进入 ask。

### E2E-2：always session rule

1. 对 `edit(src/a.ts)` 点 always。
2. 再触发 `edit(src/b.ts)`。
3. 再触发 `edit(lib/a.ts)`。

期望：

- `src/b.ts` 自动通过。
- `lib/a.ts` 仍 ask。
- 数据流记录能看到 `state.sessionRules.get(sessionId)` 命中。

### E2E-3：plan 审批层

1. 切到 plan。
2. 触发 read。
3. 触发 edit。
4. 触发 `bash(ls)`。
5. 触发 `bash(mkdir tmp)`。
6. 触发 memory read/write。
7. 触发 subagent。
8. 触发 skill。

期望：

- plan 下审批结果与 auto 的当前 `default/full-access` level 一致。
- default 下 read、memory-read、memory-write、subagent allow；edit/write、bash、skill ask。
- full-access 下普通 edit/write、bash、memory、subagent、skill allow。
- system prompt 仍可提示 plan 模式不要主动写文件，但 permission evaluator 不再用 plan gate 强制 deny。

### E2E-4：full-access 与安全闸

1. 切 `auto + full-access`。
2. 触发普通 edit/write。
3. 触发 bash dangerous。
4. 触发 external workspace write。
5. 触发 untrusted MCP tool。

期望：

- 普通 edit/write 与 bash dangerous 由 evaluator allow。
- externalWrite / untrustedMcp 仍由 scheduler 强制 ask；externalWrite 可通过 always 记住。

### E2E-5：工具列表稳定

1. 记录 auto 下 tool list。
2. 切 plan。
3. 再记录 tool list。

期望：

- 两份列表完全相同。
- 差异只体现在调用时 evaluator decision。

---

## 四、真实数据流观察点

实现时至少在测试日志或调试记录中确认以下字段流动：

```text
sessionId
callId
toolName
classification
mode
level
matchedRule
evaluatorDecision
schedulerSafetyOverride
managerResponse
sessionRulesAfterResponse
finalToolOutcome
```

注意：

- 日志不得输出 API key、完整外部 token、用户私密内容。
- 可以输出 provider/model 名称和 decision 结果。

---

## 五、残留检查门槛

实施完成后，以下检查必须无业务残留：

```text
rg "PolicyEvent" packages
rg "AutoEditRequested" packages
rg "agentState" packages
rg "from .*policy|src/policy|/policy" packages/ohbaby-agent/src
rg "MODE_ALLOWED_CATEGORIES|allowedCategories" packages/ohbaby-agent/src/core/tool-scheduler
```

允许情况：

- 迁移说明文档中的历史背景可保留。
- `"ask"` 作为 `Decision.type` 或 permission response 可保留。
- `"policy"` 作为普通英文词需人工判断；不得指向旧模块或契约。

---

## 六、子代理审查验收

代码完成、测试通过、e2e 通过后，子代理审查至少覆盖三类：

| 审查 | 必看问题 |
|------|----------|
| 权限安全 | plan/auto 是否共享 default/full-access 矩阵；scheduler 外部写/不可信 MCP 闸是否保留 |
| 架构契约 | 是否删除 policy 真相源；SDK/UI 是否一致；manager 是否重新持有 approval 状态 |
| 测试质量 | 矩阵是否完整；是否存在 mock 套 mock；是否覆盖失败路径 |

阻塞意见必须处理或与用户确认后记录。

---

## 七、最终完成标准

全部满足才可认为本轮重构完成：

- [ ] Phase 0-6 验收全部通过。
- [ ] 单测、集成测试、e2e 全部通过。
- [ ] 真实数据流检查完成。
- [ ] 残留检查无业务命中。
- [ ] 子代理审查完成。
- [ ] 文档与代码一致。
- [ ] 未提交真实 API key 或敏感日志。
