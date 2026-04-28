# permission-profiles 模块 test.md

本文档说明如何验证 `runtime/permission-profiles` 模块在协作环境中的正确性。

测试分类标准参见 `docs-test/classification.md`，mock 边界规则参见 `docs-test/writing-guide.md`。

---

## 一、Test Scope（测试范围）

**覆盖**：
- ProfileRegistry 的 getProfile(profileId)：已注册 ID 返回正确配置，未知 ID 返回错误
- validateProfileId(profileId)：合法性检查
- applyProfile(profile, policyDecision)：各 PermissionProfile 对 core/policy 决策结果的叠加过滤
- 4 种内置 profile（interactive / read-only / notify-only / full-auto）的权限边界

**不覆盖**：
- run-manager 如何使用 PermissionProfile（run-manager 侧的职责）
- 用户自定义 profile 的配置格式验证（配置 schema 层的职责）

---

## 二、Critical Scenarios（关键场景）

| 场景 | 预期结果 |
|------|---------|
| getProfile('interactive') | 返回 interactive profile 配置 |
| getProfile('unknown-id') | 抛出 UnknownProfileError |
| applyProfile(read-only, write ALLOW) | 降级为 DENY（read-only 不允许写文件）|
| applyProfile(interactive, ASK) | 保持 ASK，允许 UI/CLI 继续询问用户 |
| applyProfile(notify-only, ASK) | 转为 notify 语义，不阻塞等待用户确认 |
| applyProfile(full-auto, ASK) | 自动处理，不返回 ASK |
| validateProfileId('read-only') | 通过 |
| validateProfileId('') | 失败 |

---

## 三、Integration Points（集成点测试）

permission-profiles 是纯同步查找层，无外部 I/O 依赖。无需集成测试。

---

## 四、Verification Strategy（验证策略）

### 主策略：纯单元测试（unit）

**测试对象**：ProfileRegistry、applyProfile 函数

**Mock 范围**：无需 mock

**关注点**：applyProfile 的测试应覆盖所有 profile × 关键 operation 的组合。permission-profiles 的价值在于权限边界是否正确，遗漏某个 (profile, operation) 组合会直接导致安全边界失效。建议用参数化测试（parametrize）枚举关键组合。
