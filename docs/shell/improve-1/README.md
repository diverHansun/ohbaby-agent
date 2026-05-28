# Shell Improvement — Round 1

本目录记录 `packages/ohbaby-agent/src/shell/` 与 builtin `bash` 工具第一轮优化设计。
它与 [sandbox improve-1](../../sandbox/improve-1/README.md) 是同一条运行时安全链路的两半：

- shell 负责理解和稳定执行 shell 命令。
- sandbox 负责把 shell 分析结果转成 workspace 边界事实。
- permission 负责基于事实做 allow / ask / deny。

## 背景一句话

当前 `bash` 工具已经调用 [shell/preflight.ts](../../../packages/ohbaby-agent/src/shell/preflight.ts)，
但这个 preflight 仍是工具内部的抛错式检查：scheduler 已经完成 permission 后，`bash.execute()`
才可能因为路径越界、动态路径或黑名单失败。这个顺序对后续 skill `scripts/` 运行时不够好：
脚本中合法的 `../`、绝对路径、`~` 路径应该先触发 `external_directory` permission，
而不是被 shell 层当作执行错误直接拦截。

## 关键决策摘要

| 维度 | 决策 | 影响 |
|---|---|---|
| 职责定位 | shell 是命令语法分析与进程执行层 | 不做 permission 决策，不做 workspace 策略 |
| 命令解析 | 先收敛现有轻量 preflight，保留 opencode 风格 tree-sitter 替换缝 | 分批实施；improve-1 已覆盖本轮 external-first 所需路径与 arity 场景 |
| 外部路径 | shell 只抽取路径候选；外部路径由 sandbox 标注并由 permission ask | `../` 和绝对外部路径不会被 shell 直接拒绝 |
| 进程硬化 | 补齐 kimi-code 风格 non-interactive env 与 stdin close | 降低交互命令挂死、git 凭据提示、彩色输出噪音 |
| commandPrefix | `bash` 工具必须支持 commandPrefix 桥接 | 为未来 OS adapter / remote adapter 保留扩展点 |
| skill scripts | 作为重要消费者显式纳入设计 | 避免后续 scripts 运行时再做一套 shell/sandbox 二次实现 |

## 文档导航

1. [goal-and-duty.md](goal-and-duty.md) — shell 模块职责、非职责、与 sandbox/permission 的边界
2. [data-flow.md](data-flow.md) — 从 bash tool call 到 spawn 的数据流与 external-first 权限顺序
3. [integration-plan.md](integration-plan.md) — 分批实施路径、文件级改动、提交与验证策略
4. [test-plan.md](test-plan.md) — 单元、集成、e2e 与子代理审查要求

## 范围

shell improve-1 覆盖：

- 稳定 builtin `bash` 的执行环境：non-interactive env、stdin close、输出/取消/超时语义保持一致。
- 把现有抛错式 `preflightShellCommand()` 逐步拆成结构化 shell analysis。
- 新增结构化 shell analysis，抽取 command source、tokens、path args、dynamic 标志、danger 分类和 arity pattern；tree-sitter AST 替换留在后续阶段。
- 支持 `commandPrefix`，但 HostLocal 默认不使用。
- 为 [sandbox preflight](../../sandbox/improve-1/data-flow.md) 提供输入事实，不直接问 permission。

不在 shell improve-1 范围：

- 不做 OS 级 sandbox。
- 不做 permission rule 匹配。
- 不做 workspace inside/outside 决策。
- 不做 skill runtime 自己的脚本调度器；skill scripts 通过现有 bash tool / scheduler 链路受保护。
- 不引入后台任务管理器。

## 与 sandbox improve-1 的关系

shell 输出的是语法事实，例如：

```ts
interface ShellCommandAnalysis {
  readonly source: string;
  readonly tokens: readonly string[];
  readonly root: string;
  readonly pathArgs: readonly string[];
  readonly arityKey: string;
  readonly danger: "readonly" | "mutating" | "dangerous";
  readonly hasDynamic: boolean;
}
```

sandbox 消费这些事实，结合 lease workdir 解析路径，输出：

```ts
interface PreflightResult {
  readonly externalPaths: readonly PreflightExternalPath[];
  readonly denylistHits: readonly PreflightDenylistHit[];
  readonly commands: readonly PreflightCommand[];
}
```

因此，命令解析文件应归在 `src/shell/`；workspace 边界、denylist 和 `SandboxLease.preflight()`
归在 `src/sandbox/`。这个边界是为了避免后续再次出现“shell 一套、sandbox 一套”的二次实现。
