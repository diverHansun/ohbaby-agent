# 5. 实施与验收（improve-2）

对应方案见 [02-optimization-plan-and-change-scope.md](02-optimization-plan-and-change-scope.md)，验收口径见 [04-test-and-acceptance.md](04-test-and-acceptance.md)。本轮在分支 `codex/native-tool-preference` 上紧接 improve-1 实施。本次由 Astra 主控复核，Neon high 撰写文案，Opus high 分批审查。

## 5.1 批次验收快照

**本轮 `grep` 与 `glob` 的核心能力升级、自动化测试及 CLI 阶段 10 模型实测均已完成并基本达到预期**，具体边界与保留项如下：

- `grep` 已支持 `before`、`after`（0–20 行）、`ignore_case` 与 `output_mode`（`content` / `files` / `count`）；`glob` 已默认遵守搜索根及其下层项目 ignore 文件，提供 `include_ignored` 开关，并保持 `.git`、`dist`、`node_modules`、`out`、`target` 固定排除。
- **版本对应关系须分清**：10 模型完整 CLI 实测运行在 **`6d8392d8`**（已包含 `c71cc36e` 与 `bc62a382` 两项功能提交）；审查修正 **`84c31de3`** 落地后执行的是目标回归单测（5 文件 69 项全通过），**未在 `84c31de3` 上重跑 10 模型全量 CLI**，不能声称全部模型测过 `84c31de3`。
- 实测中观察到两处模型/边界问题（Qwen 向 `grep` 传入 `glob` 独有的 `include_ignored` 字符串参数并误称已包含忽略文件；DeepSeek Flash 在两次 `glob` 对比后又用 `bash` 打包检查 ignore 规则），详见 §5.4 与 §5.5，**不将 Qwen 的多余断言记为通过**。
- **边界与衔接**：最终交叉验证与最终分支合并不在本轮结论范围内；内置浏览器联合验证（`glob` 排除 `coverage` 后返回 4 项、`grep` 忽略大小写命中 2 处含上下文、`read` 返回标记）属于后续验收。最终 Web/TUI、全量测试、交叉评审和合并记录见 [improve-3/05-implementation-acceptance.md](../improve-3/05-implementation-acceptance.md)。

## 5.2 提交清单与改动面

| 提交 | 内容 | 主要源码与测试（相对路径） |
| --- | --- | --- |
| `c71cc36e` | Stage 1（G1–G3）：`grep` 增加上下文行、忽略大小写与 `files`/`count` 模式并同步描述 | [grep.ts](../../../../packages/ohbaby-agent/src/tools/grep.ts)、[ripgrep-search.ts](../../../../packages/ohbaby-agent/src/tools/utils/ripgrep-search.ts)、[grep.unit.test.ts](../../../../packages/ohbaby-agent/src/tools/grep.unit.test.ts) |
| `bc62a382` | Stage 2（G5）：`glob` 默认遵守项目 ignore 文件并新增 `include_ignored`（独立提交，便于单独回滚） | [glob.ts](../../../../packages/ohbaby-agent/src/tools/glob.ts)、[ripgrep-files.ts](../../../../packages/ohbaby-agent/src/tools/utils/ripgrep-files.ts)、[glob.unit.test.ts](../../../../packages/ohbaby-agent/src/tools/glob.unit.test.ts) |
| `84c31de3` | Stage 3 审查修正：修正 `files` 模式 `matchCount` 与截断提示，明确子目录 `path` 下的 ignore 作用域并补测 | [grep.ts](../../../../packages/ohbaby-agent/src/tools/grep.ts)、[glob.ts](../../../../packages/ohbaby-agent/src/tools/glob.ts)、[grep.unit.test.ts](../../../../packages/ohbaby-agent/src/tools/grep.unit.test.ts)、[glob.unit.test.ts](../../../../packages/ohbaby-agent/src/tools/glob.unit.test.ts) |

实现要点说明（面向后续维护者）：

- `grep` 在 `files` / `count` 模式下继续复用 `rg --json`（而非 `--count` 纯文本），从而保留二进制检测、UTF-8 解码和扫描完整性判断；`before`/`after` 超出 20 或与 `files`/`count` 同传时直接报参数错误，不启动 `rg`。
- `glob` 默认去掉 `--no-ignore`，改为与 `grep` 一致的 `--no-ignore-parent`、`--no-ignore-global`、`--no-require-git`；对于 `**`、`**/*` 及纯字面前缀递归（如 `packages/**`、`packages/**/*`），省略 `rg` 正向 `--glob` 而在 Node 侧做字面前缀过滤，让 `rg` 真正剪枝被忽略目录；其他具体 glob 沿用 `rg` 优先级，避免重写整套 glob 引擎。

## 5.3 自动化回归与代码审查

- **功能提交后工具回归**（对应 `b2-tools.log`）：`packages/ohbaby-agent/src/tools` 下 **23 个测试文件、299 项全部通过**（含 `grep.unit.test.ts` 30 项、`glob.unit.test.ts` 14 项、`glob-cleanup.contract.test.ts` 5 项、`files.scheduler.integration.test.ts` 17 项、`ripgrep-search.unit.test.ts` 12 项、`ripgrep-files.unit.test.ts` 6 项），覆盖 04 §4.1 全部场景。
- **Opus high 审查与 Neon high 措辞补充**（对应 `b2-opus.log`、`b2-neon-followup.log`）：
  - 审查无阻断问题，提出 3 项实质改进并全部在 `84c31de3` 落地：① 明确 `grep`/`glob` 的 ignore 仅读取搜索根及其子目录（`path` 指向子目录时工作区根 `.gitignore` 不生效），并补齐一致性单测；② `files` 模式因加了 `--max-count=1`，不再向 `metadata` 输出失真的 `matchCount`；③ 拆出文件数上限提示 `file-limit`，仅在 `content` 模式截断时建议“改用 `output_mode=files`”。
  - 经确认接受的资源边界（保持 KISS，不改）：`files`/`count` 复用 `--json` 时，4 MiB 单行记录上限和 16 MiB 接收上限仍按匹配行 JSON 计算；字面前缀递归会把未忽略文件树输出到 stdout 再按前缀过滤（本仓约 263 KB，远低于 16 MiB）。两类边界超限时均如实标记为未完成。
- **`84c31de3` 定向回归与提交检查**（对应 `b2-review-green.log`、`b2-grep-commit.log`、`b2-glob-commit.log`、`b2-followup-commit.log`）：5 个测试文件（`tool-result-details.unit.test.ts`、`glob.unit.test.ts` 15 项、`glob-cleanup.contract.test.ts` 5 项、`grep.unit.test.ts` 30 项、`ripgrep-search.unit.test.ts` 12 项）共 **69 项全部通过**；三次提交前 `eslint` 均 0 errors（285 条既有 warnings），`pnpm typecheck`（`tsc -b`）通过。

## 5.4 真实模型实测（实测版本 `6d8392d8`）

全部 10 个模型均使用隔离的 `OHBABY_DB_PATH` 与 `XDG_DATA_HOME` 运行。

- **独立工具请求**：10/10 传入生产级新版 `grep`/`glob` schema，均正常返回 `grep` 工具调用。
- **正式 CLI 10 模型端到端**：10/10 返回了正确的目标数据，分组表现如下：

| 场景组 | 模型 | 实际工具路径与观察 |
| --- | --- | --- |
| 短上下文（`peekBatch`，4 模型） | ZenMux Flash（`deepseek-v4.1-flash`）、ZenMux Sonnet（`claude-sonnet-5`）、OpenAI Astra（`gpt-6-astra`）、智谱 GLM（`glm-5.3-flash`） | 全部走原生 `grep`，无 shell `grep`。前三者直接用 `grep` 的 `before`/`after` 拿齐上下文；GLM 先 `grep` 定位再 `read` 前 6 行 |
| 长函数（`assembleParcel`，2 模型） | ZenMux Luna（`gpt-5.6-luna`）、DeepSeek Pro（`deepseek-v4-pro`） | 均走 `grep` 定位 → `read` 通读完整函数，准确返回第 40 行 `'cobalt-elm-92'`，符合 G1 预期 |
| `files` / `count` + `ignore_case`（2 模型） | OpenAI Sol（`gpt-6.1-sol`）、Qwen（`qwen3.8-flash`） | Sol 用 `output_mode="files"` + `ignore_case=true` 返回 2 条路径。Qwen 先用 `count` + `ignore_case=true` 正确统计出 2 行 + 1 行；但随后给 `grep` 误传了 `glob` 独有的 `include_ignored: "true"`，工具未拒绝未知字段而标记为 `completed`，导致模型误称“已包含忽略文件” |
| `glob` ignore 对比（`packages/**/*`，2 模型） | OpenAI Terra（`gpt-6.1-terra`）、DeepSeek Flash（`deepseek-flash`） | 均先后执行默认模式（3 项）与 `include_ignored=true`（5 项），差集正好 2 项（`packages/local-cache/spool.ts`、`packages/orchard/shop.log`），`dist` 等固定排除目录保持排除。DeepSeek Flash 在拿到结果后又跑了一条打包 `bash` 检查 `.gitignore` 等文件，属于偏好例外 |

## 5.5 偏差、已知局限与后续项

- **实测版本差**：10 模型实测在 `6d8392d8` 完成，`84c31de3` 的描述与 `metadata` 修正仅跑了 5 文件 69 项定向单测，未重跑 10 模型 CLI。
- **未知参数未被拒绝（Qwen 暴露）**：`grep` schema 声明了 `additionalProperties: false`，但实测传入 `include_ignored: "true"` 时工具仍返回 `completed`，诱使模型产生幻觉结论。`grep` 并不支持 `include_ignored`，此处不将该多余断言计为通过；通用参数校验是否严格拦截未知字段留作后续议题。
- **子目录 `path` 下的根 ignore 作用域**：沿用 `--no-ignore-parent` 使“直接传被忽略目录作 `path` 可搜索”成立，但当 `path` 为子目录时工作区根 `.gitignore` 不会生效。本轮已在 `84c31de3` 通过工具描述与单测固定为明确契约，未改行为本身。
- **偏好例外**：DeepSeek Flash 在延伸核查 ignore 规则时仍有打包 `bash`（`ls -a` + `for ... cat`）的习惯，记为后续观察。

## 5.6 本机临时记录（未入库）

以下文件仅存在于本机工作区临时目录与 `/tmp`，不作为受版本控制的永久链接，供本机复盘核对：

- 自动化测试与审查日志（`.scratch/native-preference/`）：`b2-tools.log`、`b2-opus.log`、`b2-neon-followup.log`、`b2-review-green.log`、`b2-grep-commit.log`、`b2-glob-commit.log`、`b2-followup-commit.log`
- 真实模型实测快照（`/tmp/ohbaby-native-baseline.PG1oRf/`）：`after2-runs/requests.json`、`after2-runs/e2e-results.json`
