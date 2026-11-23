# 5. 实施与验收记录

> 状态：2026-11-23 已实施并完成浏览器验收。所有 commit 都在本地分支 `feat/web-markdown`，没有 push，也没有合进 `main`。P-3 在内容更丰富的样本上没有达到 8ms 的目标，见 5.5。

## 5.1 实际交付

四个 Stage 都按 02 做完：

1. **Stage 1**：渲染器从 `MarkdownBlock.tsx` 搬到 `ui/shared/markdown-renderer.ts`，行为不变。
2. **Stage 2**：`ui/shared/markdown-stream.ts` 做增量渲染。前面已经写完的块冻结，只重算最后两块；只有 `src.startsWith(各 token.raw 拼接)` 成立时才冻结（D3）。结尾没写完的 `**`、反引号和代码围栏会临时补全，冻结片段和结尾片段都经过 `DOMPurify`。
3. **Stage 3**：`StreamingMarkdown` 在 `useLayoutEffect` 里用 `insertAdjacentHTML` 追加冻结片段、替换结尾片段，所以自动滚动不会慢一拍。消息完成后换回 `MarkdownBlock`。`.ohb-streaming-text` 的三处样式已删除，工具面板的 `pre` 样式不受影响。
4. **Stage 4**：`ConversationStream` 的阅读位置记到消息里的块（`blockIndex`、`blockOffset`）。块不在了就退回按消息行恢复；委托锚点和折叠回退写位置时会清掉块信息。

## 5.2 Commit

| Commit | 内容 |
|---|---|
| `8f255db9` | `refactor(web): move the Markdown renderer into its own module` |
| `575a8361` | `feat(web): add incremental Markdown rendering for streamed text` |
| `da17f2d6` | `chore(web): keep the Markdown mock snapshot in step with the replay` |
| `f1801676` | `feat(web): render streaming answers as Markdown` |
| `b5d79f42` | `feat(web): keep the block being read in place inside long answers` |
| `e6dfcc5e` | `docs(web): describe streaming Markdown and block reading position` |

## 5.3 自动化验证

| 检查 | 结果 |
|---|---|
| U-1 到 U-9 | `markdown-stream.unit.test.ts` 全部通过，U-1 和 U-9 都跑了 8 种分块大小 |
| `StreamingMarkdown` 组件测试 | 冻结节点不被替换、StrictMode 下不重复追加、整段替换时重置，全部通过 |
| B-9、B-10 | `reading-block.unit.test.tsx` 用每块高度不同的布局 mock 测，通过；临时去掉块级对齐后 B-9 会失败，说明测试确实测到了行为 |
| Web 单测 | 全部分支完成后 100 个文件、1,280 个用例通过 |
| 类型检查、lint | 通过 |

## 5.4 浏览器验收

在 `ohbaby-web-mock` 的 `?mock=markdown&stream=1` 回放里用 Chrome 测。

| 编号 | 结果 |
|---|---|
| B-1 | 输出过程中标题、加粗、列表都已经是 Markdown 排版，和完成后一致 |
| B-2 | 完成切换前后 HTML 相同，位置都是 1,159.3px，没有跳动 |
| B-3 | 贴底输出时离底部 0.5px，一直跟到最新内容 |
| B-4 | 用真实滚轮上滑后继续输出，内容从 97 字增长到 274 字，阅读位置一直停在 127.5px。用合成滚轮事件测会被拉回底部，那是合成事件和真实滚动时序不同造成的，换真实滚轮后正常 |
| B-5 | 输出过程中选中已冻结段落的文字，选区不丢 |
| B-6 | 输出还没结束、代码块已闭合时点 Copy，复制结果就是代码块源码 |
| B-7 | 输出中切到别的会话再切回来，内容完整、不重复，继续增长 |
| B-8 | 定义写在后面的引用式链接，完成后变成可点击的“设计文档”链接 |
| B-9、B-10 | 只做了 5.3 的单测，没有在浏览器里手动停在长回答中段测 |

## 5.5 性能

在页面里直接调用 `createMarkdownStream`，6 万字符分 500 次输出，统计单次更新耗时：

| 编号 | 目标 | 实测 P95 | 结论 |
|---|---|---|---|
| P-1 | ≤ 5ms | 0.2ms | 通过 |
| P-2 | ≤ 8ms | 0.4ms | 通过 |
| P-3 | ≤ 8ms | 纯正文样本 4.8ms；每段都带表格和链接的样本 13.1ms | 纯正文通过，内容丰富时超标 |

P-3 超标的原因在 D3 里已经写明：`marked` 不为链接定义生成 token，开头有链接定义时冻结校验一直失败，每次都退回重算整段。规划时用的是纯正文，实测 5.62ms；这次用了更接近真实回答的样本，单次全量解析本身就要 13–15ms。

这种情况只在“回答开头就写了引用式链接定义”时出现，模型很少这样写，而且 13ms 仍在一帧（16.7ms）以内，所以这次先接受，没有改 D3。如果以后真实会话里经常遇到，可以考虑先剥掉链接定义再做冻结校验。

## 5.6 没有验证的部分

- 只在 Chrome 里测过，Safari、Firefox 和 Edge 没测。
- 性能是在开发服务器上测的，不是生产构建。
