# Mermaid 图表：测试设计

> 前置：[goals-duty.md](goals-duty.md)、[dfd-interface.md](dfd-interface.md)。遵循 [Web 测试规范](../test.md)。

## 1. Test Scope（测试范围）

**覆盖：**

- 只识别真实的 Mermaid 代码块，以及各种失败时退回代码。
- 复制、切换、React 更新和取消。
- 绘制结果的安全边界。
- 在真实页面里的样式、滚动、按需加载和消息流程。

**不覆盖：**

- Pele 的布局算法和每种图的像素结果。
- Markdown 解析和流式增量，它们由相关议题测试。
- 深色模式、缩放和导出，本模块不做。

## 2. Critical Scenarios（关键场景）

### U 组：单元测试

放在 `shared/markdown-mermaid.unit.test.ts`，环境用 jsdom，直接调用真实的 Pele。Pele 1.13.0 已确认不需要浏览器布局就能出图。

| 编号 | 场景 | 预期结果 |
|---|---|---|
| U-1 | `mermaid`、`MMD`、`mermaid title="x"` | 都识别为 Mermaid |
| U-2 | `js`、空语言、`mermaidx` | 不识别 |
| U-3 | 正常流程图 | 插入一张 SVG，`<pre>` 隐藏，状态为 `ready` |
| U-4 | 模型手写的 HTML 带 `data-mermaid` 假值 | 不绘制 |
| U-5 | 语法错误 | 代码可见，没有 SVG，`done` 正常完成 |
| U-6 | 未知图类型 | 同 U-5 |
| U-7 | 源码 20,000 字符和 20,001 字符 | 前者尝试绘制，后者不加载也不绘制 |
| U-8 | 一条消息里一张好图、一张坏图 | 好图画出，坏图保留代码 |
| U-9 | 绘制后点 Copy | 复制结果等于 Mermaid 源码，末尾没有多余换行 |
| U-10 | 点切换两次 | 图和代码来回切换，SVG 节点不变 |
| U-11 | StrictMode 下挂载 | 只有一张图、一个切换按钮 |
| U-12 | 内容不变时重渲染 | SVG 节点和切换状态都保留 |
| U-13 | 内容变化、快速连续变化 | 只显示最新内容的一张图 |
| U-14 | 绘制完成前卸载或取消 | 不写 DOM |
| U-15 | `click href`、`<img>`、`onerror`、`javascript:`、init 配置注入 | SVG 里没有 `<script>`、事件属性、外部图片和链接 |
| U-16 | 默认的 `MarkdownBlock` | 不启动增强，现有调用方行为不变 |
| U-17 | 每种图类型各一个样例，再加中文和 `Promise<string>` | 都能出图，标签文字完整。这一组也是升级 Pele 时的回归样例 |

### B 组：真实页面

用 `.claude/launch.json` 里的 `ohbaby-web-mock` 启动。mock 数据里没有合适的样例时，给 `apps/ohbaby-web/src/dev/mock-scenarios.ts` 加一条。

| 编号 | 场景 | 预期结果 |
|---|---|---|
| B-1 | 助手消息输出过程中带 Mermaid | 一直显示代码，没有图闪动 |
| B-2 | 消息结束 | 代码换成图，滚动位置正常 |
| B-3 | 用户消息、命令结果、文件预览里有 Mermaid | 仍显示代码 |
| B-4 | 打开没有 Mermaid 的会话 | 网络面板里没有 Pele 代码包 |
| B-5 | 第一次出现 Mermaid | 才请求 Pele 代码包 |
| B-6 | 宽图放在 720px 容器内 | 图内横向滚动，页面不横向滚动，文字仍是 14px，Tab 能聚焦并用方向键滚动 |
| B-7 | Copy 变成 Copied、Copy failed | 不压到切换按钮 |
| B-8 | 触屏宽度和 `hover: none` | 两个按钮常显，图不被按钮盖住，切换按钮点击区 44×44px |
| B-9 | 读者停在长回答中段，同一条消息上方的图完成绘制 | 正在读的内容不动。依赖流式议题 Stage 4 |
| B-10 | 图的颜色和字体 | 来自 ohbaby token，没有卡片外框 |
| B-11 | Chrome、Edge、Safari、Firefox | B-2、B-6、B-7 通过，SVG 文字没有明显溢出 |
| B-12 | 窗口变窄变宽，消息折叠后再展开 | 宽图的键盘属性随实际溢出更新 |

## 3. Integration Points（集成点）

| 集成点 | 风险 | 验证 |
|---|---|---|
| `markdown-renderer.ts` 的代码块输出 | 标记丢失或可伪造 | U-3、U-4 |
| 现有复制逻辑 | 隐藏 `<pre>` 后读不到源码 | U-9 |
| `MessageRow` 的消息状态 | 输出中提前绘图，或用户消息被绘图 | B-1、B-3 |
| `ConversationStream` 的滚动 | 图的高度变化导致跳动 | B-2、B-9 |
| Vite 打包 | Pele 被打进首屏 | B-4、B-5，并检查产物分包 |
| Pele 升级 | 语法或输出结构变化 | U 组、B 组 |

## 4. Verification Strategy（验证策略）

规划阶段已经用一个临时原型验证了设计，原型接的是真实的 `marked`、DOMPurify、Pele 1.13.0、ohbaby token 和消息样式，只在 Chrome 上运行：

- 18 项行为检查通过 17 项。没通过的一项是 DOMPurify 去掉了根 SVG 的 `role`，设计里已改成挂载时补回。
- React 的 StrictMode、重渲染、内容变化、快速变化和卸载，8 项全部通过。
- 按钮位置和键盘滚动在桌面和触屏模拟下都通过。

这些结果说明方案可行，**不能代替实施后的验收**。下面三项只有接入项目后才能确认：

1. 真实 Vite 构建确实把 Pele 拆成懒加载包。
2. Safari、Firefox 和 Edge 的显示。
3. 真实消息流里的完成切换和滚动。

验收标准：

- U 组全部通过，并写入 Web 单测。
- B 组在 Chrome 全部通过；B-11 在四个浏览器上通过，没法在本机运行的浏览器要明确记录。
- 现有 Web 单测和类型检查通过。
- `redesign-2026-10/05-components.md` 的 `MarkdownBlock` 说明同步了 `diagrams` 开关和防伪标记。
