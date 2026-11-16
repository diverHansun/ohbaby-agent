# 上下文窗口默认值与显示

本议题于 2026-11-16 开启，接续 [2026-11-12 模型配置自动化](../2026-11-12-model-settings-automation/README.md)。本轮调整上下文窗口默认值、旧配置迁移和设置界面显示，并修复已取消的探测仍会发出请求的问题。探测继续使用服务商的模型列表和精确模型 ID。

## 1. 起因

设置界面里，OpenAI `gpt-6.1-terra` 的 Context window 输入框是空的，下方显示 "Detected: 1,000,000 tokens"。用户怀疑探测值会覆盖手填的值：比如用户想用 300k 让压缩提前触发，结果实际生效的却是探测值。

## 2. 核查结论

### 2.1 探测是否准确

探测的做法是读取服务商 `GET /models` 返回的模型元数据（[context-window-probe.ts](../../../../packages/ohbaby-agent/src/config/llm/context-window-probe.ts)）。2026-11-16 用真实 key 请求的结果如下：

| 服务商 / 协议 | 元数据字段 | 探测结果 | 官方值 |
|---|---|---|---|
| ZenMux（Chat、Anthropic） | `context_length` | deepseek-v4.1-flash 1,000,000；claude-sonnet-5 1,000,000；gpt-5.6-luna 1,050,000 | 一致 |
| DeepSeek 官方（Chat） | `context_window` | 1,048,576 | 1M |
| DeepSeek、百炼（Anthropic） | `/v1/models` 返回 404 | 未探测到 | 1M |
| OpenAI、智谱、百炼（Chat） | 只有 `id`、`owned_by` 等基本字段 | 未探测到 | 约 1M |

上述返回了窗口字段的样本与服务商标注一致。缺少窗口字段时，运行使用手填值、同路由已有探测值或默认值，依此顺序取第一个有效值。

### 2.2 用户值是否被覆盖

不会。用户填写的值和探测值分开存在 `contextWindowTokens` 和 `detectedContextWindowTokens` 两个字段里，探测只写后者。生效顺序是"用户值 → 当前路由的探测值 → 默认值"，压缩阈值也按这个生效值计算。这次用脚本验证过：用户值 300,000、探测值 1,000,000 时，生效值是 300,000。

### 2.3 截图里的 "Detected" 从哪里来

OpenAI 的元数据里没有窗口字段，这个值不是探测出来的。它来自旧版迁移规则：没有 `schemaVersion` 的旧 `model.json` 被读取时，旧的 context 值一律转成探测值（2026-11-12 讨论中的 D1）。所以旧文件里的 1,000,000，不管当初是不是用户手填的，都显示成了 "Detected"，输入框反而是空的。

## 3. 已确认的决定

| 编号 | 日期 | 决定 |
|---|---|---|
| C1 | 2026-11-16 | 默认上下文窗口从 300,000 改为 1,000,000。如果模型真实窗口更小、服务商又不提供元数据，就靠已有的"超长报错 → 强制压缩 → 重试"流程兜底；用户也可以手动填写更小的值。 |
| C2 | 2026-11-16 | 旧版配置迁移时直接丢掉旧的 context 值，不再转成探测值。丢掉后，有探测结果就用探测值，否则用 1,000,000。已经保存成版本 2 的文件不追溯处理。 |
| C3 | 2026-11-16 | Context window 和 Max output 输入框留空时，在占位文字里写明实际生效的值，例如 `1,050,000 (detected)`、`1,000,000 (default)`、`32,768 (default)`。不再额外加一行说明，Web 和 TUI 都按这个方式显示。 |

C1 的依据：本次核对的模型官方窗口都在 1M 左右；参考项目中，dsh 对未知模型的兜底值是 1M，ZCode 内置的通用规则也是 1M。OpenAI 单次输入上限是 922k，按 1M 默认值和 32,768 的输出上限算，90% 压缩点约为 87 万，低于这个上限。

C2 的影响：作者本机的旧配置里两个条目都是 1,000,000，丢掉后生效值不变。其他从 0.1.17 及更早版本升级的用户，如果当初有意填了更小的值，升级后会变回自动值。

## 4. 改动面

| 位置 | 改动 |
|---|---|
| `ohbaby-sdk` `contract/connect-model.ts` | 新增 `DEFAULT_CONTEXT_WINDOW_TOKENS = 1_000_000` 和 `DEFAULT_MAX_OUTPUT_TOKENS = 32_768`，作为前后端共用的唯一来源 |
| `ohbaby-agent` `services/llm-model/modelProfiles.ts` | 改为从 SDK 引入这两个默认值并重新导出 |
| `ohbaby-agent` `config/llm/model-document.ts` | 旧版迁移删除 context 值，不再转入 `detectedContextWindowTokens` |
| `ohbaby-web` `ui/settings/ModelEditor.tsx` | 删除 `AutoContextNote`，两个数字输入框的占位文字改为生效值；探测中显示 `Detecting…` |
| `ohbaby-cli` `tui/components/dialog/connect-panel.tsx` | 删除 `· Automatic: …` 后缀，空字段以灰字显示同样的占位文字 |
| 模块文档、测试、Web mock | 同步新的默认值、迁移规则和显示方式 |

Web 的 Reasoning Effort 行会显示影响上下文窗口探测的鉴权、限流等错误，已有推理档位仍可用。Web 和 TUI 只为匹配草稿路由的模型显示探测值。探测值缺失时，空字段显示默认值，正在探测时显示 `Detecting…`。

依赖固定窗口的配置、缓存和工具冒烟测试改用 `schemaVersion: 2` 写入明确的覆盖值。迁移用例继续使用旧格式，验证旧值被丢弃。

## 5. 验收（2026-11-17）

| 项目 | 结果 |
|---|---|
| 全量测试 `pnpm test` | 8,568 项通过，29 项跳过 |
| 格式、lint、类型检查和构建 | `pnpm preflight` 通过，lint 无错误 |
| 取消探测 | 请求取消后不调用 `fetch`，返回 `cancelled` |
| Web 设置页（mock） | 有探测值显示 `128,000 (detected)`；新建模型显示 `1,000,000 (default)`；清空 Max output 后显示 `32,768 (default)`；控制台无报错 |
| TUI `/connect` | 空字段显示探测值或默认值。探测刷新保留正在编辑的草稿，切换路由后旧路由的探测值不再显示 |
| 迁移 | 用本机旧 `model.json` 的副本读取：两个条目都没有用户值和探测值，生效值为 1,000,000，reasoning 能力保留；原文件没有被改动 |

### 三协议真实端到端复验

通过后端 REST 保存和探测配置。每条路由都验证空覆盖、手填 300,000 优先、清空后恢复探测值、默认输出上限 32,768，以及 SQLite 关闭后重开并续聊。第一轮对话调用只读 `read` 工具，第二轮用已保存的会话继续回答。

| 协议 | ZenMux 模型 | 探测窗口 | 结果 |
|---|---|---:|---|
| OpenAI-compatible | `openai/gpt-5.6-luna` | 1,050,000 | 通过 |
| OpenAI Responses | `openai/gpt-5.6-luna` | 1,050,000 | 通过 |
| Anthropic Messages | `anthropic/claude-sonnet-5` | 1,000,000 | 通过 |

另用 OpenAI 官方 `gpt-6.1-terra` 核对缺少窗口字段的路径，后端返回 `1,000,000`，来源为 `default`。超长恢复由本地生命周期和压缩测试覆盖。没有可压缩历史，或重试仍超长时，运行会报告超长失败。
