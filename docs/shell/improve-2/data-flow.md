# Shell improve-2 数据流

本文描述 improve-2 后，shell analysis 如何识别脚本执行，并把 `executedScript` /
`interpreter` / `inlineEval` 事实交给 [sandbox improve-2](../../sandbox/improve-2/data-flow.md)。

## 分析数据流（含脚本识别）

```text
command string
  |
  v
parseCommand(command)  -> details[] (root, tokens, rootIndex)
  |
  v  per detail
analyzeDetail(detail)
  |
  |-- classifyRootForm(detail.root)
  |     |-- 路径形态(./x /abs ../x ~/x X:\ /c/x)? -> executedScript = root, interpreter = undefined
  |     |-- 否则 normalizeRoot(root)
  |
  |-- resolveInterpreterScript(tokens)        [interpreters.ts]
  |     |-- root ∈ interpreter registry?
  |     |     |-- inline eval flag(-c/-e/--eval/-Command)? -> inlineEval = true, executedScript = undefined
  |     |     |-- 否则 -> executedScript = <脚本参数>, interpreter = root
  |     |-- 否则 -> 不处理
  |
  |-- extractDataPathArgs(detail)             [path-args.ts, 收窄语义]
  |     -> pathArgs（仅数据路径；排除 executedScript；脚本参数只抽明显 path-like 或路径 option 值）
  |
  |-- computeShellArityKey(tokens)            [analysis/arity.ts，不变]
  |-- classifyShellCommand(detail)            [command-classifier.ts，不变]
  |-- dynamic 检测                            [light-parser.ts，不变]
  |
  v
ShellCommandAnalysis {
  source, tokens, root,
  executedScript?, interpreter?, inlineEval?,
  pathArgs,            // 去重后
  arityKey, danger, hasDynamic,
}
```

## 三种脚本执行写法的判定表

| 命令 | interpreter | executedScript | pathArgs | inlineEval |
|---|---|---|---|---|
| `python ~/.claude/skills/foo/run.py` | `python` | `~/.claude/skills/foo/run.py` | `[]` | — |
| `node scripts/build.js --watch` | `node` | `scripts/build.js` | `[]` | — |
| `deno run tools/x.ts data.json` | `deno` | `tools/x.ts` | `[]`（裸 `data.json` 语义不明，默认不当路径，见下注） | — |
| `python run.py ../outside/input.json` | `python` | `run.py` | `["../outside/input.json"]`（明显外部/相对越界路径） | — |
| `python run.py --output-dir C:\Users\u\AppData\Local\Temp\crawl4ai` | `python` | `run.py` | `["C:\Users\u\AppData\Local\Temp\crawl4ai"]`（常见路径 option 值） | — |
| `node build.js --out dist --watch` | `node` | `build.js` | `["dist"]`（路径 option 值；workspace 内不会触发 external） | — |
| `./skills/foo/run.sh out/` | `undefined` | `./skills/foo/run.sh` | `[]`（裸脚本参数默认不抽，除非 path-like / option 命中） | — |
| `/abs/skill/run.sh` | `undefined` | `/abs/skill/run.sh` | `[]` | — |
| `bash setup.sh deploy --prod` | `undefined`（bash 视为 shell-exec） | `setup.sh` | `[]`（修复 G2：`deploy`/`--prod` 不再当路径） | — |
| `python -c 'print(1)'` | `python` | `undefined` | `[]` | `true` |
| `bash -c 'echo hi'` | `undefined` | `undefined` | `[]` | `true` |
| `cat logs/*.log` | `undefined` | `undefined` | `["logs/*.log"]`（普通数据命令，不变） | — |

注（脚本参数 vs 数据路径）：improve-2 的默认策略不是"全量跳过脚本参数"，也不是"全量当路径"，
而是**保守抽取 path-like 脚本参数**：

- 裸字符串参数（如 `data.json`、`deploy`、`--prod`）默认不当路径，因为脚本语义不透明。
- 明显路径形态（绝对路径、`./`、`../`、`~/`、Windows 盘符、MSYS `/c/...`、含目录分隔符的相对路径）
  进入 `pathArgs`，继续走 external-first。
- 常见路径 option 的值（如 `--output-dir`、`--out`、`--input`、`--file`、`--path`、`--config`）
  进入 `pathArgs`，即使值是 `dist` 这样的裸目录名；workspace 内不弹 external，外部路径照常 ask。

这个取舍避免 `bash setup.sh deploy` 的虚假 external ask，同时保留用户指定外部输入/输出目录时的
路径级事实，尤其服务 crawl4ai 这类可写 temp/output 的 skill script 工作流。

## inlineEval 的统一策略（G4，独立决策）

improve-1 的现状不一致：[shell/preflight.ts assertNoNestedShellEvaluation](../../../packages/ohbaby-agent/src/shell/preflight.ts#L318)
硬抛 `bash -c`，但 `python -c` / `node -e` 放行。这个问题与 skill 文件脚本执行相关，但不是
skill script 地基的阻塞项；建议作为 improve-2 的独立小批次处理，避免在同一批里同时改变路径边界
和 nested eval 安全语义。候选如下：

- **方案 A（一致标记，推荐）**：不再硬抛任何 inline eval；统一标 `inlineEval = true` + `danger = "dangerous"`，
  交给 permission 按 dangerous 走 ask。理由：`bash -c` 与 `python -c` 同样不透明，硬拒一个放行另一个
  没有实际安全收益，反而逼 skill 改写。把"不透明 ⇒ 需用户确认"交给 permission 更一致。
- **方案 B（一致硬拒）**：把 python/node/ruby 等的 inline eval 也纳入 `assertNoNestedShellEvaluation`，
  全部硬抛。一致但更激进，会挡住 `python -c` 这类常见单行。

推荐 A，但建议在 shell/sandbox 脚本路径模型落地并测试稳定后再切换；首批实现可以继续保持
`bash -c` 的现有硬拒行为，同时在 analysis 层先产出 `inlineEval` 事实。

## 与 sandbox 的交接

shell 不变的承诺：输出**纯语法事实**，不 resolve、不查根、不查 denylist。
improve-2 新增字段对 sandbox 的意义：

```text
ShellCommandAnalysis.executedScript  ─►  sandbox 对它做：
                                           多根 boundary（含 skill 根）
                                           denylist（脚本本身若在 ~/.ssh 等）
                                           sensitive（脚本若是 *.key 等，可能性低但一致处理）
ShellCommandAnalysis.pathArgs        ─►  sandbox 对它做：多根 boundary + denylist + sensitive（同 improve-1）
ShellCommandAnalysis.inlineEval      ─►  sandbox 无路径可查；permission 按 danger 兜底
```

sandbox 侧如何把 `executedScript` 落进 `PreflightResult`、如何用多可信根判定，见
[sandbox improve-2 data-flow](../../sandbox/improve-2/data-flow.md)。

## 进程执行侧（bash tool）不变

improve-2 不改 [tools/bash.ts](../../../packages/ohbaby-agent/src/tools/bash.ts) 的执行路径
（spawn / 非交互 env / stdin close / kill / 截断都保持）。唯一相关的是：bash tool 执行前的
`preflightShellCommand`（shell 的硬安全闸）也要认识 `executedScript`——见
[integration-plan.md](integration-plan.md) 对 preflight.ts 的同步改动。

## 已确认决策

- **D1（脚本参数策略）**：已确认采用"不全量抽取，但明显 path-like 参数和常见路径 option 值仍抽取"。
- **D3（解释器清单范围）**：已确认 registry 不是执行 allowlist，不能限制 bash 的运行能力。
  首批应尽量覆盖常见脚本 runner（python/python3/py/node/deno/bun/ruby/perl/php/bash/sh/zsh/
  pwsh/powershell 等），未命中 registry 的命令仍可运行，只是没有精确 `executedScript` 事实。
  对 `npx`/`pnpm dlx`/`uvx` 这类间接执行器，能可靠定位脚本文件的子命令可加入；定位不了时不阻塞执行。

## 待确认决策

- **D2（inlineEval 策略）**：方案 A（统一标记 + dangerous ask）vs 方案 B（统一硬拒）。推荐 A，
  但可作为脚本路径模型之后的独立批次。
