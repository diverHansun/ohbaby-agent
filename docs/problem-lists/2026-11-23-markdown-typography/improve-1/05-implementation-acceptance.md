# 5. 实施与验收记录

> 状态：2026-11-23 已实施并完成浏览器验收。所有 commit 都在本地分支 `feat/web-markdown`，没有 push，也没有合进 `main`。

## 5.1 实际交付

按 02 的方案做完，没有改范围：

1. 新建 `apps/ohbaby-web/src/ui/shared/markdown.css`，把聊天、文件预览和命令弹窗里分散的 Markdown 样式收到一处。字号全部用 `em`，跟着容器的基准字号走，所以 13px 的压缩摘要会整体缩小。
2. 正文 14px，H1 到 H6 是 20/17/15/14/14/14px，字重 600；行内代码约 13px，代码块 13px、行高 1.6。
3. 中文加粗的兜底放在 `MarkdownBlock.tsx` 的 tokenizer 里：`marked` 认不出的 `**注意：**内容` 这类写法改由兜底规则处理，处理结果仍然经过 `DOMPurify`。
4. `messages.css` 里 `.ohb-message-body p` 和触屏下的 `.ohb-message-actions` 规则保留；代码块里的 `code` 保持 `font-size: inherit`，行内代码的缩小不会漏进代码块。

## 5.2 Commit

| Commit | 内容 |
|---|---|
| `8917b79e` | `docs(web): plan the Markdown rendering overhaul`（五个议题的规划文档） |
| `4765b863` | `feat(web): share one Markdown typography and fix CJK bold` |
| `9d4c92be` | `chore(web): add a Markdown mock scenario with streaming replay` |

`?mock=markdown` 是给后面各批共用的验收页面，加 `&stream=1` 可以回放流式输出。

## 5.3 自动化验证

| 检查 | 结果 |
|---|---|
| C-1 | 15 个写法都渲染成 `<strong>`，没有残留星号 |
| C-2 | 14 个对照写法和未改动的 `marked` 输出一致 |
| C-3 | 约 8 万字符的两种长文本，解析时间都在未改动 `marked` 的 1.2 倍以内 |
| Web 单测 | 全部分支完成后 100 个文件、1,280 个用例通过 |
| 类型检查、lint | 通过；lint 只剩仓库原有的 warning |

## 5.4 浏览器验收

在 `ohbaby-web-mock` 里用 Chrome 测，读的是计算后的样式，再配合截图。

| 编号 | 结果 |
|---|---|
| S-1 | 聊天里的 H1 到 H6 是 20/17/15/14/14/14px，字重都是 600 |
| S-2 | 正文 14px，行内代码 13.02px，代码块 13px，行高 1.60，代码块用等宽字体 |
| S-3 | 文件预览：H1 20px、H2 17px、正文和列表 14px、代码块 13px、段距 12px、H2 上边距 24px，和聊天一致。命令弹窗：mock 不支持真正执行命令，所以用相同的 DOM 结构挂在页面上测，数值和聊天一致，代码块是等宽字体 |
| S-4 | 压缩摘要基准 13px，H1 19px、H2 16px |
| S-5 | 助手消息的间距规则和改动前一样（`.ohb-message-body p` 和 `> :last-child` 两条规则都没动） |
| S-6 | 用户气泡分别以段落、列表、代码块、引用结尾，底部留白都是 10px |
| S-7 | 气泡文字和编辑框都是 14px、同一字体；行高 23.8px 对 24px，差 0.2px，看不出跳动 |
| S-8 | 375px、`hover: none` 下，消息操作按钮和 5 个代码块的 Copy 都常显，Copy 没有盖住内容 |

## 5.5 没有验证的部分

- 只在 Chrome 里测过，Safari、Firefox 和 Edge 没测。
- 命令弹窗没走真实命令，是用相同结构模拟的。
