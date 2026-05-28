# Sandbox Improvement — Round 2

本目录记录 `packages/ohbaby-agent/src/sandbox/` 第二轮优化设计。
主题是**把单一 workspace 边界升级为 session 动态可信根的执行环境**，
让 skill 模块的 `scripts/` 能在 workspace 之外（已加载 skill 的 exact baseDir、用户手动信任的外部目录）受控运行，
并消费 [shell improve-2](../../shell/improve-2/README.md) 新增的脚本执行事实。

## 背景：improve-1 之后面向 skill 的两个缺口

improve-1 把 sandbox 做成了"workspace 边界事实供应方 + 统一 execution environment"，
但只有**单一 workspace 根**，且只对 shell 白名单命令的路径做边界判定。review 实测暴露：

- **G3 单根问题**：skill 脚本天然在 workspace 外（`~/.claude/skills/...`），
  sandbox preflight 目前只按单一 `workdir` 判 inside/outside，且全仓无 session trusted roots 概念。
  结果：即使 skill 已被加载，脚本路径仍会被当成 workspace 外路径，反复触发 `external_directory` ask。
- **G1 脚本盲区（消费侧）**：解释器脚本（`python run.py`）与直接执行脚本（`./run.sh`）的脚本路径
  在 improve-1 不被抽取，sandbox 对"运行一个脚本"是瞎的。shell improve-2 已新增 `executedScript`
  事实，sandbox improve-2 负责消费它。

## 关键决策摘要

| 维度 | 决策 | 影响 |
|---|---|---|
| 多可信根 | 新增 session 级 `TrustedRootRegistry`（workspace + 已加载 exact skill baseDir + external always + skill output） | skill 根可信、不弹窗；真正越界仍 ask |
| 边界判定 | `boundary.classify` 对当前 session trusted roots 判定 inside/outside | inside 任一根即视为内部 |
| 脚本事实消费 | `executedScript` 与 `pathArgs` 一并过 boundary/denylist/sensitive | 运行脚本对安全链路可见 |
| 执行环境注入 | lease / adapter 通过 `resolveCommandContext` 注入 cwd / env | skill 脚本能定位自身资源；默认仍以 workspace 为 cwd |
| 路径解析收敛 | 合并 `canonicalizeStaticPath`(shell) 与 `canonicalizeSandboxPath`(sandbox) | 消除 improve-1 遗留的双解析器（M3） |
| denylist 不变 | hard-deny 仍只覆盖 home 凭据目录 | 多根不削弱 `~/.ssh` 等硬拒 |

## 文档导航

1. [goal-and-duty.md](goal-and-duty.md) — 多根模型职责、与 shell/permission 的边界、非目标
2. [data-flow.md](data-flow.md) — 多根 boundary 数据流、executedScript 消费、PreflightResult 扩展、trusted roots 来源
3. [integration-plan.md](integration-plan.md) — 文件级改动、分阶段、与 shell improve-2 协调顺序
4. [reference-takeaways.md](reference-takeaways.md) — 对照 opencode/kimi-code/pi/Claude Code 的 skill 与多根处理

## 范围

sandbox improve-2 覆盖：

- 新增 session 级 trusted roots 管线（G3），并让 `SandboxLease` / file tools / preflight 统一消费。
- `boundary.ts` 对 trusted roots 做多根判定（G3）。
- 消费 shell 的 `executedScript`：纳入 boundary / denylist / sensitive（G1 消费侧）。
- `resolveCommandContext` 支持 cwd / env 注入约定，为 skill 提供执行环境（G5）。
- 合并两套 canonicalize 路径解析（M3）。

**不在 scope**：

- 不做 skill 模块本身（skill 发现、加载、清单解析、scripts 目录布局）——那是 skill 模块的事，
  本轮只提供它需要的"执行环境地基"。
- 不做 OS 级隔离（seatbelt/landlock/bubblewrap）——仍留 adapter 接口。
- 不做配置化 allow/deny 文件（pi 风格 `.sandbox.json`）。
- 不做命令语法分析——`executedScript`/`pathArgs` 由 [shell improve-2](../../shell/improve-2/README.md) 产出。
- 不重写 permission 系统——`external_directory` / `sensitive_path` 链路沿用 improve-1。

## 与 shell improve-2 的分工

```
shell improve-2（语法事实）              sandbox improve-2（边界 + 执行环境）
──────────────────────────             ──────────────────────────────────
executedScript / pathArgs   ──消费──►   多根 boundary + denylist + sensitive
interpreter / inlineEval    ──参考──►   inlineEval 无路径，permission 按 danger 兜底
                                        trusted roots（workspace + active skill + approved external + output）
                                        resolveCommandContext 注入 cwd/env
```

不变式：**shell 说"执行哪个脚本"，sandbox 说"这个脚本相对哪些可信根在内/外、能不能跑、在哪跑"。**

## 为 skill 模块预留的契约（不在本轮实现）

skill 模块未来落地时，向 sandbox 要的能力本轮全部备好：

- skill 工具成功加载后，把该 skill 的 exact `baseDir` 记录为 session trusted root（不弹 external）。
- 用户对外部目录选择 `always allow` 后，把该目录记录为 session trusted root；`allow once` 不记录。
- 通过 `resolveCommandContext` 拿到注入了 skill-dir env 的执行上下文。
- denylist 对 skill 脚本同样生效（skill 也不能读 `~/.ssh`）。

skill 模块自身的设计（清单、scripts 布局、生命周期）不在此文档，留给 skill 模块的 improve 轮次。
