# Web 工具失败呈现（一张卡 + bash UI `failed`）

> 状态：**代码实施与自动化验收完成，待肉眼验收。** 详见 [`05-implementation-acceptance.md`](./05-implementation-acceptance.md)。  
> 实施 git 分支（与流式时序共用）：`codex/web-tool-transcript`。  
> **必须先完成** [`../2026-08-18-web-stream-tool-order/`](../2026-08-18-web-stream-tool-order/README.md) **的全部 commit**，再做本议题。

## 1. 议题

工具失败时 Web 把 `tool-call` 和 `tool-result` 画成两张卡，失败结果标题是 `result ${callId}`（内部 ID），像调试面板。`list` 抛错已经是 `failed`，但卡片拆件；`bash` 非零退出在调度器里仍是 `success`（失败写在 `metadata`），UI 看起来像成功。用户确认：**UI 上 bash 失败就是 `failed`**；调用和结果合成一张卡；不暴露 `callId`。

本批改 **agent 的 UI 投影**（直播 + 持久化 snapshot）和 **Web 工具卡呈现**。不改 bash 工具对模型的返回合同，不做按工具名定制的豪华卡。

## 2. 文档地图

| 文档 | 作用 |
|------|------|
| [00-discussion.md](./00-discussion.md) | 冻结已确认的产品行为与边界 |
| [01-problem-analysis-and-current-state.md](./01-problem-analysis-and-current-state.md) | 以当前代码为基线的问题与根因 |
| [02-optimization-plan-and-change-scope.md](./02-optimization-plan-and-change-scope.md) | 实施契约：方案、改动面、分阶段 DoD |
| [03-reference-projects.md](./03-reference-projects.md) | OpenCode / Kimi CLI / 本仓库 TUI 的结构对照 |
| [04-test-and-acceptance.md](./04-test-and-acceptance.md) | 单测、手工验收与发布门 |
| [05-implementation-acceptance.md](./05-implementation-acceptance.md) | 实施结果、自动化证据与剩余手工验收 |

推荐阅读顺序：`00 → 01 → 02 → 03 → 04`。实施以 `02 + 04` 为准；与 `00` 冲突时先改文档再改代码。

实施结果与验收证据统一写入 `05-implementation-acceptance.md`。

## 3. In scope

- 投影：用一个共享 outcome projector，把调度器状态、metadata 与 exitCode 一次性折叠为 `{ status, error? }`，直播与 snapshot 不得各写一套判断。
- 调度器失败，或 shell/job metadata 终态为 `failed | timed_out | cancelled`，或数字 `exitCode !== 0` → `UiToolCall.status = "failed"`，并写一句短 `result.error`。UI 协议没有 timeout/cancelled 独立状态，因此两者折叠为 failed，但摘要保留差异。
- 判定按 metadata / exitCode，不写死工具名（`bash` / `task_output` / `task_kill` 同类受益）。
- Web：`pairToolCallResult` 一次调用一张卡；标题用工具名；摘要用 path/command；右侧 `running` / `completed` / `failed`；失败用红皮肤；标题、meta、摘要、aria/data 属性等 UI 自生成字段**不使用 callId**（原始工具 output 若恰含同串不在禁止范围）。
- 短错误（无/很短 output）默认展开正文；若卡片在直播中由 `running` 变成短 `failed`，也要自动展开一次；长输出默认折叠。
- 正文优先使用非空 output；output 为空字符串时回退到短 error，避免“已展开但空白”。
- output 保留边界：`completed + metadata.failed` 必须保留既有 output；`aborted` 若已有 output 也保留；普通 `ToolState.error` 当前没有 output 字段，不能承诺恢复不存在的数据。
- TUI **不改组件**；共享投影变红后，TUI 现有 `call.status === "failed" \|\| result.error` 会自动跟着变（已确认接受）。

## 4. Out of scope

- 流式 parts 顺序 / 幽灵消息 / React key → [流式时序](../2026-08-18-web-stream-tool-order/README.md)。
- 改 `bash.execute()` 使非零退出 throw（会改变模型看到的内容）。
- 按工具名做 SEARCH / READ / EDIT 豪华卡（`docs/ohbaby-web/ui/components.md` 里的后话）。
- 抽取 sdk 共享卡片组件。
- 把 failed 判断只放在 Web（会造成直播 / 刷新 / TUI 三套说法）。

## 5. 与现有文档的关系

| 文档 | 关系 |
|------|------|
| [ohbaby-web goals-duty](../../ohbaby-web/goals-duty.md) | G3 与 TUI 行为一致；ND3 不重定义领域——`failed` 是 UI 投影标签，不是改工具合同 |
| [ohbaby-web ui/components](../../ohbaby-web/ui/components.md) | 已规定「一张可折叠工具卡」；现状画成两个协议零件。本批对齐「一张卡」，不做三类豪华皮肤 |
| [ohbaby-web ui README](../../ohbaby-web/ui/README.md) | 「不暴露诊断行」；本批不在卡片上画 callId |
| [流式时序](../2026-08-18-web-stream-tool-order/README.md) | 姊妹议题；同一 git 分支、必须先做完 |

## 6. 开发闸门

1. [x] 用户审阅并确认本目录 00–04。
2. [x] 流式时序 problem-list 的 02/04 已在同一分支落地。
3. [x] 按 02 完成 Phase A（投影）、B（配对卡片）、C（短错误展开）。
4. [ ] 按 04 完成验收：自动化已通过，真实浏览器/TUI 肉眼项待执行。
5. [ ] 独立验收会话对照 02/04 出具结论（可选）；写入 `05-implementation-acceptance.md`。
