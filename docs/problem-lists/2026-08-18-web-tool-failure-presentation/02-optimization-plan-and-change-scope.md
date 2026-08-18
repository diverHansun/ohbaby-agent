# 2. 优化方案与改动面

> 给后续开发会话的执行契约。本规划会话不写代码。  
> **前置**：同一分支上 `2026-08-18-web-stream-tool-order` 的 02 已落地（parts 顺序正确）。

## 2.1 方案总览

分两刀，产品上都叫「失败呈现」，代码上不要混：

1. **投影（ohbaby-agent adapters）**：把「人应看成失败」折进已有 UI 字段 `UiToolCall.status = "failed"` 和一句 `UiToolResult.error`。直播（`run-stream-adapter`）和 snapshot（`persistent-store`）调用**同一个 outcome projector**，一次返回 `{ status, error? }`，避免“状态判断”和“摘要生成”两个 helper 被调用方拼错。
2. **Web 视图**：按 TUI `pairToolCallResult` 把 call+result 画成一张卡；标题用工具名；摘要用主 input；右侧状态；失败红皮肤；不画 callId。短错误初次失败或直播 `running → failed` 时自动展开一次，长输出折叠。

不改 bash 工具合同、不扩展 `UiToolResult.metadata`、不抽 sdk 卡片。TUI 组件不动；吃到更好的 snapshot/live parts 后自动变红。

```text
ToolCallResult / ToolState
  → projectUiToolOutcome                （新 helper）
       failed? → call.status=failed, result.error=短摘要, output 原样
  → parts: tool-call + tool-result（协议仍两段，视图再配对）

Web MessageRow
  → pairToolCallResult(parts)
  → 一张 ToolCard（失败红；短错误展开）
```

## 2.2 设计决策表

| 决策项 | 选择 | 理由 | 放弃的选项 | 代价 |
|--------|------|------|------------|------|
| failed 判定 | 调度器非 success，或 metadata.status 属于 `failed / timed_out / cancelled`，或数字 exitCode 非 0 | UI 只有 failed 终态；不写死 bash；timeout 常是 null exitCode | 只判断 bash 名或只看 exitCode | 漏 job/timeout |
| 短摘要 | `error.message` → 字符串 `metadata.error` → status 专用 `timed out/cancelled` → `exit code N` → `"failed"` | 标题短，但保留 timeout/cancel 差异 | 把 stdout 前几行当标题 | bash 又长又吵 |
| 协议是否加 metadata | 不加 | 折叠进现有字段 | `UiToolResult` 加 metadata | sdk 变更面大 |
| 判定放哪 | agent 投影 helper，直播+snapshot 共用 | 00：不要第三套 Web if | 只改 Web | 刷新/TUI 仍错 |
| TUI 变红 | 接受（不改 TUI 文件） | G3；数据对了现逻辑就会红 | 为 TUI 再投影一份「假成功」 | 双协议 |
| 配对 | Web 复制 TUI 函数，可放 `src/ui/tool-card.tsx` | App.tsx 已过大 | 继续堆在 App.tsx | 上帝文件更肿 |
| 抽 sdk pair 函数 | 本批不抽 | 与时序 YAGNI 一致 | 立刻共享 | 跨包 |
| 长失败 output | 默认折叠 | 防撑爆 | 失败一律展开 | 会话不可读 |
| 短失败 | trim 后正文同时满足 `≤ 400` 字符且 `≤ 8` 行则展开；也监听 `running → failed`，只自动展开一次 | list ENOENT 一眼能看见；覆盖直播原地更新 | 只靠 `useState(initial)` | initializer 不会响应后续失败 |
| 正文选择 | `nonEmpty(output) ?? error ?? ""` | `output` 是必填字符串，空串不能挡住 error | `output ?? error` | 展开空白 |
| callId | UI 自生成标题/meta/摘要/aria/data 不使用；原始 output 不扫描 | 00 + 不暴露诊断，同时避免误伤真实输出 | 展开区小字 | 仍像调试器 |
| bash throw | 不 | 模型要 stdout | 改 execute | 改领域合同，不可取 |

不可逆决策：**无。** sdk 不改字段；DB 仍存 completed+metadata。只是投影变了，回滚 helper 即回到「bash 看起来像成功」。

## 2.3 分阶段实施

### Phase A · 投影：UI failed + 保留 output

- **目标**：bash/`task_*` 的 failed、timed_out、cancelled、非零 exit，以及调度器 error，在 live 与 snapshot 上都是 UI `failed`，摘要保留具体原因，已有 output 还在。
- **改动文件**
  - **新增** `packages/ohbaby-agent/src/adapters/ui-state/tool-ui-outcome.ts`（或 adapters 内无循环依赖的同级位置）。只导出一个主入口，例如 `projectUiToolOutcome(input)`：输入先归一为 status + metadata + error，返回 `{ status, error? }`；同一 projector 同时服务 `ToolCallResult` 与 `ToolState`。
  - `packages/ohbaby-agent/src/adapters/ui-runtime/run-stream-adapter.ts`：先给本地 `ToolResultPayload` 补上 `metadata?: Record<string, unknown>`（上游序列化结果已携带），再让 `appendToolResult` 用 projector 设 `call.status` 与 `result.error`；`output` 仍 `result.output ?? ""`。
  - `packages/ohbaby-agent/src/adapters/ui-state/persistent-store.ts`：`toolCallStatus` / `toolResultPart` 对 `completed` 也要读 metadata。`aborted` 若带 `output` 必须保留。普通 `error` 态的 `ToolState` 类型本身没有 output 字段，则继续为空；**禁止**在 `completed`（含 metadata 失败）或 `aborted` 已有 output 的路径把内容写成 `""`。
  - 单测：新建 `tool-ui-outcome.unit.test.ts`；扩展 `run-stream-adapter.unit.test.ts`（exitCode 1 → failed 且 output 在）；扩展 persistent-store 单测/集成测（completed+metadata.failed；aborted 已有 output）。
- **DoD**：04 FP-1–FP-5、FP-13、FP-14。TUI 无需改文件即可在吃 snapshot 时显示 shell/job failed（可用现有 TUI 单测喂 failed status；本 Phase 至少保证 UiMessage 字段）。

### Phase B · Web 一张卡

- **目标**：DOM 中不再出现 `result <callId>` 标题；一次调用一张卡。
- **改动文件**
  - **新增** `apps/ohbaby-web/src/ui/tool-card.tsx`（及 `tool-card.unit.test.tsx`）：移植 TUI `pairToolCallResult` 语义；`ToolCard` 标题=`call.name`，摘要=与 TUI 相同的主字段（`command` / `file_path` / `path` / `query` / `prompt`），meta=`call.status`（pending/running/completed/failed），失败或 `result.error` 用红皮肤（现 `.ohb-tool-red`）。
  - `apps/ohbaby-web/src/ui/App.tsx`：`MessageRow` 先 pair 再渲染；删除或停止使用「result ${callId}」的 `MessagePart` 分支；`toolAccent` 不再作为失败色来源（失败看 status）。
  - `App.unit.test.tsx`：失败 list 只有一个 `.ohb-tool-panel`；文案含工具名与 failed，**不含** `result 343259142` 这类标题。
- **DoD**：04 FP-6、FP-7、FP-9、FP-10。截图那种双红卡消失。

### Phase C · 短错误初始与状态跃迁展开

- **目标**：list ENOENT 一类短错误不用点 chevron；无论卡片首次就是 failed，还是直播从 running 变 failed，都能看见；长 bash 日志默认折叠。
- **正文规则**：先取 trim 后非空的 `result.output`，否则取 `result.error`，否则空字符串；禁止 `(result.output ?? error)`，因为空字符串不会触发 `??` 回退。
- **状态规则**：初始 failed+短正文可设 open；另用前一状态/ref 或等价状态机捕捉 `running/pending → failed`，在短正文时自动打开一次。用户在失败后手动折叠，后续普通 rerender 不得反复弹开。
- **阈值**：固定为 `SHORT_FAILURE_MAX_CHARS = 400`、`SHORT_FAILURE_MAX_LINES = 8`，两者同时满足才算短；04 必测 400/401 字符与 8/9 行边界。
- **DoD**：04 FP-8、FP-11、FP-12。

## 2.4 按包/目录的改动面

| 包/目录 | 新增 | 修改 | 删除 | 说明 |
|---------|------|------|------|------|
| `packages/ohbaby-agent/src/adapters/ui-state/` | `tool-ui-outcome.ts` + unit test | `persistent-store.ts` | 无 | 单一 outcome 投影 + 有界保留 output |
| `packages/ohbaby-agent/src/adapters/ui-runtime/` | 无 | `run-stream-adapter.ts` + unit test | 无 | 直播 |
| `apps/ohbaby-web/src/ui/` | `tool-card.tsx` + `tool-card.unit.test.tsx` | `App.tsx`、`App.unit.test.tsx`、必要时 `styles.css` | 无 | 配对；尽量复用 `.ohb-tool-*` |
| `packages/ohbaby-cli` | 无 | 无 | 无 | 只消费更好的 parts |
| `packages/ohbaby-sdk` | 无 | 无 | 无 | 不加 metadata 字段 |
| `packages/ohbaby-agent/src/tools/bash.ts` | 无 | 无 | 无 | |

## 2.5 API / 协议 / 迁移与兼容

- **不改** SSE 事件 type。`message.updated` 里的 parts 仍是 call+result 两段；变的是 `status` / `error` / `output` 内容。
- 旧 DB：bash 失败仍是 `ToolState.completed` + metadata；新 snapshot 代码读 metadata 即可，**不用 migration**。
- 旧 Web 客户端若未升级：仍两张卡，但 bash 会开始显示 `failed`（因投影先上）。可接受；实施顺序仍是 A 然后 B。
- 对模型的 tool 消息：仍走 `tool-metadata-projection`，本批不改。

## 2.6 风险与回滚

| 风险 | 缓解 | 回滚 |
|------|------|------|
| `exitCode: 0` 被标 failed | exit 分支必须 `!== 0` 且是 number；null 自身不当失败 | revert projector |
| metadata 终态集合漂移 | 集中常量只含 `failed/timed_out/cancelled`；running/completed 不失败 | 单测 |
| 两套投影漏改一处 | 强制共用单一 projector，禁止 adapter 内联 if | code review |
| 配对漏掉「有 result 无 call」 | 与 TUI 一样保留未配对 result 的 fallback，但标题仍禁止 callId（可用 `result` 或工具未知） | 单测 |
| 短/长阈值争议 | 常量 + 04 写死；只影响默认展开 | 改常量 |
| 直播失败后反复自动展开 | 只响应一次非失败→失败跃迁；测试用户手动折叠后 rerender | revert Phase C 状态逻辑 |
| TUI 用户不适应 bash 变红 | 00 已确认这是正确产品 | 只能 revert Phase A |

## 2.7 与 00 边界对齐检查

| 00 结论 | 02 落点 |
|---------|---------|
| bash UI failed | Phase A |
| TUI 随投影变红 | Phase A，不改 cli 组件 |
| 判定含 scheduler、metadata 失败终态与 exitCode | §2.2 + projector |
| 短摘要 | `projectUiToolOutcome` 的 `error` |
| 长输出不展开 / 短错误展开 | Phase C |
| callId 不露 | Phase B |
| 一张卡 | Phase B |
| 不改 bash.execute | §2.8 |
| 不抽 sdk | §2.2 |
| 时序议题先做 | 文首前置 |

## 2.8 不在本批

- `2026-08-18-web-stream-tool-order` 的 reducer / key / 幽灵消息
- bash `execute()` throw
- `UiToolResult.metadata`
- SEARCH/READ/EDIT 豪华卡
- sdk `pairToolCallResult`
- 为「TUI 保持 bash 看起来像成功」做双投影
