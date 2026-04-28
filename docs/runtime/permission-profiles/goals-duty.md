# permission-profiles 模块 goals-duty.md

本文档定义 `runtime/permission-profiles` 模块的设计目标与职责边界。

---

## 一、Design Goals（设计目标）

### 1. 为无人值守的自动化 Run 提供预定义权限边界

交互式 CLI 下，用户可以随时对权限弹窗做出响应。但 scheduler 定时触发、channel 入站消息等自动化触发的 Run 没有 UI 可弹窗，必须在创建时就确定这个 Run 被允许做什么。permission-profiles 为每种触发场景提供一套预定义的权限边界，防止后台 Run 在无人知晓的情况下执行高风险操作。

### 2. 提供 Profile Registry，与触发源语义解耦

permission-profiles 只维护画像定义（id → PermissionProfile 实例），不维护"触发源 → 画像"的映射。触发源与画像 id 的联动属于 Run 默认策略（RunDefaultsPolicy），由装配层（daemon/bootstrap）定义并注入 run-manager。permission-profiles 提供 profile id 的校验接口，供装配层在启动时验证 RunDefaultsPolicy 中的 id 合法性，但不感知 trigger 语义。

### 3. 与 `core/policy` 的现有 ask/plan/agent 模式协作而不替代

`core/policy` 的模式决策矩阵（readonly / write / dangerous → ALLOW / ASK / DENY）针对交互式场景。permission-profiles 是 runtime 层的叠加约束：它决定"这个 Run 是否允许触及 policy 的 ASK 路径"，以及"ASK 时能否实际弹窗还是改为通知或直接拒绝"。两者协作，policy 在前，profile 在后兜底。

### 4. 保持审批维度与执行环境维度正交

permission-profiles 只回答"无人值守 Run 默认能做什么"，不回答"这些操作在哪里执行"。个人助手、Coding CLI、后台自动化都可以共享同一套审批画像，但分别绑定不同的 sandbox adapter、heartbeat 策略和 task 策略。

---

## 二、Duties（职责）

### 1. 定义 PermissionProfile 接口

负责：
- 定义 `PermissionProfile` 接口：`id` / `canAskUser` / `canWrite` / `canDangerous` / `onDenied`
- 定义 `onDenied` 的处理策略枚举：`reject`（报错）/ `notify`（改为发通知）/ `skip`（静默跳过）

### 2. 提供四种内置权限画像

负责实现并导出以下画像：

- **interactive**：完整的交互式权限，可弹窗询问用户（canAskUser: true，canWrite: true，canDangerous: false 默认）
- **read-only**：只允许 readonly 工具调用，写操作一律 reject（适合 heartbeat 触发的例行检查）
- **notify-only**：允许 readonly，写操作改为向用户发通知而非实际执行（适合 scheduler / channel 触发，安全默认值）
- **full-auto**：允许 readonly + write，不弹窗；dangerous / critical 是否继续要求确认，仍由 `core/policy` 或更高层部署配置决定（适合用户明确授权、但仍保留高风险护栏的场景）

### 3. 提供 Profile Registry 与 Profile Id 校验

负责：
- 维护 `PermissionProfileId → PermissionProfile` 注册表，支持内置四种画像的注册与查找
- 提供 `getProfile(id: PermissionProfileId): PermissionProfile` 接口，供 run-manager 在创建 Run 时按 id 解析画像实例
- 提供 `validateProfileId(id: string): boolean` 接口，供装配层在启动时校验 RunDefaultsPolicy 中的 profile id 合法性
- 支持通过装配层注入自定义 profile 实现（用于测试或高级定制），不硬编码注册表为静态单例

### 4. 在 Run 执行时注入权限约束

负责：
- 提供 `applyProfile(profile, policyCheck)` 适配函数：包装 `core/policy` 的 `check()` 结果，按 profile 规则过滤
- 当 profile 禁止弹窗但 policy 返回 ASK 时，改为执行 `onDenied` 策略

### 5. 权限画像覆盖的校验

负责：
- 由装配层在启动时调用 `validateProfileId()` 校验 RunDefaultsPolicy 中声明的 profile id 是否存在
- 拒绝将无人值守触发源默认配置为危险权限画像，除非用户显式开启 full-auto（此校验在装配层触发，基于 permission-profiles 提供的接口）
- permission-profiles 不参与 multitaskStrategy 和 disconnectMode 的校验；这两个字段的合法性由 run-manager 或装配层校验

---

## 三、Non-Duties（非职责）

### 1. 不负责具体权限弹窗的 UI 实现

interactive 画像的 `canAskUser: true` 只是一个标志，实际弹窗的 UI 交互由 `core/permission` 模块和 TUI 负责。permission-profiles 不调用任何 UI 接口。

### 2. 不负责关键操作（critical operation）的检测

`core/policy` 的 `CriticalOperationChecker`（`git push --force`、`rm -rf` 等）独立于 permission-profiles。关键操作的检测在 profile 过滤之前发生，是更底层的防护。

### 3. 不负责 channel 的身份认证

来自 Telegram / Slack 的消息是否来自可信用户，由 `interfaces/channels` 层验证。permission-profiles 不感知 channel 用户身份，只根据触发源类型（`channel`）提供对应的画像。

### 4. 不负责 cost / token 预算

cost guard（限制 expensive toolset）不通过 permission-profiles 实现。permission-profiles 的粒度是"这类操作允不允许"，不是"这类操作花多少钱"。

### 5. 不负责 Run 之外的权限决策

permission-profiles 的作用域是 Run 创建时。Run 内部的单次工具调用权限判断仍由 `core/policy` + `core/permission` 处理，permission-profiles 只是初始化阶段的叠加约束。

### 6. 不负责多任务策略和断连策略

`multitaskStrategy` 与 `disconnectMode` 属于 RunDefaultsPolicy 的字段，由装配层定义并注入 run-manager。permission-profiles 不知道 trigger 语义，也不拥有这两个字段的默认值。

### 7. 不负责执行环境选择

当前 Run 在原始目录、git worktree 还是容器中执行，由 sandbox 模块决定。permission-profiles 不读取 `workdir`，也不创建任何隔离环境。

---

## 四、与其他模块的关系

| 模块 | 关系 | 说明 |
|------|------|------|
| `runtime/run-manager` | 被调用 | run-manager 创建 Run 时调用 getProfile(id) 获取画像实例 |
| `core/policy` | 依赖（适配） | applyProfile() 包装 policy.check() 的结果，按 profile 过滤 |
| `core/permission` | 间接依赖 | interactive 画像允许触发 permission 弹窗；notify-only 画像阻止弹窗 |
| `sandbox` | 无直接依赖 | approval profile 与 execution profile 正交，不互相调用 |
| `daemon/bootstrap` | 被调用 | 装配层调用 validateProfileId() 校验 RunDefaultsPolicy，不依赖 trigger 语义 |
| `runtime/heartbeat` | 无直接依赖 | heartbeat 只传 triggerSource 给 run-manager，profiles 不被 heartbeat 直接调用 |
| `ohbaby-sdk` | 类型依赖 | 只暴露 PermissionProfileId 等窄类型；具体 PermissionProfile 实现留在 runtime 内部 |

---

## 五、模块边界示例

### 5.1 职责内的示例

正确：run-manager 通过 getProfile 获取画像实例（id 来自 RunDefaultsPolicy）
```typescript
// run-manager.ts 负责调用，permission-profiles 负责按 id 查找
// profileId 已由装配层从 RunDefaultsPolicy 中解析出来
const profile = profileRegistry.getProfile(resolvedProfileId)
```

正确：装配层在启动时校验 RunDefaultsPolicy 中的 profile id
```typescript
// daemon/bootstrap.ts 负责
for (const [triggerSource, defaults] of Object.entries(runDefaultsPolicy)) {
  if (!profileRegistry.validateProfileId(defaults.permissionProfileId)) {
    throw new ConfigError(`Unknown profile id: ${defaults.permissionProfileId} for triggerSource: ${triggerSource}`)
  }
}
```

正确：applyProfile 包装 policy 决策
```typescript
// run-worker.ts 中，tool-scheduler 调用 policy.check() 前注入
const wrappedCheck = applyProfile(profile, policy.check.bind(policy))
// notify-only 画像会将 ASK → notify，ALLOW(write) → notify
```

### 5.2 职责外的示例

错误：permission-profiles 不应实现弹窗 UI
```typescript
// 错误：不应该在 permission-profiles 中
if (profile.canAskUser) {
  const answer = await showDialog('Allow this operation?')
}

// 正确：弹窗由 core/permission 负责，profiles 只设置 canAskUser 标志
```

---

## 六、文档自检

- 可以用一句话说明该模块的存在意义：permission-profiles 为无人值守的自动化 Run 提供预定义审批画像，维护 profile registry 与 id 校验接口，不感知触发源语义
- 能清楚回答"这个模块不该做什么"：不维护触发源联动表、不做弹窗 UI、不做关键操作检测、不做 channel 身份认证、不做 cost 预算、不做 Run 内部工具调用的权限判断、不维护多任务策略或断连策略、不决定执行环境
- 职责与其他模块无明显重叠：core/policy（决策矩阵）、core/permission（弹窗交互）、sandbox（执行环境）、run-manager（Run 执行）、daemon/bootstrap（策略装配）边界清晰
- RunDefaultsPolicy 的 triggerSource→profileId 映射属于装配层关切，permission-profiles 不拥有也不感知该映射
