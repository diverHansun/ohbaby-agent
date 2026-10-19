# Shell / Glob 测试与验收标准

> 后续实施验收契约，本次规划不宣称下列测试已通过。遵循既有项目测试规范。unit / contract 就近，跨模块集成放 `tests/integration/shell-tools/`，安装产物检查放 smoke。

## Shell 关键场景

| ID    | 场景与断言                                                                                                                                                                                                                                                                                       | 类型                       | Stage |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- | ----- |
| S-T01 | Windows 未配置 pwsh → Windows PowerShell，已安装 Git 不再自动优先 Git Bash，调整旧 detector 优先级断言；macOS / Linux 默认；显式受支持 SHELL 优先；受支持原生路径缺失报错；继承 fish/nu 与 Windows MSYS 路径走明确平台默认，不重跑替代解释器；Windows 裸 bash 命中 WSL 启动器时不得当作 Git Bash | unit + 平台 integration    | 1     |
| S-T02 | 工具说明、审批和执行使用同一原始命令、真实方言与 cwd；等待后不重选解释器；执行参数与准备值一致                                                                                                                                                                                                   | contract + integration     | 1 / 2 |
| S-T03 | for、if、管道、重定向、引号分号、heredoc、`$(...)`、反引号、算术展开；获批后由实际 Shell 正确执行                                                                                                                                                                                                | integration                | 1 / 2 |
| S-T04 | zsh 专有语法不被 Bash grammar 误报非法；PowerShell 管道 / 变量 / 路径语法；语法错误保留系统原始 stderr；任意 exit 2 不生成语法错误标签；PowerShell 5.1 中文路径 / 输出编码做真实平台用例                                                                                                         | unit + 平台 integration    | 1 / 2 |
| S-T05 | 变量路径、命令替换、命令名无法静态确定、条件 cd、嵌套 shell：不伪造确定路径/只读；已知字面 deny 仍生效；分析不求值命令；静态自定义 CLI 的结构可 complete、风险仍保守                                                                                                                             | unit + integration         | 2     |
| S-T06 | default incomplete 且已有 `bash *` 等 allow：首次判断、manager 二次判断均仍 ask，Once 后只执行该次                                                                                                                                                                                               | integration                | 2     |
| S-T07 | incomplete 返回 Always：服务端拒绝长期回复，待审状态可继续 Once / Reject；另一请求 Always 不自动批准它                                                                                                                                                                                           | contract + integration     | 2     |
| S-T08 | deny 优先于 incomplete；完整可记忆命令保持现有行为：仅单条 git/docker 使用 arity，普通命令不放宽，多命令 allow 整体匹配；其他权限模式不意外改成 default                                                                                                                                          | unit + integration         | 2     |
| S-T09 | TUI 与 Web 中主代理 / 子代理同入口审批；审批后执行，拒绝 / 取消后不启动；根会话归属不丢失                                                                                                                                                                                                        | integration + 实际 UI 验收 | 2 / 4 |
| S-T10 | 前台、后台、task_output、task_kill、超时、关闭 child scope、session 清理均沿既有 owner / cleanup；无重复执行                                                                                                                                                                                     | integration                | 2     |
| S-T11 | parser / WASM 缺失或损坏明确准备失败，不回旧 parser；准备错误不产生误导审批 / running job                                                                                                                                                                                                        | unit + smoke               | 1 / 2 |
| S-T12 | improve-1 代理错误 spawn=0；审批等待期间配置变化在启动时应用；分析过程不运行用户命令；sandbox 路径审批与 Shell 政策拒绝消费同份事实，已知拒绝在询问前返回                                                                                                                                        | integration                | 2 / 4 |
| S-T13 | 已打包并临时安装的 agent / CLI 能从安装位置加载 grammar；脱离仓库 cwd 仍可用                                                                                                                                                                                                                     | smoke                      | 1 / 4 |
| S-T14 | 首次判断、模式生成、用户回复复核和排队后复核保持相同权限行为；incomplete 不被旧 allow 放行，新增 deny 阻止执行                                                                                                                                                                                   | integration                | 2     |
| S-T15 | params / metadata 中附加的同名字段不能替代服务端对实际命令的分析结果                                                                                                                                                                                                                             | contract                   | 2     |
| S-T16 | 自定义 PermissionPort、无 environment、直接内部调用保持支持；未提供分析时保守按 incomplete；工具注入的解释器与固定执行绑定一致                                                                                                                                                                   | integration                | 2     |

涉及危险字面拒绝的用例使用 stub spawn / 受控沙盒 fixture，绝不真实执行破坏性命令。普通 Shell 语法用临时目录和可控输出验证。分析使用副作用哨兵证明没有求值命令替换。验证命令、方言、权限与执行行为，不检查对象引用相等、恰好一次解析或已删除包装的缺失/不匹配状态。本批不新增 native parse-only 流程；不新增独立 syntax_error 状态，系统语法诊断保留在真实执行失败的 stderr 中。

## Glob 关键场景

| ID    | 场景与断言                                                                                                                                         | 类型                     | Stage |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------ | ----- |
| G-T01 | 根层 `*.ts`、递归 `**/*.ts`、`{ts,tsx}`、`[ab]`、`?`、非法模式、字面 `[id]` 目录的 `[[]id]` 写法，真实 rg 与契约一致                               | integration              | 3     |
| G-T02 | 隐藏文件可见；五类固定排除不可被正向 pattern 覆盖；ignore 文件不改变范围；只返回普通文件                                                           | integration              | 3     |
| G-T03 | 前导 `./` / `!`、Windows 分隔符、空格 / Unicode / 换行文件名；绝对路径和根外模式明确拒绝；argv 不经 Shell；返回路径不带 rg 生成的 `./`             | unit + integration       | 3     |
| G-T04 | 内部 symlink 不跟随；搜索根沿既有授权 / canonicalization；别名路径不丢失目录读锁                                                                   | integration              | 3     |
| G-T05 | N-1、N、N+1 个匹配：只有观察到额外结果才因数量截断；零结果完整与未完成分别表达                                                                     | integration              | 3     |
| G-T06 | >10,000 个已访问文件后仍能找到后续匹配；大量目录 / 稀疏匹配可取消；保持输出预算                                                                    | integration              | 3     |
| G-T07 | 采集超限、渲染超限、权限错误、rg 正常无匹配退出 1、异常退出 2、spawn 失败：正文与 metadata 完整性一致，不能返回虚假“无匹配”                        | contract + integration   | 3     |
| G-T08 | 多 chunk NUL 帧 / UTF-8 边界；损坏编码不返回替换字符路径；展示不把换行文件名拆成多个文件                                                           | unit + integration       | 3     |
| G-T09 | 取消 / limit 停止触发终止，等待 close 和 killTree 清理后释放目录锁；清理失败有现有错误事实                                                         | integration              | 3     |
| G-T10 | 模型投影保留 count / truncated / scanComplete / displayLimited / stopReason，list 原行为不变                                                       | contract                 | 3     |
| G-T11 | 已安装产物在三平台定位 bundled rg，无需系统 PATH 有 rg；不读取用户 rg config，不接网络门禁                                                         | smoke + 平台 integration | 4     |
| G-T12 | pattern 为 `/x.ts` 等前导 `/` 输入时，在拼锚定前报参数错误且 rg spawn=0；不能把 `//x.ts` 的正常无匹配当成功。Windows 盘符 / UNC 等绝对形式同样拒绝 | unit + integration       | 3     |

## 旧契约测试迁移清单

| 当前文件                                                                                                                    | 迁移要求                                                                                                                 |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------ |
| [src/index.unit.test.ts](../../../../packages/ohbaby-agent/src/index.unit.test.ts) L8 / L18                                 | 唯一直接从包根导入并断言 parseCommand 的本表用例；移除旧断言，验证新的公开契约及安装产物                                 |
| [command-parser.unit.test.ts](../../../../packages/ohbaby-agent/src/utils/command-parser/command-parser.unit.test.ts) L3–80 | 有价值的 roots / paths / wrapper 场景迁入新 analysis；不保留“有效语法应 hasError”的旧预期；matchesPattern 的测试迁移保留 |
| [preflight.unit.test.ts](../../../../packages/ohbaby-agent/src/shell/preflight.unit.test.ts) L5 / L26–35                    | fixture 改用新准备 / analysis 事实，移除旧 ParsedCommand 构造                                                            |
| [command-classifier.unit.test.ts](../../../../packages/ohbaby-agent/src/shell/command-classifier.unit.test.ts) L2 / L41     | 分类消费新的最小命令事实；保留风险场景，覆盖 AST 重定向与已知副作用选项                                                  |

path-args 的测试保留必要行为，不绑定旧函数形状：Git 路径选项、下载输出、脚本路径、重定向 / cwd，以及避免把搜索词或 mode 当路径。实现允许重写、合并或删除旧文件。同步检查 detector 平台用例及包根 / shell / utils barrel。这里区分公开 API 测试和内部旧契约测试，不把四个文件一概称作公开 API 断言。

## 现有回归与实施命令

```sh
pnpm exec vitest run packages/ohbaby-agent/src/shell packages/ohbaby-agent/src/permission packages/ohbaby-agent/src/tools/bash.unit.test.ts packages/ohbaby-agent/src/core/tool-scheduler/scheduler.unit.test.ts packages/ohbaby-agent/src/index.unit.test.ts
pnpm exec vitest run packages/ohbaby-agent/src/tools/glob.unit.test.ts packages/ohbaby-agent/src/tools/utils/ripgrep-search.unit.test.ts packages/ohbaby-agent/src/core/context/tool-metadata-projection.unit.test.ts
pnpm typecheck
pnpm --filter ohbaby-agent build
```

新增跨模块 fixture 后运行 `pnpm exec vitest run tests/integration/shell-tools`。Stage 4 按实际打包链构建 CLI / agent，临时打包安装后运行 parser / rg smoke；开发目录 import 成功不能替代。实际 TUI / Web 审批验收沿现有真实构建入口，使用确定性 provider 触发工具调用，避免消耗真实模型。

本批影响依赖交付与权限链，定向回归完成后执行仓库既有 `pnpm preflight`；若有独立存量失败，记录基线和差异，不宣称全仓通过。Read / Write / Edit 资源锁与版本校验必须保持回归通过，不为本批重写测试体系。

## 验收门与残余边界

1. S1–S5 / G1–G3 对应测试均有证据；每个 Stage 的完成定义可追溯。
2. Windows / macOS / Linux 的真实解释器和 rg 安装运行都验证；未提供平台时明确未验，不用 mocked OS 代替。
3. `parseCommand` 等旧生产调用者全部迁移，通用权限匹配仍保留；无永久双 parser / 双 Glob 引擎；公开 barrel / 类型同步，安装包导出 smoke 和仓内各包 typecheck 覆盖移除的 API。
4. 不以 AST、一次审批或目录读锁宣称 OS 沙箱。未知脚本的实际副作用属于整条授权执行的边界。
5. 旧的完整命令审批体验、子代理根会话归属、前后台清理、网络继承无回归。

最容易漏的不是 for 能否打印数字，而是：历史宽 allow 绕过 incomplete、解析成功被误当只读、审批和执行解释器不同、rg 取消后锁先释放、完整性投影被丢弃。审查应优先验证这些链路。
