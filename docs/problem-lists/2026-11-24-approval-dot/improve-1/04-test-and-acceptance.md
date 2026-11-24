# 4. 测试与验收

## 4.1 测试策略

- **圆点放在哪一列**是渲染结构，用单测覆盖，改 `apps/ohbaby-web/src/ui/sidebar/Sidebar.unit.test.tsx`。
- **颜色、居中、hover 不重叠**是视觉结果，项目没有 CSS 断言的约定，不为此新建。用 `.claude/launch.json` 里的 `ohbaby-web-mock` 启动，打开 `?mock=approval`，在浏览器里读计算后的样式并截图。

## 4.2 单测验收

| 编号 | 场景 | 通过标准 |
|---|---|---|
| U-1 | 一个会话处于 `awaiting` | 它的 `.ohb-session-lead` 带 `role="status"`、`aria-label="Waiting for approval"`，里面有 `.ohb-session-awaiting` |
| U-2 | 同一个会话的行尾 | `.ohb-session-meta` 里没有圆点 |
| U-3 | 一个会话处于 `running` | 前导列仍是 4 个点的点阵，`aria-label="Running"` |
| U-4 | 一个会话正在移动，同时处于 `awaiting` | 前导列显示移动中的 spinner，不显示圆点 |

## 4.3 浏览器验收

| 编号 | 场景 | 通过标准 |
|---|---|---|
| B-1 | `?mock=approval`，看侧边栏当前会话 | 圆点在标题左侧，和上方工作区文件夹图标左右对齐 |
| B-2 | 读圆点的位置 | 圆点中心和会话行中心的垂直距离不超过 0.5px |
| B-3 | 读圆点颜色 | 计算后的 `background-color` 是 `rgb(242, 194, 48)` |
| B-4 | hover 这一行，再打开「…」菜单 | 圆点一直可见，没有和「…」或 pin 按钮重叠，位置不变 |
| B-5 | 同一行的标题 | 出现圆点前后，标题的左边缘位置不变 |
| B-6 | 子代理列表里有等待审批的子代理 | 状态圆点颜色同样是 `rgb(242, 194, 48)`。mock 里没有这种数据时，读 `.ohb-status-dot::before` 的计算样式确认 |
| B-7 | 运行中可插话的输入框描边、警告横幅 | 颜色和改动前一致，仍是 `--warning` |

B-1 到 B-5 在桌面宽度和 375px 手机宽度下各看一遍。ohbaby 现在没有深色模式，不用测。

## 4.4 对抗性审查要点

- `--warning` 有没有被误改？全仓搜索 `--warning` 的用法，数量应该和改动前一样。
- `meta` 里还有没有 `awaiting` 判断？应该只剩相对时间，或者在消息时间议题之后变成空的。
- 前导列的判断顺序是不是 `moving` > `running` > `awaiting`？
- 圆点的 `role="status"` 是在前导列容器上，还是在里面的圆点上？只能在一处，否则读屏会读两遍。

## 4.5 完成定义

U 组和 B 组全部通过；Web 的类型检查、lint 和单测通过；02 §2.4 的设计文档已同步。
