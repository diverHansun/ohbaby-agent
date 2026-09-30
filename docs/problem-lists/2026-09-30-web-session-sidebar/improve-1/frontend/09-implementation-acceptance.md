# 前端视觉与功能验收

2026-09-30；结论：本轮设计范围通过，用户视觉反馈已落实，并授权提交合并。主记录见 [实施验收](../05-implementation-acceptance.md)。

## 环境与方法

Playwright MCP，Chromium 154.0.8037.92，1280×800 与 760×700。
验收地址 `http://127.0.0.1:5178/`，标题 `ohbaby · Session sidebar review`。临时 harness 在 `/tmp/ohbaby-sidebar-preview`，直接导入仓库真实 Sidebar/Row/Menu/ProjectRail 和 CSS，使用 30 条中英文受控会话；不是另画的静态稿。
原生 CUA 初始化超时，采用可用 Playwright；无需增加项目依赖。没有对用户真实聊天执行归档。归档回执用可选成功/失败/延迟 mock，真实回调集成由 App 测试覆盖。

## 行为检查

| 用例/验收 ID | 结果与实测 |
|---|---|
| UC-01 / A9 | 30 条有意义的会话内容；Sessions，无圆点/计数/footer，主按钮无 Select title 浮层 |
| UC-02 / A1–A4 | Pin 到最上方；刷新恢复；项目切换隔离；另一标签页接收 storage 更新 |
| UC-03 / A4 | 左侧实心 pin 可直接 Unpin，菜单显示 Unpin；回普通排序，不改变 active session |
| UC-04 / A5 | 原生确认取消保留 pin；mock 失败保留；成功移除行并清存储 pin，焦点落下一行 |
| A6 | …/右键相同两项；Shift+F10、End、Escape、Tab 可用；Esc 回触发器，Tab 离开菜单到下一行 |
| A6 边缘 | 窄视口右键菜单实测 x337/y600/w176/h74，完整在 760×700 内 |
| A7 | 列表中段置顶：scrollTop 650 → 650，active 仍 s0；行初始 transform translateY(880px)，220ms 后归位并移出当前可见区 |
| A8 | hover 200ms 时 transform none；约 1.2s 已左移约 14px；实际溢出 166px，末尾停在 -166px，不循环 |
| A8 短标题/暂停 | 短标题无位移；移开复位；菜单打开取消标题动画；末尾取消渐隐以显示全尾字 |
| A8 reduced motion | 不滚动标题、不创建行位移动画，操作仍生效 |
| 页面状态 | 空列表有 No sessions yet 和已有 New session；临时空态不丢 pin；disabled 按钮不能操作 |

存储拒绝读写、连续失败及跨项目异步归档由单元/组件回归验证，不声称做过所有浏览器权限配置组合。

## 视觉判断

默认行以标题为主，置顶标记在标题左侧且只有一个。菜单为 176×74 的两项卡片，图标/13px 正文比例一致，圆角/阴影克制；没有额外分割线、红色归档或占位 Rename。hover 提亮，选中保留既有蓝灰底，状态可区分。

用户视觉审查后补充：pin 统一倾斜，针尖朝右下。已在浏览器检查行内实心、菜单实心 Unpin 和空心 Pin；三处均仅旋转 SVG −45°，点击区域不变。补充截图 `sidebar-slanted-pin.png`，取代旧截图中的竖直 pin 样式。

再次按用户参考图缩小图标：行内 pin 从 14px 调至 12px，菜单 pin/归档从 15px 调至 13px。浏览器实测尺寸符合预期，行内点击区域仍为 24×24px；视觉检查图标与正文比例协调。最新截图为 `sidebar-smaller-icons.png`。

长标题按用户反馈移除省略号，改为直接裁切，避免与操作菜单「…」混淆。浏览器检查 30 条标题均为 clip，其中 10 条溢出；hover 后按钮持续可见、标题缓慢滚动，移开后复位。补充截图 `sidebar-title-clip.png`。
标题左端与日期固定，… 显示只压缩标题右侧；动画中无文字穿过按钮、整体位移与文字滚动不叠加。短/长标题均已截图检查。
相较参考图，主动只保留两项动作；没有照搬高分辨率截图的尺寸和命令数量。四像素菜单内边距属于方向内实现调整。

## 截图与健康检查

最终截图存放于本聊天的本地可视化目录 `sidebar-review/`，通过聊天提供可点击预览：
- `sidebar-final-rest.png`：默认列表及左侧实心 pin。
- `sidebar-final-menu.png`：Unpin / Archive 小卡片。
- `sidebar-narrow-menu.png`：窄窗口边缘菜单。
- `sidebar-moving.png`：置顶移动中间过程。

最终页面非空；无 vite-error-overlay；最终加载 console Errors 0、Warnings 0。
初次临时 harness 因 macOS /tmp 与 /private/tmp 路径解析导致未转译 TSX，已修正真实路径并重新加载验证；此问题不在生产构建。

## 剩余范围

未验 Safari/Firefox/手机触控专项、真实模型生成与归档恢复入口。后两者不属于本轮功能。无已知阻断项；最终审美取舍由用户查看截图/预览确认，不自动提交。
