# 3. 优秀项目借鉴

## 3.1 借鉴来源

| 项目 | 路径 | 调研范围 |
|------|------|----------|
| OpenCode app（主参考） | `/Users/hansunwork26/workspace/projects/code-cli/opencode/packages/app` | `components/prompt-input/submit.ts`、`context/server-session.ts`、`pages/session/timeline/rows-current.test.ts` |
| Kimi Code VS Code Webview | `/Users/hansunwork26/workspace/projects/code-cli/kimi-code` | `apps/vscode/webview-ui/src/stores/chat.store.ts`、`event-handlers.ts`、`apps/vscode/src/runtime/session-runtime.ts`、`packages/transcript/src/model/prompt.ts` |
| DeepSeek Harness | `/Users/hansunwork26/workspace/projects/code-cli/deepseek-harness/packages/client/ui-conversation` | `src/client/input/hub.ts` 的 commitSend/restore、session send 路径 |
| ohbaby 并发权威 | `docs/problem-lists/2026-07-12-workspace-prompt-concurrency/` | queued vs conversation、预分配 `userMessageId`、FIFO/busy |
| ohbaby 当前 Web/TUI | `apps/ohbaby-web/src/ui/App.tsx`、`packages/ohbaby-cli/src/tui/components/prompt/index.tsx` | 当前 pending、Composer 与 fire-and-forget 行为 |

以上均为 2026-08-18 本机源码调研，不基于产品宣传或表面截图。

## 3.2 OpenCode：主参考

OpenCode 的关键不是“它有 optimistic store”，而是以下因果链完整：

1. 发送前创建稳定 `messageID`；
2. 在同一个本地 batch 中设置 busy、加入 optimistic message、清理输入；
3. POST 使用同一个 message ID；
4. 协议消息按 ID 与 optimistic overlay 合并；
5. 请求失败时删除 overlay，并恢复仍适合恢复的输入；
6. 测试明确要求 protocol message 未到时也能渲染 optimistic user turn + thinking。

| OpenCode 做法 | ohbaby 采用方式 | 为什么不是照搬 |
|---------------|-----------------|----------------|
| client 预生成 `messageID` | **adapt**：ohbaby receipt 前用 `pending:${clientRequestId}`，receipt 后切服务端 `userMessageId` | ohbaby 的 ID ownership 当前在服务端，不为本议题改协议 |
| optimistic map keyed by identity | **adopt**：最小 keyed local attempts，避免 follow-up 覆盖前一条 pending | 只存本批必要字段，不抽通用 store |
| `setBusy + optimistic.add` 同批 | **adopt**：clear draft + local row + startup Thinking + admission spinner 同帧 | ohbaby 还需区分 Queue placement |
| protocol arrival merge | **adopt**：formal > starting > local 的纯派生优先级 | 中间复用 ohbaby 已有 prompt submission |
| failure remove + restore | **adopt**：HTTP 未受理移除 attempt，draft 仍空才恢复 | accepted terminal failure 不等于 HTTP reject |
| 所有 follow-up 可成为 timeline optimistic | **reject/adapt**：active run 再发只进 ohbaby Queue | 保持 2026-07-12 产品语义与模型上下文隔离 |

## 3.3 Kimi Code：有即时 busy，但仍暴露消息空窗

Kimi Webview 的 `sendMessage` 会立即设置 `isStreaming=true`、保存 `pendingInput` 并清 draft；输入按钮随即切为 Stop。真正的 user + assistant message 直到 SDK `turn.started` 被 adapter 转成 `TurnBegin` 后才插入。

可借鉴：

- pending input 与本地 queue 分离；
- preflight failure 删除未成功的 user/empty assistant 并恢复输入；
- runtime failure 保留现场并显示 inline error；
- transcript prompt queue 位于 timeline 旁边，`userMessageId` 只在 materialized 后存在。

不直接采用：只切按钮、不立即显示用户文本。在 ohbaby 的欢迎页首条场景中，主区域仍会像“什么都没发生”，不足以解决本议题。

## 3.4 DeepSeek Harness：立即 commit 与安全恢复

DeepSeek 的 input hub 先 `commitSend`，再异步发送；失败时只在当前草稿仍为空时恢复旧文本/媒体。这条纪律避免：请求失败发生前用户已经输入下一句话，却被旧 prompt 覆盖。

本批 adopt：

- Enter 后立即 clear/commit；
- rollback 必须关联本次提交；
- restore 前检查用户是否已经产生新 draft。

不采用：为消除首 session 特例而提前物化所有 session。该问题属于更大的 session lifecycle，不是本批必要条件。

## 3.5 ohbaby 自身约束：必须 adapt 的地方

| 约束 | 影响 |
|------|------|
| 服务端在 admission 分配 `userMessageId` | receipt 前允许临时展示 key，receipt 后必须统一 |
| prompt 有持久化 Queue | active run follow-up 不进入 conversation optimistic |
| scheduler `starting` 可因 run-ledger busy 回到 queued | starting 只能是 provisional，不能据此提前正式写 message |
| snapshot/SSE 是 Web 权威 | local attempt 只在上层事实缺位时显示，reload 不依赖 local state |
| core runner 当前另造 message ID | Phase A 必须补 ID 透传，才能获得真正稳定身份 |

## 3.6 明确不借鉴

| 做法 | 为何拒绝 |
|------|----------|
| 为“三阶段”建立通用状态机、reducer 或 optimistic framework | 当前只有一个明确发送流程；错误抽象比局部纯派生更贵 |
| execute 开头正式写/发 adapter 用户消息 | scheduler starting 不等于最终 run ownership；busy 会要求撤回投影并造成跨客户端闪烁。core claim 前临时写入是独立的存量风险，不混为同一因果 |
| receipt 带完整 message | admission 与 authoritative message 混为一谈，产生第二消息源 |
| queued 一律进 conversation | 破坏 Queue 产品语义和模型上下文隔离 |
| spinner 一直转到模型首 token | admission 与 agent work 语义混淆；后半段应由 Thinking 表达 |
| 为顺带改善 TUI 而拆核心 run lifecycle | 收益不足以覆盖跨进程一致性复杂度 |

## 3.7 对 02 的直接影响

- OpenCode 决定 Phase B 的同帧 commit、keyed overlay、稳定 ID 接管与 optimistic-before-protocol 测试。
- ohbaby 的 server-owned ID 决定 receipt 前保留临时 key，而不是照搬 client-generated message ID。
- Kimi 的 preflight/runtime error 区分强化了“HTTP 未受理恢复”与“accepted terminal failure 保留现场”的两种路径。
- DeepSeek 决定失败恢复不得覆盖新 draft。
- ohbaby 双 claim 事实否决了原先 Phase A“execute 开头正式 message”，把 Phase A 收窄为 ID 统一。
