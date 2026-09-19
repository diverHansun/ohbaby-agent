# 讨论记录与已确认要点

> 2026-09-19 与用户讨论定稿。正式方案见 01–04。
> 来源：improve-2 落地后的 chrome 跟进。同一落点 `2026-09-18-web-chrome-polish` 的 improve-3。

---

## 1. 背景与动机

侧栏新建按钮左边圆、右边贴死侧栏边缘。会话顶栏看不到上下文占用圆环。输入框里的权限图标一点就切到 full-access，没有风险提示。

## 2. 已确认：目标与范围

| 决策项 | 结论 |
|--------|------|
| 文档落点 | `docs/problem-lists/2026-09-18-web-chrome-polish/improve-3/` |
| 轮次触发 | 主动切割 / 跟进（improve-2 未覆盖侧栏内部按钮、圆环常驻、full-access 确认；用户落地后单独立轮） |
| 关键改动清单 | **不写**（沿用本议题前两轮） |
| New session 描边 | **去掉**。不要描线，避免左右圆角不对称 |
| New session hover | 整颗按钮变浅浅的灰底；默认无底、无边 |
| New session 图标 | 用参考图那种「方框 + 笔」图标（Lucide `SquarePen`），去掉现在的 `+` |
| New session 文案 | **保持英文** `New session`，不改成「新建会话」 |
| 上下文圆环 | **加回顶栏并常驻**。有数据画进度，没数据画空环，不要整颗卸掉 |
| 圆环交互 | 沿用现有 hover 提示 + 点击展开明细弹层；不在顶栏旁常驻 `32k / 200k` 字 |
| full-access 确认 | **只在 default → full-access** 点输入框权限图标时出卡 |
| 确认卡文案 | 英文。按钮：**Not now** / **Use full access**（2026-09-19 用户推翻中文特例） |
| 默认选择 | **Use full access**（主按钮 + 打开时焦点落在它；Enter 立即确认） |
| 风险说明 | 卡片正文友好说明：不问就跑命令、上网、改工作区文件；可随时改回先询问。不抄 Codex Ultra / 深度推理 |
| 反向切换 | full-access → default **直接切，不出卡** |
| 消息身份 | 暂不显示 Lychee 名称、荔枝图标、You 或机器人标签 |
| 用户消息 | 浅天蓝气泡，位于阅读列右侧；Agent 回复保持无气泡正文 |
| 工具调用 | 一次调用一行；去掉卡片描边；整行点击展开 |
| 工具箭头 | 收起时默认隐藏，hover / focus 时显示向右箭头；展开后显示向下箭头 |
| 工具详情 | 所有状态默认收起；主动展开后分别显示原始 Input / Output |
| 工具名称色 | read 金色、edit/write 绿色、其他蓝色；只给名称着色，摘要与箭头保持中性灰 |
| 工具失败 | 工具名称变红，但摘要不显示 `failed` 或错误文本，也不自动展开；主动展开后仍可查看错误输出 |

## 3. 已确认：板式

```
sidebar:
  [SquarePen] New session     ← 无边；hover 整块浅灰；左右都离开侧栏边缘

header:
  ohbaby          idle | 模型 | 圆环 | goal?
                  圆环始终在；空数据 = 空环，不是消失

composer 权限图标点击（default → full-access）:

  ┌─ Enable full access?                       ┐
  │  一段简短风险说明（命令 / 网络 / 文件）    │
  │  [ Not now ]   [ Use full access ]         │
  └────────────────────────────────────────────┘
           主按钮 = Use full access
```

## 4. 已确认：边界（不做的事）

| 项 | 本轮不做 |
|----|----------|
| TUI | 零改动 |
| 新建按钮改中文 | 只换图标和去描边 |
| 整站 i18n | 确认卡也用英文；不引入 i18n 系统 |
| PermissionModal（工具审批） | 不复用、不改样式、不改 choices |
| 权限协议 / PATCH 字段 | 确认后仍 `setPermission({ level: "full-access" })` |
| context 估算与 snapshot 投影算法 | 圆环只消费现有 `header.contextWindowUsage` |
| slash 切 full-access 的确认 | 当前 Web 没有该入口，不增加预防性实现 |
| 「不再提醒」 | 每次从 default 点进去都要确认 |
| plan 模式确认 | 只确认完整访问 |
| 侧栏顶与 header 齐高、阅读列加宽 | improve-1 / 2 已冻结 |
| 本规划会话写代码 | 审查后再实施 |
| Lychee 品牌图标 | 本轮暂缓；先用消息布局建立对话层级 |

## 5. 已确认：与关联议题的关系

| 文档 | 关系 |
|------|------|
| [improve-2](../improve-2/00-discussion.md) | 灰手 / 红盾、点击循环、`full-access` 不弹**工具审批**模态。本轮在切到 full-access **之前**加确认卡，不推翻「full-access 时不弹 PermissionModal」。 |
| [improve-1](../improve-1/00-discussion.md) | 顶栏仍约 44px。圆环必须装进现有高度，不把顶栏加高。 |
| [`docs/ohbaby-web/ui/components.md`](../../../ohbaby-web/ui/components.md) | Header 仍写「细进度条 + 读数」，与代码里的圆环不一致。本轮落地后改成常驻圆环。权限策略仍写「单击循环、无菜单」——改成「先确认再切」。 |
| [`docs/ohbaby-web/goals-duty.md`](../../../ohbaby-web/goals-duty.md) D3 / G3 | 仍要能切 default/full-access。Web 多一步确认是展示层，不改会话语义。TUI 不跟。 |
| [`docs/ohbaby-web/ui/permission-button/`](../../../ohbaby-web/ui/permission-button/README.md) | 只管工具审批四键，本轮不碰。 |

## 6. 参考（详见 03）

本轮附件是 Codex 完整访问确认卡（学信息层级，不抄产品名和大尺寸面板）；New session 图标与当前页面问题来自用户说明和现有实现。

## 7. 用户确认记录

- 2026-09-19：New session 不要边缘化描线；hover 整颗浅灰；加入如图新建会话 icon；取消 `+`。
- 2026-09-19：header 上下文占用圆环加回去。
- 2026-09-19：full-access 按钮点击后出提醒卡；暂不 / 使用完整访问权限；默认选择使用完整访问权限；卡片友好提示风险。
- 2026-09-19：主按钮获得初始焦点，Enter 立即启用 full-access；卡片保持简约高级，不加入大块能力清单或过度装饰。
- 2026-09-19：放到 improve-3；写文档并自检；不要关键改动清单（沿用本议题惯例）。
- 2026-09-19：暂不显示 Lychee 名称或荔枝图标；移除双方角色图标与标签。用户消息改为右侧浅天蓝气泡，Agent 回复保持正文。
- 2026-09-19：工具调用改成无边框披露行；默认收起；hover 后显示向右箭头，展开后转向下并显示 Input / Output。
- 2026-09-19：失败调用也静默收起，摘要不显示失败状态；用户主动展开后仍能查看原始错误输出。
- 2026-09-19：推翻「确认卡中文」特例：确认卡改英文（Enable full access? / Not now / Use full access）；项目栏右键菜单同步改英文（Remove from project rail）。components.md 权威句同步回写。
- 2026-09-19：保留工具类型名称色；失败时仅工具名称变红，不显示 `failed`，仍默认收起。
