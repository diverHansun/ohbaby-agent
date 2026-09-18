# 5. 实施验收文档

> 撰写时机：实施完成后，由 `plan-code-improvement` 验收模式独立检查后撰写。本会话不改产品代码。

## 5.1 元信息

| 项 | 值 |
|----|-----|
| 议题 / 轮次 | `docs/problem-lists/2026-09-18-web-composer-send-stop` · improve-1 |
| 规划文档版本 | 实施中修订过的 00–04（commit `c99d4370` 对齐计划；产品代码 `4a90a1c6`–`d0ce7faf`） |
| 实施范围 | `5b930cde`（`main`）…`d0ce7faf`（`codex/temp-web-composer-send-stop` HEAD） |
| 验收日期 | 2026-09-18 |
| 结论 | **通过。** 单槽主按钮、思考强度芯片、Web 文案减量与 TUI 保留均已落地；diff 无越界；自动化测试与 typecheck 绿。剩余是低优先级覆盖缺口（T11 无独立用例、T17 未做浏览器、若干 04 项断言偏弱）和 Stop `title` 未附带 Esc（00 允许不写）。 |

## 5.2 实施概况（对照 02）

| 02 条目 | 状态 | 实际实施摘要 | 证据 |
|---------|------|--------------|------|
| Stage 1 单槽主按钮 | 完成 | `showStop = isRunning && !queuedEdit && draft 为空`；if/else 只渲染 Stop 或 Send；`aria-label` 齐全；重连灰 Stop；入队后恢复 Stop | [`App.tsx`](../../../../apps/ohbaby-web/src/ui/App.tsx) `showStop`、主按钮块；[`App.unit.test.tsx`](../../../../apps/ohbaby-web/src/ui/App.unit.test.tsx) idle/running/follow-up/reconnect/permission |
| Stage 2 芯片进输入框 | 完成 | `ReasoningControl` 放在 textarea 容器与主按钮之间；select 透明无边、hover 浅灰边、focus-visible 蓝圈；typewriter 改到可裁切的 `.ohb-composer-text`；极窄屏档位 ellipsis | `App.tsx` 放置；[`styles.css`](../../../../apps/ohbaby-web/src/ui/styles.css) `.ohb-reasoning-control`、`.ohb-composer-text`、`max-width: 420px` |
| Stage 3 Web 文案 + 权威文档 | 完成 | 删除 `ComposerModel.hint` / `selectComposerHint`；Thinking 不再写 esc；footer 只在改队列时有 hint；`components.md` / `states.md` / `test.md` 已同步 | `selectors.ts`；`ThinkingIndicator`；文档三件 |
| 不抽 ActionSlot | 完成 | 无新组件 | diff 无 `ActionSlot` |
| 不改 `canSend`/`canStop` 含义 | 完成 | 仍只看 live / running+session | `selectors.ts` L102–108 |
| 不改 TUI | 完成 | `packages/ohbaby-cli` 不在 diff 内 | `git diff --name-status 5b930cde...HEAD` |

## 5.3 规划 vs 实际差异

| 维度 | 规划方案 | 实际实施 | 差异原因 | 影响评估 |
|------|----------|----------|----------|----------|
| 数据结构 | 可删 `hint` | **已删除** `ComposerModel.hint` 与 `selectComposerHint` | 与 02 首选一致 | 无；假 ViewModel 已去掉字段 |
| 数据流 | 发送/入队/`abortSession`/双击 Esc 不变 | 未改 client/runtime | — | 与规划一致 |
| 协议/接口 | 无 | 无 SDK/server 变更 | — | 与规划一致 |
| 主槽 DOM | 不要求同一节点 | Stop / Send 两个 `<button>` 互斥渲染 | 02 §2.1 已允许 | 无 |
| 具名布尔 | 02 建议 `sendHasWork` + `showStop` | 只写了 `showStop`，草稿是否非空内联判断 | 行为等价 | 可读性略偏契约，不阻塞 |
| 权威文档板式 | Stage 3「写下表板式」 | `components.md` / `states.md` 用散文写清规则，未贴 00 ASCII 表 | 形式未对齐 | 规格内容齐全 |
| Stop `title` | 「可」附带 double-click Esc | `title="Stop run"`，无 Esc | 00 是可选 | 有草稿时本就没有 Stop；空态靠按钮本身。不阻塞 |
| 焦点样式 | hover 浅灰细边；键盘焦点要清楚 | hover `border-color:#c6cfdd`；`:focus-visible` 为蓝描边+outline | Stage 2 明确允许清晰焦点 | 焦点比 hover 更重，合理 |
| 打字机留白 | 重算 `right` 或裁切 | 未再锁死 `right:106px`；文字放进 `min-width:0` 容器，`overflow:hidden` | 比改绝对 `right` 更贴 02 修订 | 无思考模型也不会留永久空位 |
| 文件/包 | `apps/ohbaby-web/src/ui` + 三份权威文档 + problem-list | 另含 problem-list 自身与 `slashCommands.unit.test.ts`（删 `hint`） | 02 已预告假模型 | 无越界 |
| 错误处理 | 气泡勿被裁 | `.ohb-composer-input` 无 `overflow:hidden`；气泡仍 absolute 上浮 | — | 未做浏览器确认（T17） |
| 依赖 | 无新依赖 | 无 | — | 与规划一致 |

无架构级单向门。未加载 `swe-architecture-design` 框架 4 的超时/幂等清单：本轮无新协议。

## 5.4 实施理由与注意事项

- 重连灰 Stop：实施中补进 00/02，代码与测试（`keeps the last-known stop action disabled while reconnecting/resyncing`）对齐。顶栏连接态仍是真相。
- 有草稿时 Stop 不在 DOM：双击 Esc 仍 abort（`keeps double Escape interruption available while a draft replaces Stop`）。触屏须清空草稿。00 已接受。
- `session-screen.dc.html` / `empty-state.dc.html` 仍写旧 hint。02 只要求改 `components.md` / `states.md` / `test.md`。那两份是冻结设计稿，不是运行时。以后改视觉参考时再清，避免和线上 UI 打架。
- `ThinkingIndicator.canInterrupt` 现在只用来决定要不要 `starting agent`，不再教 Esc。名字略旧，可以后再改，不是本轮缺口。

## 5.5 实施成果（对照 04）

### 5.5.1 验收项结果

本机命令（2026-09-18）：

```
pnpm exec vitest run apps/ohbaby-web/src/ui/App.unit.test.tsx \
  apps/ohbaby-web/src/ui/selectors.unit.test.ts \
  apps/ohbaby-web/src/ui/styles.unit.test.ts \
  apps/ohbaby-web/src/ui/slashCommands.unit.test.ts
# 4 files, 142 tests, pass

pnpm exec vitest run packages/ohbaby-cli/src/tui/app.contract.test.tsx
# 99 tests, pass

pnpm --filter ohbaby-web typecheck
# pass
```

| 验收 ID | 结果 | 证据 |
|---------|------|------|
| T1 idle 空草稿 | 通过 | `keeps one named Send action when idle…`：1 颗 disabled Send，无 Stop |
| T2 idle 有草稿 | 通过 | 同上，打字后 Send 可点 |
| T3 running 空草稿 | 通过 | follow-up 用例开头、permission 用例：仅 Stop |
| T4 running 有字 | 通过 | 打字后仅 Send |
| T5 首条 admission 转圈 | 通过（弱） | `commits the first prompt…` `aria-busy=true`；未再写「无 Stop」，实现上 `isRunning` 为假故走 Send 分支 |
| T6 running follow-up | 通过 | Enter 后仅 Stop、队列有文本，不再要求 busy Send |
| T7 编辑队列 | 通过 | running 快照下 Save、`ohb-queued-edit-hint`、Esc 不 abort |
| T8 identified 父节点 | 通过 | `closest(".ohb-composer-input")`，不在 tools |
| T9 detecting | 通过 | `.ohb-reasoning-detecting` 在 input 内，无「检测中/推理默认」；未再否定 tools（实现已不在 tools） |
| T10 unknown | 通过（弱） | `.ohb-reasoning-unknown` 在 input 内；打字后 textarea 可用；未直接断言 Send `disabled=false` |
| T11 `mode=none` | **未单独立测** | 代码仍 `identified && mode==="none"` → `return null`。无 `App.unit` 覆盖此分支 |
| T12 Thinking 无 esc | 通过 | `not.toContain("double click esc to interrupt")`；无 footer hint |
| T13 startup Thinking | 通过（弱） | `rebuilds a starting prompt…` 含 `starting agent`；未再断言无 esc，但该句已从组件删除 |
| T14 footer 无 enter/esc | 通过（弱） | running 投影用例 `.ohb-composer-hint` 为 null；未字面 `not.toContain("enter to send")` |
| T15 TUI Esc 提示 | 通过 | contract 99 绿；`ESC_INTERRUPT_HINT` 仍在 `app.tsx`；cli **零 diff** |
| T16 有草稿双击 Esc | 通过 | `keeps double Escape interruption…` 调用 `abortSession("session_1","run_1")` |
| T17 窄屏/hover 手工 | **本验收未跑浏览器** | CSS 已藏按钮文字、有 `aria-label`、420px ellipsis；`styles.unit.test.ts` 未锁芯片/窄屏规则 |
| T18 重连灰 Stop | 通过（弱） | `it.each reconnecting/resyncing`；idle 快照恢复后变 Send。**缺**「恢复 live 且仍 running → Stop 可点」 |
| T19 有草稿断线 | 通过 | draft 保留、textarea/Send disabled；live 后可入队 |
| T20 waiting-for-permission | 通过（弱） | `shows Stop while a run waits for permission`；未断言 Stop 的 `disabled` 与 `canStop` |

**回归：** Enter/队列/mode-policy footer / header 五态 / TUI 双击 Esc 契约均未在本 diff 破坏。`styles.unit.test.ts` 仍断言 typewriter `pointer-events: none`。

**对抗性：** T6 没有为保旧断言留下第二颗按钮。queued-edit 在 running 下 Esc 不 abort。admission+running 空草稿走 Stop。无思考模型不靠幽灵 `right` 留白。Web 源码已无 `double click esc` / `enter to send`。

**残余风险：** 有草稿时中断发现性弱（00 接受）。T11 缺测：若有人改 `mode==="none"` 提前 return，CI 可能看不见。T17 未做 320/375/720 目视。T18 未覆盖「重连结束仍 running」。越界扫描确认 `packages/ohbaby-cli` 零 diff，无 `ActionSlot` / Queue / 暂停。

### 5.5.2 SWE 层面评估（聚焦改动面）

改动把「没动作的灰 Send」这种偶然复杂度拿掉了，没有用新抽象换旧问题。`showStop` 一眼能读；`canSend`/`canStop` 仍是数据，挂载在 Composer。hint 字段删干净，没有「留着不用」的死状态。

| 发现 | 严重性 | SWE 依据 | 建议 |
|------|--------|----------|------|
| 单槽用 if/else 两颗按钮而非 ActionSlot | 正面 | KISS / YAGNI（03） | 保持 |
| `hint` 整字段删除 | 正面 | 死代码不如删（06） | 保持 |
| 未声明 `sendHasWork` | 低 | 02 要具名布尔；KISS 下内联也可读 | 不必为契约补变量 |
| T11 `mode=none` 无测试 | 低 | 07：高风险才强制测；此路径未改语义但 04 写了 | 可补一条「无大脑、仍有 Send」 |
| Stop title 无 Esc | 低 | 00 可选 | 若发现性不够再加，不必为对称而加 |
| `Composer` 仍然巨大 | 存量 | Long Function（06） | 本轮正确没拆文件 |
| 设计 HTML 仍写旧 hint | 存量 | 文档漂移 | 不挡发布；下次动 dc.html 再清 |

**一句话：** 改动面干净、可逆、和 00 边界一致；质量够合并（用户明确要 merge 时再合），不是「看起来做了其实双按钮还在」。

## 5.6 重要文件修改清单

| 文件 | 修改摘要 | 新增/修改/删除 |
|------|----------|----------------|
| [apps/ohbaby-web/src/ui/App.tsx](../../../../apps/ohbaby-web/src/ui/App.tsx) | 单槽、芯片放置、Thinking/footer 文案 | 修改 |
| [apps/ohbaby-web/src/ui/selectors.ts](../../../../apps/ohbaby-web/src/ui/selectors.ts) | 删除 `hint` | 修改 |
| [apps/ohbaby-web/src/ui/styles.css](../../../../apps/ohbaby-web/src/ui/styles.css) | 芯片 chrome、文本容器裁切、窄屏 | 修改 |
| [apps/ohbaby-web/src/ui/App.unit.test.tsx](../../../../apps/ohbaby-web/src/ui/App.unit.test.tsx) | T1–T10、T12、T14–T16、T18–T20 | 修改 |
| [apps/ohbaby-web/src/ui/slashCommands.unit.test.ts](../../../../apps/ohbaby-web/src/ui/slashCommands.unit.test.ts) | 假模型去掉 `hint` | 修改 |
| [docs/ohbaby-web/ui/components.md](../../../ohbaby-web/ui/components.md) | 单槽 + 芯片 + 无常驻 hint | 修改 |
| [docs/ohbaby-web/ui/states.md](../../../ohbaby-web/ui/states.md) | 运行态/重连主槽规则 | 修改 |
| [docs/ohbaby-web/test.md](../../../ohbaby-web/test.md) | admission/follow-up 单槽规则 | 修改 |
| [docs/problem-lists/2026-09-18-web-composer-send-stop/](../README.md) | 规划文档 | 新增 |

`packages/ohbaby-cli/**`：本轮 **无改动**。
