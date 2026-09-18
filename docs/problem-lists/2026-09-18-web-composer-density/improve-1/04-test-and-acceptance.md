# 4. 测试与验收标准

> 仓库无项目级 `test-blueprint.md`。沿用 `docs-test/` 与 `docs/ohbaby-web/test.md`：colocated vitest。本议题不引入视觉回归截图，不改 TUI 契约测（它们必须继续绿）。

---

## 4.1 测试范围

| 类型 | 覆盖什么 | 不覆盖什么 |
|------|----------|------------|
| App.unit | 主按钮无 Send/Stop/Save 可见字；admission 圆内转圈；`aria-label` 仍在；queuedEdit 点纸飞机后只调用 `editQueuedPrompt` 保存原条目，成功退出编辑、失败保留草稿；StatusPill 无装饰圆点 | 呼吸好看不好看；圆是否完美正圆的截图 |
| 高度函数 unit | `fitComposerTextarea`（或同名，读写 DOM 的函数）：模拟 `scrollHeight` 验 1 行、中间行数、超过 7 行封顶并 `overflowY=auto` | jsdom 真实折行排版 |
| styles.unit | send/stop 圆（`border-radius: 50%`、固定宽高）；`.ohb-button-primary` 仍非 50%；status 无 pill padding/圆点尺寸；running/connecting/reconnecting 有 pulse；resyncing/idle 的规则不含 animation；工具名 first-child 无 background/border；`.ohb-tool-panel` 仍有白底边框 | 全 CSS 快照 |
| tool-card.unit | 仍渲染 `.ohb-tool-panel` 与展开 `<pre>` | 不测像素 |
| TUI contract | **原样跑** | 不改断言 |
| 手工/浏览器 | 空框矮、窄屏自动折行到第 8 个视觉行后内部滚、滚动边界不带动 stream；思考控件随圆钮缩窄右移且不挤压输入；连接态切换与减弱动效；权限/overlay 主按钮仍是扁的 | 全机型 QA |

## 4.2 关键场景与用例

| ID | 场景 | 类型 | 验证点 | 对应 02 Stage |
|----|------|------|--------|----------------|
| T1 | live、idle、有草稿 | App.unit | 只有 `.ohb-send-button`；**无**文本「Send」；有纸飞机 svg；`aria-label="Send message"` | 1 |
| T1b | 首条发送、admission 未完成、尚未 running | App.unit | 圆里 `LoaderCircle`、`aria-busy=true`；无「Send」字；无 Stop | 1 |
| T2 | running、空草稿 | App.unit | 只有 `.ohb-stop-button`；**无**文本「Stop」；`aria-label="Stop run"` | 1 |
| T3 | 编辑 queued prompt，点纸飞机保存成功 | App.unit | 无「Save」可见字；`title`/`aria-label` 为 `Save queued prompt`；无 Stop；编辑时 footer 有 hint。点击后 `editQueuedPrompt` 以原 `promptId`、leaseId 和新文本调用一次，`onSubmit`/新 prompt 提交零次；成功响应后编辑 hint 消失并恢复原草稿。若 fake 注入新快照，只验证 UI 正确投影，不把它当成后端队列证明 | 1 |
| T3a | 保存后原条目继续调度 | 真实队列集成测试或编译后 Web E2E | 用正在运行且暂不结束的前一条任务保持队列等待；调用 `editQueuedPrompt` 前后读取真实快照，原 `promptId` 不变、文本更新、仍 queued、队列数量不增、没有第二条新提交。另核对后端保存后会触发调度：如果轮到它，允许很快转 starting/running；不能把最终状态永久写死为 queued，也不能仅靠 App.unit fake 的快照断言 | 1 |
| T3b | 编辑保存失败 | App.unit | `editQueuedPrompt` reject 时保留编辑内容、hint 与错误；不称已保存，不新增 prompt | 1 |
| T4 | overlay / 权限主按钮 | App.unit 或 styles.unit | `.ohb-button-primary` 或 `.ohb-perm-allow-primary` **不是** `border-radius: 50%` | 1 |
| T5 | 高度调整函数：1 行 | unit | height = 24；overflowY hidden（或空） | 2 |
| T6 | 高度调整函数：3 行 | unit | height = 72；未封顶 | 2 |
| T7 | 高度调整函数：10 个视觉行 | unit + 浏览器 | 模拟时 height = 168、overflowY auto；浏览器中含自动折行的长句也在第 7 个可见行封顶 | 2 |
| T8 | 草稿变化与宽度变化 | App.unit + 浏览器 | 发送清空回一行；粘贴、恢复草稿、载入 queuedEdit、窗口/容器变窄自动折行后均重算高度 | 2 |
| T9 | 顶栏 idle | App.unit | `.ohb-status-idle` 存在；没有装饰用的空圆点 span；文案 idle | 3 |
| T10 | 顶栏 running | App.unit + styles | 文案 running；CSS 对该 kind 有 pulse；无圆点 | 3 |
| T11 | reconnecting / connecting | styles 或 App.unit | 字规则带 pulse | 3 |
| T12 | resyncing / disconnected / idle | styles | **没有** pulse animation | 3 |
| T13 | 工具折叠 + 展开 | tool-card.unit | 仍有 `.ohb-tool-panel`；open 时有 `pre`；标题还在 | 3 |
| T14 | 工具名 CSS | styles.unit | `span:first-child`（或新 class）无 background/border/padding 胶囊；color 仍按 accent | 3 |
| T15 | TUI | cli contract | 不因本轮变红 | 回归 |
| T16 | 内部滚动边界 | 浏览器 | textarea 聚焦、无 slash 菜单时，滚轮、触控板及 PageUp/PageDown 滚 textarea；到顶部/底部后继续滚，对话流位置不变。slash 菜单打开时 PageUp/PageDown 保持现有菜单优先行为 | 2 |
| T17 | 呼吸减弱动效（手工） | 手工 | `prefers-reduced-motion: reduce` 时字不闪 | 3 |
| T18 | slash / 档位（回归） | 已有 App.unit + 手工 | 上浮层不被输入行裁切；思考芯片仍在输入框内 | 2 回归 |
| T19 | 权威文档 | 对照 | `components.md` / `states.md` / `test.md` 与 00 板式一致，不再写状态胶囊、单行死高、可见 Save 字 | 4 |
| T20 | 思考控件与圆钮相对布局 | 浏览器 | 桌面及 320/375/720px：identified（含最长档位）、detecting、unknown、无思考能力四态；有控件时量取控件右缘与圆钮左缘，间距桌面约 12px、极窄屏约 6px，控件位于圆钮左侧且不遮住 textarea；无控件时不留空位；textarea 可输入且无重叠、横向溢出 | 1–2 |

改现有测试时：T3 不要再断言按钮 **可见文本** 为 Save；断言 label/title，并真正点击纸飞机验证成功和失败两条路径。现有 `App.unit` 的 queued-edit 用例主要覆盖 Esc，**不能**当成 T3 已覆盖。send-stop 的单槽互斥测试继续绿。

## 4.3 集成边界

- **视图 vs 数据**：`send()` 两条路（改队列 vs onSubmit）测试不要合并。T1 的纸飞机在 running+新草稿时仍应导致队列，而不是 `editQueuedPrompt`；T3 保存的是原条目，成功后才退出编辑。
- **CSS 耦合**：T4 失败说明 Stage 1 没拆共享规则，先修选择器，不要去改 overlay 来迁就圆钮。
- **滚动**：T16 失败时先看 overflow/overscroll 是否在 textarea 自身，而非 `.ohb-composer-input`；再看焦点与 slash 菜单是否改变键盘优先级。
- **TUI**：Web 去胶囊不得改 cli 状态行。

## 4.4 回归清单

- send-stop：单槽、running 空草稿只有 Stop、running 有草稿入队、admission 转圈、重连灰 Stop、改队列 Esc 放弃而不是 abort。
- Enter 发送、Shift+Enter 换行、IME 守卫、slash palette。
- 思考芯片仍在 `.ohb-composer-input`，无思考能力时不留空位。
- 权限模态、mode/policy、Goal 芯片、命令 notice 胶囊。
- 工具 pairing、短失败自动展开一次。
- 断线：composer disabled；顶栏 `disconnected` 红字静置。运行中有新草稿与编辑原 queued prompt 的两条纸飞机路径分别回归。
- TUI Esc 提示原句。

## 4.5 验收标准（发布门）

| 项 | 标准 | 如何验证 |
|----|------|----------|
| 圆钮无字 | 主槽可见内容只有图标/转圈，没有 Send/Stop/Save 单词 | T1、T1b、T2、T3 + 浏览器 |
| 单槽仍互斥 | 任何时刻 1 颗主按钮 | 沿用 send-stop 测试 |
| 改队列语义 | 点击成功后保存原 `promptId`，同一条继续调度、没有新条目；失败仍可继续编辑 | T3、T3a、T3b；T3a 必须读取真实队列快照 |
| 运行中新消息 | 纸飞机走队列 | 已有 follow-up 测试 |
| 1–7 行 | 空一行；自动折行也计数；满 7 个可见行后内部滚且到边界不推动对话流 | T5–T8、T16 |
| 思考控件 | 圆钮变窄后自然右移，始终贴圆钮左侧；窄屏不遮挡输入 | T20 |
| overlay 未被连坐 | 扁主按钮仍在 | T4 |
| 状态纯字 | 无胶囊无点；实际切换时三态呼吸、idle/resyncing/disconnected 静止；减弱动效下均不闪 | T9–T12、T17 + 浏览器 computed animation |
| 工具少一层 | 名无小盒；外卡和 pre 仍在 | T13–T14 |
| TUI | 零功能 diff | T15 + diff 审查 |
| 权威文档 | components/states/test 与 00 一致 | T19 |

建议命令（实施会话按仓库脚本调整）：

```bash
pnpm exec vitest run apps/ohbaby-web/src/ui/App.unit.test.tsx \
  apps/ohbaby-web/src/ui/styles.unit.test.ts \
  apps/ohbaby-web/src/ui/tool-card.unit.test.tsx

# 抽出的 fitComposerTextarea unit 一并跑

pnpm exec vitest run packages/ohbaby-cli/src/tui/app.contract.test.tsx
pnpm typecheck
```

## 4.6 对抗性审查要点

| 攻击面 | 最可能怎么坏 | 防御 | 残余风险 |
|--------|----------------|------|----------|
| 共享 CSS | 改圆钮把 `/connect` 保存钮也变圆 | T4；Stage 1 先拆选择器 | 漏网的 `.ohb-button` 次级扁钮若被误写入 send 组 |
| 两条「发送」 | 改队列点纸飞机变成 onSubmit，队列里出现重复条目 | 不改 `send()` 分支；T3/T3b 验前端调用与错误路径，T3a 用真实队列验原 ID 和条目数 | 用户仍可能口头把两者叫成发送 |
| 滚动冒泡 | 满高后滚轮推动对话流，用户以为没内滚 | textarea 默认设 `overscroll-behavior: contain`；T16 验顶部和底部 | 触控板弹性滚动在部分浏览器仍可能漏 |
| overflow hidden 裁切 | 为了圆角给输入行加 hidden，slash 被切 | 02 禁止；T18 | 档位错误气泡定位若仍依赖 overflow 可见 |
| resyncing 被一起闪 | 选择器和今天一样绑在 running, resyncing | T12 显式排除 | 以后加新 kind 可能忘记分类 |
| 7 行常量漂移 | CSS max-height 和 JS maxLines 各写各的 | 高度调整函数与 CSS 用同一 24×7；T7 | 改字号时两处都要动 |

对应 01 高风险：按钮 CSS 耦合、空框死高、Save 语义误解、状态胶囊、工具名双层。T4/T5–T8/T3/T9–T14 分别接住。
