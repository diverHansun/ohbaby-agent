# 权限系统测试方案

> 基于实施方案（02-implementation-plan.md）
> 测试框架：vitest（项目已使用）

---

## 一、测试分类

| 测试类型 | 覆盖范围 | 优先级 |
|----------|---------|--------|
| 单元测试 | `assertInsideWorkdir`、`createPermissionContext`、`evaluatePermissionOnly` | P0 |
| 集成测试 | scheduler + permission + environment 完整流程 | P0 |
| 安全测试 | 绝对路径绕过、路径遍历攻击 | P0 |
| 回归测试 | write/bash 权限行为按新矩阵更新且无非预期回退 | P1 |

---

## 二、单元测试

### 2.1 `assertInsideWorkdir` 边界检查

**文件**：`packages/ohbaby-agent/src/adapters/ui-runtime/host-local-environment.unit.test.ts`（新建）

```typescript
import { describe, it, expect } from "vitest";
import path from "node:path";

// 注意：需要导出 checkWorkdirBoundary 函数（方案 A 步骤 4）
import { checkWorkdirBoundary } from "./host-local-environment.js";

describe("checkWorkdirBoundary", () => {
  const workdir = process.platform === "win32"
    ? "D:\\Projects\\Code-cli\\ohbaby-agent"
    : "/home/user/projects/ohbaby-agent";

  describe("工作区内路径", () => {
    it("相对路径在工作区内 → inside: true", () => {
      const inputPath = "packages/file.ts";
      const resolved = path.resolve(workdir, inputPath);
      const result = checkWorkdirBoundary(workdir, inputPath, resolved);
      expect(result.inside).toBe(true);
      expect(result.resolvedPath).toBe(resolved);
    });

    it("绝对路径在工作区内 → inside: true", () => {
      const inputPath = path.join(workdir, "packages", "file.ts");
      const resolved = inputPath;
      const result = checkWorkdirBoundary(workdir, inputPath, resolved);
      expect(result.inside).toBe(true);
    });

    it("工作区根目录本身 → inside: true", () => {
      const result = checkWorkdirBoundary(workdir, workdir, workdir);
      expect(result.inside).toBe(true);
    });
  });

  describe("工作区外路径", () => {
    it("相对路径逃逸工作区 → inside: false", () => {
      const inputPath = "../../../outside/file.txt";
      const resolved = path.resolve(workdir, inputPath);
      const result = checkWorkdirBoundary(workdir, inputPath, resolved);
      expect(result.inside).toBe(false);
    });

    it("绝对路径在工作区外 → inside: false（修复后）", () => {
      const outsidePath = process.platform === "win32"
        ? "C:\\Users\\user\\Documents\\secret.txt"
        : "/home/user/Documents/secret.txt";
      const result = checkWorkdirBoundary(workdir, outsidePath, outsidePath);
      expect(result.inside).toBe(false);  // ← 关键：修复前这里是 true（绕过）
    });

    it("不同驱动器的绝对路径 → inside: false", () => {
      if (process.platform !== "win32") return;
      const outsidePath = "E:\\outside\\file.txt";
      const result = checkWorkdirBoundary(workdir, outsidePath, outsidePath);
      expect(result.inside).toBe(false);
    });
  });

  describe("边界情况", () => {
    it("大小写不敏感（Windows）", () => {
      if (process.platform !== "win32") return;
      const upperWorkdir = workdir.toUpperCase();
      const lowerResolved = workdir.toLowerCase() + "\\file.ts";
      const result = checkWorkdirBoundary(upperWorkdir, "file.ts", lowerResolved);
      expect(result.inside).toBe(true);
    });

    it("符号链接解析后的路径", () => {
      // 假设 workdir 是符号链接，realpath 后指向真实路径
      const realWorkdir = process.platform === "win32"
        ? "D:\\real\\projects\\ohbaby-agent"
        : "/real/projects/ohbaby-agent";
      const resolved = path.join(realWorkdir, "file.ts");
      const result = checkWorkdirBoundary(realWorkdir, "file.ts", resolved);
      expect(result.inside).toBe(true);
    });
  });
});
```

**子代理审查标注**：
- [ ] 测试覆盖了绝对路径绕过场景（问题 1）
- [ ] 测试覆盖了相对路径逃逸场景（问题 2）
- [ ] 测试覆盖了 Windows 大小写不敏感
- [ ] 测试覆盖了符号链接场景
- [ ] **关键断言**：`expect(result.inside).toBe(false)` 对绝对路径在工作区外的情况

---

### 2.2 `createPermissionContext` 外部读检查

**文件**：`packages/ohbaby-agent/src/core/tool-scheduler/scheduler.unit.test.ts`（扩展现有测试）

```typescript
import { describe, it, expect, vi } from "vitest";

describe("createPermissionContext - externalRead", () => {
  const mockEnvironment = {
    workdir: "/workspace",
    resolvePathForExisting: vi.fn().mockResolvedValue("/workspace/file.ts"),
    containsTrustedPath: vi.fn().mockReturnValue(true),
  };

  describe("readonly 类别", () => {
    it("工作区内读 → externalRead: false", async () => {
      const request = {
        toolName: "read",
        params: { file_path: "/workspace/file.ts" },
        environment: mockEnvironment,
      };
      const context = await createPermissionContext(request, "readonly", mockTool);
      expect(context.externalRead).toBe(false);
    });

    it("工作区外读 → externalRead: true", async () => {
      const outsideEnv = {
        ...mockEnvironment,
        containsTrustedPath: vi.fn().mockReturnValue(false),
      };
      const request = {
        toolName: "read",
        params: { file_path: "/outside/secret.txt" },
        environment: outsideEnv,
      };
      const context = await createPermissionContext(request, "readonly", mockTool);
      expect(context.externalRead).toBe(true);
      expect(context.externalReadPath).toBe("/outside/secret.txt");
    });

    it("相对路径工作区外读 → externalRead: true", async () => {
      const outsideEnv = {
        ...mockEnvironment,
        containsTrustedPath: vi.fn().mockReturnValue(false),
      };
      const request = {
        toolName: "read",
        params: { file_path: "../../../outside/secret.txt" },
        environment: outsideEnv,
      };
      const context = await createPermissionContext(request, "readonly", mockTool);
      expect(context.externalRead).toBe(true);
    });
  });

  describe("write 类别（回归测试）", () => {
    it("工作区内写 → externalWrite: false", async () => {
      const request = {
        toolName: "write",
        params: { file_path: "/workspace/file.ts" },
        environment: mockEnvironment,
      };
      const context = await createPermissionContext(request, "write", mockTool);
      expect(context.externalWrite).toBe(false);
    });

    it("工作区外写 → externalWrite: true", async () => {
      const outsideEnv = {
        ...mockEnvironment,
        containsTrustedPath: vi.fn().mockReturnValue(false),
      };
      const request = {
        toolName: "write",
        params: { file_path: "/outside/file.ts" },
        environment: outsideEnv,
      };
      const context = await createPermissionContext(request, "write", mockTool);
      expect(context.externalWrite).toBe(true);
    });
  });
});
```

**子代理审查标注**：
- [ ] 测试覆盖了 readonly 类别的外部路径检查（问题 3）
- [ ] 测试覆盖了 write 类别的回归（确保不破坏现有行为）
- [ ] **关键断言**：`expect(context.externalRead).toBe(true)` 对工作区外读
- [ ] mock 的 `containsTrustedPath` 正确模拟了边界检查

---

### 2.3 `preflightCall` 处理 externalRead

**文件**：`packages/ohbaby-agent/src/core/tool-scheduler/scheduler.unit.test.ts`（扩展）

```typescript
describe("scheduler externalRead preflight", () => {
  it("default level + externalRead: true → external_directory ask", async () => {
    // 通过完整 scheduler.execute 断言 permission.ask 收到 toolName external_directory
  });

  it("full-access level + externalRead: true → 不询问但执行成功", async () => {
    // full-access 的 allow 不能再被 externalRead 强制转换成 ask
  });

  it("default level + externalRead: false → 不询问并执行成功", async () => {
    // 工作区内 read/glob/grep 不应触发 external_directory 权限
  });
});
```

**子代理审查标注**：
- [ ] 测试覆盖了 default level 下外部读需要批准，且权限请求使用 `external_directory`
- [ ] 测试覆盖了 full-access level 下外部读直接放行
- [ ] 测试覆盖了工作区内读不受影响
- [ ] 测试覆盖了批准后工具执行阶段不会再触发 `SANDBOX_BOUNDARY_ERROR`

---

## 三、集成测试

### 3.1 完整权限流程测试

**文件**：`packages/ohbaby-agent/src/core/tool-scheduler/scheduler.integration.test.ts`（新建或扩展）

```typescript
import { describe, it, expect, vi } from "vitest";
import { createToolScheduler } from "./scheduler.js";
import { createPermissionState } from "../../permission/index.js";

describe("Scheduler 权限集成 - read 工具", () => {
  it("default level: 工作区内读 → 直接执行，不询问用户", async () => {
    const permissionState = createPermissionState();
    permissionState.setLevel("default");
    const askSpy = vi.fn();
    const scheduler = createSchedulerWithMocks(permissionState, askSpy);

    const result = await scheduler.execute({
      toolName: "read",
      params: { file_path: "packages/file.ts" },  // 工作区内相对路径
      sessionId: "test-session",
      messageId: "msg-1",
      callId: "call-1",
      environment: createMockEnvironment("/workspace"),
    });

    expect(result.status).toBe("completed");
    expect(askSpy).not.toHaveBeenCalled();  // 不应询问用户
  });

  it("default level: 工作区外读 → 询问用户", async () => {
    const permissionState = createPermissionState();
    permissionState.setLevel("default");
    const askSpy = vi.fn().mockResolvedValue("once");
    const scheduler = createSchedulerWithMocks(permissionState, askSpy);

    const result = await scheduler.execute({
      toolName: "read",
      params: { file_path: "/outside/secret.txt" },  // 工作区外绝对路径
      sessionId: "test-session",
      messageId: "msg-1",
      callId: "call-1",
      environment: createMockEnvironment("/workspace"),
    });

    expect(askSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: "external_directory",
        reason: expect.stringContaining("External path access"),
      })
    );
    expect(result.status).toBe("completed");  // 用户批准后执行
  });

  it("full-access level: 工作区外读 → 直接执行，不询问用户", async () => {
    const permissionState = createPermissionState();
    permissionState.setLevel("full-access");
    const askSpy = vi.fn();
    const scheduler = createSchedulerWithMocks(permissionState, askSpy);

    const result = await scheduler.execute({
      toolName: "read",
      params: { file_path: "/outside/secret.txt" },
      sessionId: "test-session",
      messageId: "msg-1",
      callId: "call-1",
      environment: createMockEnvironment("/workspace"),
    });

    expect(result.status).toBe("completed");
    expect(askSpy).not.toHaveBeenCalled();  // full-access 不询问
  });

  it("default level: 工作区外读用户拒绝 → 返回 rejected", async () => {
    const permissionState = createPermissionState();
    permissionState.setLevel("default");
    const askSpy = vi.fn().mockResolvedValue("reject");
    const scheduler = createSchedulerWithMocks(permissionState, askSpy);

    const result = await scheduler.execute({
      toolName: "read",
      params: { file_path: "/outside/secret.txt" },
      sessionId: "test-session",
      messageId: "msg-1",
      callId: "call-1",
      environment: createMockEnvironment("/workspace"),
    });

    expect(result.status).toBe("rejected");
  });
});

describe("Scheduler 权限集成 - write 工具（回归）", () => {
  it("default level: 工作区内写 → 询问用户", async () => {
    const permissionState = createPermissionState();
    permissionState.setLevel("default");
    const askSpy = vi.fn().mockResolvedValue("once");
    const scheduler = createSchedulerWithMocks(permissionState, askSpy);

    const result = await scheduler.execute({
      toolName: "write",
      params: { file_path: "packages/file.ts", content: "test" },
      sessionId: "test-session",
      messageId: "msg-1",
      callId: "call-1",
      environment: createMockEnvironment("/workspace"),
    });

    expect(askSpy).toHaveBeenCalled();
    expect(result.status).toBe("completed");
  });

  it("full-access level: 工作区外写 → 直接执行，不询问用户", async () => {
    const permissionState = createPermissionState();
    permissionState.setLevel("full-access");
    const askSpy = vi.fn().mockResolvedValue("once");
    const scheduler = createSchedulerWithMocks(permissionState, askSpy);

    const result = await scheduler.execute({
      toolName: "write",
      params: { file_path: "/outside/file.ts", content: "test" },
      sessionId: "test-session",
      messageId: "msg-1",
      callId: "call-1",
      environment: createMockEnvironment("/workspace"),
    });

    expect(askSpy).not.toHaveBeenCalled();  // full-access 下外部写不再批准
    expect(result.status).toBe("completed");
  });
});
```

**子代理审查标注**：
- [ ] 测试覆盖了 default level 下工作区内读不拦截
- [ ] 测试覆盖了 default level 下工作区外读询问用户
- [ ] 测试覆盖了 full-access level 下工作区外读不拦截
- [ ] 测试覆盖了用户拒绝场景
- [ ] 测试覆盖了 write 工具的回归（确保不破坏现有行为）
- [ ] **关键断言**：`expect(askSpy).not.toHaveBeenCalled()` 对不应询问的场景
- [ ] **关键断言**：`expect(askSpy).toHaveBeenCalled()` 对应询问的场景

---

## 四、安全测试

### 4.1 绝对路径绕过防护

**文件**：`packages/ohbaby-agent/src/adapters/ui-runtime/host-local-environment.security.test.ts`（新建）

```typescript
import { describe, it, expect } from "vitest";
import path from "node:path";
import { createHostLocalEnvironment } from "./host-local-environment.js";

describe("安全测试 - 绝对路径绕过防护", () => {
  const workdir = process.platform === "win32"
    ? "D:\\Projects\\Code-cli\\ohbaby-agent"
    : "/home/user/projects/ohbaby-agent";

  it("绝对路径在工作区外 → 不再静默放行", async () => {
    const env = createHostLocalEnvironment(workdir);
    const outsidePath = process.platform === "win32"
      ? "C:\\Users\\user\\Documents\\secret.txt"
      : "/home/user/Documents/secret.txt";

    // 修复后：resolvePathForExisting 应该返回路径（让 scheduler 处理权限）
    // 而非静默放行或抛错
    const resolved = await env.resolvePathForExisting(outsidePath);
    expect(resolved).toBe(outsidePath);  // 返回路径，不抛错
    // scheduler 层会检查 externalRead 并走权限流程
  });

  it("路径遍历攻击（../../../etc/passwd）→ 正确处理", async () => {
    const env = createHostLocalEnvironment(workdir);
    const traversalPath = process.platform === "win32"
      ? "..\\..\\..\\Windows\\System32\\config\\SAM"
      : "../../../etc/passwd";

    const resolved = await env.resolvePathForExisting(traversalPath);
    // 应该返回解析后的路径，让 scheduler 检查 externalRead
    expect(resolved).toBeDefined();
  });

  it("符号链接逃逸 → 正确处理", async () => {
    // 假设工作区内有一个符号链接指向工作区外
    // 这个测试需要实际创建符号链接，可能需要跳过或 mock
    const env = createHostLocalEnvironment(workdir);
    // ... 符号链接测试逻辑
  });
});
```

**子代理审查标注**：
- [ ] 测试覆盖了绝对路径绕过场景（问题 1）
- [ ] 测试覆盖了路径遍历攻击
- [ ] 测试覆盖了符号链接逃逸
- [ ] **关键断言**：修复后不再静默放行，而是返回路径让 scheduler 处理

---

## 五、验收标准

### 5.1 功能验收

| 场景 | default level | full-access level | 验收条件 |
|------|--------------|-------------------|---------|
| 工作区内读 | ✅ 不拦截 | ✅ 不拦截 | `askSpy` 未被调用 |
| 工作区外读 | ⚠️ 询问用户 | ✅ 不拦截 | `askSpy` 被调用 / 未被调用 |
| 工作区内写 | ⚠️ 询问用户 | ✅ 不拦截 | `askSpy` 被调用 / 未被调用 |
| 工作区外写 | ⚠️ 询问用户 | ✅ 不拦截 | `askSpy` 被调用 / 未被调用 |
| bash（普通） | ⚠️ 询问用户 | ✅ 不拦截 | `askSpy` 被调用 / 未被调用 |
| bash（敏感路径） | ⚠️ 询问用户 | ⚠️ 询问用户 | `askSpy` 被调用 |

### 5.2 安全验收

- [ ] 绝对路径不再绕过边界检查
- [ ] 路径遍历攻击被正确检测
- [ ] 符号链接逃逸被正确处理
- [ ] 权限级别变更立即生效

### 5.3 回归验收

- [ ] write 工具行为符合新矩阵：default 询问，full-access 不询问
- [ ] bash 工具行为符合新矩阵：default 询问，full-access 普通命令不询问，敏感路径仍询问
- [ ] 现有 session rules 功能正常
- [ ] 现有 plan mode 功能正常

---

## 六、子代理审查清单

### 审查员 A：安全审查

- [ ] 绝对路径绕过已修复（问题 1）
- [ ] 路径遍历攻击已防护
- [ ] 符号链接逃逸已防护
- [ ] 权限级别变更立即生效
- [ ] 无新的安全漏洞引入

### 审查员 B：功能审查

- [ ] default level 行为符合预期
- [ ] full-access level 行为符合预期
- [ ] 工作区内读不拦截
- [ ] 工作区外读走权限流程
- [ ] write/bash 工具回归通过

### 审查员 C：代码质量审查

- [ ] 单元测试覆盖率 > 80%
- [ ] 集成测试覆盖所有关键路径
- [ ] 测试用例命名清晰，描述行为而非实现
- [ ] mock 使用合理，不过度 mock
- [ ] 无硬编码的路径或环境依赖

### 审查员 D：性能审查

- [ ] 边界检查无显著性能退化
- [ ] `TrustedRootRegistry.contains` 性能可接受
- [ ] 无不必要的文件系统操作

---

## 七、测试执行命令

```bash
# 单元测试
npx vitest run packages/ohbaby-agent/src/adapters/ui-runtime/host-local-environment.unit.test.ts
npx vitest run packages/ohbaby-agent/src/core/tool-scheduler/scheduler.unit.test.ts

# 集成测试
npx vitest run packages/ohbaby-agent/src/core/tool-scheduler/scheduler.integration.test.ts

# 安全测试
npx vitest run packages/ohbaby-agent/src/adapters/ui-runtime/host-local-environment.security.test.ts

# 全量测试
npx vitest run packages/ohbaby-agent/src
```

---

## 八、测试数据准备

### 8.1 Mock Environment

```typescript
function createMockEnvironment(workdir: string) {
  return {
    workdir,
    resolvePathForExisting: vi.fn(async (inputPath: string) => {
      return path.isAbsolute(inputPath)
        ? inputPath
        : path.resolve(workdir, inputPath);
    }),
    resolvePathForWrite: vi.fn(async (inputPath: string) => {
      return path.isAbsolute(inputPath)
        ? inputPath
        : path.resolve(workdir, inputPath);
    }),
    containsTrustedPath: vi.fn((resolvedPath: string) => {
      const normalized = path.resolve(resolvedPath).toLowerCase();
      const root = path.resolve(workdir).toLowerCase();
      return normalized.startsWith(root);
    }),
    trustPath: vi.fn(),
    resolveCommandContext: vi.fn(() => ({ cwd: workdir, kind: "host-local" })),
  };
}
```

### 8.2 Mock Tool

```typescript
const mockTool = {
  name: "read",
  description: "Read file",
  parametersJsonSchema: {
    type: "object",
    properties: {
      file_path: { type: "string" },
    },
    required: ["file_path"],
  },
  execute: vi.fn(async () => ({ content: "file content" })),
};
```
