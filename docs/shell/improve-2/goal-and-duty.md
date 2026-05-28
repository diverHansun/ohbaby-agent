# Shell improve-2 职责定位

## improve-1 留下的边界与本轮的扩展点

improve-1 已经确立的职责边界（保持不变）：

- shell 拥有命令语法知识：parser、tokens、root、danger、arity、dynamic 标记。
- sandbox 拥有 workspace 边界知识：路径解析、inside/outside、denylist、sensitive。
- permission 拥有决策：allow / ask / deny。

improve-2 不改这个三层划分，只**补全 shell 层对"脚本执行"这一命令子类的理解**。
当前 [path-args.ts](../../../packages/ohbaby-agent/src/shell/path-args.ts) 用命令白名单抽路径，
对"执行一个脚本"的三种主流写法是盲的：

1. **解释器执行**：`python run.py`、`node build.js`、`ruby x.rb`、`deno run x.ts` ——
   解释器不在白名单，脚本文件参数不被抽取。
2. **直接执行**：`./run.sh`、`/abs/run.sh`、`../tools/run.sh` ——
   脚本就是命令 root，而抽取只看 root 之后的参数，于是零抽取。
3. **shell-exec 带参**：`sh setup.sh deploy --prod` —— 当前把 `deploy`/`--prod` 也当路径。

这三类正是 skill `scripts/` 的日常调用形态，所以本轮把它们纳入 shell 分析。

## improve-2 的 Goal

> shell 在 improve-2 之后，对每条命令额外回答一个问题：**"这条命令是否在执行一个脚本文件？
> 如果是，脚本文件是哪个？"** 并把这个事实（`executedScript`）与普通数据路径参数（`pathArgs`）
> 分离，交给 sandbox 做边界判定。

这仍是单一职责：shell 只识别**语法上的脚本位置**，不判断脚本"在哪算可信"（那是 sandbox 的多根 boundary）。

## 单一职责分解（本轮新增/调整的单元）

### 1. interpreter registry（`src/shell/interpreters.ts`，新增）

- **做什么**：维护解释器命令表及其"脚本参数位置"规则。
  例：`python`/`python3` → 首个非 flag 且非 `-c`/`-m` 的参数是脚本；
  `node` → 首个非 flag 且非 `-e`/`--eval` 的参数是脚本；
  `deno run` → `run` 之后首个非 flag 参数；`pwsh -File x.ps1` → `-File` 的值。
- **怎么用**：`resolveInterpreterScript(tokens) → { script?: string; isInlineEval: boolean }`
- **边界**：只懂"哪个 token 是脚本文件"，不解析脚本内容、不判断路径归属。

### 2. 命令-as-路径识别（`src/shell/path-args.ts` 扩展）

- **做什么**：当命令 root 本身是路径形态（`./`、`../`、`/`、`~/`、`X:\`、msys `/c/`）时，
  把 root 识别为被执行脚本。
- **怎么用**：在 `extractShellPathArgs` 之前先判 root 形态。
- **边界**：仅形态判断（是否像路径），不 resolve、不查边界。

### 3. `executedScript` 字段（`src/shell/analysis/types.ts` 扩展）

- **做什么**：在 `ShellCommandAnalysis` 上新增 `executedScript?: string` 与 `interpreter?: string`。
- **语义**：`executedScript` 是"被当作程序执行的脚本文件"的原始 token；`pathArgs` 仅保留**数据**路径
  （被读写的文件/目录），不再混入脚本本身；脚本参数只在明显 path-like 或常见路径 option 值时进入
  `pathArgs`。
- **边界**：字段是事实容器，填充逻辑在 light-parser。

### 4. shell-exec 抽取修复（`src/shell/path-args.ts` 修复 G2）

- **做什么**：`bash`/`sh`/`zsh` 后只把**脚本文件**（首个非 flag 参数）标为 `executedScript`，
  后续裸参数不再进 `pathArgs`；若后续参数明显是外部/相对越界路径，或是 `--output-dir` 等路径
  option 的值，仍作为数据路径输出。
- **怎么用**：替换现有 `addAllPositionalPaths` 对 SHELL_EXEC_COMMANDS 的处理分支。

### 5. path string utils 收敛（`src/utils/path-strings.ts`，新增，解决 M2）

- **做什么**：把散落在 [shell/preflight.ts](../../../packages/ohbaby-agent/src/shell/preflight.ts)、
  [shell/path-args.ts](../../../packages/ohbaby-agent/src/shell/path-args.ts)、
  [sandbox/paths.ts](../../../packages/ohbaby-agent/src/sandbox/paths.ts) 的
  `stripMatchingQuotes` / `msysPathToWindowsPath` / `optionValue` / `stripRedirectionPrefix`
  统一到一处。
- **边界**：纯字符串函数，无 IO、无 node:fs 依赖。sandbox 侧 paths.ts 改为 import 此模块。

## 非目标声明

### 1. 不做多可信根判定
"脚本在 skill 目录里因此可信" 这类判断属于 sandbox 的 boundary（多根）。shell 只输出
`executedScript` 原始/可识别的路径形态，是否 inside 任何可信根由 sandbox 决定。

### 2. 不注入 cwd / env
skill 脚本运行所需的 cwd（skill 目录）和 env（指向 skill 资源的变量）由
[sandbox lease.resolveCommandContext](../../../packages/ohbaby-agent/src/sandbox/lease.ts) 注入。
shell 不碰执行环境构造，只做分析与（bash tool 内的）进程硬化。

### 3. 不解析脚本内容
shell 不读取 `run.py` / `run.sh` 的内容做静态分析。脚本内部行为由运行时的 permission
（脚本内若再调 bash 工具会再次过链路）和未来 OS adapter 负责，不在本轮。

### 4. 不引入 tree-sitter
improve-2 在现有轻量 parser 上加 interpreter/直接执行识别即可。tree-sitter 替换仍是后续独立增强。

### 5. 不在首批强行改变 nested-eval 的安全强度
G4 的统一不是"放开所有 `-c`"，而是先让 analysis 层能一致标记 `inlineEval`。是否把
`bash -c` 从现有硬拒改成 dangerous ask，或把 `python -c` / `node -e` 也提升为硬拒，是独立安全
语义决策，见 [data-flow.md](data-flow.md)。首批脚本路径模型可以不改变现有硬拒行为。

## 与 sandbox 的职责契约（改动点）

improve-2 在既有 `ShellAnalysisResult` 契约上**只增不改**：

```ts
interface ShellCommandAnalysis {
  readonly source: string;
  readonly tokens: readonly string[];
  readonly root: string;
  readonly pathArgs: readonly string[];      // 语义收窄：仅数据路径
  readonly executedScript?: string;          // 新增：被执行的脚本文件（原始 token）
  readonly interpreter?: string;             // 新增：解释器名（python/node/...），直接执行时为 undefined
  readonly arityKey: string;
  readonly danger: "readonly" | "mutating" | "dangerous";
  readonly hasDynamic: boolean;
  readonly inlineEval?: boolean;             // 新增：bash -c / python -c / node -e 等内联代码
}
```

不变式：

1. `executedScript` 与 `pathArgs` 互斥——脚本文件不重复出现在 `pathArgs`。
2. `pathArgs` 只含被命令读写的**数据**路径，不含脚本本身；脚本参数默认不全量抽取，但明显
   path-like 参数与路径 option 值会进入 `pathArgs`。
3. `interpreter` 存在 ⇒ `executedScript` 来自解释器脚本参数；`interpreter` 为空但
   `executedScript` 存在 ⇒ 直接执行（root 即脚本）。
4. `inlineEval = true` 时通常没有 `executedScript`（代码在命令行里）；sandbox 不必为它找脚本路径，
   permission 按 danger 兜底。
5. shell 不保证 `executedScript` 在任何根内——这是 sandbox 的判定。
