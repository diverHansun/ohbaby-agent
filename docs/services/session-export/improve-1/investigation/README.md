# 会话导出源码复核

调查日期：2026-10-17（Asia/Taipei）。本次按用户要求，详细读取现有 session-export 的 11 份文档，并核对六个本地参考项目的实现。调查只记录事实；后端实施范围与产品取舍在对话中讨论，原有方案文档尚未修改。

> 本文是实施前的调查快照，“尚未实现”等描述对应调查当时。后续实施和当前验收结论见 [05 后端验收](../05-implementation-acceptance.md) 与 [06 前端验收](../06-frontend-acceptance.md)。

## 当前结论

六个项目的导出目的不同：Codex 和 Kimi 提供可读 Markdown，Pi 提供 HTML 和可恢复的 JSONL，OpenCode 提供 JSON 与 Markdown，DeepSeek Harness 下载诊断日志 ZIP，ZCode 发布经过过滤的公开分享。格式名称相同，也不代表导出的内容范围相同。

ohbaby 当前还没有导出实现。持久化消息接口能读取 compact 前的原始内容；现有 UI 投影会过滤部分内容，不能直接代表完整导出数据。

## 范围与来源

- 包含：入口、内容范围、compact、运行状态、隐藏字段、工具与附件、保存位置、安全措施、测试源码，以及 ohbaby 的接入边界。
- 不包含：参考项目的线上版本、线上服务行为、运行六个参考仓库的完整测试、TUI/Web 视觉验收。
- 方法：三个只读子代理分组调查，主代理核对关键实现与现有文档；以本地检出源码为准。
- 用户截图只用于确认 Web 会话菜单的位置，不作为导出能力已有实现的证据。

| 文档 | 范围 | 本地 HEAD |
|---|---|---|
| [01-ohbaby-current-state.md](./01-ohbaby-current-state.md) | 现有数据源、SDK、传输、基线验证 | `0bcda4846f57fb02c20f67d989297ff6225ffffd` |
| [02-codex.md](./02-codex.md) | 完整线程 Markdown、客户端保存、防覆盖 | `12cca49c81c8aa6a37a5cc4e39964ee3b70f9458` |
| [03-pi.md](./03-pi.md) | HTML、JSONL、分支、模板安全 | `7d75a0e3eb273dff753d49c066ea29fbe7b3b6f6` |
| [04-opencode.md](./04-opencode.md) | 多端 JSON/Markdown、内容差异、sanitize | `15b24ae12ddb8b7ae3e923b286b4032761bee510` |
| [05-kimi-code.md](./05-kimi-code.md) | Markdown、模型上下文、诊断 ZIP | `cbd754049a114ee36d1b27675c82819e4963c692` |
| [06-deepseek-harness.md](./06-deepseek-harness.md) | 持久日志、ZIP、附件、浏览器下载 | `d743267388641bc76f17c45ce8b4c231aed1d32c` |
| [07-zcode.md](./07-zcode.md) | 公开分享、白名单投影、快照一致性 | `aac4755666d09fdcd70272fcf063c077a639015f` |

所有参考仓库均位于 `/Users/hansun025/Projects/code-cli/`。文档内代码路径相对于各自仓库根目录，行号是本次检出的快照。

## 现有文档的引用修正与补充

| 引用或需要补充的边界 | 本次复核 |
|---|---|
| “和参考的 6 个项目一样不脱敏” | OpenCode 有可选结构清理，ZCode 有公开字段投影。正文秘密识别、内部字段过滤和原样留存是不同的事情。 |
| OpenCode 只导出已完成消息 | 仅 CLI/TUI 专用 export API 有 settled 过滤；Web/GUI 分页读取消息，没有同样过滤。 |
| OpenCode 中文标题会变成空文件名 | 清洗为空时会退回 session ID，不会生成空名。 |
| Pi 两种格式的内容范围（原文未展开） | HTML 包含全树，JSONL 只导当前分支；两者没有 ohbaby 方案要求的同源范围。 |
| Pi 导出只提醒敏感信息 | 本地 `/export` handler 没有额外敏感信息提醒。ohbaby 的提醒是自己的产品决定。 |
| Pi 的 `$` 模板替换问题（补充触发机制） | payload 已 base64；已确认的问题是模板脚本作为 replacement string 后，脚本中的 `$$` 等模式被解释，例如 Cost 标签丢掉美元符号。 |
| Kimi 时间戳防止覆盖 | 只有秒级时间戳，Markdown 普通 writeFile 和 ZIP 最后 rename 都不能保证不覆盖。 |
| DeepSeek 笔记原话：“主机路径对远程浏览器没有意义” | 指定归档笔记没有这句。源码确有浏览器下载和拒绝路径参数，不能把推导写成原文引述。 |
| ZCode 导出 JSON、部分能导回 | 实际是云端分享投影与附件，导入用于新会话上下文；不是本地原始会话导出/恢复。 |

这些差异主要影响引用准确性，不代表现有 ohbaby 方案需要整体推翻。

## 待核实事项

- 后端新增 SDK 必需方法后，Web 的接口实现也要接线；这两处底层文件是否纳入后端批次，已在对话中说明，尚待范围讨论。
- “运行中导出”目前文档只说明保留状态，没有明确承诺未持久化的流式尾部；实现前需明确快照含义。
- 实际 HTML 安全、超过 20 MB 会话的导出耗时/内存、不同平台 Downloads 行为，都要等实现后验证。
- Pi 指定模型已由用户确认使用 `opencode-go/gemini-4-argon-contributor`，认证检查为 `ready`。本次尚未调用其进行实现审查。

## 推断汇总

- 从当前 SDK 必需接口和 BrowserDaemonClient 的 implements 关系看，只修改后端与 SDK 而完全不改 Web 传输层，会导致 Web 类型检查失败。这是由源码接口关系推断，尚未通过修改代码复现。
- 从六个项目的多端/多格式差异看，“HTML 和 JSONL 是否同一内容范围”不能靠采用同一种文件格式保证。该推断由 Pi 与 OpenCode 的两条不同收集链路支持。
