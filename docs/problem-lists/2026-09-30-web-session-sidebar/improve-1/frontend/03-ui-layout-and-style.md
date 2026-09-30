# 布局与视觉

## 1. 原则

标题优先；默认列表只呈现内容与必要状态。操作在需要时出现，卡片紧凑，动效解释位置变化。无彩色 pin、危险红 Archive、大面积阴影或玻璃模糊。

## 2. 来源

用户 Codex/Cursor 截图：圆角浅底 hover、图标和文字一行的轻菜单。源码取舍见 [参考](../03-reference-projects.md)。不照搬截图的大量命令/快捷键/分隔线。

## 3. 局部 token 初值

仅为侧栏 feature 建语义变量，不重建全站主题。
- ink #3f4147；muted #737780；surface #fff；菜单项 hover #f0f0f2，行 hover rgba(255,255,255,.56)；border rgba(30,32,38,.12)；focus 沿用蓝色。
- 间距阶梯 4/8/12/16；行高沿用约 50px；行内 pin 12px、… 16px，点击目标至少 24px；pin 与标题视觉间隔约 8px。
- pin 采用针尖朝右下的倾斜样式：行内实心标记与菜单图标统一旋转 −45°；仅旋转图形，点击区域保持不变。已置顶实心，未置顶菜单项空心。
- 菜单初值 176–192px 宽、6px 内边距、每项 32px 高、圆角 9px；轻描边与一层低透明阴影。pin 与归档图标 13px，正文 13px，左对齐。
- 菜单 z-index:50，在 rail(45) 上方、overlays(55) 下方；没有页面遮罩。
- 重排 220ms ease-out（可在 200–250ms 调整）；菜单仅约 100ms opacity；标题延迟 600ms、约 24px/s。

## 4. 线框

```text
Sessions
  [solid pin] Pinned session title       […]  <- … only hover/focus
              Sep 29
  [empty slot] Ordinary session title
               Sep 28

                      +-------------------+
                      | [pin] Pin / Unpin |
                      | [drawer] Archive |
                      +-------------------+
```

标题/日期左边缘对齐。实心 pin 只在标题行，不能在日期旁再画一个。普通会话同样预留窄 pin 槽。右侧 … 只有交互时占标题的可见区域；标题左端及日期不跳动。长标题直接裁切，不添加省略号；在自己的裁剪区域滚动，不穿过按钮。
保留 New session 和项目头；删除 Recent、圆点及运行闪动、footer 数量和横线。

## 5. 视口

沿用现有桌面侧栏宽度和折叠方式，不做手机专项。窄窗口菜单应夹在 viewport 8px 边界内，不裁切。菜单尺寸不照搬高分辨率截图。

## 6. 文案

Sessions、Pin、Unpin、Archive；图标按钮 accessible name 含会话标题。移除行主按钮的 Select 原生 title，不弹遮挡标题的整行 tooltip。pin 的 Unpin 提示允许保留。

## 7. 视觉验收

默认态无常驻 …、归档和圆点；pin 小而可辨；两项菜单的文字/图标比例协调；hover/选中可区分；无 footer；中文长标题不覆盖按钮；菜单无分隔线/大面积空白。

## 8. 实现约束摘要

必须遵守：用户确认的布局/动作/边界，见 [04](04-interaction-and-states.md)。初值可调：本章尺寸/色值/动效速度，经浏览器视觉检查记录在 09。自由发挥仅限这些视觉初值，不能添加产品动作。菜单不开放 Edit Icon、Fork、Delete 等参考中的额外选项。
