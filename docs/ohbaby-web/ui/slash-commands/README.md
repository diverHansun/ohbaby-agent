# ohbaby-web · Slash Commands UI

> v0.1.6 的 slash UI 增强规格。设计参考来自 `ohbaby-web Slash.dc.html`，但命令集合以 daemon `/v1/commands?surface=web` 返回的 palette catalog 为唯一事实源。passthrough 命令仍经 `ohbaby-sdk` web-safe helper 过滤；结构化命令只打开 overlay。

---

## 1. Scope

本批做：

- `/` 输入触发候选面板。
- 候选按 category 分组，展示命令路径、参数提示、描述和颜色点。
- 键盘：`↑/↓` 逐项选择，`PageUp/PageDown` 分页跳选，`Tab` 补全，`Enter` 执行，`Esc` 关闭。
- 只读成功结果弹层：`/status`、`/help`、`/mcps`、`/skills`。
- `/new` 继续作为状态变更命令执行，不弹只读 modal；成功/失败仍可用 notice 表示。
- `/connect`、`/connect-search`、`/compact` 作为结构化 overlay 命令出现；提交走独立 REST，不走 `POST /v1/commands`。
- running/error notice 保留；无法结构化的成功输出回退为安全文本/markdown notice。

本批不做：

- `parentBehavior: "interaction"` 命令。
- 分页、高级搜索、命令历史、session 切换侧栏。

---

## 2. Catalog Contract

- UI 不硬编码可执行命令集合。
- `OhbabyWebClient.listCommands()` 返回 `UiWebCommandCatalog`，其中每个命令带 `executionKind` 与 `action`。
- 浏览器执行前仍调用 `resolveSlashCommand(catalog, parseSlashCommandInput(text), { surface: "tui" })`。
- server 仍在 `POST /v1/commands` 再次用同一 SDK helper 校验 passthrough invocation。
- overlay 命令不进入 passthrough allowlist，手写 `POST /v1/commands` 必须被拒绝。
- 收到 `command.catalog.updated` 后，浏览器清空 catalog 缓存；下一次打开 slash 面板或执行 slash 命令重新 GET。

---

## 3. Palette

位置：宽度跟 composer 对齐，最大高度约 320px。

- 空态首页：向下展开，避免遮挡居中的 logo/wordmark。
- 运行态：向上展开，贴近底部 composer，并避开 conversation/permission/result 卡片的阅读动线。

视觉：

- 白底，1px 中性描边，12px radius，轻阴影。
- 行高稳定，选中行浅蓝灰底。
- 候选行使用固定列宽；描述和参数提示过长时 ellipsis，不反向撑大 composer。
- 输入区宽度固定在页面布局给定宽度内；completion chip 固定宽度，选择 `/new`、`/skills` 等不同长度命令时不能造成输入框或 Send 按钮位移。
- category label 小号大写，低对比中性灰。
- footer 显示：`↑↓ select`、`↵ run`、`⇥ complete`、`esc dismiss`。

行为：

- draft 不以 `/` 开头时关闭。
- composer 不能发送时关闭；运行中或等待权限时不拉取/显示/执行 slash 候选，避免 `/new` 等状态变更命令打断 in-flight run。
- draft 为 `/` 时显示全部 web-safe 候选。
- draft 为 `/sta` 等局部输入时用 SDK 过滤/匹配可见命令。
- `PageDown` / `PageUp` 按固定步长跳选，并在首尾 clamp。
- `Tab` 用当前选中命令补全为完整路径文本，不立即执行。
- `Enter` 执行当前选中候选；若没有候选，则按普通 slash 解析失败处理，保留草稿并显示错误。
- 已打开面板收到 `command.catalog.updated` 后重新调用 `OhbabyWebClient.listCommands()`，使用 client 层被事件失效后的最新目录。

---

## 4. Result Modal

只读结果从 `command.result.delivered` 的 raw `UiSlashCommandOutput` 派生。modal 是易失 UI 投影，不写回 snapshot。

通用壳：

- backdrop：半透明深灰。
- dialog：白底，14px radius，1px 描边，强一点的居中阴影。
- header：命令 chip（如 `/status`）+ 标题 + 关闭按钮。
- 关闭：`Esc`、点击关闭按钮、点击 backdrop。

命令形态：

- `/status`：键值行，显示 session、model/context（若可从 snapshot 派生）、connection、permission、working dir/server/version（若 output 存在）。
- `/help`：双栏，左侧 shortcuts，右侧 web-safe commands；必须过滤未开放命令。
- `/mcps`：服务器列表，ok/error 状态点，transport/tool count/error 文案由 output data 派生；缺字段时回退 JSON 文本。
- `/skills`：技能列表，名称、描述、source chip；缺字段时回退 JSON 文本。

---

## 5. Safety

- markdown 输出仍走 `MarkdownBlock` 消毒。
- text 输出用 React 文本/`pre` 渲染，不注入 HTML。
- data 输出只读解析；未知 subject 回退为 `JSON.stringify(data, null, 2)`。
- `/help`、候选面板、modal 内命令列表都必须用 SDK web-safe helper 过滤。
- UI 只展示已接线的 passthrough/overlay 命令，未接线 interaction 命令继续隐藏，避免用户看到不可执行的承诺。

---

## 6. Acceptance

- 单测：catalog 暴露给 UI，unsupported 命令不出现，overlay 命令不经 passthrough；Tab 补全、`PageUp/PageDown` 和候选选择可预测。
- reducer 测试：`command.result.delivered` 保留 raw output，同时保留原有 text/markdown fallback。
- 组件测试：输入 `/` 打开面板；`Tab` 补全；`Enter` 执行；只读结果打开 modal；`Esc` 关闭。
- 组件/集成测试：运行中不打开 slash palette；`command.catalog.updated` 后已打开面板/执行重新拉 catalog。
- Playwright headless：本地 web 端空态/运行态可见，slash palette 与 `/status` modal 可操作；输入 `/` 和切换候选时 composer/input/chip 尺寸稳定。
