# 审批卡片放回输入框

本议题于 2026-11-23 记录，来自 Web 审批卡片改版（[03 §4.6](../../ohbaby-web/redesign-2026-10/03-ui-layout-and-style.md)，D38）。

**状态：审批卡片已回到输入框位置，并通过 Web 端到端验收。** “拒绝并说明”用户决定先不做，Reject 保持现状。

## 1. 方案全景

1. **卡片回到输入框的位置。** 审批期间不能发消息，草稿保留，排队区跟输入框一起收起。
2. **样式用用户选定的问句式。** 一层边框，从上到下是来源行、问句标题、分色命令和按钮。Allow once 用黑色，Always allow 收进向上弹出的菜单。
3. **卡片上不放停止按钮。** 卡片只回答这一条请求，停止运行归输入框。要停止时先点 Reject，有多条待审批时要逐条拒绝，输入框回来后再点 Stop。
4. **“拒绝并说明”暂缓。** 调研结论留在第 5 节，以后做时接着讨论。
5. **不做“发消息自动拒绝”。** 原来倾向的“先 steer、再拒绝”方案放弃，原因见第 3 节。

## 2. 为什么改回来

D38 把卡片放进会话后，输入框在审批期间仍然可用，于是多出一个问题：这时发的消息算 steer、算排队，还是算拒绝？

现在的行为是消息进入排队区，点 Steer 后消息会显示在对话里，但模型要等这次审批结束才读得到，因为 steer 只在每一步开始前读取（`core/lifecycle/lifecycle.ts` 的 `beforeStep`）。用户看到的是“发出去了，模型没反应”。

把卡片放回输入框，这个状态就不存在了，也不用为它设计规则。

## 3. 参考项目

dsh、ZCode、kimi-code、opencode 已在 2026-11-23 对照代码核实。codex 和 claude-code 沿用同日上一轮调研的结论，这一轮没有复核。

| 项目 | 审批时的输入框 | 拒绝并说明 | 说明怎么给模型 | 普通拒绝后 |
| --- | --- | --- | --- | --- |
| dsh Web | 隐藏，保留草稿 | 不支持 | 无 | 继续循环 |
| ZCode 桌面 | 隐藏，保留草稿 | 支持，反馈行常驻 | 写进工具结果 | 继续循环，文案要求模型停下等待 |
| kimi-code 桌面 | 隐藏，保留草稿 | 支持，点 Feedback 展开 | 写进工具结果 | 继续循环，靠文案和系统提示词约束 |
| opencode Web | 移除，保留草稿 | Web 不支持，TUI 支持 | 写进工具结果 | 中断这一步，不再调模型 |
| claude-code | 卸载 | 支持，按 Tab 展开 | 写进工具结果 | 停下等用户 |
| codex | 替换 | 不收文字，选项会结束本轮 | 下一轮用户消息 | 结束本轮 |

从这张表能得出三点：

- 主流做法都是审批时挡住主输入框。唯一的例外是 kimi 的 VS Code 插件，那里发出的消息也只是排队。
- 这些项目都没有“发消息自动拒绝审批”的逻辑。这种做法会猜错意图（“可以跑，跑完顺便看下 lint”也会被当成拒绝），有多条待审批时也不知道该拒哪条。
- 支持写说明的项目，普通工具都把说明写进工具结果，不新增 user message，也不走 steer。

有两处不能照搬：

- kimi TUI 输入说明时按 Esc 会直接拒绝并丢掉文字。
- ZCode 桌面自动聚焦到“允许一次”，用户正在打字时按回车可能误批。

## 4. 卡片位置的改法

| 项 | 做法 |
| --- | --- |
| 位置 | 主对话的输入框是绝对定位，卡片用同样的定位层，左右和底部都与输入框对齐，并用 `--approval-space` 给消息流留出底部空间。侧栏子对话的输入框在文档流里，卡片也放在文档流里 |
| 样式 | 用户选定的问句式：一层边框，来源行、问句标题、分色命令、按钮依次排开，Allow once 用黑色 |
| 输入框 | 保持挂载，用 `display: none` 和 `inert` 隐藏，草稿、排队区、目标条一起收起 |
| **停止按钮** | **卡片上不放。** 2026-11-24 用户确认，和 2026-09 的决定一致（[execution-reliability D9](../2026-09-19-execution-reliability/improve-1/00-discussion.md)：“审批卡片移除 Cancel run”）。opencode、kimi-code、dsh 的审批卡片也没有停止按钮。输入框的 Stop 和 `abortRun` 不变 |
| 同步失败 | 审批同步失败（`error`、`unavailable`）时这些请求已经答不了，卡片收起，输入框和 Stop 回来，并显示 Retry approvals，避免用户既不能审批也不能停止 |
| 焦点 | 新请求到来时焦点移到标题，单按 Enter 不批准。点卡片里的文字后焦点仍在卡片内，快捷键继续有效。点到卡片外面后快捷键不生效，避免误批或误拒。审批结束后，如果之前焦点在输入框，就回到输入框 |
| 防误触 | 不做延迟弹出，因为单按 Enter 本来就不批准。Esc 和 ⌘/Ctrl+Enter 都忽略按住不放产生的重复按键 |
| 侧栏子对话 | 同样放回输入框位置 |
| 保留的改动 | 命令分色（`shell-tokens`）、`commandDescription` |
| 撤掉的改动 | `ConversationStream` 和 `SessionConversation` 的 `approval` 属性，`ohb-approval-standalone` |

## 5. 拒绝并说明（暂缓）

2026-11-23 用户决定先不做，Reject 保持现状。下面保留调研结论，以后做时从这里接着讨论。

### 5.1 交互

当时比较过三种入口，倾向 B，没有定稿。

| 方案 | 做法 | 优点 | 缺点 |
| --- | --- | --- | --- |
| A | Reject 带箭头，菜单里选 `Reject and tell why` | 卡片最干净，和 Allow 的菜单对称 | 要点两下，入口不好发现 |
| B | 操作行左侧放输入框，占位文字 `Tell the agent what to do instead` | 一眼能看到，不增加卡片高度，写完回车就发 | 卡片上常驻一个输入框 |
| C | 左侧放 `Add a note`，点击后展开 | 平时最安静 | 展开时卡片变高 |

三版共用这些规则：

- 没写字时，按钮是 `Reject` 和 `Allow once`。
- 写了字后，按钮变成 `Cancel` 和 `Reject and send`，Allow 暂时隐藏，避免用户写了话却点了批准，文字白写。
- Enter 发送，Shift+Enter 换行，输入法组字时不发送。空内容不能发送，最长 4096 字符（同 ZCode）。
- 在输入框里按 Esc 只退出输入，文字保留，不会触发拒绝。
- 卡片出现时不自动聚焦到这个输入框，免得用户还没看清就把字打进去。

### 5.2 后端链路

核心层已经有 `suggest` 响应，链路断在下面几处：

| 位置 | 改动 |
| --- | --- |
| `ohbaby-sdk/src/contract/snapshot.ts` | `UiPermissionResponse` 增加可选的 `feedback` |
| `ohbaby-server/src/protocols/web/request-helpers.ts` | `permissionResponseFromBody` 放行 `feedback`。它现在只保留 `choiceId` 和 `remember`，新字段会被丢掉 |
| `ohbaby-agent/src/adapters/ui-inprocess.ts` | `toCorePermissionResponse`：`reject` 带非空说明时转成 `suggest`；其他选项带说明时报错 |
| `ohbaby-agent/src/core/tool-scheduler/scheduler.ts` | `confirmPermission` 的拒绝分支把说明写进 `message`，不再把错误对象放进 `details` |

现在如果接通 `suggest`，模型收到的内容是这样，说明埋在 `details` 里（已运行验证）：

```json
{"status":"rejected","error":{"type":"PermissionRejectedError","message":"Tool rejected by user: bash","details":{"permissionId":"perm_1","suggestion":"别跑测试，只看 git status","name":"PermissionRejectedWithSuggestionError"}}}
```

建议改成下面的措辞。

普通拒绝：

```text
The user rejected this tool call, so it did not run. Do not retry it or try to get around it. Stop and wait for the user's next instruction.
```

拒绝并说明：

```text
The user rejected this tool call, so it did not run. The user said:
<说明原文>
Follow the user's message. Do not repeat the rejected call unless the user asks for it.
```

Agent 循环不用改：拒绝后本来就会继续下一步，模型马上能读到这段话。子代理的审批走同一条链路，说明会回到发起请求的那个子代理。

## 6. 遗留问题

这些问题这次没有改，等用户决定：

1. **写文件和外部路径的卡片还不够好懂。** 标题是 `Write tool requires confirmation: write`，正文是 `write(notes/**)` 这样的规则原文。外部路径卡片也看不到实际命令。这一项放到 [一条 bash 命令连续弹出多次审批](../2026-11-23-bash-double-approval/README.md) 一起处理。
2. **侧栏子对话的来源写的是 `Main agent`。** 侧栏子对话有自己的根会话，所以被判成主代理。
3. **按钮文案。** 现在是 `Reject`，Codex 用的是 `Deny`。
4. **普通拒绝后模型怎么做。** 现在模型会继续下一步，可能马上又发起一次审批，这时输入框又被卡片盖住，用户来不及点 Stop。2026-11-24 用户决定先保持现状。以后如果要让它停下等用户，可以先只改工具结果的文案（ZCode 的做法）。

“拒绝并说明”重新启动时，还要定两件事：

- 同一批有多条待审批时，说明只对当前这条生效（kimi 的做法），还是应用到整批（opencode 的做法）。倾向只对当前这条生效，因为一次拒绝不该影响用户没看过的请求。
- 范围是否只改 Web。TUI 审批时本来就挡住输入，没有 steer 的歧义，可以另开议题。
