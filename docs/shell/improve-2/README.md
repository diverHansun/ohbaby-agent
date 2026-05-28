# Shell Improvement — Round 2

本目录记录 `packages/ohbaby-agent/src/shell/` 第二轮优化设计。
主题是**把命令语法分析从"固定命令白名单"升级为"覆盖脚本执行的完整模型"**，
为后续 skill 模块的 `scripts/` 提供可靠的执行前分析基础。

它与 [sandbox improve-2](../../sandbox/improve-2/README.md) 是同一条链路的两半：

- **shell improve-2** 让命令分析认识"脚本是怎么被执行的"——解释器调用、直接执行、脚本参数。
- **sandbox improve-2** 让执行环境认识"脚本可以在哪里跑"——多可信根、skill 目录、cwd/env 注入。

## 背景：improve-1 之后暴露的脚本执行盲区

improve-1 把 shell 分析做成了结构化的 [ShellCommandAnalysis](../../../packages/ohbaby-agent/src/shell/analysis/types.ts)，
路径抽取走 [path-args.ts](../../../packages/ohbaby-agent/src/shell/path-args.ts) 的**命令白名单**
（cat/cp/ls/bash/sh/grep/find/curl…）。对普通命令够用，但对 skill 最常见的脚本执行模式有系统性盲区。
review 实测（preflight 探针）证据：

```
OK    [bash ~/.claude/skills/foo/run.sh]   resolved=[<skill路径>]   ← 提取到
OK    [python ~/.claude/skills/foo/run.py] resolved=[]             ← 脚本路径没提取
OK    [node scripts/build.js]              resolved=[]             ← 没提取
OK    [./skills/foo/run.sh]                resolved=[]             ← 直接执行，零提取
OK    [/abs/skill/run.sh]                  resolved=[]             ← 零提取
OK    [sh ./setup.sh arg1]                 resolved=[setup.sh, arg1] ← arg1 被误当路径
THROW [bash -c 'echo hi']                  Nested shell evaluation ← 硬拒
OK    [python -c 'print(1)']               resolved=[]             ← 不拒（与 bash -c 不一致）
```

后果：解释器脚本（python/node/ruby…）与直接执行的脚本（`./x.sh`、`/abs/x.sh`）的**脚本路径
不进入 boundary / denylist / sensitive 检查**——sandbox 对"运行一个脚本"这件事是瞎的。
bash 层 permission 仍会按 `mutating` 兜底问，但缺少路径级事实。

## 关键决策摘要

| 维度 | 决策 | 影响 |
|---|---|---|
| 解释器识别 | 新增 interpreter registry（python/node/ruby/deno/bun/perl/pwsh -File…），抽取脚本文件参数 | 解释器脚本路径进入边界检查 |
| 直接执行识别 | 当命令 root 本身是路径形态（`./x`、`/abs`、`../x`、`~/x`）时，把 root 作为被执行脚本事实 | 直接执行的脚本不再零检查 |
| 脚本 vs 数据参数 | 新增 `executedScript` 字段，与 `pathArgs` 分离；脚本参数只抽明显 path-like 或常见路径 option 值 | 避免误把普通脚本参数当路径，同时保留外部输入/输出目录的 external-first 检查 |
| shell-exec 过度提取 | 修复 `sh script.sh arg1` 把 `arg1` 当路径 | 消除 skill 带参调用的虚假 external ask |
| `-c`/`-e` 策略 | analysis 层先统一标记 `inlineEval`；是否放开 `bash -c` 硬拒作为独立小批次决策 | 避免脚本路径模型与 nested eval 安全语义一次变更过大 |
| 路径事实去重 | shell 层输出前去重 | metadata 干净，sandbox 不必兜底去重 |
| 字符串工具收敛 | `stripMatchingQuotes`/`msysPathToWindowsPath`/`optionValue` 合并到共享 `utils/path-strings` | 消除 improve-1 遗留的三处副本（M2），避免 sandbox 依赖 shell helper |

## 文档导航

1. [goal-and-duty.md](goal-and-duty.md) — shell 在脚本执行场景下的职责扩展、非职责、与 sandbox 的边界
2. [data-flow.md](data-flow.md) — 解释器/直接执行命令的分析数据流、新增字段 schema
3. [integration-plan.md](integration-plan.md) — 文件级改动、分阶段实施、与 sandbox improve-2 的协调顺序
4. [test-plan.md](test-plan.md) — 单元/集成/探针回归覆盖

## 范围

shell improve-2 覆盖：

- 新增 interpreter registry 与脚本参数抽取（G1a）。
- 命令 root 为路径形态时识别为被执行脚本（G1b）。
- `ShellCommandAnalysis` 新增 `executedScript` 字段，区分"被执行脚本"与"数据路径参数"。
- 脚本后续参数不做全量路径抽取，但明显 path-like 参数、外部路径、常见路径 option 值继续进入
  `pathArgs`，保持 external path 优先。
- 修复 shell-exec 命令把脚本参数误当路径（G2）。
- 统一 `inlineEval` 事实输出；是否改变 `bash -c` 现有硬拒行为作为独立决策点（G4）。
- shell 层路径事实去重（G6）。
- 收敛重复的路径字符串辅助函数到共享 `utils/path-strings`（M2）。

**不在 shell improve-2 范围**：

- 不做多可信根判定——那是 sandbox 的 boundary 职责（见 [sandbox improve-2](../../sandbox/improve-2/README.md)）。
- 不做 cwd/env 注入——那是 sandbox lease / adapter 职责。
- 不引入 tree-sitter（仍留作后续；improve-2 在轻量 parser 上扩展即可）。
- 不做 skill 模块自身的脚本调度器。
- 不做 OS 级隔离。

## 与 sandbox improve-2 的分工

```
shell improve-2 产出（语法事实）        sandbox improve-2 消费（边界事实 + 执行环境）
────────────────────────────          ──────────────────────────────────────────
ShellCommandAnalysis {                 PreflightResult {
  executedScript?: string  ◄─────────►   executedScript 经多根 boundary / denylist 判定
  pathArgs: string[]       ◄─────────►   pathArgs 经多根 boundary 判定
  interpreter?: string                   trusted roots 含 active skill exact baseDir
  ...                                    cwd/env 注入留给 lease
}                                      }
```

不变式：**shell 只回答"这条命令要执行哪个脚本、碰哪些数据路径"，sandbox 回答"这些路径相对
哪些可信根在内/外、是否敏感"。** 任何"在哪里算可信"的判断都不进 shell。
