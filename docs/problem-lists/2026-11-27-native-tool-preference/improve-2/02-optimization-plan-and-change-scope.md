# 2. 方案与改动面

问题见 [01](01-problem-analysis-and-current-state.md)。决策状态见下表。

## 2.1 目标

补上数据里最常见的几个缺口，让模型在"搜代码、看上下文"时不必退回 bash。只加常用的，不追求和 ripgrep 参数一一对应。

## 2.2 设计决策表

| 编号 | 决策点 | 建议 | 理由 | 状态 |
| --- | --- | --- | --- | --- |
| G1 | grep 上下文行 | 加 `before`、`after` 两个参数（整数，0–20，默认 0），对应 `rg -B`、`rg -A`。不加对称的 `context`。参数描述写明"like grep -B / -A"，并提示超过 20 行时先用 grep 拿行号，再用 read 的 `offset` 读。上下文行和匹配行的格式要能区分（例如匹配行 `path:12:`，上下文行 `path-13-`，不相邻的块之间用 `--` 隔开）。`limit` 只数匹配行，总输出靠现有字节上限兜底 | 数据里 `-A` 31 次、`-A` 加 `-B` 6 次、`-C` 0 次（01 §1.1）。用 `-A 40` 到 `-A 60` 的都是在读函数体，放到 100 容易撑满 50 KiB，交给 read 更合适。参数名用单词而不是 `-A`、`-B`，和 ohbaby 其他参数的写法一致，也避免部分 OpenAI 兼容解析器处理不了以 `-` 开头的键 | 已定稿（2026-11-27，与 Gemini 核对） |
| G2 | grep 忽略大小写 | 加 `ignore_case`（布尔，默认 false），对应 `rg -i` | 32 次使用；内联 `(?i)` 模型不一定知道 | 已定稿（2026-11-27，与 Gemini 核对） |
| G3 | grep 输出模式 | 加 `output_mode`：`content`（默认，现有行为不变）、`files`（只列文件名）、`count`（每个文件的匹配行数）。实现上沿用现有的 `--json` 解析，不另写一套文本解析：`files` 加 `--max-count=1`，`count` 按文件累加。这两种模式下 `limit` 按文件数算；传了 `before`、`after` 时报参数错误 | 计数约 25 次、只列文件名 14 次；claude-code 和 kimi-code 都有这个参数（它们默认是 `files`，ohbaby 保持 `content`，不改现有行为）。复用 `--json` 能保留现有的二进制检测、UTF-8 解码和扫描完整性判断 | 已定稿（2026-11-27，与 Gemini 核对） |
| G4 | grep 分页 | 不加 `offset`。结果超出 `limit` 时提示模型缩小范围或改用 `output_mode=files` | KISS；现在 `limit` 加截断提示已经够用，分页会让状态管理变复杂 | 已定稿（2026-11-27，与 Gemini 核对） |
| G5 | glob 默认遵守 ignore 文件 | 改成和 grep 一致：去掉 `--no-ignore`，换成 grep 用的那组参数（遵守项目里的 `.gitignore`、`.ignore`、`.rgignore`，不读父目录和全局 ignore）。加 `include_ignored`（布尔，默认 false），为 true 时恢复 `--no-ignore`。固定排除目录不变。正向 glob 能覆盖文件级 ignore 规则，这一点和 grep 的 `include` 一样，接受 rg 的语义，在描述里写明。结果为空时提示可以设 `include_ignored=true`，或者把被忽略的目录直接设为 `path` | grep 和 glob 看到的文件集合应该一致；kimi-code 也是默认遵守、按需打开。2026-10 选 `--no-ignore` 只是为了保留旧行为（01 §1.3）。实测目录级规则（构建、缓存目录）在去掉 `--no-ignore` 后就能生效，这正是要解决的问题。Gemini 建议不传正向 glob、改在 Node 里按 glob 过滤，好让文件级规则也生效；但那要在 Node 里重写一套和 rg 完全一致的 glob 匹配（`{a,b}`、`[[]id]`、根锚定），风险和工作量都不小，收益只是少数"点名找被忽略文件"的情况，不采用 | 已确认（2026-11-27） |
| G6 | list 多层 | 不加 `depth`。list 描述里写明"递归查找用 glob" | glob 的 `**` 已经能递归；两个工具做同一件事会让模型更难选 | 已定稿（2026-11-27，与 Gemini 核对） |
| G7 | list 显示大小 | 不加 | 抽样看，52 次 `ls -l` 几乎都是 `ls -la <目录>` 的习惯写法，真要看大小的只有 2 次（01 §1.1）。很多是看 `~/.ohbaby`，improve-1 的 Stage 0 修好 `~` 之后 list 就能做 | 已定稿（2026-11-27，与 Gemini 核对） |
| G8 | read | 不改 | 没发现 read 能力不足导致的 bash 调用 | 已定稿（2026-11-27，与 Gemini 核对） |
| G9 | 工具描述同步 | 参数定下来后，按 improve-1 §2.4 的流程更新 grep、glob、list 的描述和参数描述；删掉 improve-1 文案里已经不成立的说法（例如 glob 的"does not apply .gitignore"） | 描述和能力必须一致 | 已定稿（2026-11-27，与 Gemini 核对） |

## 2.3 改动面

路径相对 `packages/ohbaby-agent/src/`。

| 位置 | 改什么 |
| --- | --- |
| `tools/grep.ts` 的 `createGrepTool` | `before`、`after`、`ignore_case`、`output_mode` 的 schema、校验、描述；按 `output_mode` 组织输出 |
| `tools/utils/ripgrep-search.ts` 的 `searchWithRipgrep` | 按参数加 `-B`、`-A`、`-i`；`files` 模式加 `--max-count=1`；`count` 模式在 `--json` 结果上按文件累加 |
| `--json` 结果解析（`ripgrep-search.ts` 约 L183） | 现在遇到 `type: "context"` 会报"Unexpected record type"。要接住这类记录（它没有 `submatches`），并保持现有字节上限 |
| `tools/glob.ts`、`tools/utils/ripgrep-files.ts` | 默认去掉 `--no-ignore`，改为和 grep 相同的 ignore 参数；`include_ignored=true` 时恢复 `--no-ignore`。固定排除目录保持不变 |
| 各工具单测 | 见 [04](04-test-and-acceptance.md) |

## 2.4 实施阶段

| 阶段 | 内容 |
| --- | --- |
| Stage 1 | grep：G1–G3 |
| Stage 2 | glob：G5 |
| Stage 3 | 描述同步（G9），Pi 打磨，Gemini 审查 |

## 2.5 风险与回滚

- **上下文行撑大输出**：`before`、`after` 上限 20，并沿用现有的 16 MiB 接收上限和展示 token 上限。
- **glob 默认值变化**：用户可能突然找不到被 ignore 的文件。描述里写清楚 `include_ignored`，并在结果为空且路径里有被忽略的目录时给出提示（可选）。
- **回滚**：每个参数独立，可以单独 revert；glob 的默认值变化单独一个提交。

## 2.6 和另外两轮的衔接

- 依赖 improve-1 的描述格式和 Pi 流程。
- 和 improve-3 没有代码依赖。

## 2.7 不在本轮范围

- grep 多行匹配（`multiline`）、按文件类型过滤（`type`）、分页（`offset`）。
- 新增行数统计、目录大小之类的工具（交给 improve-3 的只读 bash）。
- list 显示文件大小、修改时间（G7）。
- 让 glob 的文件级 ignore 规则不被正向 glob 覆盖（G5 里不采用的做法）。
- read 读目录、读二进制。
