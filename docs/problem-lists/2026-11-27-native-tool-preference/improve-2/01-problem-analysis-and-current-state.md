# 1. 现状与问题分析

代码锚点以 2026-11-27 的 `main`（`39ab6863`）为准，路径相对 `packages/ohbaby-agent/src/`。

## 1.1 bash 里实际用了哪些查看参数

从本机 `ohbaby.db` 的 956 次 bash 调用里按命令文本粗略统计（正则匹配，有误差）：

| 用法 | 次数 | 原生工具现在能不能做 |
| --- | --- | --- |
| `grep`/`rg`（任何用法） | 265 | 部分能 |
| 其中接在其他命令的管道后面（`... \| grep`） | 77 | 不适用，这是在过滤命令输出，本来就该用 bash |
| `grep -A/-B/-C`（上下文行） | 37：只用 `-A` 31 次，`-A` 加 `-B` 6 次，`-C` 0 次 | 不能 |
| `grep -i`（忽略大小写） | 32 | 只能写 `(?i)` 内联标志，描述里没说 |
| `grep -c`（计数） | 18 | 不能 |
| `grep -l`（只列文件名） | 14（2026-11-27 重新统计，初稿是 5） | 不能 |
| `find` | 28 | glob 能做按名字找 |
| `ls -l`、`ls -la` | 52 | list 只给名字，不给大小和时间。抽样看几乎都是 `ls -la <目录>` 的习惯写法（看目录在不在、看隐藏文件），list 本来就列隐藏文件；只有 2 次接 `awk '{print $5,$9}'` 真要看大小 |
| `ls -R`、`tree` | 7 | glob 能做 |
| `wc` | 78 | 不能（improve-3 让只读 `wc` 免审批） |
| `head`/`tail` | 364 | 多数是 `\| tail -20` 这样截断测试输出，不是读文件 |
| `sed -n` | 93 | read 能做 |
| `cat` | 56 | read 能做 |

结论：grep 的上下文行和忽略大小写是最常见的缺口，计数和只列文件名次之。`wc`、管道过滤本来就该交给 bash。

上下文行的用法值得细看。`-A` 的取值分布是：12（9 次）、20（3 次）、6、8、14、40、45（各两三次）、50、60。大的取值几乎都是"找到函数定义，再往下看函数体"，例如 `grep -n "function preparePromotion" -A50 shell-jobs/store.ts`。这其实是在拿 grep 读文件，换成"grep 拿到行号，再用 read 的 `offset` 读"更合适。

## 1.2 grep 现状

- `tools/grep.ts:59` 的 `createGrepTool`：参数只有 `pattern`、`path`、`include`、`limit`。
- 只返回"路径 + 行号 + 截断预览"，描述里写着"No pagination or export"。
- `tools/utils/ripgrep-search.ts:86-103` 的参数是 `--no-config --engine=default --json --hidden --no-ignore-global --no-ignore-parent --no-require-git --threads=1`，可选 `--glob include`，再加 `--glob !.git` 和 `--regexp`。
- 默认遵守项目里的 `.gitignore`、`.ignore`、`.rgignore`。

## 1.3 glob 现状

- `tools/glob.ts:29`：参数是 `pattern`、`path`、`limit`。
- `tools/utils/ripgrep-files.ts:67-86` 用了 `--no-ignore`，不读任何 ignore 文件，只固定排除 `.git`、`dist`、`node_modules`、`out`、`target`。
- 这是 [2026-10-11 shell-and-glob improve-2 §2.3](../../2026-10-11-shell-and-glob/improve-2/02-optimization-plan-and-change-scope.md) 定下的参数。那一轮的 [03 参考项目](../../2026-10-11-shell-and-glob/improve-2/03-reference-projects.md) 第 26 行写的是"显式使用 `--no-ignore` 保留现状"，也就是为了和换成 ripgrep 之前的行为保持一致，不是专门的设计取舍。§2.8 把"ignore 文件模式"列为不在那一批。
- 结果：grep 遵守 `.gitignore`，glob 不遵守，两个工具对同一个仓库看到的文件集合不一样。构建产物、缓存目录（例如 `.next`、`coverage`、`.turbo`）会出现在 glob 结果里。
- 2026-11-27 用本机 ripgrep 15.1.0 实测去掉 `--no-ignore` 之后的行为：
  - **目录级规则照样生效**。`.ohbaby/`、`node_modules` 这类被忽略的目录，即使 glob 写了 `/**/settings.json`，也会在遍历时整个跳过。
  - **文件级规则会被正向 glob 覆盖**。`.gitignore` 里有 `*.tsbuildinfo`，但 `glob **/*.tsbuildinfo` 仍然能找到这些文件。这是 rg 的规则："明确点名的 glob 优先于 ignore"。grep 的 `include` 现在就是这个行为，描述里也写了（"Explicit include uses rg glob precedence and can override ignores"）。
  - **把被忽略的目录直接设为 `path` 可以搜到里面的文件**。因为父目录的 ignore 文件本来就不读（`--no-ignore-parent`），`path=.ohbaby` 时根目录 `.gitignore` 里的 `.ohbaby/` 不起作用。

## 1.4 list 现状

- `tools/list.ts:17`：只列一层，只给名字，目录名后面加 `/`。固定排除 `.git`、`node_modules`、`dist`。
- 没有文件大小、修改时间。`ls -l` 的 52 次调用里，有一部分是想看大小或时间，有一部分只是习惯。

## 1.5 read 现状

- `tools/read.ts`：带行号、`offset`、`limit`、`cursor` 分页，单次 50 KiB。
- 能力够用，没发现 bash 读文件是因为 read 做不到。

## 1.6 SWE 视角

- 加参数会让工具描述变长，模型也更容易传错参数。只加数据里常用的，不追求和 ripgrep 对齐。
- glob 改默认行为是一个不容易回退的改动：模型和用户一旦习惯了"glob 找不到被忽略的文件"，再改回来又会有一次认知切换。要先讨论清楚。
