# improve-1 · 4. 验收

> 行为验收沿用 [08](../08-test-and-acceptance.md) 中和本批有关的条目；视觉按 [03 §7](../03-ui-layout-and-style.md)。

## 必须通过

| ID | 检查 | 方式 |
|---|---|---|
| A1 | 拆分前后现有测试全部通过；改了 DOM 结构的测试同步修改，不删场景 | `pnpm exec vitest run apps/ohbaby-web` |
| A2 | 组件样式里没有字面量颜色（`tokens.css` 除外）；`styles/overrides.css` 已删除 | 改写后的 `ui/styles.unit.test.ts` 断言 |
| A3 | 拆分后的文件各自只做一件事，组件文件不超过约 400 行；纯逻辑文件不依赖 React | 代码检查 |
| A4 | 发送、插话、排队、停止、审批、斜杠命令、子代理、上下文用量都能正常使用 | 现有测试 + 浏览器走查 |
| A5 | 侧栏里能切换项目（沿用现有切换），`ProjectRail` 已删除 | 浏览器走查 |
| A6 | 没配模型时不显示提示，点发送打开 `/connect` 浮层，文字保留 | 浏览器走查 |
| A7 | 没有打开目录时，选择条显示 `Open folder…`，点发送打开目录选择；取消、打开目录前后草稿保留，未创建实例不显示断开；不展示附件和未接通的 Search/Settings 按钮 | integration + 浏览器走查 |
| A8 | `Menu` 有单测：键盘导航、贴边翻转、过滤、关闭后焦点归还 | unit |
| A9 | 审批浮层在消息区内、不遮挡、可折叠、多请求可翻页；顶栏显示标题、工作目录和上下文用量，70% 和 90% 时变色 | integration + 走查 |
| A10 | 玻璃元素上的文字对比度 ≥ 4.5:1；不支持 `backdrop-filter` 时退回实底；`prefers-reduced-motion` 下只保留转圈 | 走查 |
| A11 | 系统字体加 JetBrains Mono；斜杠面板没有金粉蓝；不显示 `runtime:model-switch` 通知 | 走查 + unit |
| A12 | [test.md](../../test.md) 中写死旧尺寸的场景、`App.unit.test.tsx` 中依赖 `ProjectRail` 和旧空态的用例已按新结构改写 | 测试 |
| A13 | `pnpm typecheck`、`pnpm lint` 无新增错误；`pnpm build` 通过 | 命令 |

## 视觉走查

在 1440、900、390 三个宽度下截图，与 Claude、Codex、Cursor 参考截图对比：

- 中性偏暖白，侧栏深一档；玻璃只出现在顶栏、菜单、通知、输入框卡片上。
- 两条顶栏连成一条；会话行单行、紧凑；没有卡片套卡片。
- 空态是字标加居中的项目选择和输入框卡片；控制按钮在卡片底部，发送是深色圆形按钮。
- 除字标外界面上没有金、粉、蓝三色。
