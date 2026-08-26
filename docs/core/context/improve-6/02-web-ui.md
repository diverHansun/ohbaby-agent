# 2-web. Web 占用环、hover/click 与 `/status` 卡片

> 前端契约。数据字段以 [02](./02-optimization-plan-and-change-scope.md) §2.5 为准。显示名严格使用 [00](./00-discussion.md) §2.1 的固定英文文案及大小写。

## 目标

用户在顶栏用小环感知占用；hover 看粗数字；click 看七类估算。`/status` 卡片给同一套七类。环和 click 面板 **不**显示 cache。**Cache 行（`Cache hit {n}%`）属下一轮，本批 `/status` 卡片不含 cache**（设计见 [00](./00-discussion.md) §2.4）。

## 交互与状态

| 状态 | 外观 | 输入 | 下一状态 |
|------|------|------|----------|
| unavailable | 不渲染环，保留 model 名（已拍板，不画空环） | usage 到达 | compact |
| compact | 约 14px SVG 环，填充 = `contextWindowRatio`；无面板 | hover | tooltip |
| compact | 同上 | click / Enter | detail |
| tooltip | 浮层：`{n}% context used` + `~{used} / {window} tokens`（总量来自校准后的启发式占用，仍保留 `~`） | mouse leave | compact |
| tooltip | 同上 | click | detail |
| detail | 标题 Context Usage；`{n}% Full`；`~{used} / {window}`；堆叠彩条；七行英文名 + `~{count}`；关闭 X | click outside / Escape / X | compact |
| /status card | 现有 session/model/… 行 + 占用详情块（同 detail 的条与七行）。**下一轮**追加 `Cache hit {n}%` 行 | 关 modal | — |

环在 hover 时仍显示；tooltip 与 detail 互斥（开 detail 时关掉 tooltip）。

无键盘焦点陷阱：detail 是轻量 popover，不是全屏 modal（`/status` 已是 command modal）。

## 布局

**顶栏（替换当前细条，不要再并排一根单色条）：**

```text
[OHBABY]  ·  connected  ·  model  ·  (ring)  ·  optional goal
```

环右侧不重复 `7.1k / 1m` 文本：**环为主触发器，去掉细条与短标签，粗数字只靠 hover**（2026-08-26 用户确认）。

**Click 面板（对标 Cursor，无 Rules 行）：**

```text
Context Usage                              ×
43% Full                    ~110.1K / 256K
[■■ system ■ builtin ■ mcp ■ skills ■ conversation ■ summary ■ sub ░░░░░]

● System prompt              ~1.1K
● Built-in tools            ~11.3K
● MCP tools                  ~2.4K
● Skills                     ~5.7K
● Conversation              ~70.5K
● Summarized conversation   ~15.0K
● Subagent exchanges          ~0
```

彩条总长度 = 占用百分比（未用部分浅底）。段宽度 = 该类 / 七类之和 × 占用百分比。某类为 0 时不画段，但列表仍显示 `~0`。

**`/status` 卡片：** **替换**现有 `statusRows` 里的 context 粗行，插入同一套条+七行（已拍板：替换而非追加在其下）。无 composition 时保持旧单行 context，不画空条。manual compact 后若尚未重新 prepare，也按无 composition 处理，不能沿用压缩前明细。下一轮再追加：

```text
cache          Cache hit 61%
```

或无可信数据时 `cache          Cache hit —`（session aggregate 口径，见 00 §2.4）。任何时候都不要把 cache 画进彩条。

## 数据映射

| UI | 字段 |
|----|------|
| 环填充、hover %、面板 % | `contextWindowRatio` |
| hover 与面板总量 | `currentTokens` / `contextWindowTokens` |
| 七行 | `composition[key]`，缺 composition 时详情只显示总量、不画假分类 |
| `/status` cache（下一轮） | `promptCache.cacheReadShare === null` → `Cache hit —`；否则 `Cache hit {n}%` |

显示名写死英文，不跟 UI locale 走（00）。

## 无障碍

- 环是 `button`，`aria-label` 含百分比与 used/window。
- `aria-expanded` / `aria-haspopup="dialog"`。
- 面板 `role="dialog"`，Esc 关闭。
- 色块旁边必须有文字行，不能只靠颜色。

## 测试要点

- 无 usage：不出现可点环（或明确 empty）。
- 有总量无 composition：环可用，click 只有总量，**七行整体隐藏**（不渲染假 0，避免把缺失当成全 0）。
- 有 composition：七行顺序与 00 表一致；某类为 0 仍显示 `~0`。
- runtime model context 显示在 System prompt；summary 只显示在 Summarized conversation；Subagent exchanges 只含父窗口 `subagent_run` / `subagent_status` / `subagent_close` 的 call 与对应回写部分。
- `/status`：有 composition 详情块；**本批无 Cache 行**（下一轮：null 文案 `Cache hit —`）。
- 子代理 session 不把 child 精确值画进主环（沿用现 tracker 语义）。
