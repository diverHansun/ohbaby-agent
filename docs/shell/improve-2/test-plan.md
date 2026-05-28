# Shell improve-2 测试与审查计划

## 测试目标

证明三件事：
1. 脚本执行的三种写法（解释器 / 直接执行 / shell-exec）都被正确识别。
2. 数据路径收窄没有误伤普通命令（cat/ls/grep/cp 等行为不变）。
3. shared path utils 收敛是纯重构，零行为变化。

## 单元测试

### interpreters（新增 `src/shell/interpreters.unit.test.ts`）

- `python run.py` → `{ interpreter: "python", script: "run.py", inlineEval: false }`
- `python -c 'x'` → `{ interpreter: "python", inlineEval: true, script: undefined }`
- `python -m http.server` → 按决策（module 视为 inlineEval 类或单列），断言稳定
- `node build.js --watch` → script `build.js`，`--watch` 不是 script
- `node -e 'x'` / `node -p 'x'` → inlineEval
- `deno run tools/x.ts` → script `tools/x.ts`；`deno eval 'x'` → inlineEval
- `pwsh -File x.ps1` → script `x.ps1`；`pwsh -Command 'x'` → inlineEval
- 非解释器（`git`/`cat`）→ undefined

### 直接执行识别（`src/shell/path-args` 或 light-parser 单测）

- `./run.sh` / `../tools/run.sh` / `/abs/run.sh` / `~/x/run.sh` / `C:\x\run.bat` / `/c/x/run.sh`（msys）
  → `executedScript = root`，`interpreter = undefined`
- `git status`（root 非路径形态）→ `executedScript = undefined`

### light-parser 字段填充（扩展 `analysis/light-parser.unit.test.ts`）

逐行断言 [data-flow.md 判定表](data-flow.md)：每条命令的 `interpreter` / `executedScript` /
`pathArgs` / `inlineEval` 四元组。重点：
- `bash setup.sh deploy --prod` → `executedScript: "setup.sh"`，`pathArgs: []`（G2）
- `node build.js --watch` → `pathArgs: []`（普通脚本 flag 不当路径）
- `node build.js --out dist` → `pathArgs: ["dist"]`（常见路径 option 值；workspace 内不触发 external）
- `python run.py ../outside/input.json` → `pathArgs: ["../outside/input.json"]`（明显 path-like）
- `python run.py data.json` → `pathArgs: []`（裸脚本参数语义不明，默认不抽）
- `python run.py --output-dir C:\Users\u\AppData\Local\Temp\crawl4ai` → 抽取 output-dir 值并交给 sandbox 判定
- `cat logs/*.log` → `pathArgs: ["logs/*.log"]`（普通命令不变）
- `bash x.sh` → `pathArgs` 不含 x.sh 且无重复（G6）

### shared path utils 收敛（`src/utils/path-strings.unit.test.ts` / `src/utils/path-canonicalize.unit.test.ts`）

- `stripMatchingQuotes` / `msysPathToWindowsPath` / `optionValue` / `stripRedirectionPrefix`
  逐函数测，断言与改造前行为逐字节一致（可用 improve-1 既有用例迁移过来做对照）。

### preflight 同步（扩展 `shell/preflight.unit.test.ts`）

- preflight 对 `python run.py` / `./x.sh` 的 resolvedPaths 与 analysis 的 executedScript 一致。
- inlineEval 决策（D2）：
  - 首批若不改变安全语义：`bash -c 'x'` 仍硬拒；analysis 层可标 `inlineEval`。
  - 方案 A：`bash -c 'x'` 与 `python -c 'x'` 都**不抛**，标 dangerous。
  - 方案 B：两者都抛 "nested shell evaluation"。
  测试按最终选定方案写，并显式注释决策来源；建议把 D2 作为独立小批次。

## 探针固化（防回归）

把 improve-1 review 用过的临时 preflight 探针固化为 `shell/preflight.script-exec.unit.test.ts`，
覆盖 review 当时发现问题的全部命令：

```
python ~/.claude/skills/foo/run.py    -> 现在能识别脚本（曾 resolved=[]）
node scripts/build.js                  -> 识别脚本
./skills/foo/run.sh                    -> 识别脚本（曾 zero-extract）
/abs/skill/run.sh                      -> 识别脚本
sh ./setup.sh arg1                     -> arg1 不再是路径（曾误当路径）
python run.py --output-dir /tmp/crawl  -> output-dir 仍作为路径事实
python run.py data.json                -> 裸脚本参数不作为路径事实
mkdir -p a/b/c                         -> 不抛（improve-1 H2 回归守卫）
cat *.txt / ls src/*.ts                -> glob 不抛（improve-1 H1 回归守卫）
```

这些断言同时守护 improve-1 的 H1/H2 修复不被 improve-2 改动破坏。

## 集成测试

- 扩展 [tests/integration/core/bash-tool-scheduler.integration.test.ts](../../../tests/integration/core/bash-tool-scheduler.integration.test.ts)：
  通过完整 scheduler 链跑一个"解释器执行 workspace 内脚本"（无 ask）和一个"执行 workspace 外脚本"
  （触发 external_directory ask）的端到端用例——验证 shell 的 `executedScript` 真正流到 sandbox 并被消费。
  （sandbox 侧多根用例见 [sandbox test 计划](../../sandbox/improve-2/integration-plan.md)。）

## 审查要求

- S1（shared path utils）必须以"零行为变化"通过——diff 应只是搬移 + import，不含逻辑修改。
- S2–S4 每阶段独立提交、独立绿，便于回滚。
- 合并前跑全量 `pnpm test` + `tsc -b`，并人工跑一遍探针测试确认输出符合判定表。
