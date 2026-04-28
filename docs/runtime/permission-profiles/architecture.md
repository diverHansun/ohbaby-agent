# permission-profiles 模块 architecture.md

本文档描述 `runtime/permission-profiles` 模块的内部结构与设计决策。所有内容均服务于 `goals-duty.md` 中定义的设计目标与职责。

---

## 一、Architecture Overview（总体架构）

permission-profiles 采用 **Registry + Adapter** 两层结构：Registry 管理画像定义，Adapter 将画像约束叠加到 `core/policy` 的决策结果上。

```
┌──────────────────────────────────────────────────────────────┐
│ ProfileRegistry（公共接口）                                    │
│                                                              │
│ 职责：                                                       │
│ - 维护 PermissionProfileId → PermissionProfile 注册表        │
│ - 提供 getProfile(id) 查找接口                               │
│ - 提供 validateProfileId(id) 校验接口                        │
│ - 支持注入自定义 profile（测试/高级定制）                      │
└──────────────────────────────────────────────────────────────┘
                          │
          ┌───────────────┴───────────────┐
          ▼                               ▼
┌──────────────────────┐     ┌────────────────────────────┐
│ 内置 Profile 定义     │     │ applyProfile() 适配函数     │
│                      │     │                            │
│ - interactive        │     │ 职责：                     │
│ - read-only          │     │ - 包装 policy.check() 结果  │
│ - notify-only        │     │ - 按 profile 规则过滤       │
│ - full-auto          │     │ - ASK → notify/reject/skip │
└──────────────────────┘     └────────────────────────────┘
```

### 主要组件

| 组件 | 职责 |
|---|---|
| **ProfileRegistry** | 唯一公共类，管理 profile 注册与查找 |
| **内置 Profile 定义** | 四种预定义画像的常量对象，不含业务逻辑 |
| **applyProfile()** | 纯函数适配器，将 profile 约束叠加到 policy 决策上 |

---

## 二、Design Pattern & Rationale（设计模式与理由）

### 1. Registry 模式

ProfileRegistry 维护 `id → PermissionProfile` 的映射，支持查找和校验。

**使用理由**：
- 装配层（daemon/bootstrap）需要在启动时校验 RunDefaultsPolicy 中的 profile id 合法性，Registry 提供 `validateProfileId()` 接口
- run-manager 在创建 Run 时需要按 id 获取画像实例，Registry 提供 `getProfile(id)` 接口
- Registry 支持注入自定义 profile，便于测试时替换内置画像

**不使用全局单例的理由**：
- 全局单例难以在测试中替换；Registry 通过依赖注入传递，测试可以创建独立实例

### 2. Adapter 模式（applyProfile）

`applyProfile(profile, policyCheck)` 是一个函数适配器，将 `core/policy` 的 `check()` 包装为符合 profile 约束的版本。

**使用理由**：
- `core/policy` 的决策矩阵（ALLOW / ASK / DENY）是独立的，permission-profiles 不修改它，只在其结果上叠加约束
- Adapter 模式保持两者解耦：policy 不知道 profiles 存在，profiles 不修改 policy 内部逻辑

### 3. 数据对象（Profile 定义）

四种内置 profile 是纯数据对象（`const interactive: PermissionProfile = { ... }`），不是类实例。

**使用理由**：
- profile 没有行为，只有属性（`canAskUser`、`canWrite`、`onDenied` 等）
- 纯数据对象更易序列化、比较和测试

---

## 三、Module Structure & File Layout（模块结构与文件组织）

```
src/runtime/permission-profiles/
├── index.ts              # 公共接口：导出 ProfileRegistry、applyProfile、内置 profile id 常量
├── registry.ts           # ProfileRegistry 类实现
├── profiles/
│   ├── interactive.ts    # interactive profile 定义
│   ├── read-only.ts      # read-only profile 定义
│   ├── notify-only.ts    # notify-only profile 定义
│   └── full-auto.ts      # full-auto profile 定义
├── apply-profile.ts      # applyProfile() 适配函数
├── types.ts              # PermissionProfile 接口、PermissionProfileId、OnDeniedStrategy
└── __tests__/
    ├── registry.test.ts
    └── apply-profile.test.ts
```

### 各文件职责

| 文件 | 定位 | 说明 |
|---|---|---|
| `index.ts` | 公共接口 | 导出 ProfileRegistry、applyProfile 和类型；内置 profile 对象不直接导出，通过 registry 访问 |
| `registry.ts` | 核心实现 | ProfileRegistry 类，构造时注册内置四种画像 |
| `profiles/` | 数据定义 | 每个文件是一个 profile 常量对象，无副作用 |
| `apply-profile.ts` | 适配逻辑 | 纯函数，不依赖 registry，只依赖 PermissionProfile 类型 |
| `types.ts` | 类型定义 | PermissionProfile 接口；PermissionProfileId 若已在 ohbaby-sdk 定义则从 sdk 导入 |

### 对外稳定接口 vs 内部实现

- **对外稳定**：`ProfileRegistry` 的 `getProfile` / `validateProfileId` 方法；`applyProfile` 函数签名；`PermissionProfile` 接口
- **内部实现**：注册表数据结构；各 profile 的具体属性值（可随策略调整）

---

## 四、Architectural Constraints & Trade-offs（约束与权衡）

### 1. profile 不感知 trigger 语义

ProfileRegistry 不维护 `TriggerSource → PermissionProfileId` 的映射。这个映射属于 RunDefaultsPolicy，由装配层定义。

**代价**：装配层需要同时了解 TriggerSource（来自 run-manager 语义）和 PermissionProfileId（来自 permission-profiles），是两个模块的交汇点。但这个交汇点本来就应该在装配层，而不是在任何一个业务模块内部。

### 2. applyProfile 是纯函数，不是方法

`applyProfile` 不挂在 ProfileRegistry 上，也不挂在 PermissionProfile 对象上，而是独立的纯函数。

**代价**：调用方需要同时持有 profile 对象和 `applyProfile` 函数引用，比 `profile.apply(check)` 的调用方式稍显繁琐。但纯函数更易测试，且避免了 profile 对象承担行为的职责膨胀。

### 3. 放弃的方案：profile 作为策略类（Strategy 模式）

可以让每个 profile 是一个类，实现 `PermissionStrategy` 接口，包含 `apply(check)` 方法。这样调用方只需要 `profile.apply(check)` 即可。

**放弃理由**：profile 的核心是数据（属性集合），不是行为。`applyProfile` 的逻辑对所有 profile 是通用的（根据 `canWrite`、`onDenied` 等属性做分支），不需要每个 profile 各自实现。把通用逻辑分散到四个类里反而增加了维护成本。
