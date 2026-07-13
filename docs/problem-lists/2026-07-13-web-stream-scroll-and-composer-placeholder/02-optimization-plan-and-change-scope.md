# 2. 优化方案与改动面

> 本文是后续**实施会话**的执行契约。规划会话不写代码。

---

## 2.1 方案总览

三处纵切，建议顺序 **Phase A → Phase B → Phase C**（跟滚是阅读正确性；占位是体验抛光；IME 是输入正确性）。B 与 C 都改 Composer，可同 commit，但 DoD 分开。

```text
Phase A: Stick-to-bottom
  ConversationStream
    + stickToBottom ref/state
    + onScroll → 更新 stick
    + ResizeObserver(stream-inner) + layout effect → stick 时贴底
    + session/prompt 边界重置 stick=true

Phase B: Typewriter idle placeholder
  ComposerInput
    + focused state
    + idle 空未聚焦 → TypewriterPlaceholder overlay
    + disabled/running → 原生静态 placeholder
    + prefers-reduced-motion 降级

Phase C: IME Enter guard
  Composer onKeyDown
    + isComposing / keyCode 229 → early return（不 send / 不 slash / 不 preventDefault）
    + 非组字 Enter 语义不变
```

## 2.2 设计决策表

| 决策项 | 选择 | 理由 | 放弃的选项 | 代价 |
|--------|------|------|------------|------|
| 跟滚触发源 | `ResizeObserver` + 关键 React deps | 覆盖 delta 文本、markdown 重排、thinking/pending 出现 | 只扩 deps 到「最后一条 text length」 | 需 observer 清理 |
| 用户打断 | scroll 事件算 near-bottom | 不拦截 wheel；符合 00 | `wheel` 上一律 unpin（触控板惯性误伤多） | 需统一阈值 |
| near-bottom | `80px` | 与常见 chat UI 接近；可常量抽出 | 0px 严格底 | 大字号下偶发误判，可调 |
| stick 存储 | `useRef` 为主 + 必要时 state | 贴底本身不需要驱动额外 paint | 每 delta setState stick | 少一次 render 风暴 |
| 打字机载体 | overlay `span`，`pointer-events: none` | 原生 placeholder 无法动画 | contenteditable / 假输入框 | 需同步字体 metrics |
| 触发条件 | empty && !focused | 用户已确认标准做法 | hover 触发 | — |
| 文案 | `Ask Lychee anything…` / `Describe the change you want…` / `Plan the next step…` | 用户终审冻结 | 单句循环；旧 `Ask ohbaby…` | — |
| reduced-motion | 静态显示首句 | 尊重系统设置 | 完全去掉占位 | — |
| IME Enter | `isComposing \|\| keyCode===229` 则跳过发送/slash | 浏览器标准 + 兼容兜底 | 只听 `compositionend` 再发 | 需单测 mock composing |

## 2.3 分阶段实施

### Phase A — Stick-to-bottom 跟滚

**目标**：流式输出时默认贴底；用户上滚后不抢控制权；回底后恢复。

**建议改动文件**：

| 文件 | 动作 |
|------|------|
| `apps/ohbaby-web/src/ui/streamScroll.ts`（新建，名称可微调） | `isNearBottom(el, threshold)`、`scrollToBottom(el)` 纯函数 |
| `apps/ohbaby-web/src/ui/streamScroll.unit.test.ts`（新建） | 阈值边界单测（mock element metrics） |
| `apps/ohbaby-web/src/ui/App.tsx` | 重写 `ConversationStream` 滚动逻辑 |
| `apps/ohbaby-web/src/ui/App.unit.test.tsx` | 增加 stick / unpin 行为测（jsdom mock scroll metrics） |

**`ConversationStream` 行为契约**：

1. 挂载 / `activeSessionId` 变化 → `stickToBottom = true`，贴底。
2. `pendingPrompt` 出现、`isRunning` 翻转、消息内容高度变化 → 若 stick，则贴底。
3. `onScroll`：若 `isNearBottom` → stick=true；否则 stick=false。
4. **禁止**在 wheel/touch 上 `preventDefault`。
5. 贴底用 `element.scrollTop = element.scrollHeight`（与现网一致）；不要强上 `scroll-behavior: smooth`（流式会抖）。

**内容观察推荐实现**：

```text
streamRef → .ohb-stream
innerRef  → .ohb-stream-inner
ResizeObserver(inner) → scheduleStickScroll()
useLayoutEffect([sessionId, pendingPrompt, isRunning, messagesSignature?]) → scheduleStickScroll()
```

`messagesSignature` 可选：例如 `lastMessageId + lastTextLength + messages.length`，作为 ResizeObserver 的补充，防止某些环境下 observer 时序问题。二者都要在 stick=false 时 no-op。

**DoD（Phase A）**：

- [ ] 流式 delta 增长时，处于底部的视图持续贴底。
- [ ] 手动上滚后，后续 delta **不**强制拉回底部。
- [ ] 再滚回阈值内后，后续增长再次贴底。
- [ ] 切换 session / 发送后出现 pending 时会贴底。
- [ ] `styles.unit.test.ts` 中 stream 滚动契约仍绿。
- [ ] 新增 unit 覆盖 near-bottom 与 stick 状态转换。

### Phase B — Composer 打字机占位

**目标**：替换 idle 文案；空且未聚焦时打字机；聚焦或有字隐藏。

**建议改动文件**：

| 文件 | 动作 |
|------|------|
| `apps/ohbaby-web/src/ui/TypewriterPlaceholder.tsx`（新建） | 轮播打字/删除；接收 `active: boolean` + `phrases` |
| `apps/ohbaby-web/src/ui/TypewriterPlaceholder.unit.test.tsx`（新建） | fake timers：打出、暂停、`active=false` 停止 |
| `apps/ohbaby-web/src/ui/App.tsx` | Composer：`focused` state；idle 空未聚焦渲染 overlay；调整 `composerPlaceholder` |
| `apps/ohbaby-web/src/ui/styles.css` | `.ohb-composer-typewriter`、光标闪烁、`prefers-reduced-motion` |
| `apps/ohbaby-web/src/ui/App.unit.test.tsx` | 断言旧文案消失；focus 后 overlay 移除；reduced-motion 可测 CSS 或组件 prop |
| `apps/ohbaby-web/src/ui/styles.unit.test.ts` | 可选：断言 typewriter 相关 class 存在 |

**`composerPlaceholder` 调整**：

| 状态 | placeholder 属性 | Overlay |
|------|------------------|---------|
| disabled | `daemon unavailable` | 无 |
| running | `run in progress` | 无 |
| idle + empty + !focused | `""`（空，避免双重文案） | Typewriter 可见 |
| idle + focused 或非空 | `""` | 无 |

**打字机参数（实施默认，可微调）**：

| 参数 | 默认 |
|------|------|
| 打字间隔 | 45–55ms / 字 |
| 打完停顿 | 1400ms |
| 删除间隔 | 28–35ms / 字 |
| 删完切换停顿 | 400ms |
| 光标 | 细竖线闪烁，与 mono 文本同行 |

**DoD（Phase B）**：

- [ ] 页面上不再出现 `Message ohbaby...`。
- [ ] 空闲空框未聚焦可见打字机轮播：`Ask Lychee anything…` → `Describe the change you want…` → `Plan the next step…`。
- [ ] focus 或输入后立即消失；blur 且仍空则恢复。
- [ ] running/disabled 仍显示静态原生 placeholder。
- [ ] `prefers-reduced-motion: reduce` 下不逐字动画。
- [ ] overlay 不阻挡点击聚焦 textarea。

### Phase C — IME 组字 Enter 守卫

**目标**：IME 组字中按 Enter 只确认候选上屏，不发送消息、不执行 slash；非组字行为不变。

**建议改动文件**：

| 文件 | 动作 |
|------|------|
| `apps/ohbaby-web/src/ui/ime.ts`（新建，名称可微调）或内联小函数 | `isImeComposing(event): boolean` → `nativeEvent.isComposing \|\| keyCode === 229` |
| `apps/ohbaby-web/src/ui/ime.unit.test.ts`（若抽 helper） | 组字 / 非组字 / 229 兜底 |
| `apps/ohbaby-web/src/ui/App.tsx` | Composer `onKeyDown`：在 Enter 发送与 slash Enter 分支前 early-return；**组字时不得 `preventDefault`** |
| `apps/ohbaby-web/src/ui/App.unit.test.tsx` | `isComposing: true` 的 Enter **不**调用 `submitPrompt`；普通 Enter 仍发送；slash + composing 不执行 |

**行为契约**：

```ts
// 伪代码 — 实施时落在 onKeyDown 顶部或 Enter 分支前
if (isImeComposing(event)) {
  return; // 不 preventDefault，不 send，不 runSlash
}
```

1. 普通 Enter（未组字、无 Shift）→ 仍 `preventDefault` + `send()`。
2. Slash 打开 + Enter（未组字）→ 仍执行 slash。
3. 组字中 Enter → 上述两路径都不走。
4. 最低要求覆盖两条 Enter 路径；若 slash 的 Arrow/Tab 在组字中也会误伤 IME，可对会 `preventDefault` 的键同样 early-return（推荐，但不阻塞只先修 Enter）。

**DoD（Phase C）**：

- [ ] `isComposing: true` 时 Enter 不触发 `submitPrompt` / slash run。
- [ ] 组字路径无 `preventDefault`（可用 spy 或行为测：handler return 前未调用）。
- [ ] 非组字 Enter 发送回归仍绿。
- [ ] 手工：中文输入法下键入英文候选，Enter 上屏进框且不发送；再 Enter 才发送。

## 2.4 按包/目录的改动面

| 包/目录 | 新增 | 修改 | 删除 | 说明 |
|---------|------|------|------|------|
| `apps/ohbaby-web/src/ui/` | `streamScroll.ts`、`TypewriterPlaceholder.tsx`、可选 `ime.ts` + 对应 `*.unit.test.*` | `App.tsx`、`styles.css`、既有 unit tests | 无 | 纯 UI |
| `apps/ohbaby-web/src/api/` | — | — | — | 明确不改 |
| `packages/ohbaby-cli` | — | — | — | 不改 TUI |

## 2.5 API / 协议 / 迁移与兼容

- **无** REST/SSE/DB 变更。
- **无** 持久化设置（stick 状态仅会话内内存）。
- 文案硬编码；不引入 i18n。

## 2.6 风险与回滚

| 风险 | 缓解 | 回滚 |
|------|------|------|
| jsdom 难以真实滚动 | helper 单测 + 手工/Playwright 抽检 | 单 revert UI commit |
| ResizeObserver + effect 双触发抖动 | stick 时赋值幂等；rAF 合并贴底 | 去掉 observer，仅 signature deps |
| 打字机与 slash palette / completion suffix 叠字 | overlay 只覆盖 textarea 文本区；z-index 低于 palette | 降级为静态新文案 |
| 触控板惯性触发多次 scroll 误 unpin | near-bottom 阈值 80px；回底可恢复 | 调大阈值 |
| 仅查 `isComposing` 漏部分浏览器 | 同时兜底 `keyCode === 229` | — |
| 组字结束瞬间二次 Enter | 标准行为：第一次上屏，第二次发送；单测分两事件 | — |
| App.tsx 更大 | 新逻辑进小组件/helper | — |

## 2.7 与 00 边界对齐检查

| 00 结论 | 02 落点 |
|---------|---------|
| 默认跟滚 | Phase A stick=true 贴底 |
| 不阻止滚轮 | 无 preventDefault；仅读 scrollTop |
| 未聚焦打字机 | Phase B `!focused && empty` |
| 新文案三句（含 Lychee） | Typewriter phrases 常量按 00 |
| IME 组字 Enter 不发送 | Phase C `isImeComposing` 守卫 |
| 本批不做 Jump | §2.8 与 00/README Out of scope 一致 |
| 不改 daemon/TUI | 改动面表已排除 |

## 2.8 不在本批

- **Jump to latest 悬浮按钮**（明确不做）。
- 虚拟列表、消息分页。
- TUI 对齐（含 TUI IME）。
- 占位多语言框架。
- 改 `eventReducer` 或流式协议。
- 改变非组字时 Enter=发送 的产品约定。
