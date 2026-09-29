# Pi 最终审查原文（修复前）

> `opencode/claude-opus-5-5`，medium；同一 Pi 会话承接计划审查。下文保留原回复，意见随后核实并修复，最终结论见 improve-4.1/05。截图已按用户要求删除，临时路径不是最终制品链接。

我读了 4.1 的 diff、Web 的 session/conversation/commands 源码和 CSS，并查看了 `/tmp/ohbaby-improve41-visual/` 下的全部截图；没有改文件，也没有启动服务。

**结论：** 4.1 已确认的几项在代码层面都落实了：
- 健康切换不再显示 Recovering：`use-session-sync-banner.ts` 去掉了"已有 view 就算恢复"的判断，慢加载改为 Loading 占位；后端 `getRecoveryState` 只在真有待补保存或进入失败时才返回 recovering。
- Bash 行不再显示 ⚠，旧工具不再显示阶段缺失说明。
- 子会话向下箭头及其样式已清理干净。
- skill 改为 prompt 被接受即结束命令。

但有一张最终截图直接证明了一个可见回归，需要改。此外还有几处小的排版和可访问性问题。

## 必须改

**1. 正常 Stop 后页面顶部出现红色 "user-stop · Dismiss" 横幅（截图证实）**
- 证据：`final-skill-normal-stop.png` 拍摄于 13:16，晚于 HEAD 提交时间 13:02。截图中没有任何真实错误，却有红底横幅，文字是内部原因码 `user-stop`。这违反"正常 Stop 不是 error"，也是典型的系统自说自话。
- 根因：`SessionScreen.tsx:252-289` 的 `selectPersistedPromptError` 把最新一条 `interrupted` 的 prompt 当作错误显示，文案用的是 `error.message`。improve-4 把用户 Stop 从 cancelled 改成了 interrupted，并带上 reason `user-stop`，旧的过滤条件因此失效。
- 范围：截图是 skill 场景；这段代码对普通 prompt 同样成立（推断，未另拍）。
- 最小修复：
  - 在该函数里用 `latest.runId` 到 `view.snapshot.runs` 找对应 run；如果 `inputsCloseReason === "user-stop"`，直接返回 null。这与 `hasUnsentSteerAfterLatestStop` 用的是同一个事实，不需要改协议。
  - `service-shutdown` / `process-interrupted` 仍然提示，但文案固定为 "Prompt was interrupted."，不要直接显示内部原因码。
- 另请核对 TUI：`app.tsx` 的 `runtimeStatusLabel` 分支对 interrupted 会拼出 `error: ...`，需要确认用户 Stop 后是否也会显示 `error: user-stop`。我没有核实到。

**2. 输入框附近的命令错误可能被 composer 盖住（CSS 推断，缺浏览器证据）**
- 现状：`SessionScreen.tsx:~1085-1102` 新增的 `ErrorBanner`（commandInputError）和错误类 `CommandNoticeList` 放在 `.ohb-root-composer {display: contents}` 里，按正常文档流排在 composer 前面。
- 而主布局下的 composer 是 `position: absolute; bottom: 0; z-index: 30`（`conversation-layout.css:37-45`、`subagents.css:8`）。流式布局里这两个元素会落到列底部，正好被 composer 盖住。
- 所有截图里都没有这个状态，请先在浏览器里用一个错误 slash（例如未知命令）确认一次。
- 最小修复：把这两者作为 `Composer` 已有的 `topContent` 传进去，和 unsent-steer、队列放在同一个位置。不需要新增 CSS 定位。

**3. 命令通知新增的关闭按钮没有样式，也没有可访问名称**
- 现状：`CommandResultModal.tsx:38-46` 的 `<button title=…><X/></button>`，而 `notices.css` 没有对应规则，会渲染成浏览器默认的带边框按钮，并独占一行。
- 建议：

```css
.ohb-command-notice { position: relative; }
.ohb-command-notice > button {
  position: absolute; top: 8px; right: 8px;
  width: 24px; height: 24px; display: grid; place-items: center;
  border: 0; border-radius: 6px; background: transparent;
  color: #9a9ea6; cursor: pointer;
}
.ohb-command-notice > button:hover { background: #f1f2f4; color: #5f636b; }
.ohb-command-notice .ohb-command-label { padding-right: 28px; }
```

- 同时补上 `aria-label="Dismiss command result"`。

**4. /status 里的长值被裁切（`stage4-status.png`）**
- 原因：`overlays.css:260` 的值列只设置了字体，没有 `min-width: 0`。flex 子项的默认最小宽度是内容宽度，连续的路径片段无法换行，就被 `.ohb-command-modal {overflow: hidden}` 裁掉了。
- 修复：

```css
.ohb-status-result > div > span:nth-child(2) {
  flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere;
}
```

- 窄屏（`overrides.css:164` 附近的媒体查询）：把列布局从只作用于 context 行扩展到全部行，即 `.ohb-status-result > div { flex-direction: column; align-items: flex-start; gap: 4px; }`，标签列宽改为 auto。
- 弹窗宽度改为 `width: min(560px, calc(100vw - 32px))`，避免 443px 宽时左右贴边。

**5. 只有工具结果的面板：可访问语义不一致（同意另一份审查）**
- 现状：`tool-card.tsx:114-140` 的 `OrphanToolResultCard` 已按执行结果把名称变红，但没有传 `abnormal`，所以折叠时 aria-label 只有标题。
- 修复：按 `ToolCard` 的相同规则计算 `abnormal`（`execution.outcome !== "success"`，或 `result.error` 存在），并传给 `ToolPanel`。⚠ 符号按当前规则只对 Bash 隐藏。

**6. Steer 提示迟到或残留（TUI 已实测；Web 同类，推断）**
- 05 已经记录 TUI 的问题。Web 的 `Composer.tsx:118-121,1037` 中，`onAccepted` 直接执行 `setSteerNotice(true)`，没有核对目标 run。如果 Stop 之后 ack 才到，会和 "Task stopped before your steer message was sent." 同时显示，直到下一次 run 变化。
- 最小修复（两端一致）：notice 记下 `expectedRunId`，只有在它等于当前 `activeRunId`、且没有 unsentSteer 时才渲染。不动 `steerAttempts`。

## 可延期或需用户决定

- **skill 用户气泡显示整份 SKILL 展开文本**（见 `stage4-skill-title-clean.png`、`final-skill-normal-stop.png`）。这是本轮截图里最大的视觉噪声，但不在已确认范围内。
  - 已有显示与模型输入分离的通道：`core/agents/runner.ts:93-95` 写入 `metadata.displayText`，`persistent-store.ts:162` 投影给 UI。
  - 让气泡显示 `/skill-name args` 不会改变发给模型的文本和 cache。但 live 投影的 userMessage 以及排队卡片、编辑用的 `prompt.text` 也要一起处理。
  - 建议作为下一小批，由用户确认后再做。
- `SessionSyncNotice` 的 recovering 状态仍用红色 error-banner 样式。它只在真实失败重试时出现，可以接受。
- 历史修复里 `changed` 的记账缺口、标题标点：同意另一份审查，列为非阻塞。

## 没有发现问题的部分

- Loading 占位（`layout.css:533` 起）绝对定位不会推动 composer，`ohb-app-content` 是 `position: relative`。
- Goal 业务错误与"结果未确认"能并存，位置在原面板内，读起来清楚。
- 子会话的小面板和展开视图在删掉按钮后没有留下空浮层。
- 分页滚动的截图与描述一致。

## 能否提交

第 1 项有截图直接证明，属于用户可见回归，必须在最后小修复批里处理。第 2 项请先用浏览器确认一次再改。第 3–6 项都是几行级别的改动。改完后建议补拍三张截图：正常 Stop、未知 slash 命令的错误、窄屏 /status。之后可以进入分批提交。
