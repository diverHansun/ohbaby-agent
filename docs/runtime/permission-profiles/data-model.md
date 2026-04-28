# permission-profiles 模块 data-model.md

本文档定义 `runtime/permission-profiles` 模块的核心概念与数据模型。

---

## 一、Core Concepts（核心概念）

### 概念 1：PermissionProfile（权限画像）

一组预定义的权限约束集合，描述"在什么条件下允许/拒绝/通知哪些操作"。PermissionProfile 是叠加在 `core/policy` 决策结果上的第二层过滤，不替代 policy，而是在 policy 允许的范围内进一步收窄。

四种内置画像：

| 画像 | 语义 |
|---|---|
| `interactive` | 默认交互模式，允许询问用户（ASK 保持 ASK）|
| `read-only` | 只读模式，所有写操作被 deny |
| `notify-only` | 通知模式，操作执行但仅通知用户，不阻塞 |
| `full-auto` | 全自动模式，不询问用户，所有 ASK → 自动允许（在 policy 允许范围内）|

### 概念 2：ProfileRegistry（画像注册表）

维护 `PermissionProfileId → PermissionProfile` 的映射。支持内置画像查找和自定义画像注入（测试用）。Registry 是运行时获取画像的唯一入口。

### 概念 3：applyProfile（画像应用函数）

一个纯函数，将 PermissionProfile 的约束叠加到 `core/policy` 的决策结果上。applyProfile 不依赖 Registry，不持有状态，输入确定时输出确定。

---

## 二、Entity / Value Object 区分

| 概念 | 分类 | 理由 |
|---|---|---|
| `PermissionProfile` | Value Object（数据对象）| 无行为，只有属性；创建后不可变；不同画像可直接比较属性值 |
| `ProfileRegistry` | Entity | 持有注册表映射，有 `register()` 修改操作，进程内管理画像集合 |
| `PermissionProfileId` | Value Object（字符串枚举）| 纯标识符，无行为 |

---

## 三、Key Data Fields（关键数据字段）

### PermissionProfile 字段说明

| 字段 | 含义 |
|---|---|
| `id` | 画像标识符，如 `'interactive'`、`'read-only'` |
| `canAskUser` | 是否允许向用户展示确认对话框（false 时 ASK → 自动处理）|
| `canWrite` | 是否允许写操作（false 时写操作 ALLOW → DENY）|
| `onDenied` | 当操作被 deny 时的处理策略：`'notify' \| 'reject' \| 'skip'` |
| `canRunCode` | 是否允许执行代码（false 时代码执行 ALLOW → DENY）|

### onDenied 策略说明

| 值 | 含义 |
|---|---|
| `'notify'` | 记录日志并通知用户，但不阻塞流程（notify-only 画像使用）|
| `'reject'` | 抛出 PermissionDeniedError，中断当前操作 |
| `'skip'` | 静默跳过该操作（适用于全自动场景的低风险操作）|

### 内置画像属性对比

| 画像 | canAskUser | canWrite | canRunCode | onDenied |
|---|---|---|---|---|
| `interactive` | true | true | true | `'reject'` |
| `read-only` | true | false | false | `'reject'` |
| `notify-only` | false | true | true | `'notify'` |
| `full-auto` | false | true | true | `'skip'` |

---

## 四、Lifecycle & Ownership（生命周期与归属）

### PermissionProfile 生命周期

- **创建**：模块加载时作为常量对象初始化，注册到 ProfileRegistry
- **使用**：run-manager 在 startRun 时通过 `getProfile(id)` 获取，封装进 RunContext
- **不可变**：获取后不修改；多个 Run 可共享同一个 profile 对象引用
- **销毁**：随进程结束

### 数据归属

| 数据 | 归属 | 说明 |
|---|---|---|
| 内置 profile 常量 | permission-profiles 模块（静态）| 不依赖配置文件；4 种内置画像在代码中定义 |
| 自定义 profile（可选）| 注入方（装配层/测试）| 通过 `profileRegistry.register()` 注入；生产环境通常不使用 |
| ProfileId 合法性 | permission-profiles 模块 | validateProfileId 是权威校验入口 |
| TriggerSource → ProfileId 映射 | daemon/bootstrap（RunDefaultsPolicy）| **不在此模块**；permission-profiles 不知道触发源语义 |

---

## 五、文档自检

- [x] PermissionProfile 作为数据对象（不是策略类）的定位清晰
- [x] applyProfile 作为叠加过滤（不替代 policy）的定位清晰
- [x] TriggerSource → ProfileId 映射不在此模块的边界说明
- [x] 四种内置画像的属性对比直观
