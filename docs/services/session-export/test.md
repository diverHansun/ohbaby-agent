# session-export 模块 test.md

本文遵循项目现有的测试约定：测试文件和源码放在同一个目录下，按后缀分类，分别是 `*.unit.test.ts`、`*.integration.test.ts`、`*.contract.test.ts`，用 vitest 运行（`pnpm test:unit` 等）。

接入层（TUI、server、web）的测试和验收标准见 [improve-1/04](./improve-1/04-test-and-acceptance.md)。

---

## 一、Test Scope（测试范围）

**覆盖：**
- Collector 的过滤、标注、排序、统计规则（D1–D3）。
- JSONL 的结构和版本字段（D4）。
- HTML 的数据嵌入，以及页面打开时的安全性（D5、G5）。
- 文件名生成（D6）。
- 错误码（D7）。

**不覆盖（由 improve-1/04 负责）：**
- 写文件和 Downloads 目录解析，这部分在 TUI。
- REST 和 JSON-RPC 的传输与鉴权。
- 网页端下载和菜单交互。

---

## 二、Critical Scenarios（关键场景）

| ID | 场景 | 预期 |
|---|---|---|
| S1 | 普通会话，包含用户消息、助手正文、思考、工具调用 | 每种内容都出现在导出里，顺序和数据库里一致 |
| S2 | 会话 compact 过 | 被 compact 的 part 仍然导出，带 `compacted: true`。摘要消息带 `kind: "compaction-summary"`，并且有摘要全文 |
| S3 | 在 model-state、model-context part、`UserMessage.system`、`select_tools`、`todo_read` 里各放一个唯一的哨兵字符串，例如 `__LEAK_SENTINEL_1__` | 先把 JSONL 逐行解析，再把 HTML 里嵌入的 base64 数据解码，然后断言**所有哨兵都不存在**。不要用 `encrypted`、`signature` 这类词去 grep：数据被 base64 编码后搜不到，正常讨论里出现这些词又会误报 |
| S3b | 同一个会话里有 compact 摘要（synthetic）和中断类系统消息 | 两者都**保留**，没有因为过滤规则被误删 |
| S4 | 有 `todo_write`、`subagent_run` 工具调用 | 照常导出 |
| S5 | 用户消息带 `metadata.displayText` | 导出的是 displayText |
| S6 | 子代理结果回填（`runtimeInput.kind = subagent-result`） | 导出为 `role: "system"`，带 `runtimeInput` |
| S7 | 会话还在运行，有 `running` 状态的工具、没写完的助手消息 | 正常导出，工具 `status` 是 `running` |
| S8 | 会话不存在、是子代理会话、过滤后为空、format 不合法 | 分别抛出 `SESSION_NOT_FOUND`、`SUBAGENT_SESSION`、`EMPTY_SESSION`、`INVALID_FORMAT` |
| S9 | JSONL 结构 | 每一行都能被 `JSON.parse` 解析。第 1 行 `type` 是 `session`、`format` 是 `ohbaby.session-export`、`version` 是 1。中文没有被转义。文件以 `\n` 结尾。可选字段不出现 `null` |
| S10 | token 统计 | 和 `modelRequests[].usage` 手工相加的结果一致。没有 modelRequests 时，回退到原始 part（包含 model-state carrier）上的 `tokenUsage`；缺失 usage 不伪造为零，reasoning 不重复计入 total |
| S11 | 文件名 | 固定 `now` 后，`session_1760000000000_k3x9ab1` 生成 `ohbaby-<YYYYMMDD-HHmmss>-k3x9ab1.html` 或 `.jsonl`，mimeType 对应。同一秒内导出**不同会话**，文件名也不同。id 里有特殊字符或没有 `_` 时，按 dfd §2.1 第 7 步的规则处理 |

### HTML 安全与正确性（G5，最高优先级）

| ID | 场景 | 预期 |
|---|---|---|
| H1 | 正文里有 `<script>alert(1)</script>`、`<img src=x onerror=…>`、`<details>` | 页面上原样显示为文字，DOM 里没有生成对应的元素 |
| H2 | 正文里有 `[x](javascript:alert(1))`、`![](https://tracker/x.png)` | `javascript:` 链接只显示文字。远程图片不会渲染成 `<img>`（见 H9）。就算渲染了，CSP 的 `img-src data:` 也会拦下来 |
| H3 | 工具输出或思考里包含 `</script>` | 页面结构完好，数据能完整解码 |
| H4 | 正文里有 `$&`、`$$`、`` $` `` | 页面上原样显示，用来验证模板拼接没有被 `$` 替换语法破坏（pi 的 bug） |
| H5 | 中文、emoji | 解码后和原文一字不差 |
| H6 | 模板里没有内联事件属性，并且有 CSP meta | 对生成的 HTML 做静态检查：没有 `on\w+=` 属性，`<meta http-equiv="Content-Security-Policy">` 存在，CSP 里包含 `base-uri 'none'` 和 `form-action 'none'` |
| H7 | 工具输出里有 MCP 返回的 png、jpeg、gif、webp data URI 图片，前后夹着普通文字 | 图片渲染成 `<img>`，`src` 就是这个 data URI。前后的文字照常转义显示 |
| H8 | 工具输出里有 `data:image/svg+xml` 图片、`data:text/html` 链接、base64 段里混入非法字符 | 都**不**渲染成 `<img>`，按纯文本显示 |
| H9 | Markdown 正文里有 `![](data:image/png;base64,…)` 或 `![](https://…)` | 都不渲染成 `<img>`，只显示 alt 文字 |

---

## 三、Integration Points（集成点测试）

| 集成点 | 验证重点 | 失败时的预期 |
|---|---|---|
| 和真实 SQLite 的 `MessageManager` | 写入消息，执行 compact（`commitCompaction`），再导出。compact 前后内容都在，标记正确 | 数据库读取失败时，错误原样抛出，不吞掉 |
| 和 `SessionManager` | 子代理会话被拒绝。archived 会话可以导出 | — |
| `assets.generated.ts` | `generate-session-export-assets.mjs --check` 在构建时通过 | 模板改了但没重新生成时，构建失败 |

---

## 四、Verification Strategy（验证策略）

- **Collector 和 JSONL**：用 unit 测试。用内存里的 Message/Part 构造数据，不 mock 内部函数，只替换注入进来的 `sessionManager` 和 `messageManager`。
- **compact 场景**：用 integration 测试，走真实数据库，因为 compact 标记是在数据库事务里写进去的。
- **HTML 安全**：
  - 在 jsdom 里加载生成的 HTML，让 `template.js` 真正运行一遍，然后检查 DOM，覆盖 H1–H5、H7–H9。仓库里已经有 jsdom 25。
  - **不能**只对模板源码做正则检查。pi 的 XSS 测试就是只检查源码，结果漏掉了 `$` 的问题。
  - CSP 在 jsdom 里不生效，所以 H2 的远程图片拦截要用 H6 的静态检查，加上一次真实浏览器的手工验证。
- **手工验证**：分别在 Chrome、Safari、Firefox 里打开一个真实会话导出的 HTML。确认折叠能用、深浅色主题正常、打印正常，开发者工具的 Network 面板里没有任何请求。
