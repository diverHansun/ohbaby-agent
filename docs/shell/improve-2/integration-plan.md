# Shell improve-2 接入方案

本文给出 shell improve-2 的文件级改动与分阶段实施。sandbox 侧的多根 boundary 与执行环境
见 [sandbox improve-2 integration-plan](../../sandbox/improve-2/integration-plan.md)。

## 总览

| 模块 | 增 | 改 | 删 / 收敛 |
|---|---|---|---|
| [src/shell/](../../../packages/ohbaby-agent/src/shell/) | `interpreters.ts` | `analysis/types.ts` / `analysis/light-parser.ts` / `path-args.ts` / `preflight.ts` | 三处重复的路径字符串 helper 收敛到共享 utils |
| [src/sandbox/](../../../packages/ohbaby-agent/src/sandbox/) | — | `paths.ts` 改 import 共享 path strings 与 canonicalize | 删自有 `stripMatchingQuotes`/`msysPathToWindowsPath` 副本 |
| [src/utils/](../../../packages/ohbaby-agent/src/utils/) | `path-canonicalize.ts` | — | shell/sandbox 双 walk-up canonicalize 收敛到共享工具 |
| [src/utils/](../../../packages/ohbaby-agent/src/utils/) | `path-strings.ts` | — | shell/sandbox 重复字符串 helper 收敛到共享工具 |
| [src/tools/bash.ts](../../../packages/ohbaby-agent/src/tools/bash.ts) | — | 仅在 metadata 透出 `executedScript`（可选） | — |

permission / scheduler **本轮不改**——`executedScript` 的边界判定全部在 sandbox 侧消费，
permission 接口不变。

## 文件改动详情

### 新增 `src/shell/interpreters.ts`

```ts
export interface InterpreterScript {
  readonly interpreter: string;       // "python" | "node" | ...
  readonly script?: string;           // 脚本文件 token；inlineEval 时 undefined
  readonly inlineEval: boolean;
}

// 每个解释器声明：inline-eval flag 集合 + "脚本参数从哪开始"
export function resolveInterpreterScript(
  tokens: readonly string[],
): InterpreterScript | undefined;
```

registry 不是执行 allowlist，而是"脚本参数位置提取表"。命令能否运行仍由 bash permission / sandbox
preflight 决定；未命中 registry 的解释器不应被拒绝，只是少一个 `executedScript` 事实。首批应尽量覆盖
常见脚本 runner：`python`/`python3`/`py`/`node`/`deno`/`bun`/`ruby`/`perl`/`php`/`bash`/`sh`/`zsh`/
`pwsh`/`powershell`，并以数据表方式后续无痛扩展。
每项规则示例：
- `python`：inline = `-c`；module = `-m`（`-m` 后是模块名不是文件，按 inlineEval 类处理或单列）；否则首个非 flag 是脚本。
- `node`：inline = `-e`/`--eval`/`-p`/`--print`；否则首个非 flag 是脚本。
- `deno`：子命令 `run`/`test`/`eval`；`eval` → inlineEval；`run` 后首个非 flag 是脚本。
- `pwsh`/`powershell`：`-File <x>` 的值是脚本；`-Command`/`-EncodedCommand` → inlineEval。

### 新增 `src/utils/path-strings.ts`（解决 M2）

把以下函数从 preflight.ts / path-args.ts / sandbox/paths.ts 抽出集中：
`stripMatchingQuotes` / `msysPathToWindowsPath` / `optionValue` / `stripRedirectionPrefix` /
`candidatePathFromToken` / `normalizeRoot`。纯字符串，无 IO。

改动方：
- [shell/preflight.ts](../../../packages/ohbaby-agent/src/shell/preflight.ts) 删本地副本，import。
- [shell/path-args.ts](../../../packages/ohbaby-agent/src/shell/path-args.ts) 删本地副本，import。
- [sandbox/paths.ts](../../../packages/ohbaby-agent/src/sandbox/paths.ts) 的 `stripMatchingQuotes`/`msysPathToWindowsPath` 改 import 共享 utils。
- 不把这些 helper 放在 `shell/` 下再给 sandbox import，避免把纯共享工具误归属到某个领域模块。

### 改 `src/shell/analysis/types.ts`

`ShellCommandAnalysis` 加 `executedScript?` / `interpreter?` / `inlineEval?`（schema 见
[goal-and-duty.md](goal-and-duty.md)）。

### 改 `src/shell/analysis/light-parser.ts`

`analyzeDetail` 新流程：
1. `classifyRootForm(detail.root)`：root 是路径形态 → `executedScript = root`。
2. 否则 `resolveInterpreterScript(detail.tokens)`：命中解释器 → 填 `interpreter`/`executedScript`/`inlineEval`。
3. `extractDataPathArgs(detail, { executedScript })`：抽数据路径，排除 `executedScript` 与脚本参数。
4. 去重 `pathArgs`（解决 G6）。
5. 现有 arity / danger / dynamic 不变。

注：improve-1 的 `commandDanger(detail.text)` 二次 `parseCommand` 可顺手优化为直接吃 `detail`
（review 时我提的 L2），属可选清理。

### 改 `src/shell/path-args.ts`

- `extractShellPathArgs` 重命名/收窄为 `extractDataPathArgs`，新增"已知 executedScript 时跳过它"。
- SHELL_EXEC_COMMANDS 分支（G2 修复）：不再 `addAllPositionalPaths`；首个非 flag 参数交由 light-parser
  作为 `executedScript`，其余裸参数默认不进 `pathArgs`。
- 新增脚本参数窄抽取：明显 path-like（绝对路径、`./`、`../`、`~/`、盘符/MSYS、带目录分隔符）
  与常见路径 option 值（`--output-dir`、`--out`、`--input`、`--file`、`--path`、`--config` 等）
  仍进入 `pathArgs`。这保证 `--output-dir /tmp/x` 等外部路径继续 external-first。
- 修复 [path-args.ts:366-370](../../../packages/ohbaby-agent/src/shell/path-args.ts#L366-L370) 的冗余
  双重重定向扫描（review L3）——顺手清理。

### 改 `src/shell/preflight.ts`（shell 硬安全闸同步）

`preflightShellCommand` 是 bash.execute 时的硬闸。它要：
- 用 `executedScript` 而非"所有位置参数"来判断脚本路径（与 analysis 一致，避免双套逻辑再次分叉）。
- `assertNoNestedShellEvaluation`：首批可保持现有 `bash -c` 硬拒，只让 analysis 产出 `inlineEval`；
  若本批纳入 D2，则按最终决策统一为"dangerous ask"或"全部硬拒"。
- 复用 `src/utils/path-strings.ts` 与共享 `src/utils/path-canonicalize.ts`（与 sandbox 的 walk-up canonicalize 在 improve-2
  合并，见 [sandbox integration-plan](../../sandbox/improve-2/integration-plan.md) 对 M3 的处理）。

## 分阶段实施

| 阶段 | 内容 | Exit criteria |
|---|---|---|
| **S1：path utils 收敛（M2/M3）** | 抽 `utils/path-strings.ts` 与 `utils/path-canonicalize.ts`，三处改 import，行为不变 | 全量测试绿；无行为变化；删除重复定义；无 shell↔sandbox 循环 |
| **S2：executedScript 模型** | 新增字段 + interpreter registry + 直接执行识别 + light-parser 填充 | 新增 interpreters/analysis 单测；判定表全部命中 |
| **S3：数据路径收窄 + G2/G6 修复** | `extractDataPathArgs` 排除脚本本身；脚本参数仅窄抽 path-like/路径 option；去重 | `sh setup.sh arg1` 不再把 arg1 当路径；`--output-dir /tmp/x` 仍触发路径事实；`bash x.sh` 不再重复 |
| **S4：preflight 同步** | 硬闸认识 executedScript；inlineEval 只同步事实，安全语义可保持现状 | preflight 与 analysis 对脚本判定一致；探针回归通过 |
| **S5：inlineEval 统一（可选独立小批次）** | 按 D2 决策把 inline eval 统一为 dangerous ask 或全部硬拒 | `bash -c` / `python -c` / `node -e` 行为一致且测试明确 |

S1 可独立先合（纯重构）。S2–S4 与 [sandbox improve-2](../../sandbox/improve-2/integration-plan.md) 的
多根消费需对齐：**shell 先产出 `executedScript`，sandbox 再消费**，所以 shell S2 应早于 sandbox 的消费阶段。

## 迁移顺序（与 sandbox 协调）

```
shell S1 (shared path utils) ──┐
shell S2 (executedScript)    ──┼─► sandbox 消费 executedScript（sandbox improve-2 阶段 2）
shell S3 (data path 收窄)    ──┘
shell S4 (preflight/inline)  ──► 独立，最后做
```

## 回归与探针

improve-1 的 review 用过一个 preflight 探针（构造命令跑 `preflightShellCommand` 看 resolved/throw）。
improve-2 应把它固化成测试（见 [test-plan.md](test-plan.md)），覆盖判定表里每一行，
确保 `python run.py` / `./x.sh` / `sh x.sh arg` 的行为符合预期，防止回归。

## 不在 scope 但要预留

| 事项 | 预留方式 |
|---|---|
| tree-sitter 替换轻量 parser | analysis 层接口不变，内部可替换 |
| 间接执行器（npx/uvx/pnpm dlx） | registry 可扩展；本轮可先覆盖明确脚本文件位置的子命令，无法可靠定位脚本时不阻塞执行 |
| 脚本参数声明式精细识别 | 本轮只窄抽 path-like / 路径 option；未来可加脚本声明（如 `# ohbaby:path-args`）做更精细 opt-in |
