# 2. 优化方案与改动面

> 本文是交给实施会话的契约。开发者按本文修改，按 [04](04-test-and-acceptance.md) 自测。

## 2.1 方案总览

这轮不改数据结构和协议，分三步：

1. **讲清规则**：通过工具描述和系统提示词告诉 agent，列表是计划顺序，可以跳序，也可以同时推进多个任务。
2. **修停止态**：Goal 停止、失败或被阻塞后，隐藏 todo 面板，避免进行中的任务继续显示。
3. **重做展示**：Web 面板改成悬浮毛玻璃，折叠时显示并行数量，展开时让进行中的任务保持可见。

```text
Stage 1：agent 规则          Stage 2：停止态投影        Stage 3：Web 面板
工具描述 + base.md           publishGoalUpdated         TodoDock + session.css + tokens.css
重新生成模板，更新测试和文档  补契约测试                 更新测试和文档，真实页面验收
```

三个 Stage 可以分别提交和回退。Stage 3 上线时必须已包含 Stage 2，否则停止后的残留任务会一直转，比静态样式更误导人。

## 2.2 设计决策表

| ID | 决策 | 选择 | 理由 | 放弃的选项 | 代价 | 回应 |
|---|---|---|---|---|---|---|
| D1 | 并行约束放在哪里 | 提示词 | 工具看不到运行时 | 校验 `in_progress` 数量 | 依赖模型遵守规则 | P1 |
| D2 | 列表顺序含义 | 计划顺序，不是严格队列 | 允许按前置条件灵活选择 | 增加依赖或优先级字段 | 顺序仍靠模型维护 | P1 |
| D3 | 完成项 | 留在原位并划线 | 用户确认，进度位置稳定 | 隐藏或移到底部 | 占用列表空间 | P2 |
| D4 | 列表已满 | 移除最早完成的项 | 保留未完成工作 | 提高上限 | 旧完成项会消失 | P2 |
| D5 | 放弃的任务 | 从列表移除 | 不增加状态 | 新增 `cancelled` | 不保留放弃记录 | P2 |
| D6 | 折叠摘要 | 第一个进行中的任务 + `+N` | 一行内同时说明当前任务和并行数量 | 列出全部进行中的任务 | 其余任务要展开查看 | P3 |
| D7 | 自动滚动 | 第一个进行中的任务变化时，只滚动列表内部 | 不打断手动滚动，也不带动外层页面 | 每次更新都滚动；`scrollIntoView` | 需要少量定位代码 | P4 |
| D8 | 进行中样式 | 左侧淡蓝 spinner，文字正文色稍加粗，不加底色 | 用户改定：转动比静态点更能说明“正在做”，有了 spinner 就不需要再用蓝色标文字 | 静态蓝点 + 整行浅蓝 | 多个任务并行时会有几个 spinner 同时转；停止后残留会更显眼，所以 Stage 2 是硬前提 | P5 |
| D9 | 面板样式 | 悬浮玻璃 | 用户确认，沿用现有玻璃 token | 继续使用边框托盘 | 需要处理背后内容的对比度 | P5 |
| D10 | 停止态 | Goal 不再 `active` 且没有活跃 prompt 时，把 `visible` 改为 `false` | 符合“暂停的 Goal 保留清单但不显示”，Web 和 TUI 一起修好 | 给 TodoDock 传 `isRunning`，只修 Web | 下一次 run 开始时，旧 `in_progress` 会显示到模型改写为止 | P7 |

## 2.3 分阶段实施

### Stage 1：agent 规则

**目标**：agent 能理解计划顺序、跳序和真实并行。

**改动**：

1. `packages/ohbaby-agent/src/tools/todo.ts`：将 `todo_write` 描述替换为 [00 §3](00-discussion.md#3-已确认提示词) 的文案。
2. `packages/ohbaby-agent/src/core/system-prompt/prompts/primary/base.md`：将 “Todo tracking” 的第 3、4 条替换为 00 §3 的 4 条。文案以 00 为准，不要改写。
3. 运行下面的命令，重新生成 `templates.generated.ts`，不要手改生成文件：

   ```bash
   pnpm --filter ohbaby-agent run prompt:generate
   ```

4. 更新以下测试：
   - `prompt-assets.unit.test.ts`：改旧文案断言，新增计划顺序、满 10 条和不相邻并行的断言。
   - `todo.unit.test.ts`：更新描述断言，新增多个不相邻 `in_progress` 的写入和读取用例。
   - `goal-completion.real.e2e.test.ts`：同步工具描述夹具。
5. 更新 `docs/tools/architecture.md`、`docs/tools/data-model.md`、`docs/tools/todo-list/data-model.md`、`docs/tools/todo-list/goals-duty.md` 中的顺序语义，以及 `test.md` 的 CS11。

**完成定义**：04 的 A1-A6 通过。

### Stage 2：停止态投影

**目标**：Goal 不再运行后，面板不再把任务显示为进行中。

修改 `packages/ohbaby-agent/src/adapters/ui-inprocess.ts` 的 `publishGoalUpdated`。Goal 状态变化有两个入口，都会经过这个函数：

```ts
function publishGoalUpdated(
  sessionId: string,
  snapshot: GoalSnapshot | null,
): void {
  const goal = setGoalProjection(sessionId, snapshot);
  publish({
    goal,
    sessionId,
    timestamp: now().getTime(),
    type: "goal.updated",
  });
  if (snapshot?.status !== "active" && !activePromptsBySession.has(sessionId)) {
    hideTodoAfterRun(sessionId);
  }
}
```

有活跃 prompt 时不隐藏：它可能是用户插入的普通任务，这轮结束时 `refreshTodoProjectionAfterRun` 会更新投影。列表内容不删除，TUI 的 Ctrl+T 仍能查看。

规划时已用临时转换验证这段修改：用户停止、模型失败、预算耗尽三个复现都变为 `visible: false`，`ui-inprocess` 和 TUI 的 360 个契约测试全部通过。仓库里的代码没有改动，实施时要把 04 的 S1-S6 写成正式测试。

**完成定义**：04 的 S1-S6 通过。

### Stage 3：Web 面板

**目标**：实现 00 §4 确认的面板样式和交互。

#### TodoDock

修改 `apps/ohbaby-web/src/ui/conversation/TodoDock.tsx`：

1. 状态图标改用真实元素：
   - `pending`：`<span className="ohb-todo-ring" />`
   - `in_progress`：共享组件 `<Spinner size={11} />`（`apps/ohbaby-web/src/ui/shared/Spinner.tsx`），不传 `label`，由行的 `aria-label` 说明状态
   - `completed`：lucide 的 `Check`，`size={14}`，`strokeWidth={1.6}`
2. 任务文字加上 `className="ohb-todo-text"`。
3. 折叠摘要继续使用 `selectTodoDockPreview`。当摘要项是 `in_progress` 且还有其他进行中的任务时，显示 `+N`，其中 `N = 进行中总数 - 1`。
4. `+N` 使用独立的 `<span className="ohb-todo-more" aria-hidden="true">`，不能放进会被截断的文字里。摘要行的 `aria-label` 写成 `In progress: task 2, 1 more in progress`。
5. 新增列表 ref 和滚动 effect。`listRef` 只挂在展开态的列表上，Hook 必须放在 `if (!props.todoList) return null` 之前：

   ```tsx
   const listRef = useRef<HTMLDivElement>(null);
   const firstActiveIndex =
     props.todoList?.todos.findIndex((todo) => todo.status === "in_progress") ??
     -1;

   useLayoutEffect(() => {
     const list = listRef.current;
     const row = firstActiveIndex >= 0 ? list?.children[firstActiveIndex] : undefined;
     if (!list || !row) return;

     const listRect = list.getBoundingClientRect();
     const rowRect = row.getBoundingClientRect();
     if (rowRect.top < listRect.top) {
       list.scrollTop -= listRect.top - rowRect.top;
     } else if (rowRect.bottom > listRect.bottom) {
       list.scrollTop += rowRect.bottom - listRect.bottom;
     }
   }, [expanded, firstActiveIndex]);
   ```

#### 样式

在 `apps/ohbaby-web/src/ui/styles/tokens.css` 新增：

```css
--progress: #2a78d6;
--progress-track: rgba(42, 120, 214, 0.22);
--shadow-dock:
  0 0 0 0.5px rgba(0, 0, 0, 0.09), 0 1px 2px rgba(0, 0, 0, 0.04),
  0 14px 34px -18px rgba(0, 0, 0, 0.24);
```

修改 `apps/ohbaby-web/src/ui/session/session.css`：

| 选择器 | 目标样式 |
|---|---|
| `.ohb-main-body.has-todos .ohb-composer:not(.ohb-composer-hero)` | `background: linear-gradient(to top, var(--bg) 52px, transparent 132px)` |
| `.ohb-todo-dock` | `--bg-glass`、`--glass-blur`（含 `-webkit-` 前缀）、无边框、`--radius-xl`、`--shadow-dock`、`margin: 0 auto 8px`、`padding: 9px 10px 8px`、`width: calc(100% - 20px)`、`max-width: calc(var(--content-width) - 20px)` |
| `.ohb-todo-item` | `gap: 9px`、`padding: 3px 4px`，保持 `align-items: flex-start`，长文本换行时图标对齐首行 |
| `.ohb-todo-marker` | `display: grid`、`place-items: center`、`width: 14px`、`height: 1.45em`，移除等宽字体 |
| `.ohb-todo-marker .ohb-spinner` | 轨道 `--progress-track`，转动的弧 `--progress`；转速和减弱动效规则沿用共享 `.ohb-spinner` |
| `.ohb-todo-ring` | 11px 空心圆，`1.2px solid var(--border-focus)` |
| `.ohb-todo-in_progress` | 无背景，文字 `--text`，`font-weight: 500` |
| `.ohb-todo-pending`、`.ohb-todo-completed` | 文字 `--text-muted` |
| `.ohb-todo-completed .ohb-todo-text` | 划线，替换原来的 `span:last-child` |
| `.ohb-todo-completed .ohb-todo-marker` | 颜色 `--success-ink` |
| `.ohb-todo-preview .ohb-todo-text` | 单行省略，替换原来的 `span:last-child` |
| `.ohb-todo-more` | `flex: none`，颜色 `--text-muted`，普通字重 |
| `.ohb-todo-progress`、`.ohb-todo-chevron` | 颜色改为 `--text-muted` |
| `.ohb-main-body.has-todos :is(.ohb-prompt-queue, .ohb-goal-strip, .ohb-steer-recovery)` | 背景改为 `--bg-glass`，加 `--glass-blur`（含 `-webkit-` 前缀），避免消息文字从这些浅色条背后透出 |
| `.ohb-main-body.has-todos .ohb-stream` | 底部留白从 350px / 370px 调整为 360px / 380px，保留 `--steer-recovery-space` |

渐变固定在输入框下方，不增加 JS 测量。输入框本身已经是玻璃卡片，变高时仍能保持可读。如果浏览器验收发现文字穿帮，只调整渐变的两个像素值。

Goal 状态条会多占约 18px，这是现有留白的缺口。B5 要在 Goal 状态条和排队消息都显示时验收；如果最后一条消息被挡住，把留白调整为 380px / 400px。

#### 测试和文档

1. 更新 `App.unit.test.tsx` 中锁定 `✓●○` 的断言，补充 04 的 W1-W8。
2. 更新 `docs/tools/todo-list/goals-duty.md`、`use-case.md`、`test.md` 的 Web 描述。
3. 更新 `docs/ohbaby-web/redesign-2026-10/03-ui-layout-and-style.md` 第 32、182 行附近的玻璃和 Todo 描述，并在同目录 `README.md` 的 D21、D30 中加入 Todo 面板。

**完成定义**：04 的 W1-W8、B1-B6 通过。

## 2.4 按包和目录的改动面

| 包或目录 | 新增 | 修改 | 删除 | 说明 |
|---|---|---|---|---|
| `packages/ohbaby-agent/src/tools/` | 无 | 工具描述和测试 | 无 | 不改 schema |
| `packages/ohbaby-agent/src/core/system-prompt/` | 无 | `base.md`、生成模板、测试 | 无 | 模板必须生成 |
| `packages/ohbaby-agent/src/goals/` | 无 | e2e 夹具 | 无 | 只同步描述 |
| `packages/ohbaby-agent/src/adapters/` | 契约用例 | `ui-inprocess.ts` 的 `publishGoalUpdated` | 无 | 不改事件结构 |
| `apps/ohbaby-web/src/ui/conversation/` | 无 | `TodoDock.tsx` | 文字状态标记 | 不外移组件 |
| `apps/ohbaby-web/src/ui/session/` | 无 | `session.css` | 旧托盘样式 | 不改 Composer 结构 |
| `apps/ohbaby-web/src/ui/styles/` | 3 个 token | `tokens.css` | 无 | 字面量颜色只放这里 |
| `apps/ohbaby-web/src/ui/` | 用例 | `App.unit.test.tsx` | 旧字符断言 | 测试语义 |
| `docs/tools/`、`docs/ohbaby-web/redesign-2026-10/` | 无 | 见 1.8 | 无 | 同步权威文档，回应 P6 |

本议题改动小，不单独建立模块级 `improve-N` 文档。

## 2.5 API、协议、迁移与兼容

- `todo_write` 的输入 schema 不变。
- `UiSessionTodoList` 和 `todo.updated` 的结构不变。Goal 停止时会多发一次 `visible: false` 的 `todo.updated`。
- 历史 session 的 todo 可以继续恢复，不需要迁移。
- 提示词变化只影响新请求。

## 2.6 风险与回滚

| 风险 | 影响 | 缓解 | 回滚 |
|---|---|---|---|
| 模型不遵守提示词 | 列表被重排 | 工具描述和系统提示词同时说明，真实模型验收 | 回退 Stage 1 |
| 提醒按进行中优先排列，模型照抄 | 计划顺序被打乱 | 提示词要求先读完整列表并保留顺序；A5 观察 | 下一轮再评估提醒格式 |
| 玻璃背后文字影响阅读 | 面板可读性下降 | 使用 86% 玻璃和 `--text-muted`，按最差背景核对 | 回退 Stage 3 |
| 面板遮挡最后一条消息 | 看不到内容 | 调整底部留白，B5 带 Goal 状态条验收 | 调整留白值 |
| 停止后 spinner 还在转 | 用户误以为任务仍在执行 | Stage 2 在 Goal 停止时隐藏面板，S1-S4 覆盖 | 回退 Stage 3 |
| 自动滚动抢用户滚动 | 手动查看被打断 | 只在第一个进行中的索引变化时滚动 | 移除 effect |
| Goal 状态变化误隐藏运行中的面板 | 任务还在跑，面板消失 | 有活跃 prompt 时不隐藏，S5 覆盖 | 回退 Stage 2 |
| 停止后再开新 run，旧 `in_progress` 又显示 | 短时间显示过期状态 | 接受：新 run 中模型会读取并改写列表，不增加清理逻辑 | 不需要 |

每个 Stage 单独提交，回退不需要数据处理。

## 2.7 与 00 边界对齐检查

| 00 结论 | 02 落点 |
|---|---|
| 多个不相邻 `in_progress`、计划顺序 | D1、D2、Stage 1 |
| 完成项留在原位、列表满时移除最早完成项 | D3、D4、Stage 1 |
| 放弃任务直接移除 | D5、Stage 1 |
| 淡蓝 spinner、文字不标蓝 | D8、D10、Stage 2、Stage 3 |
| 悬浮玻璃、16px 圆角、8px 间距 | D9、Stage 3 |
| 折叠显示 `+N`、展开跟随进行中 | D6、D7、Stage 3 |
| TUI 只使用新提示词 | 2.4、2.8 |

## 2.8 不在本轮

- todo id、依赖、优先级、`cancelled` 状态。
- 用代码校验 `in_progress` 是否真实运行。
- 调整 10 条上限或 100 字符限制。
- TUI 界面改动。
- 调整提醒的排序方式。
- 断网时的 todo 专用状态。
- 新 run 开始时自动清理上次遗留的 `in_progress`。
