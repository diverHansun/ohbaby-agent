# ohbaby-web · UI 状态可视化

> 各状态如何在界面上呈现。连接态/运行态是 preview 的「正确性可见」核心；空态是首屏。对齐 [`../data-model.md`](../data-model.md)（ConnectionState 五态机、ViewState）与 [`../use-case.md`](../use-case.md)。参考实现：[`design/session-screen.dc.html`](./design/session-screen.dc.html)、[`design/empty-state.dc.html`](./design/empty-state.dc.html)。

---

## 1. ConnectionState 五态 → 状态胶囊

状态胶囊（header 右侧）是用户能看到的唯一连接真相（无诊断行）。颜色组：slate=蓝、green、gold、red。

| ConnectionState | 文案 | 色组 | 动效 | 含义 |
|---|---|---|---|---|
| `live` + run idle | `idle` | green | 无 | 实时、空闲 |
| `live` + run running | `running` | slate | pulse | 实时、agent 运行中 |
| `connecting` | `connecting` | gold | pulse | 建连中 |
| `reconnecting` | `reconnecting` | gold | pulse | SSE 断、带 Last-Event-ID 重连 |
| `resyncing` | `resyncing` | slate | pulse | 命中 resync-required，重拉 snapshot 重建 |
| `disconnected` | `disconnected` | red | 无 | 不可恢复（如 401），等用户介入 |

> `running` 是 `live` 下的子状态（连接 live 且有 run 进行）。`reconnecting`/`resyncing` 必须显眼（gold/slate + pulse），让"在补线/重同步"对用户透明——不假装无事。

---

## 2. 运行态（run）

- **running**：状态胶囊 `running`(slate,pulse) + 流内三色波点思考指示器（`Thinking · {elapsed}s · double click esc to interrupt`）+ composer 显示 Stop。
- **idle**：状态胶囊 `idle`(green) + 流内定稿行 + composer 显示 Send。
- **中断**：double-esc 或 Stop → 转 idle（与 CLI 一致）。
- **命令 UI**：slash 命令执行中显示 running notice；错误回流后就地更新；只读成功结果可打开结构化 modal。command UI 是易失投影，不改变 run 状态，除非 command 本身通过 backend 产生 session/run 事件。

---

## 3. 空态 / 就绪屏（首屏未发 prompt）

参考 [`design/empty-state.dc.html`](./design/empty-state.dc.html)：

- **居中抬升的输入框**（非底部 dock），上方 `oh ba by` 字标 + `ohbaby-agent · ~/dev/ohbaby-agent · glm-5.1` 一行上下文。
- **发送首条 prompt 后**：输入框下沉到底部 dock，进入主会话屏布局。
- 仍受连接态约束：未建连/建连中时状态胶囊如实显示（connecting/disconnected），输入受限。

---

## 4. 错误 / 不静默（呼应 non-functional）

UI 不得静默失败。当前已定义的呈现：

- **401 token 失效** → `disconnected`(红) 胶囊 + 提示"重启 ohbaby serve / 重新打开"。
- **403 错主**（审批属于另一连接）→ 权限模态内提示，不误标为已处置（见 [`components.md`](./components.md) PermissionModal）。
- **网络错 / 通用失败** → 通知条（待补具体样式；归 ConversationStream 顶部或 header 下方的瞬时条）。

> 注：通用错误通知条的视觉样式当前设计未给出具体稿，实现时按"瞬时、可见、可关"补齐；状态机层面已由 ConnectionState 覆盖主链路失败。

---

## 5. 开发者可观测性（不在 UI）

`seqNum / clientId / lastEventId / 端口` 等不进 UI（决策 1，简洁优先）。正确性（基线对齐、续传、resync）在内部强制执行，开发者从 devtools/console/日志查看。v0.1.6 不做指标/trace 上报（见 [`../non-functional.md`](../non-functional.md)）。
