# 4. 测试与验收标准

> 仓库无项目级 `test-blueprint.md`。沿用 `docs/ohbaby-web/test.md` 与 colocated vitest：`*.unit.test.ts` / `App.unit.test.tsx`。本议题不引入视觉回归截图，不改 TUI 契约测（它们必须继续绿）。

---

## 4.1 测试范围

| 类型 | 覆盖什么 | 不覆盖什么 |
|------|----------|------------|
| 组件/合同（`App.unit.test.tsx`） | 主槽互斥、芯片父节点、Thinking 无 esc 句、改队列 hint 仍在、admission 转圈仅在 Stop 未上场时 | 像素、hover 细边截图 |
| selectors 单测 | 若删除 `hint`：`ComposerModel` 不再带该字段；`canSend`/`canStop`/`isRunning` 含义不变 | 为 hint 文案补新测（字段将消失） |
| 样式单测 | typewriter 仍 `pointer-events: none`；若锁定 `right` 值则更新期望 | 全 CSS 快照 |
| TUI 契约测 | **原样跑**，确认 `Press Esc again to interrupt` 仍在 | 不改断言、不改 TUI |
| 手工/浏览器 | hover 细边、running 变脸、芯片不裁气泡、打字机不与大脑重叠 | 全机型视觉 QA |

## 4.2 关键场景与用例

| ID | 场景 | 类型 | 验证点 | 对应 02 Stage |
|----|------|------|--------|----------------|
| T1 | live、idle、空草稿 | App.unit | 有 `.ohb-send-button[disabled]`，**无** `.ohb-stop-button` | 1 |
| T2 | live、idle、有草稿 | App.unit | Send 可点；无 Stop | 1 |
| T3 | `status.kind=running`、空草稿、有 session | App.unit | **只有** `.ohb-stop-button`，无 Send | 1 |
| T4 | running + textarea 有字 | App.unit | **只有** Send 且可点（入队）；无 Stop | 1 |
| T5 | 首条发送、HTTP admission 未完成、run 尚未 running | App.unit | 仍有 busy Send（`aria-busy=true`），无 Stop | 1 |
| T6 | running 时 follow-up Enter | App.unit | 草稿清空后回到只有 Stop；队列出现该文本；**不要**再要求 busy Send 必须存在 | 1 |
| T7 | 编辑 queued prompt | App.unit | 主按钮 title/文案为 Save；无 Stop；footer 仍有 queued-edit hint | 1 |
| T8 | 推理 identified | App.unit | `[aria-label="Reasoning effort"]` 的 closest 是 `.ohb-composer-input`，不是 `.ohb-composer-tools` | 2 |
| T9 | 推理 detecting | App.unit | 有转圈大脑，无「推理默认」「检测中」字 | 2 |
| T10 | 推理 unknown | App.unit | 可见 `unknown`；输入有效草稿后 Send 可用；unknown 控件在输入框内 | 2 |
| T11 | `mode=none` identified | App.unit | 无推理控件，主按钮仍在 | 2 |
| T12 | Thinking 在 running | App.unit | 有 `Thinking` 与秒数；**不含** `double click esc to interrupt` | 3 |
| T13 | startup Thinking（`canInterrupt=false`） | App.unit | 仍可有 `starting agent`；无 esc 句 | 3 |
| T14 | footer | App.unit | 无 `enter to send`、无 `double click esc to stop` | 3 |
| T15 | TUI running 按一次 Esc | cli contract | 帧含 `Press Esc again to interrupt` | 3 回归 |
| T16 | 双击 Esc（Web） | 新增 App.unit | running + 有草稿、Stop 不在 DOM 时，textarea 连按两次 Esc 仍调用 `abortSession`；编辑队列时 Esc 优先放弃编辑，不触发 abort | 1/3 |
| T17 | 窄屏相关 | 手工 | 主按钮文字可藏，须有 `aria-label`；芯片与主按钮不并排成两颗主操作 | 1–2 |
| T18 | running + 空草稿时 SSE 进入 `reconnecting` / `resyncing` | App.unit | 顶栏显示连接状态；主槽只有 disabled Stop；恢复 live 后若新快照仍 running 则 Stop 可点，若已 idle 则显示 Send | 1 |
| T19 | running + 有草稿时断线 | App.unit / 手工 | 已有草稿保留、textarea 与 Send disabled；恢复 live 且新快照仍 running 后可入队，若已 idle 则正常发送。断线期间不要求清空禁用的 textarea | 1 |
| T20 | `waiting-for-permission` + 空草稿 | App.unit | 仍只有 Stop，依 `canStop` 决定能否点击；不得只识别 `status.kind=running` | 1 |

改现有测试时：把「admission 必须找到 `.ohb-send-button[aria-busy=true]`」限制在 T5；T6 按新规则改，不要为了保测试把灰 Send 留着。

## 4.3 集成边界

- **视图 vs 数据**：`isRunning`/`canStop`/`canSend` 仍由 `selectViewModel` 投影。测试不要改 fake snapshot 语义来迁就 UI。
- **队列**：running follow-up 仍只进 Queue。T6 失败时先看 `submitPromptAccepted` 是否还走队列，再看按钮互斥。
- **档位**：`getCurrentModel().reasoning` 仍驱动控件；搬家后订阅 `snapshot.replaced` / `session.updated` 的 refresh 不得丢掉。
- **TUI**：与 Web 无共享组件。Web 删文案不得改 `ESC_INTERRUPT_HINT`。

## 4.4 回归清单

- Enter 发送、Shift+Enter 换行、slash palette 键盘、IME 守卫。
- 队列：编辑 lease、Cancel、Esc 放弃编辑（此时 Esc **不是** abort）。
- 权限模态、mode/policy 循环仍在 footer。
- `mode === "none"` 无大脑。
- 断线：composer `disabled`，placeholder `daemon unavailable`。
- 重连时保留最后已知运行态对应的灰 Stop；顶栏以 `reconnecting` / `resyncing` 为连接状态真相，恢复后按最新快照刷新。
- header 五态胶囊仍显示 connecting/reconnecting/disconnected（hint 删了也不能丢这些）。
- TUI 双击 Esc 中断与「换 run 后要重新双击」契约测。
- 打字机：空闲空草稿未聚焦仍显示；聚焦或有字时隐藏。

## 4.5 验收标准（发布门）

| 项 | 标准 | 如何验证 |
|----|------|----------|
| 单槽 | composer 出现时，`.ohb-composer-input` 内主操作按钮恰好 1 颗 | T1–T7、T18–T20；浏览器跑 idle/running/打字/入队 |
| 空态 Stop | running 空草稿只见 Stop | T3 + 手工 |
| 入队 | running 有草稿只见 Send，发出去进队列 | T4、T6 |
| 芯片 | identified、detecting、unknown 均在输入框内；无白底实边、hover 出细边、键盘焦点明显、留大脑、英文档位；最长占位词与窄屏不覆盖控件 | T8–T11 + 手工 hover/窄屏 |
| Web 文案 | Thinking/footer 无 esc/enter 说明书；改队列 hint 仍在 | T12–T14、T7 |
| TUI 文案 | `Press Esc again to interrupt` 仍在 | T15：`packages/ohbaby-cli` 相关 contract 测试 |
| 无障碍 | 图标-only 主按钮有 `aria-label`；档位 select 仍有 `aria-label="Reasoning effort"` | T17、T8 |
| 断线状态 | 最后已知 running 且空草稿时只有灰 Stop；重连完成后不保留过期动作 | T18–T19 |
| 范围 | diff 不含 `packages/ohbaby-cli/src` 功能改动（测试文件也不为「删提示」而改） | diff 审查 |
| 权威文档 | `components.md` / `states.md` / `test.md` 与单槽+芯片+Web/TUI 文案分叉一致 | 对照 00 板式表 |

建议命令（实施会话按仓库脚本调整）：

```bash
pnpm exec vitest run apps/ohbaby-web/src/ui/App.unit.test.tsx \
  apps/ohbaby-web/src/ui/selectors.unit.test.ts \
  apps/ohbaby-web/src/ui/styles.unit.test.ts \
  apps/ohbaby-web/src/ui/slashCommands.unit.test.ts

pnpm exec vitest run packages/ohbaby-cli/src/tui/app.contract.test.tsx
pnpm typecheck
```

## 4.6 对抗性审查要点

1. **T6 保测试情结**：最容易把 busy Send 留在 Stop 旁边「好让旧断言过」。防御：T3/T6 明确禁止第二颗按钮；失败时改测试。
2. **queued edit + running**：Save 占槽时不能偷偷再画 Stop。Esc 放弃编辑不得误触发 abort（现有 `onKeyDown` 先处理 queuedEdit）。
3. **`isPromptAdmitting` 与 `isRunning` 重叠**：follow-up 入队瞬间两真。空草稿时 Stop 优先于转圈 Send；有草稿时 Send 占槽但 disabled。测 T6 不要回到 T5。
4. **芯片 `return null` 与 typewriter 留白**：无思考模型时不能按「芯片+Send」永久留白。absolute typewriter 的 `white-space: nowrap` 也可能越界绘制，必须裁切并在实际浏览器检查 375px、720px 视口、最长占位短语、`high`/较长档位及无思考模型；同时确认 textarea 仍有可输入宽度、错误气泡不被裁。
5. **误改 TUI**：搜索 `double click esc` 只应改 web；`Press Esc again to interrupt` 只属于 cli。发布 diff 扫这两句。

残余风险：有草稿时 Stop 不在 DOM，新用户可能不知道双击 Esc；Stop 的 title 在此状态也不可用，触屏用户须先清空草稿。00 已接受。不在本轮加回第二颗按钮或 Thinking 可点击。
