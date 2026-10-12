# 第 4 批参考项目与取舍

> 2026-10-12。定位与取舍以 [plan 03](../plan/03-reference-projects.md) 为准，本文只挑本批相关的小范围，写清**不照搬**的部分。
> 本地参考根目录 `/Users/hansun025/Projects/code-cli/`，只读本地检出版本，不把它当作质量验证。

## 3.1 借鉴来源（本批相关）

| 项目 | 路径 | 本批看的点 |
| --- | --- | --- |
| Pi | `pi/packages/coding-agent/src/core/compaction/compaction.ts`、`core/settings-defaults.ts` | 固定保留段口径、切点对齐、旧摘要继承 |
| ZCode | `ZCode/apps/zcode-cli/packages/core/src/runtime/helpers/compact-selection.ts` | 按交互组保留尾段 |
| 本地 claude-code | `claude-code/src/services/compact/compact.ts`、`components/`（重建版，非官方） | 手动 compact 的压前／压后显示、占用刷新时机 |
| Gemini CLI | `packages/core/src/context/chatCompressionService.ts` | “压完没变小”拒绝 |

## 3.2 可借鉴点（adopt / adapt）

| 项目 | 做法（实际读到） | ohbaby 取舍 |
| --- | --- | --- |
| Pi | 保留段固定 `keepRecentTokens: 20000`（`settings-defaults.ts:11`），`findCutPoint`（`compaction.ts:446`）从最新往前累计到预算、在合法边界停 | **adapt**：采用“固定 20K＋对齐合法边界”口径，数字同为 20K；但 Pi 不主动补用户轮、也无第二档上限，ohbaby 也不加第二档 |
| Pi | 更新摘要走 `previousSummary` 路径：`UPDATE_SUMMARIZATION_PROMPT`（`:577`）把旧摘要放进 `<previous-summary>` 合并，`previousSummary` 在 `:653/:730` 传入 | **adapt**：采用“新摘要继承旧摘要”的方向；ohbaby 的载体是“读全部活动旧摘要一起进摘要请求”，不照搬它的 entry 结构与提示词措辞 |
| ZCode | `selectCompactEntries`（`compact-selection.ts:31`）按交互组分组，保留最近若干组 | **adapt**：采用“整组保留、不拆 call/result”的思想；ohbaby 按 token 预算而非固定组数选尾段，不照搬它的 `groupsToPreserve` 计数逻辑 |
| 本地 claude-code | 手动 `/compact` 完成消息给 `Context: ~X → ~Y tokens`；自动路径只插分隔消息 | **adapt**：ohbaby 手动与自动**统一**都给压前／压后占用 |
| Gemini CLI | 压完重算真实 token，变大即拒绝（`chatCompressionService.ts:696`，重建版参照） | **adopt 思想**：ohbaby 保留“占用必须下降”硬门槛；**不 adopt** 它的 `hasFailedCompressionAttempt` 闩锁（与“不增加永久失败锁”冲突） |

## 3.3 明确不借鉴（reject）

- **Reasonix 的保留段收缩循环**：`planCompaction` 是对固定 16% 窗口预算逐步缩到装得下、可缩到零尾段（`tailFloor=0`），也不处理“压后重建仍超窗”。ohbaby 只记“收缩保留段”这一**先例存在**，用“一次按缺口算＋下限＝最近完整交互组”，**不学循环、不学零尾段**（见 [plan 03 §5.5](../plan/03-reference-projects.md)）。
- **Kimi 的 `preShrinkHistoryToWindowBudget`**：它裁的是**发给摘要模型的输入副本**，属于模式 A，不是模式 B，不能拿来当“压后收缩保留段”的依据（见 [plan 03 §5.2](../plan/03-reference-projects.md)）。
- **40K／窗口 30%**：本批只用一个固定 20K，不加第二档（plan 03 §4 已确认）。
- **claude-code／opencode 的“压后不立即重算占用”**：两家都等下一轮真实 usage。ohbaby 占用本来就是本地估算口径，所以**提交后立即刷新**，但要写明是估算、下一轮校正（plan 03 §5.1）。
- **渐变进度条／完成 toast／用量面板**：不引入，复用现有 spinner 与消息流提示。

## 3.4 对 02 方案的影响

直接来自参考的决策：20K 固定口径（Pi）、整组不拆（ZCode 与各家共识）、“占用必须下降”门槛（Gemini 思想，去闩锁）、压前／压后显示（claude-code 手动路径，ohbaby 统一化）。其余（模式 A／B 分流、无进展地板、失败终止、遗漏 metadata、`modelRequests` 归属）是 ohbaby 自身取舍，参考项目只支持局部选择，不构成“行业最优”。
