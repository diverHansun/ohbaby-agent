# 1. 问题基线与当前实施状态

> 时间口径：规划时分支 `temp/connect-reasoning-errors-improve-1`，HEAD `5b930cde`。分析对象是当时工作区的 Web composer，不是目标态。

---

## 1.1 问题陈述

1. **主操作位没有互斥。** `Composer` 在 `isRunning` 时额外挂 `.ohb-stop-button`，`.ohb-send-button` 始终存在。空草稿时 Send 因 `draft.trim().length === 0` 被 disable，用户看到「灰 Send + 活 Stop」。
2. **两件独立能力被画成两颗常驻按钮。** `canSend` 在 live 时为真（running 仍可入队）；`canStop` 在 live + running + 有 session 时为真。数据层拆开是对的，展示层没有「没动作就退场」的规则。
3. **思考强度占 footer，和 Stop 抢输入框宽度。** `ReasoningControl` 在 `.ohb-composer-tools`，靠 `margin-left: auto` 推 hint。用户要把 Stop 腾出的槽给档位，而不是再并排一颗主按钮。
4. **Web 用文案教常识操作。** Thinking 行写 `double click esc to interrupt`，footer hint 写 `enter to send` / `double click esc to stop`。有了可见 Stop 之后，这些是重复说明书。TUI 没有这颗按钮，同样的 Esc 提示不能删。
5. **权威 UI 文档已经过时，且和代码不完全一致。** `components.md` 写 running 显示 Stop、idle 显示 Send，没写两颗并排；代码却是 Stop **加在** Send 旁边。`states.md` 仍要求 Thinking 行带 esc 文案。

## 1.2 已确认的产品/技术分界

引用 00：本轮只改 **ohbaby-web 展示层**。发送、入队、`abortSession`、双击 Esc 的行为保持。TUI 零改动。`canSend` / `canStop` 继续做 disabled 数据，不做挂载数据。

---

## 1.3 ohbaby-web 现状

### 1.3.1 goals-duty

`docs/ohbaby-web/goals-duty.md` D3 要求会话交互含「发 prompt」和「中断 run」，没有规定必须两颗按钮。Non-duty 仍是：web 不持有独立事实源。本轮不把中断语义改进 store/client。

Gap：职责成立，chrome 把两个动作同时画出来，制造偶然复杂度。

### 1.3.2 architecture

composer 整段在 `apps/ohbaby-web/src/ui/App.tsx` 的 `Composer`（约 L2397）。主按钮、思考强度、hint、队列编辑都挤在这一个函数里。`App.tsx` 已是神文件，但本轮再抽 `ActionSlot` 是 YAGNI。可逆改动：改渲染互斥和 CSS，不改 SDK、store、daemon。

思考强度 `ReasoningControl`（约 L2199）已是独立函数，搬家成本低：从 `.ohb-composer-tools` 挪到 `.ohb-composer-input`。

### 1.3.3 data-model

`ComposerModel`（`apps/ohbaby-web/src/ui/selectors.ts` L34–45）字段：

| 字段 | 实际含义 | 是否被 UI 误用 |
|------|----------|----------------|
| `canSend` | `connectionState === "live"` | 否。Composer 再叠草稿非空、`!isSubmitting`、`!isPromptAdmitting` |
| `canStop` | live + running/等权限 + 有 session | 否。Stop 按钮 `disabled={!canStop}` |
| `isRunning` | `running` 或 `waiting-for-permission` | **是**。用它**挂载** Stop，而不是只决定主槽变脸 |
| `hint` | 连接态或 `enter to send` / `double click esc to stop` | footer 常驻渲染；连接态与 header 胶囊重复 |
| `disabled` | 非 live | textarea / mode / permission 共用 |

没有「主槽当前动作」这个派生字段。缺它不是数据模型错误，是视图没写互斥。

连接态与 run 快照独立更新：SSE 断开后 store 将 `connectionState` 改为 `reconnecting`，但保留最后一份 `view.snapshot`。因此可同时出现 `isRunning=true`、`canStop=false`。顶栏显示 `reconnecting`，流内 Thinking 仍基于旧快照；这不证明 run 此刻仍在执行。现有 Composer 在此状态挂灰 Stop 和灰 Send。单槽方案应保留灰 Stop 的动作外观，待 replay / resync 更新快照后再切换。

`hint` 被 `slashCommands.unit.test.ts` 的假 `ComposerModel` 填成 `""`，selectors 单测没有断言 hint 文案。

### 1.3.4 dfd-interface

发送：`Composer.send` → `onSubmit` → `submitText` → client prompt API。running 时 follow-up 进队列，不进对话（`App.unit.test.tsx`「keeps an active-run follow-up in the queue」）。

中断：`onStop`（`App.tsx` L902–910）→ `runtime.abortSession(sessionId, runId)`。键盘：textarea `Escape` 650ms 内连按两次（L2979–2986）。TUI 用 1500ms 窗口和 `Press Esc again to interrupt`（`packages/ohbaby-cli/src/tui/app.tsx` `ESC_INTERRUPT_HINT`）。

Admission：`isPromptAdmitting` = 当前 session 有尚未拿到 `userMessageId` 的 local attempt。此时 Send 上 `aria-busy` + `LoaderCircle`。run 起来之后 `isRunning` 为真，今天仍保留 busy Send **并且**再画 Stop。

本轮不改这条数据流，只改哪颗按钮可见。

### 1.3.5 use-case

| 用户在干什么 | 今天看到 | 问题 |
|--------------|----------|------|
| 空闲打字 | 一颗 Send | 无 |
| 发送瞬间 | 草稿空、Send 转圈 | 可接受 |
| run 已起、框空 | **Stop + 灰 Send** | 本议题痛点 |
| run 已起、再打字 | Stop + 亮 Send（入队） | 两颗都活着；产品上允许入队，但用户已否决双按钮 |
| 编辑队列 | Send 变 Save，running 时 Stop 仍在 | 双按钮；Esc 先放弃编辑，不中断 |
| 档位 | footer 白底 select | 占第二行，且比输入框里的 Stop 更宽 |

双击 Esc 在 Web 始终可用（只要 `canStop`），不依赖 Stop 是否渲染。去掉 Thinking 行文案不会拿掉能力。

### 1.3.6 non-functional

窄屏（`styles.css` L2992）把 `.ohb-send-button span` 和 `.ohb-stop-button span` `display: none`，变成两个并排图标，且 Stop/Send **没有 `aria-label`**（只靠可见文字 + title）。单槽后这个问题会减轻；两态切换时仍应给图标按钮补可访问名。

打字机 overlay `right: 106px`（桌面）、窄屏 `62px`，按「右侧只有 Send」留白。档位进框后若不改，空闲占位会和大脑重叠。

思考强度 error 气泡 `position: absolute; bottom: calc(100% + 8px)`，按 footer 往上浮写的。进输入框后可能被圆角裁切，实施时要看 overflow。

`prefers-reduced-motion`：现有 spinner 没有减动效分支；本轮不借机做动效系统。

### 1.3.7 test

现有覆盖偏发送路径，几乎不断言 Stop 的存在：

- `App.unit.test.tsx` 多处查 `.ohb-send-button` 的 `aria-busy`（首帧 admission、running follow-up 入队）。
- L1400 断言 Thinking 文案含 `double click esc to interrupt`。
- L3885 断言推理 `<select>` 在 `.ohb-composer-tools` 里。
- 无测试：「running + 空草稿时 DOM 里只有一颗主按钮」。
- TUI `app.contract.test.tsx` 大量断言 `Press Esc again to interrupt`；本轮必须保持绿，作为「TUI 不改」的回归网。

`docs/ohbaby-web/test.md` 写「Send 仅在 HTTP admission 期间旋转」。若按 00 在 Stop 已上场时拿掉 busy Send，这条规格过时。

仓库无项目级 `test-blueprint.md`。沿用 colocated vitest：`App.unit.test.tsx`、`selectors.unit.test.ts`、`styles.unit.test.ts`。

---

## 1.4 TUI 现状（明确不改）

`packages/ohbaby-cli/src/tui/app.tsx`：

- `ESC_INTERRUPT_WINDOW_MS = 1500`
- 第一次 Esc 把 runtime 标签换成 `Press Esc again to interrupt`
- 第二次 Esc 调 `abortRun`

TUI 没有 Web 那种实心 Stop。提示是中断的发现性来源。00 确认本轮零改动。01 记录以免实施时「统一文案」误伤 CLI。

---

## 1.5 跨模块一致性

| 面 | 一致？ | 说明 |
|----|--------|------|
| 中断 API | 是 | Web `abortSession`，TUI `abortRun`，都是打断当前 run |
| 双击 Esc | 窗口不同（Web 650ms / TUI 1500ms） | 本轮不统一 |
| 提示文案 | Web/TUI 本就不同句 | 本轮 Web 再减一档；不要为了对称去改 TUI |
| 档位语义 | Web `ReasoningControl` 刚按 2026-09-17 改过 | 搬家不得回退中文「推理默认」或检测中写字 |

## 1.6 改动影响面（现状视角）

会动到：

- `apps/ohbaby-web/src/ui/App.tsx`：`Composer` 按钮挂载、`ReasoningControl` 放置、`ThinkingIndicator` 文案、可能删除 `hint` 渲染。
- `apps/ohbaby-web/src/ui/selectors.ts`：可删 `hint` / `selectComposerHint`（若无其它读者）。
- `apps/ohbaby-web/src/ui/styles.css`：芯片无边框、typewriter `right`、footer 在 reasoning 搬走后的 `margin-left`。
- `apps/ohbaby-web/src/ui/App.unit.test.tsx`、`styles.unit.test.ts`、`slashCommands.unit.test.ts`（若删 `hint` 字段）。
- `docs/ohbaby-web/ui/components.md`、`states.md`、`test.md`。

不会动到：`ohbaby-sdk`、server、agent runtime、TUI 源码与契约测。

未超出单轮承载。无需 0.4 分轮。

## 1.7 SWE 原则审视摘要

- **偶然 vs 本质**（00 哲学）：本质是「运行中仍可排队 + 仍可中断」。偶然是空态死 Send 占槽、footer 再教一遍 Esc。
- **KISS / YAGNI**（03）：单槽互斥几行布尔值足够。不要 ActionSlot、不要为布局跳动预留幽灵宽度。
- **关注点分离**（02）：`canSend`/`canStop` 留在 selector；挂载规则留在 Composer。不要把「现在该画哪颗」塞进 ViewModel，除非测试读起来很痛。
- **代码为人读**：主槽规则用具名布尔（`stopVisible` / `sendHasWork`）写在 Composer 顶部，避免嵌套三元。
- **合理权衡**：running + 有草稿时中断发现性变弱（Stop 被 Send 换掉）。键盘焦点在 textarea 时仍可双击 Esc；清空草稿后 Stop 回来。Stop 隐藏时其 `title` 不可见，触屏用户必须先清空草稿。这是用户确认的单槽代价。
- **文档漂移**：`components.md` 的「动作按钮」段描述的是互斥变脸，代码却是并排。先让代码回到文档的互斥意图，再把文档改成「槽位规则 + 档位芯片」。

## 1.8 与既有文档关系

| 文档 | 角色 | gap |
|------|------|-----|
| `docs/ohbaby-web/ui/components.md` §2–3 | 权威 UI 规格 | Thinking 带 esc；footer 右侧 hint；动作按钮未写 Save/入队/灰 Send 并排 |
| `docs/ohbaby-web/ui/states.md` §2 | 运行态可视 | 要求 composer 显示 Stop，未处理「有草稿时主槽是 Send」 |
| `docs/ohbaby-web/test.md` | Web 测试规格 | admission 旋转规则过时 |
| `docs/ohbaby-web/ui/slash-commands/README.md` | slash 时 composer 尺寸稳定 | 档位芯片宽度变化可能影响输入区；实施时勿反向撑破 max-width |
| 2026-09-17 connect-reasoning-errors | 档位 UX | 本轮不得改语义，只改位置与 chrome |

02 必须逐条回应：单槽互斥、芯片搬家、Web 文案减、TUI 不动、权威文档同步。
