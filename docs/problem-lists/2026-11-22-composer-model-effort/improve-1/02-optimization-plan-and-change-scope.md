# 2. 优化方案与改动面

> 本文交给实施会话。规划会话不写代码。路径都相对 `apps/ohbaby-web/src/ui/`，另有说明的除外。

## 2.1 方案总览

把思考强度并进模型按钮：按钮上显示"模型名 + 灰色强度"，菜单根层是现在的模型列表，下面多一行"Effort ›"，点进去是当前模型支持的强度。`ReasoningControl` 删掉，手机"更多"菜单里的思考强度一项也删掉。`useReasoning` 的逻辑和后端都不动。

```
桌面（底部一行）
[权限 ▾]                    [gpt-5.2 High ▾] (↑)
                                  │
                                  ▼
             ┌─────────────────────────────┐
             │ (筛选框，模型 ≥ 9 个时出现)   │
             │ OpenAI                      │
             │   gpt-5.2            ✓      │  ← 模型列表，过长时自己滚动
             │   gpt-5-mini    default     │
             │ DeepSeek                    │
             │   deepseek-v4               │
             │ ─────────────────────────── │
             │ Effort           High   ›   │  ← 不随列表滚动，不参与筛选
             │ ─────────────────────────── │
             │ Manage models…              │
             └─────────────────────────────┘
                                  │ 点 Effort
                                  ▼
             ┌─────────────────────────────┐
             │ ‹ Effort                    │
             │   Off                       │
             │   Low                       │
             │   Medium                    │
             │   High               ✓      │
             └─────────────────────────────┘
```

## 2.2 设计决策表

| 决策项 | 选择 | 理由 | 放弃的选项 | 代价 |
|---|---|---|---|---|
| A1 模型菜单怎么拿到思考强度状态 | `Composer` 的 `modelControl` 从现成节点改成函数 `(reasoning: ReasoningState) => ReactNode`，`ComposerControls` 调用时把 `useReasoning` 的结果传进去 | `useReasoning` 需要的会话、客户端、`onReasoningChange` 都在 `ComposerControls` 手里，原地不动；`ModelMenu` 只多一个参数 | 把 `useReasoning` 提到 `SessionScreen`：要多传好几个参数，`Composer` 里其他用到它的地方也得跟着改。用 React Context：一处用法不值得 | `Composer` 和 `SessionScreen` 的传参写法要改 |
| A2 按钮文字 | 模型名 + 空格 + 强度。强度用 `--text-dim`；只在状态为 `choice` 且有值时显示；识别中、未知、不支持思考时只显示模型名。强度文字首字母大写显示（`high` 显示为 High），按钮和二级列表一致；保存的值不变 | 按钮只显示真正生效的设置。识别中、未知这些暂时状态放到菜单里的 Effort 一行说明 | 继续在按钮上显示转圈的脑袋图标或 `unknown`：按钮变宽，和"合并后更清爽"相违背 | 识别中的反馈从按钮挪进菜单，不打开菜单就看不到 |
| A3 宽度不够时 | 模型名先用省略号截断，强度文字不截断 | 强度一般只有 2–6 个字母，模型名可长可短 | 两段一起截断：强度可能只剩一两个字母，看不懂 | 极窄时模型名只剩几个字母，悬停的 `title` 显示全名 |
| A4 Effort 一行 | 放在模型列表和"Manage models…"之间，带 `data-menu-filter="false"`，不随列表滚动。右侧灰色显示当前强度和 `›`。识别中显示"Detecting…"、未知显示"Unknown"（有保留但未生效的档位时显示"High · inactive"），这两种状态下这一行不能点，`title` 是原因。不支持思考（`hidden`）时整行不出现 | 和"Manage models…"一样固定在可见位置，长列表也不用滚到底找 | 放在列表最上面：打开菜单时焦点在当前模型上，Effort 在上面反而离得远 | 无 |
| A5 Effort 二级 | 用 `Menu` 现有的 `level`：根层 `"models"`，二级 `"effort"`。二级第一行是"‹ Effort"返回，下面是强度选项，当前项打勾。Esc 和返回行都回到根层 | 手机"更多"菜单已经这样做，交互一致，不写新代码 | 嵌套的侧边子菜单：`Menu` 明确不支持（`shared/Menu.tsx` 注释），手机上也展不开 | 无 |
| A6 选完是否关闭 | 选模型后关闭（和现在一样），选强度后也关闭，焦点回到按钮 | 选模型后要等会话回传才生效，这期间菜单里的 Effort 还是旧模型的档位，保持打开容易误选 | ZCode 选完模型菜单不关：会出现上面说的错位 | 换模型再调强度要打开两次 |
| A7 保存强度失败 | 错误文字显示在 Effort 一行下方（`role="alert"`），按钮上的强度文字换成 danger 色 | 原来错误显示在下拉框旁边，合并后没有那个位置；菜单关着时用颜色提示 | 走 `onError` 弹全局错误：强度失败不值得打断用户 | 菜单关着时只有颜色提示 |
| A8 手机 | 合并按钮在手机上照常显示（含强度）；"更多"菜单删掉 Reasoning Effort 二级，只留 Full access 开关 | 一件事只放一个地方 | 手机上保留"更多"里的强度：同一设置两个入口 | "更多"菜单只剩一项。先保留这个菜单（D29 的位置不变，后续还会放别的） |
| A9 无障碍 | 按钮 `aria-haspopup="menu"`，`title` 改成"Model and reasoning effort for this chat"；Effort 一行的可读文字包含当前档位或状态（如"Effort, High"），识别中这一行带 `aria-busy` | 原来 `role="status"`、`role="alert"` 的语义要保留 | 无 | 无 |

## 2.3 分阶段实施

本轮分两个 Stage，都属于 improve-1。

### Stage 1：合并按钮与菜单

- 目标：桌面和手机都只剩一个"模型 + 强度"入口，功能和现在等价。
- 改动：
  - `composer/ModelMenu.tsx`：新增 `reasoning: ReasoningState` 参数；按钮显示强度（A2、A3）；根层加 Effort 一行（A4）；加 `"effort"` 二级（A5、A6）；显示保存失败（A7）。
  - `composer/ComposerControls.tsx`：去掉 `<ReasoningControl>`；`modelControl` 改为函数调用，传入 `reasoning`。
  - `composer/Composer.tsx`：`modelControl` 的类型改成函数。
  - `session/SessionScreen.tsx`：`modelControl={(reasoning) => <ModelMenu ... reasoning={reasoning} />}`。
  - `composer/ComposerMoreMenu.tsx`：删掉 `"thinking"` 二级和 `reasoning` 参数，只留 Full access。
  - `composer/ReasoningControl.tsx`：删除。
  - `composer/controls.css`：删掉 `.ohb-reasoning-control`、`.ohb-reasoning-status` 等只给这个控件用的样式（`conversation/messages.css` 里消息区的 `ohb-reasoning-*` 不动，删之前先确认没有别处在用）；新增按钮内强度文字、Effort 一行、错误文字的样式；调整窄屏下按钮的最大宽度。
  - 测试：按 04 改 `App.unit.test.tsx` 和 `composer/model-refresh.integration.test.tsx`。
- 完成定义：04 的 A-1 到 A-10 全部通过；`pnpm` 的 Web 类型检查、lint、单测通过；浏览器里桌面和 375px 宽度各走一遍。

### Stage 2：同步设计文档

- 目标：权威设计文档和代码一致。
- 改动（路径相对仓库根）：
  - `docs/ohbaby-web/redesign-2026-10/README.md`：新增 D37，写明"模型与思考强度合并为一个按钮，菜单里 Effort 二级"，并在 D22、D29 后注明被 D37 修改。
  - `docs/ohbaby-web/redesign-2026-10/03-ui-layout-and-style.md`：线框改成 `[gpt-5 Med v] (^)`，§4.3 和窄屏表格里的描述同步。
  - `docs/ohbaby-web/redesign-2026-10/05-components.md`：`ModelMenu` 一节写进按钮文字和 Effort 二级；`ComposerControls` 的组成改掉；`ComposerMoreMenu` 只剩 Full access；删掉 `ReasoningControl`。
  - `docs/ohbaby-web/redesign-2026-10/04-interaction-and-states.md`：控件状态表里"模型、思考强度"合并为一项。
- 完成定义：在这几篇里搜"思考强度"和 `ReasoningControl`，不再有和代码矛盾的描述。

## 2.4 按包和目录的改动面

| 包/目录 | 新增 | 修改 | 删除 | 说明 |
|---|---|---|---|---|
| `apps/ohbaby-web/src/ui/composer/` | 无 | `ModelMenu.tsx`、`ComposerControls.tsx`、`Composer.tsx`、`ComposerMoreMenu.tsx`、`controls.css`、`model-refresh.integration.test.tsx` | `ReasoningControl.tsx` | 主体改动 |
| `apps/ohbaby-web/src/ui/session/` | 无 | `SessionScreen.tsx` | 无 | 只改 `modelControl` 的写法 |
| `apps/ohbaby-web/src/ui/` | 无 | `App.unit.test.tsx` | 无 | 思考强度相关用例改成菜单操作 |
| `docs/ohbaby-web/redesign-2026-10/` | 无 | `README.md`、`03`、`04`、`05` | 无 | Stage 2 |
| `packages/*`、后端 | 无 | 无 | 无 | 不动 |

## 2.5 接口、迁移与兼容

- 只有前端内部的组件参数变化：`Composer.modelControl` 变成函数，`ModelMenu` 多了 `reasoning`，`ComposerMoreMenu` 少了 `reasoning`。
- 会话里保存的思考强度、`model.json` 里的 `reasoningDefault` 都不变，用户已有的设置照常生效。
- 没有数据迁移。

## 2.6 风险与回滚

| 风险 | 应对 |
|---|---|
| 换模型后 Effort 显示的还是旧模型的档位 | A6 选完就关菜单；保存请求返回前按钮本来就是禁用状态（`ModelMenu` 的 `saving`）。04 A-6 专门验证 |
| 窄屏下按钮把底部一行挤换行 | A3 只截模型名；04 A-9 在 375px 验证 |
| 删掉 `<select>` 后测试大面积失败 | 用例的行为断言保留，只改操作方式（04 §4.4） |
| 误删消息区的 `ohb-reasoning-*` 样式 | 2.3 已写明只删 `controls.css` 里的 |

回滚：本轮全是前端展示改动，回退对应提交即可，不影响数据。

## 2.7 与 00 边界对齐

| 00 结论 | 02 落点 |
|---|---|
| 一个按钮，模型名 + 灰色强度 | A2、A3 |
| 模型按提供方分组 + "Effort ›" 二级 | A4、A5，复用现有分组 |
| 不用滑块、分段按钮、胶囊 | A5 用现有 `Menu` 二级 |
| 只做 Web，后端不改 | 2.4 后端和 `packages/*` 无改动 |
| 不列关键改动清单 | 本文没有 2.9 |

## 2.8 不在本轮

| 项 | 说明 |
|---|---|
| TUI 的模型与思考强度入口 | 00 已确认不做 |
| 菜单里显示每个模型的思考能力（比如在模型名旁标"支持思考"） | 没有用户提出，先不做 |
| "更多"菜单只剩一项后是否取消 | 等语音输入等后续功能确定手机控件布局后再看 |
