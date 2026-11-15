# 06 数据、接口与状态

字段以 SDK 契约 [shell-job.ts](../../../packages/ohbaby-sdk/src/contract/shell-job.ts) 为准。大部分数据层能力已在 Web 版实现，TUI 尽量复用，只补终端特有的部分。

## 1. 接口到界面的映射

TUI 用进程内客户端（`UiBackendClient`），调用和 Web 相同的三个方法。进程内代理已转发这些方法（`packages/ohbaby-sdk/src/in-process-rpc/proxy.ts`）。契约里 `runtimeEpoch`、`bindingGeneration` 是可选的，SDK 读取器本来就不传，TUI 也不传。

| 接口 | 谁在用 | 怎么用 |
|---|---|---|
| `listShellJobs({ mode: "background-or-unconfirmed", owner: main/subagents, limit: 1 })`，两个并行 | 会话级探测：`/bg` 能否打开、提示行运行数、筛选是否可用、默认筛选 | 只读 `statusCounts` |
| `listShellJobs({ mode: "background-or-unconfirmed", owner?, limit: 30, cursor? })` | 面板列表 | 用 SDK 的 `createShellJobListReader` |
| `getShellJobOutput` | 详情 | 运行中或结果尚未就绪时每 2 秒轮询 |
| `stopShellJob` | 确认后的取消 | 返回后不直接改行，等列表或输出刷新 |
| 事件 `shell-jobs.invalidated` | 探测、列表 | 节流，最多 2 秒一次（Web 06 §3.2） |
| `session.resync-required` | 探测、列表、详情 | 立即刷新 |

提示行的运行数取探测结果里两个 `statusCounts.running` 之和。

bash 标签的 `· background` 不请求接口，只读工具结果 `details.kind === "bash"`、`details.mode === "background"`、`details.jobId`。

## 2. 共用视图函数（T10）

Web 的 `apps/ohbaby-web/src/ui/side-panel/background-tasks/task-view.ts` 都是纯函数：`taskTitle`、`taskGroup`、`canCancel`、`managedElsewhere`、`taskElapsed`、`shortDuration`、`taskTrailing`、`taskStatusLine`、`taskNotes`、`taskOutputView`、`groupCounts`、`totalCount`。

做法：挪到 `packages/ohbaby-sdk/src/util/shell-job-view.ts`，从 SDK 导出；Web 改为从 SDK 引入，单元测试随之搬家。TUI 直接用。这样状态行、说明行、时长格式只有一份。

TUI 自己只加一个终端专用的转换：

```ts
/** 列表一行：按宽度截断说明和命令，时长或失败字样永远完整。 */
function taskRowText(item: UiShellJobRow, now: number, width: number, showOwner: boolean): {
  readonly left: string;      // 说明 + 命令 + 启动者，已截断
  readonly trailing: string;  // 时长、Failed、Timed out、Unknown 或 Cancelling…
};
```

宽度计算用现有 `visibleWidth`，传入的 `width` 是内容宽（`contentWidth`）。尾列固定 11 列，命令列阈值和截断顺序见 03 §4.2、§5。

## 3. 状态策略

### 3.1 读取与订阅

Web 的 React hook（`useShellJobRefresh`、`useBackgroundTaskProbe`）放在 Web 包里，TUI 不能直接引用。TUI 在自己的包里写同样逻辑的 hook，规则照搬 Web 06 §3：

- 探测：两个 `limit: 1` 的读取器，会话打开期间存在；结果未知或失败时沿用上次结果。
- 列表：面板打开期间存在（进入详情也保留）；查询变了才取消旧请求，同查询的刷新排队合并。
- 失效事件节流 2 秒。终端没有“页面在后台”的概念，不做可见性判断。

如果实现时发现两份 hook 几乎逐行相同，可以把与 React 无关的节流器挪进 SDK，两边各自包一层 hook。本轮不强制。

### 3.2 输出轮询

和 Web 06 §3.3 相同：详情打开且任务仍运行，或 `resultReadyAt` 仍为空时轮询，间隔 2 秒，上一次返回后才计时；终态且结果就绪后才停止；失败暂停，等 `r`；离开详情、关闭面板时取消请求。冻结（往上滚）只影响显示位置，不停止轮询。

### 3.3 分页

每页 30 行，选择移到最后一行时加载下一页；失效刷新按已加载行数从头重读，每次最多 100 行，全部回来后一次替换（Web 06 §3.4）。

### 3.4 取消

- 按 `c` 进入确认：记下 `{ jobId, until: now + 5s }`，到期自动清除。
- 按 `y`：清除确认，记入 `cancelling: Set<jobId>`，发请求。
- `accepted`：保持，直到列表或输出里状态不再是 `running`。
- `already-terminal`：清除，刷新列表。
- 出错：清除，按 §4 显示。
- 请求 10 秒没有回应：中止请求并恢复取消入口；若列表或输出已观察到任务结束则不误报，否则提示 `System didn't respond to Cancel. Try again.`。进程内客户端可能把超时转换为 `AbortError`，因此以本次请求的超时信号判断。
- 状态挂在面板组件上，关闭面板即丢弃（后端状态为准）。

### 3.5 时钟

列表或详情里有运行中的任务时才启动 1 秒时钟。

## 4. 错误映射

| 错误 | 来源 | 表现 | 对应 04 |
|---|---|---|---|
| `SHELL_JOB_NOT_FOUND` | output、stop | 详情优先显示 `This task is no longer available.`，不再使用旧列表行展示状态或取消入口；刷新列表 | 2.3 |
| `SHELL_JOB_OTHER_BACKEND` | stop | 不提示，刷新后出现说明行 | 2.3 |
| `SHELL_JOB_CLEANUP_BUSY` | stop | 面板内一行 `ohbaby is already cleaning up this task.` | 2.2 |
| `SHELL_JOB_NOT_READY` | output | 不提示，下次轮询再试 | 2.3 |
| `SHELL_JOB_NOT_READY` | stop | 按普通错误处理 | 2.2 |
| `SESSION_SCOPE_CHANGED` | 所有 | 不提示，丢弃结果 | — |
| 其他错误 | 所有 | 面板内一行原因（用现有 `formatError`），加载类后接 ` · r retry` | 2.2、2.3 |

## 5. 主屏改动

- `store/transcript.ts` 的 `isVisibleTranscriptMessage` 加上 `runtimeInputKind !== "background-task-result"`。
- `components/message/parts/tool-display.ts`：标题后缀机制已经在这里（例如读文件的 ` · 0 lines`）。bash 结果是后台任务时追加 ` · background`（灰色）。bash 标题最多两行，命令长时要优先保留后缀，先截命令。`tool-part.tsx` 只管命令摘要，不改。
- `layout/fullscreen-shell.tsx`：删掉翻页提示三档文案，`position` 不为空时也显示分隔线；删掉 `Ctrl+B`、`Ctrl+F`、`Ctrl+Y` 的处理（T11）。保留 `Shift+PgUp/PgDn/Home/End` 和鼠标滚轮。
- `/bg`：
  - 后端命令目录 `packages/ohbaby-agent/src/commands/catalog.ts` 登记 `id: "bg"`、`surfaces: ["tui"]`；`builtin.ts` 加一条在其他界面返回 `INTERACTION_REQUIRED` 的处理（照 `btw`、`rewind`）。
  - `builtin.ts` 的 `HELP_COMMAND_ORDER` 加上 `bg`，否则 `/help` 里看不到唯一的入口。
  - `app.tsx` 在本地拦下：有会话且探测确认有任务时打开面板；否则用 `emitLocalNotice` 出 info 级通知，命令返回 completed。
- `app.tsx` 面板接线，照 `subagentBrowserOpen` 逐处加上后台任务面板的状态：
  - 全局 `useInput` 在面板打开时提前返回，和 Side chat 同级（04 §1.1）；
  - `AppShell` 的 `identity` 和 `scrollEnabled`；
  - `output` 的渲染分支（Side chat、子代理浏览器之后再加一支）；
  - 主屏提示行、todo 区和输入框的隐藏条件；
  - 当前会话变化时关闭面板（照会话变化时关闭子代理浏览器的 effect）。
  - 两个整屏面板互斥：打开一个时另一个关闭。

## 6. 测试数据

TUI 没有 Web 那样的 `?mock=` 机制，测试用假客户端：

| 场景 | 内容 | 对应 |
|---|---|---|
| 无任务 | 只有前台记录（Web D12） | `/bg` 不打开、提示行无运行数 |
| 待审批 | “一般”加一条待审批请求 | 主屏提示行不显示、面板顶部审批行 |
| 一般 | 主代理 2 个运行中（Dev server、Watch tests）、3 个已结束（Unit tests 成功、Build 失败、Type check 被取消），另有 2 条前台记录 | UC-TBG-01、03、04 |
| 子代理 | 主代理 1 个，两个子代理各 2 个 | UC-TBG-02 |
| 只有子代理 | 只有子代理有任务 | 默认 All |
| 大量 | 1 个运行中、250 个已结束 | 自动加载 |
| 特殊 | lost、清理未确认、别的后端管理、超时、owner-ended、输出超 32KiB、日志截断、无尾部 | 04 §2.3 |
| 取消错误 | `OTHER_BACKEND`、`CLEANUP_BUSY`、网络错误 | 04 §2.2 |

数据内容可以从 Web 的 `apps/ohbaby-web/src/dev/mock-shell-jobs.ts` 抽出复用；如果抽取的代价不小，TUI 测试里直接写精简版即可。

## 7. 和后端的对齐

TUI 不需要后端新增接口。只有两处后端改动：`/bg` 的命令目录登记（仅 tui），以及视图函数挪进 SDK。
