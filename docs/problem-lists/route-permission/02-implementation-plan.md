# 权限系统实施方案

> 基于问题分析报告（01-problem-analysis.md）
> 遵循软件工程原理：高内聚低耦合（references/02）、SRP（references/03）、KISS（references/03）

---

## 一、实施优先级

基于 SWE 原理的优先级排序：

| 优先级 | 问题 | 理由 |
|--------|------|------|
| P0 | 问题 1：绝对路径绕过 | 安全漏洞，必须立即修复 |
| P0 | 问题 2：相对路径硬抛错 | 用户体验断裂，核心功能不可用 |
| P1 | 问题 3：scheduler 只检查 write | 读工具无外部路径权限机制，阻塞问题 2 的完整解决 |
| P1 | 问题 6：bash/write 策略未对齐 | 当前行为与 default/full-access 产品语义不一致 |
| P2 | 问题 4：双轨逻辑 | 技术债，长期维护风险 |
| P3 | 问题 5：隐式副作用 | 当前无影响，预防性修复 |

---

## 二、实施方案

### 方案 A：最小修复（推荐首轮迭代）

**目标**：修复 P0/P1 问题，让读工具的外部路径走权限系统

#### 步骤 1：修复 `assertInsideWorkdir` 绝对路径绕过

**文件**：`packages/ohbaby-agent/src/adapters/ui-runtime/host-local-environment.ts`

**修改**：删除绝对路径的特殊处理，让所有路径统一走边界检查

```typescript
// 修改前
function assertInsideWorkdir(
  workdir: string,
  inputPath: string,
  resolved: string,
): string {
  if (path.isAbsolute(inputPath)) {
    return resolved;  // ← 删除这行
  }
  // ...
}

// 修改后
function assertInsideWorkdir(
  workdir: string,
  inputPath: string,
  resolved: string,
): string {
  const normalizedRoot = normalizeForBoundary(workdir);
  const normalizedCandidate = normalizeForBoundary(resolved);
  if (normalizedRoot === normalizedCandidate) {
    return resolved;
  }
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes workspace: ${inputPath}`);
  }
  return resolved;
}
```

**验证**：
- 绝对路径 `D:\outside\file.txt` 应该抛出 `Path escapes workspace`
- 工作区内绝对路径 `D:\Projects\...\file.txt` 应该正常通过

---

#### 步骤 2：在 scheduler 层增加 `externalRead` 检查和执行能力

**文件**：`packages/ohbaby-agent/src/core/tool-scheduler/scheduler.ts`

**修改**：扩展 `createPermissionContext` 支持 readonly 类别的外部路径检查，并在获批后给工具执行层一个 scoped read environment wrapper

```typescript
// 修改前
if (category !== "write" || !request.environment) {
  return {
    environment: request.environment,
    externalWrite: false,
    requireExplicitApproval,
    params: request.params,
  };
}

// 修改后
if (!request.environment) {
  return {
    environment: request.environment,
    externalWrite: false,
    externalRead: false,
    requireExplicitApproval,
    params: request.params,
  };
}

// 对 readonly 类别也做外部路径检查
if (category === "readonly") {
  const filePath = getFilePathParam(request.params);
  if (filePath) {
    const canonicalPath = await canonicalizeForPermission(
      request.environment,
      filePath,
    );
    const isExternal = isOutsideTrustedEnvironment(
      request.environment,
      canonicalPath,
    );
    return {
      environment: request.environment,
      externalWrite: false,
      externalRead: isExternal,
      externalReadPath: isExternal ? canonicalPath : undefined,
      externalReadAskPattern: isExternal
        ? await externalAskPattern(canonicalPath)
        : undefined,
      requireExplicitApproval,
      params: { ...request.params, file_path: canonicalPath },
    };
  }
}

// write 类别保持原逻辑
if (category !== "write") {
  return {
    environment: request.environment,
    externalWrite: false,
    externalRead: false,
    requireExplicitApproval,
    params: request.params,
  };
}
```

**新增类型**：`ToolPermissionContext` 增加 `externalRead` 和 `externalReadPath` 字段

```typescript
interface ToolPermissionContext {
  readonly environment?: ToolExecutionEnvironment;
  readonly externalWrite: boolean;
  readonly externalWritePath?: string;
  readonly externalRead: boolean;  // 新增
  readonly externalReadPath?: string;  // 新增
  readonly externalReadAskPattern?: string;  // 新增
  readonly preflight?: PreflightResult;
  readonly preflightError?: unknown;
  readonly requireExplicitApproval: boolean;
  readonly params: Record<string, unknown>;
}
```

---

#### 步骤 3：在 `preflightCall` 中处理 `externalRead`

**文件**：`packages/ohbaby-agent/src/core/tool-scheduler/scheduler.ts`

**修改**：当 `externalRead` 为 true 时，先按 `external_directory` 权限检查；`default` 下询问用户，`full-access` 下直接允许。不要在 `evaluatePermissionOnly()` 中无条件把 `allow + externalRead` 改成 ask，否则会破坏 `full-access` 和 session allow rule。

```typescript
const externalReadResult = await confirmExternalReadPermission(
  prepared.call,
  prepared.permissionContext,
);
if (externalReadResult) {
  return externalReadResult;
}
```

**执行能力**：
- `once` 批准：使用 scoped read wrapper，仅允许本次调用访问 `externalReadPath`
- `always` 批准：可调用 `environment.trustPath({ kind: "external-approved", ... })`，同时本次仍使用 wrapper 兜底
- `full-access`：不询问用户，但仍使用 wrapper 或 full-access resolver，避免工具执行阶段被 sandbox lease 拦截

---

#### 步骤 3.5：调整 write 和 bash 的权限语义

**文件**：
- `packages/ohbaby-agent/src/permission/evaluator.ts`
- `packages/ohbaby-agent/src/core/tool-scheduler/scheduler.ts`

**修改**：
- `default` 下所有 bash（包括 `bash-readonly`）返回 ask
- `full-access` 下普通 bash 返回 allow
- `sensitive_path` 在 `full-access` 下仍返回 ask
- `full-access` 下 `externalWrite` 不再强制 ask；执行环境继续使用 scoped write wrapper 让外部写实际可执行

```typescript
if (call.toolName === "sensitive_path") {
  return ask(`Sensitive path access requires confirmation: ${call.toolName}`);
}
if (level === "full-access") {
  return allow();
}

case "bash-readonly":
case "bash-mutating":
case "bash-dangerous":
  return ask(`Shell command requires confirmation: ${call.toolName}`);
```

---

#### 步骤 4：修改环境层，让边界检查返回结构化结果而非抛错

**文件**：`packages/ohbaby-agent/src/adapters/ui-runtime/host-local-environment.ts`

**修改**：将 `assertInsideWorkdir` 改为返回结构化结果，由调用方决定如何处理

```typescript
// 新增类型
interface BoundaryCheckResult {
  readonly inside: boolean;
  readonly resolvedPath: string;
  readonly inputPath: string;
}

// 修改函数签名
function checkWorkdirBoundary(
  workdir: string,
  inputPath: string,
  resolved: string,
): BoundaryCheckResult {
  const normalizedRoot = normalizeForBoundary(workdir);
  const normalizedCandidate = normalizeForBoundary(resolved);
  if (normalizedRoot === normalizedCandidate) {
    return { inside: true, resolvedPath: resolved, inputPath };
  }
  const relative = path.relative(normalizedRoot, normalizedCandidate);
  const inside = !relative.startsWith("..") && !path.isAbsolute(relative);
  return { inside, resolvedPath: resolved, inputPath };
}

// 修改 resolvePathForExisting
async resolvePathForExisting(inputPath: string): Promise<string> {
  const resolved = await fs.realpath(resolveHostPath(root, inputPath));
  const result = checkWorkdirBoundary(root, inputPath, resolved);
  if (!result.inside) {
    // 不再抛错，而是返回 resolved 路径，让 scheduler 层处理权限
    return result.resolvedPath;
  }
  return result.resolvedPath;
}
```

**注意**：这个修改需要与步骤 2/3 配合，否则环境层不再拦截外部路径，但 scheduler 层也没有检查，会导致安全漏洞。真实运行链路中还必须覆盖 `sandbox/lease.ts`，因为截图中的 `SANDBOX_BOUNDARY_ERROR` 来自 lease 的 trusted-root 检查，而不是 host-local environment 的 `assertInsideWorkdir`。

**实施顺序**：必须先完成步骤 2/3，再修改步骤 4。

---

### 方案 B：统一边界检查（推荐二轮迭代）

**目标**：修复 P2 问题，统一 `assertInsideWorkdir` 和 `assertTrusted`

#### 步骤 1：让 host-local environment 使用 TrustedRootRegistry

**文件**：`packages/ohbaby-agent/src/adapters/ui-runtime/host-local-environment.ts`

**修改**：引入 `TrustedRootRegistry`，替换手动的边界检查

```typescript
import { TrustedRootRegistry } from "../../sandbox/index.js";

export function createHostLocalEnvironment(
  workdir = process.cwd(),
): ToolExecutionEnvironment {
  const root = realpathExistingDirectory(path.resolve(workdir));
  const trustedRoots = TrustedRootRegistry.create(root);  // 使用 sandbox 的 registry

  return {
    workdir: root,
    async resolvePathForExisting(inputPath: string): Promise<string> {
      const resolved = await fs.realpath(resolveHostPath(root, inputPath));
      // 使用 TrustedRootRegistry.contains 检查边界
      if (!(await trustedRoots).contains(resolved)) {
        // 返回路径，让 scheduler 层处理权限
        return resolved;
      }
      return resolved;
    },
    // ...
  };
}
```

**优势**：
- 统一边界检查逻辑，消除双轨
- 支持动态信任扩展（`trustPath`）
- 与 sandbox lease 行为一致

---

### 方案 C：修复隐式副作用（推荐三轮迭代）

**目标**：修复 P3 问题，消除 `"command" in params` 的隐式判断

#### 步骤 1：显式检查 toolName

**文件**：`packages/ohbaby-agent/src/permission/matcher.ts`

**修改**：
```typescript
// 修改前
if (toolName === "bash" || "command" in call.params) {
  return "bash";
}

// 修改后
if (toolName === "bash") {
  return "bash";
}
```

**文件**：`packages/ohbaby-agent/src/permission/classifier.ts`

**修改**：
```typescript
// 修改前
if (toolName === "bash" || "command" in call.params) {
  // 分类为 bash
}

// 修改后
if (toolName === "bash") {
  // 分类为 bash
}
```

**注意**：需要确认是否有 MCP 工具依赖 `"command" in params` 的行为。如果有，需要显式注册为 bash 类别。

---

## 三、实施风险与缓解

| 风险 | 影响 | 缓解措施 |
|------|------|---------|
| 步骤 4 修改环境层后，scheduler 层未同步修改 | 安全漏洞 | 严格按顺序实施：先步骤 2/3，后步骤 4 |
| 统一 TrustedRootRegistry 后，性能下降 | 读工具变慢 | 性能测试，必要时缓存 registry |
| 删除 `"command" in params` 后，MCP 工具失效 | 功能回归 | 先排查现有 MCP 工具，确认无依赖 |

---

## 四、实施检查清单

- [ ] 步骤 1：修复 `assertInsideWorkdir` 绝对路径绕过
- [ ] 步骤 2：scheduler 增加 `externalRead` 检查
- [ ] 步骤 3：`preflightCall` 处理 `externalRead` 并授予 scoped read capability
- [ ] 步骤 3.5：调整 write/bash 的 default/full-access 语义
- [ ] 步骤 4：环境层返回结构化结果
- [ ] 单元测试覆盖所有修改
- [ ] 集成测试验证 default/full-access 行为
- [ ] 安全测试验证绝对路径不再绕过
- [ ] 性能测试验证无显著退化
