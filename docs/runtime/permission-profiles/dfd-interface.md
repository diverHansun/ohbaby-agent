# permission-profiles 模块 dfd-interface.md

本文档描述 `runtime/permission-profiles` 模块与外部模块之间的数据流与接口契约。

---

## 一、Context & Scope（上下文与范围）

permission-profiles 提供权限画像的注册、查找和应用能力，是 runtime 权限决策的数据层。

| 方向 | 外部模块 | 交互方式 |
|---|---|---|
| 被调用 | `runtime/run-manager`（startRun 阶段）| `profileRegistry.getProfile(id)` 获取画像 |
| 被调用 | `runtime/daemon/bootstrap`（启动时）| `validateProfileId(id)` 校验 RunDefaultsPolicy 中的 id 合法性 |
| 被调用 | `core/lifecycle` / `core/tool-scheduler` | `applyProfile(profile, policyCheck)` 叠加权限约束 |
| 数据来源 | 内置四种 profile 定义（模块内静态数据）| 不依赖外部配置 |

---

## 二、Data Flow Description（数据流描述）

### 流程 1：Run 启动时画像解析（getProfile）

```
run-manager.startRun()
  → profileRegistry.getProfile(resolvedProfileId)
  ↓
ProfileRegistry 查找内置 profile 或自定义 profile
  ├── 找到 → 返回 PermissionProfile 对象
  └── 未找到 → 抛出 UnknownProfileError
  ↓
PermissionProfile 被封装进 RunContext
  → 传递给 RunWorker → 传递给 lifecycle
```

### 流程 2：启动时 profile id 校验（validateProfileId）

```
daemon/bootstrap 构建 RunDefaultsPolicy 后
  → 对每个 triggerSource 的 permissionProfileId：
    profileRegistry.validateProfileId(id)
  ↓
  ├── 合法 → 继续启动
  └── 不合法 → 启动失败，明确错误信息（Fail Fast）
```

校验在启动时完成，避免运行时才发现配置错误。

### 流程 3：权限决策时叠加 profile 约束（applyProfile）

```
core/policy.check(action, context) → PolicyDecision（ALLOW / ASK / DENY）
  ↓
applyProfile(permissionProfile, policyDecision)
  ↓
  根据 profile 属性叠加约束：
  ├── canAskUser = false → 将 ASK 转为 profile.onDenied 策略（notify / reject / skip）
  ├── canWrite = false → 将写操作 ALLOW 降级为 DENY
  └── 其他约束按 profile 定义应用
  ↓
返回最终 PolicyDecision（已叠加画像约束）
```

`applyProfile` 不修改 policy 的内部逻辑，只在 policy 结果上做叠加过滤。

---

## 三、Interface Definition（接口定义）

### 接口 1：profileRegistry.getProfile(id)

**语义**：按 id 获取 PermissionProfile 对象，用于组装 RunContext。

- **输入**：`PermissionProfileId`（字符串）
- **输出**：`PermissionProfile` 对象
- **错误**：id 不存在时抛出 `UnknownProfileError`
- **同步/异步**：同步

### 接口 2：profileRegistry.validateProfileId(id)

**语义**：校验 id 是否合法，用于装配层启动检查。

- **输入**：`PermissionProfileId`
- **输出**：`boolean`（或 throw）
- **使用场景**：仅在 daemon/bootstrap 启动阶段调用，不在热路径调用

### 接口 3：applyProfile(profile, policyDecision)

**语义**：将 profile 约束叠加到 policy 决策结果上，返回最终决策。

- **输入**：`PermissionProfile`、`PolicyDecision`
- **输出**：最终的 `PolicyDecision`（已应用 profile 约束）
- **特性**：纯函数，无副作用，不修改入参

---

## 四、Data Ownership & Responsibility（数据归属与责任）

| 数据 | 归属 | 责任边界 |
|---|---|---|
| 内置 profile 定义（数据对象）| permission-profiles 模块 | 静态数据，不依赖外部配置；4 种内置画像由此模块维护 |
| `PermissionProfile` 对象（运行时）| ProfileRegistry 持有注册表，getProfile 返回引用 | 调用方（run-manager）只读，不修改 profile 对象 |
| `TriggerSource → ProfileId` 映射 | daemon/bootstrap（RunDefaultsPolicy）| **不在 permission-profiles 模块**；permission-profiles 只知道 ProfileId，不知道触发源 |
| policy 决策逻辑 | `core/policy` | applyProfile 只叠加过滤，不修改 policy 内部矩阵 |
| 自定义 profile 注入 | 调用方（测试/高级定制）| ProfileRegistry 支持 `register(id, profile)` 注入；用于测试 mock |
