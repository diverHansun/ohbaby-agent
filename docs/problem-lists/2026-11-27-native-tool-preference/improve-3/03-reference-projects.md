# 3. 参考项目

路径相对 `code-cli/`。锚点来自 2026-11-27 子代理调研，codex 的两次提交和 claude-code 的 `cd` 注释已由主代理打开源码核对。

缩写：

- CC = `claude-code/packages/builtin-tools/src/tools/BashTool/`
- CCU = `claude-code/src/utils/`
- ZC = `ZCode/apps/zcode-cli/packages/core/src/tool/handlers/`

## 3.1 总体路线

| 项目 | 只读 bash | 兜底 | 对本轮的启发 |
| --- | --- | --- | --- |
| claude-code | 自动放行 | 路径约束检查排在只读放行之前（CC `bashPermissions.ts:1112` 在 `:1154` 之前），工作区外路径一律审批 | 参数级规则最细，用来查漏 |
| ZCode | 自动放行 | 没有路径检查 | 白名单范围和重定向规则的参考 |
| codex | **已取消白名单** | 系统沙箱 | 见 §3.2 |
| kimi-code | 一律审批 | 无 | 保守路线，ohbaby 的现状和它一样；用户选了放行 |
| opencode | — | 外部目录先合并问一次，再问命令；重定向目标不算外部目录 | 和 bash-double-approval 议题相关 |

## 3.2 codex 为什么撤掉白名单

- 2026-08-19 的 `3b45c29062`（"Stop treating Git commands as inherently safe"）先把 git 移出白名单，理由是仓库配置能让只读的 git 命令执行外部程序。
- 同一天的 `942af8447b`（"Retire the untrusted approval policy"）删掉了整份已知安全命令白名单。之后在不受信任的项目里，每条命令都要审批，除非 exec policy 规则显式放行。
- codex 有系统沙箱，撤掉白名单后仍有兜底；ohbaby 没有沙箱，所以不能照搬"全部审批"，也说明白名单必须收紧，不认识的一律算 mutating。

## 3.3 逐项对照

| 问题 | claude-code | ZCode | 对本轮的结论 |
| --- | --- | --- | --- |
| 重定向 | 拆分时去掉 `2>&1` 和静态目标的重定向（CCU `bash/commands.ts:274-330`）；目标是 `/dev/null` 一律放行（CC `pathValidation.ts:947`），写到其他文件按写处理 | 只放行 `>&数字`、目标是 `/dev/null` 的重定向、输入重定向；拒绝 `/dev/tcp`、`/dev/udp`（ZC `bash-readonly-policy-argv-io.ts:63-79`） | P10：只认 `/dev/null` 和文件描述符复制 |
| `cd` | 算只读，但目标按读路径校验；**不跟踪 cd 之后的 cwd**，cd 加写操作一律审批，源码注释说跟踪 cwd 太复杂（CC `pathValidation.ts:630-655`） | `cd` 最多一个参数；执行后 cwd 跑出工作区就重置回去（ZC `bash-cwd-policy.ts:60-63`） | P11：ohbaby 已经能跟踪 `cd x && cat y`，只修长链；`;`、`\|\|` 维持不完整 |
| `~` | 展开后做路径校验；`~user`、`~+` 要审批（CCU `permissions/pathValidation.ts:396-440`） | 没有专门处理 | P12：只展开 `~` 和 `~/`，和 improve-1 Stage 0 一致 |
| `$`、通配符 | 含 `$` 的词一律拒绝；没加引号的通配符拒绝，注释举例 `python *` 可能展开成 `--help`（CC `readOnlyValidation.ts:1351-1357`、`1600`） | 参数展开、命令替换算动态，判为非只读 | ohbaby 已经把它们记为不完整，不动 |
| `uniq` | 只接受选项，不接受文件参数（CC `readOnlyValidation.ts:1525`） | 不限参数，`uniq in out` 会写文件（漏洞） | P3：带第二个位置参数算 mutating |
| `sort`、`tree`、`date`、`file` | 选项白名单：`sort` 不含 `-o`，`tree` 不含 `-o`、`-R`，`date` 拦 `-s`（CC `readOnlyValidation.ts:165`、`247`、`648`、`730`） | 选项白名单 | P3 按同样思路拦写入和执行参数 |
| `sed` | 只允许 `-n` 加 `Np` 形式的打印，或不带文件和 `-i` 的替换；拦 `w`、`e`（CC `sedValidation.ts:608-613`） | 严格语法回调（ZC `bash-readonly-policy-callbacks.ts:16-45`） | P4 见 02 |
| `find` | 拦 `-exec`、`-delete`、`-fprint*`、`-fls`（CC `readOnlyValidation.ts:1569`） | 同上，另拦 `-files0-from`（ZC `argv-direct.ts:4-16`） | P2 |
| `rg` | 不在白名单，注释给了用 `--pre=bash` 执行任意命令的例子（CC `readOnlyValidation.ts:1338`） | 白名单，测试里 `--pre` 判为非只读 | P2：拦 `--pre`、`--pre-glob` |
| `git` | 拦 `-c`、`--config-env`、`--exec-path`（CC `readOnlyValidation.ts:1726-1746`）；子命令按选项白名单，`git branch` 不允许位置参数（CCU `shell/readOnlyCommandValidation.ts:807-830`）；检测裸仓库，禁止先写 `hooks/` 再跑 git（CC `readOnlyValidation.ts:1925-1966`） | 另拦 `-C`、`--git-dir`、`--work-tree`；判断 `.git` 是否可信（ZC `bash-git-runtime-safety.ts:71`） | P2、P6 |
| `less`、`more` | 不收录 | 不收录 | P2：移出白名单 |

## 3.4 借鉴原则

- claude-code 的参数级规则最细，用来查漏。放行范围按 ohbaby 数据里常用的命令来定，不追求和它一样大。
- claude-code 不跟踪 cwd，是因为它的路径校验和解析是两套。ohbaby 的解析器本来就带 cwd 跟踪，路径预检也按跟踪后的 cwd 解析（`shell/preflight.ts` 的 `resolveAnalyzedPath`），所以修长链不算引入新机制。
