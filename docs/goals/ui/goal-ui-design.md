# Goal UI Design

本文档描述 `goals` 模块在 CLI TUI 与 Web UI 中的呈现和操作方式。它只覆盖前端适配层，不改变后端状态机、GoalService、GoalDriver 或持久化语义。

## 1. Design Goals

- 让用户能在不输入 `/goal status` 的情况下知道当前 session 是否存在 active/paused goal。
- CLI 保持命令式体验，只显示紧凑状态，不引入可视化管理面板。
- Web 使用操作面板管理 goal，复用现有 structured overlay/card 风格，不另起一套视觉体系。
- `/goal` 是 CLI 与 Web 的统一命令入口，但两端行为符合各自交互模式：CLI 执行命令，Web 打开面板。
- UI 只消费 SDK 中的 goal 投影字段：`sessionId`、`goal.status`、`goal.objective`、`goal.pauseReason`。不暴露 `goalId`、turn/token usage 或后端内部迁移细节。

## 2. Duties

- CLI 在 prompt 输入框附近显示当前 active session 的 goal 状态。
- Web 在状态栏附近显示当前 active session 的 goal 状态，目标全文放在 Goal 面板中展示和编辑。
- Web `/goal` 打开 Goal 面板；`/goal pause|resume|cancel|replace ...` 打开同一个面板并高亮对应操作，不直接执行子命令。
- Web Goal 面板支持查看状态、编辑 objective、暂停、恢复、删除当前 goal。
- Goal 为空、cancelled、completed 后，CLI 与 Web 都不显示常驻状态。

## 3. Non-Duties

- 不在 CLI 中显示 objective、编辑框或删除按钮；这些属于 Web 面板职责。
- 不新增后端 goal 状态；UI 只处理 `active` 和 `paused`。
- 不实现 Web 自动恢复 goal；恢复仍由用户点击 Resume 或 CLI `/goal resume` 显式触发。
- 不把 Goal 面板做成新的页面、嵌套卡片或独立设计系统。
- 不在本轮实现 goal 历史、预算编辑、turn/token 详情或多 goal 队列。

## 4. Architecture Overview

### 4.1 Shared Contract

后端已经通过 SDK 暴露：

```ts
interface UiSessionGoal {
  readonly sessionId: string;
  readonly goal: {
    readonly status: "active" | "paused";
    readonly objective: string;
    readonly pauseReason?: string;
  };
}
```

UI 侧新增的选择器只做 active session 过滤与展示格式化，不创建新的领域模型。

### 4.2 CLI TUI

CLI 复用现有 TUI store 中的 `goals: UiSessionGoal[]`。新增一个 selector：

- 输入：`state.activeSessionId` 与 `state.goals`
- 输出：active session 的 `UiGoal | null`

`Prompt` 组件新增可选 `goalStatusLabel`，将其插入现有 dock status 行。建议格式：

```text
goal active · auto · default · session_...
goal paused · auto · default · session_...
```

若无 active goal，dock status 不显示 goal 信息。该状态条不拦截输入，不改变 `/goal` 命令行为。

### 4.3 Web UI

Web 复用现有 `StructuredCommandOverlay`：

- `StructuredOverlayKind` 增加 `goal`
- `UiWebCommandAction` 增加 `openGoalPanel`
- Web command catalog 将 builtin `goal` 映射为 overlay command
- `structuredOverlayKindForAction("openGoalPanel")` 返回 `goal`

Web 状态栏新增一个紧凑 goal chip，位置在 connection/model/context 元信息附近。常驻 chip 只显示状态，完整 objective 在 Goal 面板中显示。显示规则：

- active：`goal active`
- paused：`goal paused`
- 无 goal：不渲染

点击 chip 打开 Goal 面板。chip 可通过 `title` 暴露完整 objective，避免状态栏拥挤。

Goal 面板复用 `.ohb-structured-*` 类族，作为 structured overlay 的一个 body，不新增新的 card 系统。

## 5. Data Flow

### 5.1 Snapshot and Event Projection

1. 后端 snapshot 包含 `goals?: UiSessionGoal[]`。
2. 后端 `goal.updated` 事件携带 `{ sessionId, goal }`。
3. CLI store 与 Web reducer 已经把 `goal.updated` 投影进 snapshot。
4. CLI/Web selector 从 snapshot 中按 active session 选出一个 goal。
5. UI 根据 goal 是否存在决定是否显示状态。

### 5.2 Web Slash Command Flow

1. 用户输入 `/goal`、`/goal pause`、`/goal resume`、`/goal cancel` 或 `/goal replace <text>`。
2. 无论从 slash palette 选中还是直接回车提交，Web 都通过 catalog + slash resolver 解析为 builtin `goal`，不做任何硬编码文本匹配。直接提交路径对所有 overlay 命令（goal/compact/connect）通用：解析到 overlay 命令即打开对应面板，而不是报错。
3. Web 不立即调用 `executeSlashCommand` 执行该 invocation。
4. Web 打开 Goal 面板，并从 resolver 的 rawArgs 推导 initial intent：
   - empty/status：只打开面板
   - pause：高亮 Pause
   - resume：高亮 Resume
   - cancel：高亮 Delete（不提供 `delete` 别名，子命令词表与后端一致）
   - replace：预填 objective 编辑框
   - arbitrary objective：预填 objective 编辑框，作为 create/replace 草稿
5. 用户点击面板按钮后，Web 才通过 `client.executeSlashCommand`（携带 `allowOverlay`）执行真正命令；client 对未携带 `allowOverlay` 的 overlay 命令保持报错，作为兜底守卫。

### 5.3 Web Panel Action Flow

- Save：
  - 若当前有 goal：执行 `/goal replace <objective>`
  - 若当前无 goal：执行 `/goal <objective>`
- Pause：执行 `/goal pause`
- Resume：执行 `/goal resume`
- Delete：执行 `/goal cancel`

命令结果仍进入既有 command notice 流。面板同时用本地 status line 展示 pending/success/error，避免用户不知道按钮是否生效。

## 6. UI Detail

### 6.1 CLI Compact Status

CLI 状态只展示状态词，不展示 objective：

```text
goal active · auto · default · session_...
goal paused · auto · default · session_...
```

颜色：

- active：`theme.status.accent`（skyBlue，与 Web 的蓝色 accent 对应；不用 `theme.status.running`，它与 warning 同为黄色系，两态会难以区分）
- paused：`theme.status.warning`

goal 段以独立 `<Text>` 着色渲染，其余 dock status 保持 dim。状态行不能换行挤压 prompt；终端宽度不足时仍允许现有 dock status 自然截断。

### 6.2 Web Status Chip

Web chip 使用现有 status pill 的克制风格：白底、hairline 边框、mono 字体，尺寸节奏与 connection pill 对齐（12px / 6px 12px padding），但不用彩色底，保持在 connection pill 之下的视觉层级。常驻文本只展示状态，全小写：

```text
goal active
goal paused
```

状态用圆点的形态编码，不引入第二种色相：active 为实心蓝点（`#5f86c4`，即应用唯一 accent），paused 为同色空心圆环（实心=运行中，空心=挂起）。不使用琥珀/黄色系。

chip 是 button，具备 `title` 展示完整 objective 与 hover/focus-visible 态；面板内展示并编辑 objective。

### 6.3 Web Goal Panel

面板结构：

```text
Goal
Status        active
Objective     [textarea]
Pause reason  interrupted          (only when paused and pauseReason exists)

[Delete goal]          [Pause] [Resume] [Save]
```

按钮规则：

- Pause：仅 active goal 可用
- Resume：仅 paused goal 可用
- Save：objective 非空时可用
- Delete：仅存在 goal 时可用

Delete 是唯一的破坏性操作且首版不弹确认，因此在布局上与其余按钮物理隔离：置于行首并以 `margin-right: auto` 推到最左，文字用既有的 muted 红（`#c4756b`，同 stop button）。文案使用 `Delete goal`，执行 `/goal cancel`，表示从 UI 角度移除当前 goal。

子命令 intent（`/goal pause` 等）打开面板时，对应按钮获得 autofocus 与蓝色 focus 系高亮（复用输入框 focus ring 的颜色），用户回车即可执行，键盘流不中断；`replace`/arbitrary objective intent 则 autofocus objective 编辑框。

## 7. Constraints and Trade-offs

- 采用 `openGoalPanel` 作为 Web command action，会扩展 SDK Web command contract；代价是 SDK/Web 测试需要同步更新，收益是 Web 不需要把 `/goal` 子命令误当成直接执行命令。
- CLI 只显示 status，不显示 objective；代价是用户要 `/goal status` 才能看详情，收益是终端输入区稳定、低噪音。
- Web 面板通过既有 command API 执行动作，而不是新增 goal-specific RPC；代价是面板需要构造 slash invocation，收益是复用权限、命令事件、notice 与后端行为。为此服务端 `/v1/commands` 在 passthrough/skill 之外单独放行 `goal`（SDK `supportsWebOverlayCommandInvocation`，可执行 overlay 白名单目前仅 goal）；connect/connect-search/compact 仍被拒绝，它们的面板走专用 RPC。
- 不新增 visual card system；这限制了面板表现力，但降低了 UI 偏移和维护成本。

## 8. Test Plan

遵循 `docs/goals/test.md` 中的项目测试约束：unit/contract 为主，不调用真实 LLM。

### 8.1 SDK Contract

- `filterWebCommandCatalog` 将 builtin `goal` 暴露为 `executionKind: "overlay"` 与 `action: "openGoalPanel"`。
- Web passthrough allowlist 不把 `goal` 当作直接 passthrough command。

### 8.2 CLI TUI

- selector 能按 active session 找到当前 goal。
- `Prompt` 在存在 active goal 时渲染 `goal active`。
- `Prompt` 在存在 paused goal 时渲染 `goal paused`。
- 无 goal 时不渲染 goal 状态。

### 8.3 Web Reducer and Selectors

- `selectViewModel` 暴露 active session goal 给状态栏和面板。
- `goal.updated` 删除事件后，状态栏不再显示 goal。

### 8.4 Web UI

- `/goal` palette item 打开 structured Goal 面板，不直接执行 command。
- `/goal pause` 打开 Goal 面板并高亮 Pause。
- Goal chip 点击打开同一面板。
- Save/Pause/Resume/Delete 按钮调用对应 goal command。
- 面板复用 `.ohb-structured-*` 类族；测试检查关键 class，而不是视觉快照。

### 8.5 Manual Verification

- `pnpm build`
- `pnpm start`
- CLI：创建/暂停 goal 后检查 prompt 附近状态行；cancel 后状态消失。
- Web：输入 `/goal` 打开面板；编辑 objective、pause/resume/delete；确认状态栏同步更新。

## 9. Implementation Order

1. SDK：扩展 Web command action 与 catalog projection。
2. CLI：添加 active goal selector 与 prompt status label。
3. Web selectors：向 ViewModel 暴露 active goal。
4. Web overlay：新增 Goal 面板 body，复用 structured overlay。
5. Web slash flow：拦截 goal overlay action，解析 argv 为 panel initial intent。
6. Tests：按第 8 节补充并运行相关 unit/contract 测试。

## 10. First-Version Decisions

- Goal 面板的 Delete 不弹 `window.confirm`。按钮文案使用 `Delete goal`，执行后通过 command notice 与面板 status line 反馈；误触风险由布局隔离（Delete 独占最左）承担。
- Objective 编辑不实时保存。首版只在点击 Save 时保存，避免用户输入过程中触发 replace。
- Web empty state 显示 goal chip。若 snapshot 有 active session goal，即使消息为空也显示；无 active session 不显示。
- 面板打开期间，若另一端（如 CLI `/goal replace`）更新了 objective，面板会以最新值重置未保存的本地草稿。首版接受该覆盖行为：单人使用下冲突罕见，且以后端为准比静默分叉更安全。
- intent 词表只接受后端子命令（`status`/`pause`/`resume`/`cancel`/`replace`），不提供 `delete` 等 UI 侧别名，避免 UI 与命令行为词表漂移。
