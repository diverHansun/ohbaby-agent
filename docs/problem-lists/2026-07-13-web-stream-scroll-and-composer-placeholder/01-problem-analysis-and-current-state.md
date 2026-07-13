# 1. 问题基线与当前实施状态

> 时间口径：2026-07-13，分析时工作区为 `ohbaby-agent` 当前分支；本议题**尚未实施**。基线以 `apps/ohbaby-web/src/ui/App.tsx` 与相关样式/测试为准。

---

## 1.1 问题陈述

1. **流式输出不跟滚**：agent 正在流式写消息时，用户必须手动滚轮才能看到最新内容。
2. **半截自动滚逻辑失效**：已有 `scrollTop = scrollHeight` 代码，但依赖不足以覆盖流式内容增长。
3. **无用户意图感知**：即便修好依赖，也会与用户上滚阅读历史抢控制权；当前也没有 stick / unpin 状态机。
4. **占位文案陈旧**：idle 默认 `"Message ohbaby..."`，品牌感与产品语气弱。
5. **原生 placeholder 无法做打字机**：`textarea[placeholder]` 是静态字符串，不能逐字动画；需要自定义 overlay。
6. **IME 组字 Enter 被当成发送**：中文等输入法组字时，Enter 本意是确认候选上屏，却触发 `send()` / slash 执行，并 `preventDefault` 打断 IME。

## 1.2 已确认的产品/技术分界

引用 `00-discussion.md`：

- UI-only；不改 daemon 事件流。
- Stick-to-bottom + 用户上滚暂停 + 回底恢复。
- 打字机仅 idle 空框未聚焦；运行中/不可用态静态文案。
- IME 组字中 Enter 不发送、不抢事件；非组字 Enter 仍发送。

```text
[.ohb-stream 滚动容器]
   ↑ stick? ──yes──> 贴底
   │
   └─ user scroll up past threshold ──> stick=false（滚轮畅通）
   └─ user near bottom again ──────────> stick=true

[composer]
  draft empty && !focused ──> TypewriterOverlay 可见
  focused || draft non-empty ──> Overlay 隐藏；原生 placeholder 仅用于 disabled/running
  keydown Enter + isComposing ──> 放行（不上送）
  keydown Enter + !isComposing ──> send / slash（现语义）
```

## 1.3 ohbaby-web ConversationStream 现状

### 1.3.1 goals-duty

`ConversationStream`（`App.tsx`）负责渲染当前 session 可见消息、pending prompt、command notices、thinking indicator，并试图在内容变化时滚到底。

**职责缺口**：它假设「条数变化 ≈ 需要贴底」，忽略了「同条消息文本增长」这一主路径。

### 1.3.2 architecture

滚动容器是 `.ohb-stream`（`styles.css`：`flex: 1; min-height: 0; overflow-y: auto`）。Composer 绝对/固定停靠底部，stream 单独滚动——该布局契约已有 `styles.unit.test.ts` 断言，本批应保留。

自动滚实现内嵌在组件 `useEffect` 内，无独立 helper，也无 scroll 事件监听。

### 1.3.3 data-model

跟滚相关的**运行时状态**当前不存在：

| 应有状态 | 现状 |
|----------|------|
| `stickToBottom: boolean` | 无 |
| near-bottom 判定 | 无 |
| 内容高度订阅 | 无（仅 React deps） |

消息数据来自 `ViewModel.activeSession.messages`；流式时 `status === "streaming"`，文本经 `eventReducer.applyMessageDelta` 累加，**message id / 数组 length 常不变**。

### 1.3.4 dfd-interface

```text
SSE message.part.delta
  → eventReducer.applyMessageDelta（同 id 更新 parts.text）
  → store snapshot
  → selectViewModel
  → ConversationStream re-render
  → useEffect deps: [messages.length, pendingPrompt, isRunning]
       ✗ length 不变 → 不贴底
```

根因链路：**delta 更新触发了 re-render，但没有触发 scroll effect 的有效依赖，也没有 ResizeObserver。**

代码锚点：

```1288:1293:apps/ohbaby-web/src/ui/App.tsx
  useEffect(() => {
    const element = streamRef.current;
    if (element) {
      element.scrollTop = element.scrollHeight;
    }
  }, [messages.length, props.pendingPrompt, props.view.composer.isRunning]);
```

```513:541:apps/ohbaby-web/src/api/daemon/eventReducer.ts
function applyMessageDelta(...) {
  // 同 messageId 就地更新 parts，数组 length 通常不变
}
```

### 1.3.5 use-case

| 场景 | 期望 | 现状 |
|------|------|------|
| 用户在底部，agent 流式输出 | 自动跟到底 | 不跟 |
| 用户上滚看历史，同时 agent 继续输出 | 保持用户位置，不抢滚轮 | 当前也不跟（碰巧「不抢」），但修好 deps 后若无 stick 会抢 |
| 用户滚回底部 | 恢复跟滚 | 无状态机 |
| 切换 session | 贴底显示该会话 | 依赖 length 变化，多数情况会贴一次，但不保证内容完全布局后的高度 |
| 发送 prompt / pending 出现 | 看到自己的消息与后续 | `pendingPrompt` 在 deps 中，部分覆盖 |

### 1.3.6 non-functional

- 流式高频 re-render 下，`scrollTop` 赋值应廉价；应避免每 delta 强制 layout thrash 以外的重逻辑。
- 不引入会阻止 `wheel` 默认行为的 listener（`preventDefault` 禁止用于「跟滚」）。
- `prefers-reduced-motion`：跟滚是位置同步不是装饰动画，可保持即时贴底；打字机需降级为静态首句或瞬时切换（见 02）。

### 1.3.7 test

- `App.unit.test.tsx`：大量 UI 行为，**无** ConversationStream 滚动断言。
- `styles.unit.test.ts`：断言 `.ohb-stream` 为唯一对话滚动区，本批不得破坏。
- `eventReducer.unit.test.ts`：覆盖 streaming delta 累加——证明「length 不变、内容变」是常态。

**测试缺口**：没有「stick / unpin / 回底恢复」行为测试；没有流式内容增长触发贴底的回归网。

## 1.4 ohbaby-web Composer 占位现状

### 1.4.1 goals-duty

Composer 提示用户可输入什么；`composerPlaceholder(view)` 按 disabled / running / idle 返回字符串。

### 1.4.2 architecture

```2550:2565:apps/ohbaby-web/src/ui/App.tsx
        <textarea
          ...
          placeholder={composerPlaceholder(props.view)}
          ...
          value={draft}
        />
```

```3723:3731:apps/ohbaby-web/src/ui/App.tsx
function composerPlaceholder(view: ViewModel): string {
  if (view.composer.disabled) {
    return "daemon unavailable";
  }
  if (view.composer.isRunning) {
    return "run in progress";
  }
  return "Message ohbaby...";
}
```

`.ohb-composer-input` 已是 `position: relative`（`styles.css`），适合放绝对定位 overlay，无需改整体 layout。

### 1.4.3 data-model

- `draft` 已在 Composer 本地 state。
- **缺少** `focused: boolean`（可用 `onFocus`/`onBlur` 局部 state，不必进 ViewModel）。
- **缺少** 打字机帧状态（当前字符索引、当前句索引）；应留在 overlay 组件内部。

### 1.4.4 dfd-interface

```text
view.composer.disabled / isRunning / idle
  → composerPlaceholder(string)
  → textarea.placeholder（浏览器绘制）
```

要接入打字机，idle 路径应变为：

```text
idle && empty && !focused → TypewriterOverlay（pointer-events: none）
idle && (focused || non-empty) → 无 overlay；textarea 无/空 placeholder
disabled|running → 原生 placeholder 静态文案（或同等静态 overlay）
```

### 1.4.5 use-case

| 场景 | 期望 | 现状 |
|------|------|------|
| 空闲空框未聚焦 | 打字机轮播新文案 | 静态 `Message ohbaby...` |
| 点击聚焦 | 立即隐藏动效 | n/a |
| 输入任意字符 | 隐藏 | 原生 placeholder 自动隐藏（但文案旧） |
| run in progress | 静态提示 | 已有 |
| daemon unavailable | 静态提示 | 已有 |

### 1.4.6 non-functional

- Overlay 必须 `pointer-events: none`，不能挡住 textarea 点击聚焦。
- 动画计时器在隐藏时应清理，避免泄漏与后台 setState。
- `prefers-reduced-motion: reduce` 时显示完整首句静态文案，不逐字动画。
- 文案与现有 mono 字体（IBM Plex Mono）对齐，避免换用另一套 display 字体造成视觉噪声。

### 1.4.7 test

- 现有测试可能断言 `"Message ohbaby..."`——实施时需检索并更新。
- 无 focus/blur 占位切换测试。

## 1.5 Composer IME / Enter 发送现状

### 1.5.1 goals-duty

Composer `onKeyDown` 负责：slash 导航、Enter 发送、Esc 停跑/取消队列编辑、Shift+Tab 切 mode。应在「真正要提交用户意图」时才发送；**IME 确认候选不是发送意图**。

### 1.5.2 architecture / dfd

```text
用户按 Enter（中文输入法组字中）
  → textarea keydown
  → onKeyDown: key==="Enter" && !shiftKey
  → preventDefault() + send()     ← 错误抢走 IME
  ✗ 候选未上屏 / 误发空或半截消息
```

代码锚点：

```2416:2430:apps/ohbaby-web/src/ui/App.tsx
        if (event.key === "Enter" && !event.shiftKey) {
          event.preventDefault();
          runSlashCommand(selectedCommand);
          return;
        }
        // ...
      if (event.key === "Enter" && !event.shiftKey) {
        event.preventDefault();
        send();
        return;
      }
```

两处均未检查 `event.nativeEvent.isComposing` 或 `keyCode === 229`。

### 1.5.3 use-case

| 场景 | 期望 | 现状 |
|------|------|------|
| 中文 IME 组字中 Enter 确认 `hello` 上屏 | 文字进入 draft，不发送 | 触发 send / 打断上屏 |
| 组字结束后再 Enter | 发送 | 发送（正确） |
| Slash 打开 + 组字中 Enter | 先上屏，不执行 slash | 可能执行 slash |
| 英文直接输入（无 IME）Enter | 发送 | 发送（正确） |

### 1.5.4 test

- `pressTextareaKey` 只派发普通 `KeyboardEvent`，**从不设置 `isComposing`**。
- 无「组字中 Enter 不调用 submitPrompt」回归。

## 1.6 跨模块一致性

| 点 | 结论 |
|----|------|
| eventReducer streaming | 正确；UI 未消费「内容变更」信号做滚动 |
| TUI | 本批不动；行为可日后对齐但不阻塞 |
| Queue / pending prompt | 会改变 stream 高度；跟滚方案必须观察内容高度而非仅 message length |
| IME | 纯前端 keydown 契约；与协议无关 |

## 1.7 改动影响面（现状视角）

| 区域 | 可能触及 |
|------|----------|
| `apps/ohbaby-web/src/ui/App.tsx` | `ConversationStream`、Composer textarea、`composerPlaceholder`、**Composer `onKeyDown` IME 守卫** |
| 可能新增 `apps/ohbaby-web/src/ui/streamScroll.ts` 或同级 helper | near-bottom / stick 纯函数，便于单测 |
| 可能新增 `TypewriterPlaceholder.tsx`（或同文件小组件） | 打字机 UI |
| 可选小 helper `isImeComposing(event)` | 便于单测与两处 Enter 共用 |
| `apps/ohbaby-web/src/ui/styles.css` | overlay、光标闪烁、reduced-motion |
| `App.unit.test.tsx` / `styles.unit.test.ts` | 行为与样式契约；IME Enter 用例 |
| **不改** | `eventReducer.ts`、daemon client、TUI |

## 1.8 SWE 原则审视摘要

- **偶然复杂度**：跟滚失败来自错误 deps；IME 误发送来自忽略浏览器已提供的 composing 信号——都是 UI 契约缺口，不是协议缺陷。
- **YAGNI**：不做 Jump-to-latest 按钮、不做虚拟列表；stick 布尔 + 阈值足够；IME 只加守卫，不重做快捷键系统。
- **信息隐藏**：near-bottom 与 `isImeComposing` 应收进小 helper，避免 `App.tsx` 魔法散落。
- **可读性**：打字机逻辑不要内联进巨大 Composer 函数；小组件 + CSS 即可。
- **可逆性**：纯前端，回滚成本低；无数据迁移。

## 1.9 与既有文档关系

本议题不 supersede 导航 / 并发 problem-list。仅补充 Web 对话阅读、空态引导与输入法友好性的交互缺口。若 `docs/ohbaby-web` 有「composer placeholder 文案」描述，实施后应顺手改成新文案（非本批阻塞）。
