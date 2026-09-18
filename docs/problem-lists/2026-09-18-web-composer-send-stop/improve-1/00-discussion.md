# 讨论记录与已确认要点

> 2026-09-18 与用户讨论定稿。正式方案见 01–04。
> 来源：本会话对 Web composer Send/Stop 冗余的讨论，以及用户提供的输入框参考截图（无边框档位字 + 右侧实心主按钮）。

---

## 1. 背景与动机

Web 输入框把「发送/入队」和「中断 run」画成两颗并排按钮。发送后草稿被清空，Send 变灰仍占着，Stop 再插进来。用户认为这是前端冗余，要收成一个发送/停止按钮。

腾出来的位置给思考强度：做成参考图那种轻控件——平时几乎没有框，hover 才出细边。Enter 发送、空态点 Stop、双击 Esc 中断属于操作常识，Web 不必常驻说明书。TUI 没有这颗 Stop 按钮，Esc 提示要留。

## 2. 已确认：目标与范围

| 决策项 | 结论 |
|--------|------|
| 文档落点 | `docs/problem-lists/2026-09-18-web-composer-send-stop/improve-1/` |
| 轮次 | 一轮 `improve-1`；实施分 Stage，不预开 improve-2 |
| 关键改动清单 | **不写**（用户未要求） |
| 主操作槽 | **永远一颗**。Send / 转圈 / Stop / Save 同一位置变脸，不能站两个位置 |
| running + 空草稿 | 只显示 **Stop**，不要灰 Send |
| running + 有草稿 | 显示 **Send**（入队）。中断靠 Stop 不在时的双击 Esc，或先清空草稿让 Stop 回来 |
| running + 发送后 | follow-up 进入现有后端队列；草稿清空后主槽恢复 **Stop** |
| 重连 + 最后已知 running + 空草稿 | 顶栏显示 `reconnecting` / `resyncing`，主槽显示不可点击的 **Stop**；只表示最后已知状态 |
| 文案 | running 时按钮仍叫 **Send**，不叫 Queue；停止叫 **Stop**，不叫暂停 |
| 思考强度位置 | 输入框内、主按钮**左边**；running 时**不让位**给 Stop |
| 思考强度外观 | 留大脑；无边框、底透明；hover/focus 只要浅灰细框，不要浅底 |
| 档位语义 | 沿用现有英文档位、检测中只转圈、unknown 写 `unknown`、关不了思考按钮仍在 |
| Web Thinking 行 | 去掉 `double click esc to interrupt`；只留状态（`Thinking · Ns` / `starting agent`） |
| TUI Esc 提示 | **不去除**。`Press Esc again to interrupt` 与双击 Esc 行为保持现状 |
| composer footer hint | 去掉 `enter to send` / `double click esc to stop` 及连接状态重复句 |
| 改队列 hint | **保留** `Editing queued prompt · Enter save · Esc keep original` |
| Stop `title` | 可写双击 Esc，不占版面 |

## 3. 已确认：板式

```
空闲、空草稿:     [>] [输入] [🧠 high ▾] [灰 Send]
空闲、有草稿:     [>] [输入] [🧠 high ▾] [Send]
刚发送、run 未起: [>] [输入] [🧠 high ▾] [转圈]
运行、空草稿:     [>] [输入] [🧠 high ▾] [Stop]
运行、有草稿:     [>] [输入] [🧠 high ▾] [Send]     ← 入队
重连、先前运行:   [>] [输入] [🧠 high ▾] [灰 Stop]  ← 等待状态同步
编辑队列:         [>] [输入] [🧠 high ▾] [Save]
无思考能力模型:   [>] [输入] [Send 或 Stop]
```

footer 只留 mode、permission；思考强度不在这一行。无思考模型不留空位硬对齐。

## 4. 已确认：边界（不做的事）

| 项 | 本轮不做 |
|----|----------|
| TUI 文案与 Esc 中断 | Web 与 TUI 提示策略分叉是有意的 |
| Send→Queue、Stop→暂停 | 入队是 Send 在 running 时的结果；Stop 是 `abortSession` |
| Thinking 行可点中断 | 空态已有 Stop，再做一个容易两处打架 |
| 第二颗 Stop / Split Button / 预留空位 | 单槽是硬约束 |
| 抽 `ActionSlot` 抽象 | Composer 里几行互斥即可 |
| 改 `canSend` / `canStop` 数据含义 | 只改谁占用槽位 |
| 整张卡片式 composer（下沿一排 + 圆发送） | 只借鉴档位的无边框 hover |
| 档位中文化、检测中加字、无能力时留空位 | 与 2026-09-17 档位 UX 一致 |
| mode/permission 搬进输入框 | 仍在 footer |
| 后端协议、队列、admission | 展示层改造 |
| 原规划会话写代码 | 原计划另开会话；用户后续明确授权本会话继续实施，以下方确认记录为准 |

## 5. 已确认：与关联议题的关系

| 文档 | 关系 |
|------|------|
| [`docs/ohbaby-web/ui/components.md`](../../../ohbaby-web/ui/components.md) | 权威组件规格仍写「running 显示 Stop、idle 显示 Send」和 footer 右侧 hint、Thinking 行带 esc 文案。本轮落地后必须改这篇，不能只改代码。 |
| [`docs/ohbaby-web/ui/states.md`](../../../ohbaby-web/ui/states.md) | 运行态仍写 `Thinking · {elapsed}s · double click esc to interrupt` + composer 显示 Stop。本轮同步。 |
| [`docs/ohbaby-web/test.md`](../../../ohbaby-web/test.md) | 「Send 仅在 HTTP admission 期间旋转」在「空草稿 + 已 running」时不再成立，须改成单槽规则。 |
| [2026-09-17-connect-reasoning-errors](../../2026-09-17-connect-reasoning-errors/README.md) | 档位检测中只转圈、unknown 英文、关不了思考按钮仍在。本轮只搬家和改 chrome，不改这些语义。 |
| [2026-07-13-web-stream-scroll-and-composer-placeholder](../../2026-07-13-web-stream-scroll-and-composer-placeholder/README.md) | 打字机占位的 `right` 留白按「右侧只有一颗 Send」写的。思考强度进框后必须改 inset，否则字会钻到大脑底下。 |
| [`docs/ohbaby-web/ui/permission-button/`](../../../ohbaby-web/ui/permission-button/README.md) | 权限按钮有意不和 send/stop 共用类。本轮不要为了「统一按钮」去改权限弹窗。 |

## 6. 用户确认记录

- 2026-09-18：不要两颗主按钮同时占位；Stop 的位置让给思考强度。
- 2026-09-18：running 时按钮仍叫 Send，不叫 Queue。
- 2026-09-18：板式为输入框内 `[思考强度][Send/Stop]`；思考强度 running 时不消失。
- 2026-09-18：思考强度留大脑；只要细框，底继续透明。
- 2026-09-18：Web 可去掉 hint；若控件自己能说话，Enter/Stop/Esc 不必常驻说明书。改队列 hint 除外（后续规划写明保留）。
- 2026-09-18：`double click esc to interrupt` 在 **Web 去除、TUI 不去除**。
- 2026-09-18：确认方案，用 `plan-code-improvement` 写文档，放在 `docs/problem-lists/`。
- 后续讨论确认：运行中输入草稿时 Send 取代 Stop；发送后由现有后端入队并恢复 Stop。SSE 重连期间，空草稿保留最后已知运行态对应的灰 Stop；顶栏明确显示重连，重同步后以新快照为准。
- 最新授权：本会话优化对齐文档、启动子代理审查，再在临时分支开发和测试，分批 commit；等待用户审查，不 merge、不 push。
