# 讨论记录与已确认要点

> 2026-09-18 与用户讨论定稿。正式方案见 01–04。
> 来源：send-stop 验收之后的新一轮前端优化讨论。文档与上一批分开。

---

## 1. 背景与动机

单槽已经落地，输入框右边仍是一颗带字的扁胶囊（Send / Stop / Save），空着也占得偏高。顶栏 `idle` 是绿底胶囊加点，工具名再套一层彩色小盒，卡片里套卡片。

用户要三件事同时做完：圆钮只放纸飞机；输入框空着矮、打字长高、封顶内部滚；少套一层卡片（连接状态、工具名）。

## 2. 已确认：目标与范围

| 决策项 | 结论 |
|--------|------|
| 文档落点 | `docs/problem-lists/2026-09-18-web-composer-density/improve-1/` |
| 轮次 | 一轮 `improve-1`；实施分 Stage，不预开 improve-2 |
| 关键改动清单 | **不写**（用户未要求） |
| 发送钮 | **圆 + 纸飞机，不要字**。桌面和窄屏都不要「Send」 |
| 思考强度位置 | 圆钮缩窄后，控件在主按钮左侧随 flex 布局自然向右靠，维持合适间距；不能固定旧坐标或挤掉窄屏输入宽度 |
| Stop | 同一圆坑，只放方块，不要「Stop」字。灰 Stop（重连、不可点）规则沿用 send-stop |
| 转圈 | 刚发出去、admission 未完成时，转圈画在圆里，不要字 |
| 「Save」是什么 | **不是**「运行中点发送去排队」。Save 只出现在**改 Queue 里已有那条**时：主槽现在写 Save，点了走 `finishQueuedEdit` → `editQueuedPrompt` |
| 运行中点纸飞机 | 框里是新草稿、不是改队列：走现有 `onSubmit`，真正在跑用户消息就把这条 **queued** |
| 改队列时的脸 | 仍是**纸飞机圆钮**，不要「Save」字。仅在保存请求成功后表示**原队列条目已更新**，继续按队列调度；不新增一条。若它已轮到，可能立即开始执行。UI 退出编辑并恢复原草稿；仍在队列时列表反映新文本，不另加永久 `Saved` 标签。读屏 `aria-label` / `title` 继续 `Save queued prompt`，footer hint `Editing queued prompt · Enter save · Esc keep original` **保留** |
| 输入框高度 | 空着约一行；打字随视觉行增高；**最多显示 7 个视觉行**（含自动折行），之后内部滚。textarea 聚焦且 slash 菜单关闭时，滚轮和 PageUp/PageDown 滚 textarea，不捎走对话流；slash 菜单打开时保留现有键盘优先级 |
| 对齐 | 长高后圆钮和思考芯片贴右下；`>` 贴顶。空着一行时看起来仍是一条 |
| 连接状态 | 去掉胶囊和圆点，**只留字，不可点**。色组沿用现有 green/slate/gold/red |
| 呼吸 | **只有** `running` / `connecting` / `reconnecting` 让字轻轻呼吸。`idle`、`resyncing`、`disconnected` 静着（今天 `resyncing` 圆点会闪，本轮要停） |
| 工具 | **只拆工具名那一层**小胶囊，颜色留在字上。外层工具卡片、展开后的结果卡片 **不拆** |
| CSS 隔离 | 圆钮样式只打在 `.ohb-send-button` / `.ohb-stop-button`，不要和 `.ohb-button` / `.ohb-button-primary` 绑在一起 |

## 3. 已确认：板式

```
空闲、空草稿:     [>] [一行输入] [🧠 high ▾] [○ 纸飞机灰]
空闲、有草稿:     [>] [随行增高] [🧠] [○ 纸飞机]
刚发送、run 未起: [>] [一行空]   [🧠] [○ 转圈]
运行、空草稿:     [>] [一行空]   [🧠] [○ 方块]
运行、有草稿:     [>] [随行增高] [🧠] [○ 纸飞机]   ← 入队
编辑队列:         [>] [草稿]     [🧠] [○ 纸飞机]   ← 成功后原条目更新并继续调度，脸上不是 Save
重连、先前运行:   [>] [一行空]   [🧠] [○ 灰方块]
满 7 行:          textarea 内部滚，外框不再长
顶栏状态:         idle / running / connecting / reconnecting / resyncing / disconnected 纯字
工具折叠行:       [外层白卡]  彩色工具名(无小盒)  摘要  状态  ▾
工具展开:         外层白卡 + 原来的结果 <pre>
```

## 4. 已确认：边界（不做的事）

| 项 | 本轮不做 |
|----|----------|
| TUI | 零改动 |
| 拆外层工具卡 / 结果 `<pre>` | 用户明确先只拆名称层 |
| 命令 notice 标题小胶囊、Goal 芯片 | 同类 chrome，本轮不顺手改 |
| 改排队/中断/admission 协议 | 只改脸上的字和图 |
| 把改队列点纸飞机变成「再发一条新消息」 | 语义仍是保存这条 queued prompt |
| 抽 AutoGrowTextarea / ActionSlot 组件 | Composer 里几行即可；高度调整函数独立测试，无需新组件 |
| mode/permission 进输入框、整卡式 composer | |
| 像素视觉回归、必做 Playwright | 手工看呼吸和滚动 |
| 原规划会话写代码 | 审查通过后再实施 |

## 5. 已确认：与关联议题的关系

| 文档 | 关系 |
|------|------|
| [2026-09-18-web-composer-send-stop](../../2026-09-18-web-composer-send-stop/README.md) | 前一轮：单槽互斥、思考芯片进框、Web 去 hint。本轮不改互斥规则。send-stop 把「圆形发送」标成 out of scope，由本议题接走。本轮落地后，那批文档里「显示 Send/Save 字」会被权威 UI 文档覆盖，不回写那批 00–05。 |
| [`docs/ohbaby-web/ui/components.md`](../../../ohbaby-web/ui/components.md) | 仍写「显示 Send/Save」、状态胶囊、单行输入。本轮落地后必须改这篇。 |
| [`docs/ohbaby-web/ui/states.md`](../../../ohbaby-web/ui/states.md) | 连接态写成胶囊 + 圆点 pulse；`resyncing` 也 pulse。本轮：纯字；pulse 只留 running/connecting/reconnecting。 |
| [`docs/ohbaby-web/test.md`](../../../ohbaby-web/test.md) | slash「不改变 composer 尺寸」仍成立；需补 7 行封顶、图标钮无可见字。 |
| [`docs/ohbaby-web/ui/permission-button/`](../../../ohbaby-web/ui/permission-button/README.md) | 权限已用 `.ohb-perm-*`。overlay 仍有 `.ohb-button-primary`。改发送圆钮时必须先把 send/stop 从共享规则里拆走。 |
| [2026-08-18-web-tool-failure-presentation](../../2026-08-18-web-tool-failure-presentation/) | 工具单卡配对、短失败自动展开。本轮不改配对和展开，只改名称层 chrome。 |
| [2026-07-13-web-stream-scroll-and-composer-placeholder](../../2026-07-13-web-stream-scroll-and-composer-placeholder/README.md) | 对话流滚动与打字机占位。本轮封顶后内部滚不得抢走 stream 的滚轮。 |

## 6. 用户确认记录

- 2026-09-18：圆 + 纸飞机，不要字。
- 2026-09-18：输入框空着矮，打字长高，封顶后内部滚。最多 7 行开始内部滚。
- 2026-09-18：少套一层卡片：idle 和工具名。idle 收成字即可，不要点、不要胶囊。
- 2026-09-18：运行中提交**新草稿**，纸飞机沿用发送路径，新消息进入队列。
- 2026-09-18：编辑**已有 queued 条目**时同样显示纸飞机，但点击成功是保存原条目修改，原条目继续按队列调度。
- 2026-09-18：工具先拆工具名称的一层，外层工具卡片和结果卡片不要拆。
- 2026-09-18：只有 running / connecting / reconnecting 才让字轻轻呼吸。
- 2026-09-18：先对齐文档，先不实施；完成后做文档自检。文档与 send-stop 分开。
- 2026-09-18：圆钮缩窄后思考强度控件应适当右移；改队列的 Save 也改成无字纸飞机，保存请求成功才表示原条目已更新并继续按队列调度。

规划期未决项：**无。** 对齐、圆坑尺寸、`resyncing` 不呼吸、CSS 隔离，按上表默认写入，不再单开一轮。
