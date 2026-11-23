# Mermaid 图表：实施与验收记录

> 状态：2026-11-23 已实施并完成浏览器验收。所有 commit 都在本地分支 `feat/web-markdown`，没有 push，也没有合进 `main`。

## 1. 实际交付

按 `architecture.md` 和 `dfd-interface.md` 做完，没有改范围：

1. 渲染器给 `mermaid`、`mmd` 代码块加 `data-mermaid`，值是本页的 `COPY_TOKEN`。模型自己写的同名属性值对不上，会被忽略。
2. `MarkdownBlock` 新增 `diagrams` 属性，默认关。`MessageRow` 只给完成的助手消息打开；输出中、用户消息、命令结果、文件预览和压缩摘要都保持代码。
3. `ui/shared/markdown-mermaid.ts` 在第一次遇到 Mermaid 时才 `import("pele/lazy")`（Pele 精确锁定 1.13.0）。超过 20,000 字符、图类型不认识或语法错误时保持代码。画好的 SVG 再用 `DOMPurify` 的 SVG 配置清洗一遍，然后插在隐藏的 `<pre>` 前面，所以 Copy 和代码视图都不变。
4. Copy 旁边加了切换按钮（lucide 的 `workflow` 和 `code-xml` 图标），在图和代码之间切换，不重画。
5. 宽图在自己的框里横向滚动。`ui/shared/markdown-scroll-region.ts` 用一个共享的 `ResizeObserver` 跟踪所有框，只在内容溢出时加 `role="region"` 和 `tabindex`。公式也复用这套逻辑。

## 2. Commit

| Commit | 内容 |
|---|---|
| `cb4b113b` | `feat(web): draw Mermaid diagrams in finished answers` |
| `e8fcde16` | `docs(web): describe Mermaid diagrams and add them to the Markdown mock` |

## 3. 自动化验证

`markdown-mermaid.unit.test.tsx` 有 35 个用例，覆盖 U-1 到 U-17，全部通过。写测试时调整了两处：

- U-15 里 `evil.example` 出现在标签文字里是无害的，所以只检查 `<style>` 和属性里不能出现它。
- U-17 的 gitGraph 样例里，Pele 不能解析中文分支名，改用 `feature`；中文标签放在流程图里测。

全部分支完成后，Web 单测 100 个文件、1,280 个用例通过，类型检查和 lint 也通过。

## 4. 浏览器验收

在 `ohbaby-web-mock` 的 `?mock=markdown` 里用 Chrome 测。

| 编号 | 结果 |
|---|---|
| B-1 | 输出过程中检查了 27 次，一直是代码，没有画图 |
| B-2 | 消息完成后两张好图画出，坏图保持代码，页面仍贴在底部（差 1px） |
| B-3 | 由 `MessageRow` 的开关控制，只有完成的助手消息打开；U-16 测了默认关。浏览器里没有逐一检查用户消息、命令结果和文件预览 |
| B-4 | 没有 Mermaid 的页面不请求 Pele |
| B-5 | 构建产物里 Pele 是独立的 `lazy-*.js`，各图类型再拆成小包；入口文件里只有 `import("./lazy-…")` |
| B-6 | 宽图在框内滚动，页面不横向滚动，图里文字 14px；Tab 能聚焦，有焦点框，方向键能滚动 |
| B-7 | Copy 变成 Copied 时向左伸展，和切换按钮之间留 14px，不重叠 |
| B-8 | 375px、`hover: none` 下两个按钮常显，图上方留出 34px 不被盖住，切换按钮点击区 44×44px |
| B-9 | 依赖流式议题 Stage 4 的块级阅读位置，单测覆盖；浏览器里没有单独测 |
| B-10 | 颜色来自 ohbaby 的 token，没有卡片外框 |
| B-11 | 只测了 Chrome |
| B-12 | 窄宽度下宽图加上 `role="region"`，回到桌面宽度后去掉 |

控制台没有和 Mermaid 相关的错误。桌面端悬停按钮会浮在图的右上角，和设计一致。

## 5. 没有验证的部分

- B-11 要求的 Edge、Safari、Firefox 都没测。
- B-3、B-9 只有单测和代码路径，没有在浏览器里逐项手动测。
