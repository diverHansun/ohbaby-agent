# 03 — 优秀项目设计借鉴点

> 创建日期: 2026-06-09
> 来源: opencode / kimi-code / claude-code 代码分析

---

## 1. opencode 借鉴点

> 仓库: `D:\Projects\Code-cli\opencode`
> 分析范围: session 列表 UI、自动命名、键盘导航

### 1.1 PgUp/PgDn 翻页模式

**文件**: `packages/opencode/src/cli/cmd/tui/ui/dialog-select.tsx:195-204`

```ts
if (evt.name === "pageup")   move(-10)
if (evt.name === "pagedown") move(10)
if (evt.name === "home") moveTo(0)
if (evt.name === "end")  moveTo(flat().length - 1)
```

**借鉴点**: 固定跳 10 行，最简实现。额外支持 Home/End 跳到首尾。

**ohbaby 采用**: 实现 PgUp/PgDn，可选 Home/End。

### 1.2 日期分组显示

**文件**: `packages/opencode/src/cli/cmd/tui/component/dialog-session-list.tsx:112-170`

```ts
let category = new Date(x.time.updated).toDateString()
if (category === today) category = "Today"
```

**借鉴点**: Today 特殊处理，历史日期显示完整日期字符串。

**ohbaby 不采用**: 1 行极简设计下无分组需求。

### 1.3 当前 session 标记

```ts
gutter: isWorking ? <Spinner /> : undefined
// 或 dot 前缀标记当前 session
```

**借鉴点**: 用 `●` 或 spinner 标记当前活跃 session。

**ohbaby 不采用**: 无此需求（1 行设计不区分当前/历史）。

### 1.4 AI 自动命名

**文件**: `packages/opencode/src/session/prompt.ts:193-219`

```ts
const text = yield* llm.stream({
  messages: [
    { role: "user", content: "Generate a title for this conversation:\n" },
    ...msgs  // 首条 user 消息
  ],
  small: true,
  retries: 2,
})
// 清理 <think> 标签，截断到 100 字符
const cleaned = text
  .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
  .split("\n").map(l => l.trim()).find(l => l.length > 0)
```

**借鉴点**:
- 使用 `small: true` 配置小模型
- 自动清理 reasoning 模型的 `<think>` 标签
- 标题最长 100 字符（97 + "..."）
- 仅在有且只有一条 real user message 时触发

**ohbaby 采用**: 采纳异步命名、`<think>` 清理、长度清理、首条 real user message guard。第一版不新增 small/title model 配置，复用当前 active model/provider，并用 system prompt 约束输出长度。

### 1.5 isDefaultTitle 检测

**文件**: `packages/opencode/src/session/session.ts:615+`

```ts
function createDefaultTitle(isChild = false) {
  return (isChild ? "Child session - " : "New session - ") + new Date().toISOString()
}

export function isDefaultTitle(title: string) {
  return /^(New session - |Child session - )\d{4}-\d{2}-\d{2}T...Z$/.test(title)
}
```

**借鉴点**: 用正则匹配判断 title 是否是默认生成值，从而区分"用户/AI 已命名"和"未命名"。

**ohbaby 部分采用**: 保留“默认标题才允许自动覆盖”的 guard 思路；实现上识别 `""`、`"New session"`、`"Untitled session"` 和旧的 `New session - ISO` 格式。

---

## 2. kimi-code 借鉴点

> 仓库: `D:\Projects\Code-cli\kimi-code`
> 分析范围: session picker 卡片设计、自动命名、安全处理

### 2.1 3 行卡片设计

**文件**: `apps/kimi-code/src/tui/components/dialogs/session-picker.ts`

```
❯ Session Title Here     2m ago  (current)
  ses_01HXYABCDEFGHIJK     ~/path/to/project
  › last prompt text sent by user…
```

**借鉴点**:
- 3 行信息密度：title + id/path + last prompt
- `❯` 选中指示器
- 左截断路径（`truncatePathLeft`：保留尾部的有意义的目录名）
- `(current)` inline 标记而非 dot 前缀
- cards 之间空白行分隔

**ohbaby 不采用**: 1 行极简设计，但 `❯` 选中指示器可借鉴。

### 2.2 虚拟窗口滚动

**文件**: `apps/kimi-code/src/tui/components/dialogs/session-picker.ts:162-172`

```ts
const visibleStart = Math.max(0,
  Math.min(
    this.selectedIndex - Math.floor(this.maxVisibleSessions / 2),
    Math.max(0, this.sessions.length - this.maxVisibleSessions)
  )
)
const visibleSessions = this.sessions.slice(visibleStart, visibleStart + this.maxVisibleSessions)
```

**借鉴点**: 选中项居中而不是在顶部，滚动跟随选中项。

**ohbaby 不采用**: 简单窗口分页更适合 Ink React 框架。

### 2.3 页脚提示

```ts
"Showing 1-4 of 12 sessions"
```

**借鉴点**: 明确告知用户总条数和当前位置。

**ohbaby 采用**: PgUp/PgDn 后显示 `"Showing {start}-{end} of {total} sessions · pgup/pgdn · ↑↓"`。

### 2.4 首条消息作为临时标题

**文件**: `packages/agent-core/src/session/prompt-metadata.ts:1-9`

```ts
export function titleFromPromptMetadataText(text: string): string {
  return text.slice(0, MAX_TITLE_LENGTH);  // 200 chars
}
```

**借鉴点**: 无 AI 的情况下也立刻有可读的临时标题。

**ohbaby 采用**: 改为截断 + "…" 作为临时标题，AI 完成后替换。

### 2.5 Prompt 安全脱敏

**文件**: `packages/agent-core/src/session/prompt-metadata.ts:43-58`

```ts
const sanitized = text
  .replaceAll(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*?-----END [^-]*PRIVATE KEY-----/gi, '[redacted]')
  .replaceAll(/\b(authorization)\s*:\s*bearer\s+\S+/gi, '$1: Bearer [redacted]')
  .replaceAll(/\b(api[_-]?key|token|secret|password|passwd|pwd)\b\s*[:=]\s*.../, '$1=[redacted]')
  .replaceAll(/\bsk-[A-Za-z0-9_-]{12,}\b/g, '[redacted]')
```

**借鉴点**: 存储 prompt 到 metadata 前自动脱敏，防止 API key / token / 私钥泄露。

**ohbaby 采用**: 用于 AI 标题生成的输入脱敏。

### 2.6 防重复命名

```ts
private needUpdateEasyTitle(metadata: SessionMeta): boolean {
  if (hasCustomTitle(metadata)) return false;
  if (!isUntitled(metadata.title)) return false;
  return true;
}
```

**借鉴点**: 只有 title 仍然是默认值时才自动生成，防止覆盖用户手动设置的标题。

**ohbaby 采用**: 同理，只在 title 仍是默认/未命名状态，或仍等于本次写入的临时标题时覆盖，避免覆盖用户或其他流程改写的标题。

---

## 3. claude-code 借鉴点

> 仓库: `D:\Projects\Code-cli\claude-code`
> 分析范围: AI 命名 prompt 设计、ESC 多层级处理、标题优先级链

### 3.1 高质量 AI 命名 Prompt

**文件**: `src/utils/sessionTitle.ts:56-129`

```
Generate a concise, sentence-case title (3-7 words) that captures the
main topic or goal of this coding session.

Good examples:
"Fix login button on mobile"
"Add OAuth authentication"
"Refactor API client"

{ "title": "..." }
```

**借鉴点**:
- 明确约束长度（3-7 words）
- 明确格式（sentence-case）
- 提供正例而非仅正/反例对
- JSON schema 约束输出格式

**ohbaby 采用**: 核心 prompt 设计参考此模式。

### 3.2 标题优先级链

**文件**: `src/utils/log.ts:30-58`

```ts
function getLogDisplayTitle(log: LogOption): string {
  return agentName || customTitle || summary || firstPrompt || "Autonomous session" || sessionId.slice(0, 8)
}
```

**借鉴点**: 多级回落确保永远有东西可展示。

**ohbaby 不采用**: 1 行设计下直接用 title（有则显示，无则 "New session"）。

### 3.3 上下文感知的多层 ESC

**文件**: `src/components/LogSelector.tsx:821-866`

```ts
// ESC in rename mode → exit rename (不关闭整个 selector)
// ESC in search mode → clear search
// ESC in list mode → cancel & exit
```

每个 context 有不同的 ESC 行为。

**ohbaby 借鉴**: Phase 1 只需基础 ESC（关闭整个 dialog），后续迭代可按需分层。

### 3.4 渐进式加载

```ts
// 用户滚动到列表底部时加载更多
MAX_SESSIONS_TO_SEARCH = 100
```

**借鉴点**: 大量 session 时不需要一次性加载全部。

**ohbaby 不采用**: 当前 session 数量预估不会超过几百条，全量渲染可行。

---

## 4. 借鉴优先级矩阵

| 借鉴点 | 来源 | Phase | 理由 |
|--------|------|-------|------|
| AI 命名异步触发与清理 | opencode | 4 | 核心功能；模型复用当前 active model/provider |
| AI 命名 prompt 格式 | claude-code | 4 | 质量保证 |
| PgUp/PgDn ±10 翻页 | opencode | 2 | 核心交互 |
| 页脚提示 "Showing X of Y" | kimi-code | 2 | UX 完整性 |
| 防重复命名 guard | kimi-code | 4 | 防止覆盖 |
| Prompt 安全脱敏 | kimi-code | 4 | 安全 |
| ESC 静默取消（不报错） | — | 1 | Bug fix |
| OverlayCard 样式统一 | ohbaby 现有 | 2 | 视觉一致 |
| `❯` 选中指示器 | kimi-code | 2 | UX 细节 |
| 日期分组 Today | opencode | 不采用 | 1 行设计不需要 |
| 渐进式加载 | claude-code | 不采用 | 数据量不大 |
| 虚拟窗口居中 | kimi-code | 不采用 | Ink 框架限制 |

---

## 5. 关键代码片段索引

| 片段 | 文件 | 行号 |
|------|------|------|
| opencode PgUp/PgDn | `packages/opencode/src/cli/cmd/tui/ui/dialog-select.tsx` | 195-204 |
| opencode AI 命名 | `packages/opencode/src/session/prompt.ts` | 193-219 |
| opencode isDefaultTitle | `packages/opencode/src/session/session.ts` | 615+ |
| kimi-code 3 行卡片 | `apps/kimi-code/src/tui/components/dialogs/session-picker.ts` | 90-172 |
| kimi-code 安全脱敏 | `packages/agent-core/src/session/prompt-metadata.ts` | 43-58 |
| kimi-code 防重复命名 | `packages/agent-core/src/session/rpc.ts` | 216-251 |
| claude-code AI 命名 prompt | `src/utils/sessionTitle.ts` | 56-129 |
| claude-code 标题优先级 | `src/utils/log.ts` | 30-58 |
| claude-code 多层 ESC | `src/components/LogSelector.tsx` | 821-866 |
