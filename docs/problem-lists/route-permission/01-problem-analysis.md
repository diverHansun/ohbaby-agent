# 权限系统问题分析报告

> 分析日期：2026-05-31
> 分析范围：permission、sandbox、shell、tools 模块及 tool-scheduler

---

## 一、问题概述

当前权限系统存在**架构层面的断裂**：路径边界检查（`assertInsideWorkdir`）与权限决策系统（`evaluatePermission`）是两条完全脱节的路径，导致：

1. **权限级别（default/full-access）对路径边界检查完全无效**
2. **读工具（read/glob/grep）的外部路径访问无法走用户批准流程**
3. **绝对路径存在安全绕过漏洞**

### 期望的权限行为

| 场景 | default level | full-access level |
|------|--------------|-------------------|
| 工作区内读 | ✅ 不拦截 | ✅ 不拦截 |
| 工作区外读 | ⚠️ 用户批准 | ✅ 不拦截 |
| 工作区内写 | ⚠️ 用户批准 | ✅ 不拦截 |
| 工作区外写 | ⚠️ 用户批准 | ⚠️ 用户批准（可记住） |
| bash（普通） | ⚠️ 用户批准 | ✅ 不拦截 |
| bash（敏感路径） | ⚠️ 用户批准 | ⚠️ 用户批准 |

---

## 二、问题详细分析

### 问题 1：`assertInsideWorkdir` 绝对路径绕过

**位置**：`packages/ohbaby-agent/src/adapters/ui-runtime/host-local-environment.ts:35-37`

**问题代码**：
```typescript
function assertInsideWorkdir(
  workdir: string,
  inputPath: string,
  resolved: string,
): string {
  if (path.isAbsolute(inputPath)) {
    return resolved;  // ← BUG: 绝对路径完全绕过边界检查
  }
  // ... 只有相对路径才走下面的检查
}
```

**影响**：
- 读工具（read/glob/grep）使用绝对路径（如 `D:\outside\secret.txt`）可以**静默访问工作区外任意文件**
- 权限级别（default/full-access）对此**完全无效**
- 这是一个**安全漏洞**：绕过工作区边界保护

**根因**：
- `assertInsideWorkdir` 的设计意图是"只检查相对路径是否逃逸工作区"
- 但绝对路径同样需要边界检查，否则形成安全绕过

**受影响模块**：
- `adapters/ui-runtime/host-local-environment.ts`
- 所有使用 `resolvePathForExisting`、`resolvePath`、`resolvePathForWrite` 的工具

---

### 问题 2：`assertInsideWorkdir` 相对路径硬抛错

**位置**：`packages/ohbaby-agent/src/adapters/ui-runtime/host-local-environment.ts:44-47`

**问题代码**：
```typescript
const relative = path.relative(normalizedRoot, normalizedCandidate);
if (relative.startsWith("..") || path.isAbsolute(relative)) {
  throw new Error(`Path escapes workspace: ${inputPath}`);  // ← 硬抛错，无法走权限审批
}
```

**影响**：
- 当相对路径逃逸工作区时，直接抛出 JavaScript Error
- 错误被工具捕获后显示为"执行失败"，而非"需要用户批准"
- 用户**无法通过权限系统批准**工作区外的读取操作
- 权限级别（default/full-access）对此**完全无效**

**根因**：
- 边界检查在环境层（environment layer）执行，而非权限层（permission layer）
- 环境层没有与权限系统通信的机制，只能"放行"或"拒绝"

**受影响模块**：
- `adapters/ui-runtime/host-local-environment.ts`
- `tools/read.ts`、`tools/glob.ts`、`tools/grep.ts`、`tools/list.ts`

---

### 问题 3：`createPermissionContext` 只检查 write 类别，readonly 无外部路径能力

**位置**：`packages/ohbaby-agent/src/core/tool-scheduler/scheduler.ts:1149-1156`

**问题代码**：
```typescript
if (category !== "write" || !request.environment) {
  return {
    environment: request.environment,
    externalWrite: false,  // ← 读工具永远 externalWrite: false
    requireExplicitApproval,
    params: request.params,
  };
}
```

**影响**：
- scheduler 只对 `category === "write"` 的工具做外部路径检查
- 读工具（category: "readonly"）的外部路径被**完全跳过**
- 即使我们修复了问题 2，scheduler 层也没有机制让读工具走"用户批准"流程
- 在真实运行链路中，`read/glob/grep` 会先被 `evaluatePermission(readonly)` 放行，然后在工具执行阶段调用 sandbox lease 的 `resolvePathForExisting()`，最终由 `assertTrusted()` 抛出 `SANDBOX_BOUNDARY_ERROR`
- `full-access` 只影响 permission fallback，不会自动扩展 sandbox trusted roots，因此同样会在 lease 层失败

**根因**：
- `createPermissionContext` 的设计只考虑了写工具的外部路径场景
- 读工具的外部路径权限检查被遗漏
- 路径能力授予（trusted root / scoped environment wrapper）没有作为 permission 决策的结果传递到工具执行层

**受影响模块**：
- `core/tool-scheduler/scheduler.ts`
- 所有 readonly 类别的工具

---

### 问题 4：`assertInsideWorkdir` vs `assertTrusted` 双轨逻辑

**位置**：
- `packages/ohbaby-agent/src/adapters/ui-runtime/host-local-environment.ts:30-48`
- `packages/ohbaby-agent/src/sandbox/lease.ts:25-48`

**问题对比**：

| 特性 | `assertInsideWorkdir` | `assertTrusted` |
|------|----------------------|-----------------|
| 绝对路径检查 | ❌ 绕过 | ✅ 检查 |
| 相对路径检查 | ✅ 检查 | ✅ 检查 |
| 使用 TrustedRootRegistry | ❌ 否 | ✅ 是 |
| 支持动态信任扩展 | ❌ 否 | ✅ 是 |

**影响**：
- 两套边界检查逻辑行为不一致
- host-local environment 的安全性**低于** sandbox lease
- 违反 DRY 原则（references/03）：相似的逻辑分散在两处，维护成本高

**根因**：
- `host-local-environment.ts` 是早期实现，未使用 sandbox 模块的 `TrustedRootRegistry`
- 两套代码独立演化，未统一

**受影响模块**：
- `adapters/ui-runtime/host-local-environment.ts`
- `sandbox/lease.ts`
- `sandbox/trusted-roots.ts`

---

### 问题 5：`"command" in params` 隐式副作用

**位置**：
- `packages/ohbaby-agent/src/permission/matcher.ts:113`
- `packages/ohbaby-agent/src/permission/matcher.ts:207`
- `packages/ohbaby-agent/src/permission/classifier.ts:84`

**问题代码**：
```typescript
// matcher.ts:113
if (toolName === "bash" || "command" in call.params) {
  return "bash";
}

// matcher.ts:207
if (toolName === "bash" || (isRecord(params) && "command" in params)) {
  return "bash";
}

// classifier.ts:84
if (toolName === "bash" || "command" in call.params) {
  // 分类为 bash
}
```

**影响**：
- 任何工具如果参数中包含 `command` 字段，会被误分类为 bash 工具
- 当前 builtin 工具中没有此问题，但 MCP 工具或自定义工具可能触发
- 误分类会导致权限模式匹配错误（使用 bash 的 arity-key 逻辑）

**根因**：
- 使用 `"command" in params` 作为 bash 工具的判断条件是**隐式耦合**
- 应该显式检查 `toolName === "bash"` 或使用工具注册时的 category

**受影响模块**：
- `permission/matcher.ts`
- `permission/classifier.ts`
- 潜在的 MCP 工具或自定义工具

---

### 问题 6：`default/full-access` 的 bash 与 write 策略未对齐产品语义

**位置**：
- `packages/ohbaby-agent/src/permission/evaluator.ts:73`
- `packages/ohbaby-agent/src/permission/evaluator.ts:83`
- `packages/ohbaby-agent/src/core/tool-scheduler/scheduler.ts:683`

**当前行为**：
- `default` 下 `bash-readonly` 直接 allow，例如 `git status` 不需要用户批准
- `full-access` fallback 直接 allow，导致 `sensitive_path` 也不会询问用户
- scheduler 需要对 `externalWrite` 保留安全审批；`full-access` 下工作区外写仍应询问，并允许用户记住审批

**期望行为**：
- `default` 下所有 bash 都需要用户批准
- `full-access` 下普通 bash 直接允许，但敏感路径仍需要用户批准
- `full-access` 下工作区内 write/edit 不需要批准；工作区外 write/edit 需要外部路径审批，审批可记住，执行层仍应获得 scoped path capability，避免 policy allow 后被 sandbox resolver 拦截
- `plan` 模式的审批规则与 `auto` 模式的 `default/full-access` 矩阵保持一致，不再使用单独的 plan deny gate

**根因**：
- `evaluatePermission()` 的 `full-access` 分支过早返回 allow，无法保留敏感路径例外
- `bash-readonly` 被归入 default allow 列表，和产品语义不一致
- external write 的安全审批需要与 session rule 记忆机制打通，否则无法做到"批准一次，下次不再弹"

---

## 三、问题影响矩阵

| 问题 | 严重性 | 影响范围 | 用户可见 | 安全风险 |
|------|--------|---------|---------|---------|
| 问题 1：绝对路径绕过 | 🔴 高 | 所有读工具 | ❌ 不可见 | ✅ 是 |
| 问题 2：相对路径硬抛错 | 🔴 高 | 所有读工具 | ✅ 可见 | ❌ 否 |
| 问题 3：scheduler 只检查 write | 🔴 高 | 所有 readonly 工具 | ✅ 可见 | ❌ 否 |
| 问题 4：双轨逻辑 | 🟡 中 | 边界检查 | ❌ 不可见 | ✅ 是 |
| 问题 5：隐式副作用 | 🟢 低 | 潜在 MCP 工具 | ❌ 不可见 | ❌ 否 |
| 问题 6：bash/write 策略未对齐 | 🔴 高 | bash、write/edit | ✅ 可见 | ✅ 是 |

---

## 四、问题关联性

```
问题 1（绝对路径绕过）
    ↓
问题 4（双轨逻辑）← 根因：两套边界检查不一致
    ↓
问题 2（相对路径硬抛错）
    ↓
问题 3（scheduler 只检查 write）← 根因：读工具无外部路径权限机制
    ↓
问题 6（策略矩阵不一致）← 根因：permission fallback 与 scheduler 硬编码策略混杂
```

**核心矛盾**：路径边界检查（环境层）与权限决策（权限层）是两条脱节的路径，需要统一。
