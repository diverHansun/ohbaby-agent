# 2-tui. TUI 本轮保持总占用

> TUI 契约。00：无环、无 hover/click；本轮不展示七类，不做 ASCII 堆叠条。**Cache 行下一轮**（设计见 [00](./00-discussion.md) §2.4）。

## 目标

底栏与 `/status` 继续使用已回归的总占用格式。后端/SDK 可以新增 optional composition，但 TUI 本轮不消费它。先让 Web 验证七类数据和交互，再决定终端是否需要七行纯文本或独立 `/context`。

## 底栏（不改语义）

保持 `formatContextWindowUsage`：`38K / 1M (4%)`。不把该标签做成可点控件，不画环。

## `/status` 面板（本轮不改）

保持现有结构：

```text
╭─ Status ─
│ Runtime    idle
│ Session    session_1
│ Model      deepseek-v4-pro
│ Context    110K / 256K (43%)
│ Tools      12 builtin, 2 skill, 4 mcp
│ MCP        3 connected
│ Project    /path
╰──────────
```

下一轮可在 Context 与 Tools 行之间独立追加 Cache 行：

```text
│ Cache      Cache hit 61%
```

规则：

- 总量行与底栏使用同一 `formatContextWindowUsage`：`{used} / {window} ({percent})`。
- `UiContextWindowUsage.composition` 是 optional；TUI 读取逻辑继续忽略它，未知字段不应破坏现有面板。
- 不添加七行、ASCII 条、ANSI 分类色、点击或新 slash 命令。
- manual compact 后 total-only usage 仍正常显示。
- （下一轮）Cache 行：`Cache hit {n}%`；`promptCache.cacheReadShare === null` → `Cache hit —`。禁止把无数据显示成 `0%`。
- Tools 行继续表达工具**个数**，与 Context 总量无混名。

## 数据

与 Web 同一 `/status` payload：`contextWindow` 可以含 composition，但 TUI 本轮只读现有总量字段，不另建 API。下一轮同 payload 增加 `promptCache`。

## 测试要点

- 无 composition 的 payload：保持旧单行 Context。
- 有 composition 的 payload：仍只显示旧单行 Context，不因未知字段崩溃或重复显示。
- 底栏与 `/status` 单测继续锁 `38.4K / 1M (4%)` 契约。
- （下一轮）cache 缺省：`Cache hit —`，禁止 `0%`。

## 延期条件

七类 TUI UI 不进入本轮 DoD。只有 Web 实际使用后证明分类有稳定诊断价值，并出现明确终端需求时，才重新比较：

1. `/status` 下七行纯文本；
2. 独立 `/context` 诊断页；
3. 继续只保留总量。

本轮不为这三个未来选项预建 renderer/view model，遵循 KISS/YAGNI。
