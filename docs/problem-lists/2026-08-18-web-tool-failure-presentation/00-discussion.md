# 讨论记录与已确认要点

> 2026-08-18 与用户讨论定稿。正式方案见 01–04。

---

## 1. 背景与动机

工具失败时 Web 渲染不到位：成功调用还能看出工具名和输出，失败时出现红色 `result <callId>` 卡片，把内部 ID 和原始 `ENOENT` 摊在折叠条上。用户指出 bash 尤其明显。讨论后拆成两层：呈现（调用/结果拆成两张卡）和语义（bash 非零退出在 UI 协议里仍是成功）。

## 2. 已确认：目标与范围

| 决策项 | 结论 |
|--------|------|
| bash 非零退出 | **UI 上就是 `failed`**；不让 bash 工具 throw |
| TUI | **跟着变红**：只改共享投影，不改 TUI 组件 |
| failed 判定 | 调度器失败 **或** metadata 终态为 `failed / timed_out / cancelled` **或** 数字 `exitCode !== 0`；不写死 bash 名字 |
| 失败摘要 | 一句短的：`error.message` / `metadata.error` / `timed out` 或 `cancelled` / `exit code N` / `"failed"` |
| 默认展开 | **长输出不展开**；短错误初次渲染时展开；直播中 `running → failed` 且正文很短时也自动展开一次。短的固定定义：trim 后同时满足 `≤ 400` 字符且 `≤ 8` 行 |
| 正文来源 | 优先非空 output；`output === ""` 时回退到短 error，不能用空字符串挡住 error |
| output 边界 | `completed + metadata.failed` 保留 output；`aborted` 的可选 output 也保留；普通 `ToolState.error` 无 output 字段，不虚构可恢复内容 |
| callId | UI 自生成的标题、meta、摘要、aria/data 属性均不用 callId；原始工具 output 若恰好含同串不属于泄露 |
| 卡片 | 一次调用一张卡（配对 tool-call + tool-result） |
| 落点 | `docs/problem-lists/2026-08-18-web-tool-failure-presentation/` |
| 批次 | 单批；建议三笔 commit：投影 → 配对卡片 → 短错误展开 |
| git | 与时序议题共用 `codex/web-tool-transcript`；**本议题实施全部排在时序议题之后** |
| 前置 | 流式时序 problem-list 先落地（parts 顺序正确后再改卡片） |

## 3. 已确认：产品行为

| 场景 | UI |
|------|-----|
| `list` 路径不存在（抛错） | 一张 `list` 卡，`failed`，短错误可见；无 `result 123` 卡 |
| `bash` exit ≠ 0 | 一张 `bash` 卡，`failed` + 短摘要（如 exit code）；output 仍可展开 |
| `bash` timeout / cancelled | 一张 `bash` 卡，UI 状态 `failed`，摘要分别为 `timed out` / `cancelled`；output 若有仍可展开 |
| `bash` exit 0 | 仍是 `completed`，不是 failed |
| 刷新 / snapshot | `completed + metadata.failed` 仍是 failed 且 stdout 还在；aborted 已有 output 也不清空 |
| 后台 job（`task_output` 等同类 metadata） | 同一套判定，不单独开例外 |

## 4. 已确认：边界（不做的事）

| 项 | 本批不做 |
|----|----------|
| 改 bash `execute()` 返回合同 | 模型仍要完整 stdout / exitCode |
| 只在 Web 判断 failed | 直播、刷新、TUI 会各说各话 |
| 按工具名豪华卡（SEARCH/READ/EDIT） | 设计后话；本批统一一张卡 + 成败两张皮 |
| 抽 sdk 共享卡片 | 与时序议题同一 YAGNI |
| 失败一律展开整段 output | 长 stderr 会撑爆会话流 |
| 流式 parts 顺序 / key / 幽灵消息 | 上一份 problem-list |

## 5. 已确认：与时序议题的关系

- 文档：两份并列 problem-list，互不嵌套。
- 实施：同一临时分支；时序 commit 全部完成后再做本议题。
- 时序保证「零件排对」；本议题保证「失败不要画成零件说明书，bash 在 UI 上是 failed」。

## 6. 用户确认记录

- 2026-08-18：确认 bash UI 为 `failed`；TUI 随投影变红；判定不写死工具名；短摘要；长输出不自动展开、短错误可展开；UI 自生成文案不暴露 callId；两份 problem-list；共用临时分支。
- 2026-08-18 开发前终审：冻结 metadata 的 `failed / timed_out / cancelled` 均折叠为 UI failed，并用摘要保留差异；原因是现 UI 协议没有独立 timeout/cancelled 终态。
- 2026-08-18：补充确认实现契约：直播 `running → failed` 的短错误应自动展开；空 output 回退 error；不对类型中不存在的 error output 作恢复承诺。
