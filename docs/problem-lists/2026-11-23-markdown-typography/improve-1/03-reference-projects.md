# 3. 参考项目借鉴

> 参考项目都在 `code-cli/` 下，结论来自 2026-11-23 读到的源码。

## 3.1 字号和间距

| 项目 | 正文 | H1 / H2 / H3 / H4 | 代码 | 来源 |
|---|---|---|---|---|
| opencode | 14px / 1.6 | 17 / 15 / 14 / 14 | 无固定阶梯 | `packages/session-ui/src/components/markdown.css` |
| dsh | 14px / 24px | 21 / 19 / 18 / 14 | 行内 0.875em | `packages/client/ui-primitives/src/markdown/MarkdownText.module.css` |
| ZCode | 基准 / 1.75 | 基准 +4 / +2 / 基准 / 基准 | | `packages/ui/src/components/ai-elements/message.tsx` |
| ohbaby（方案） | 14px / 1.7 | 20 / 17 / 15 / 14 | 行内 0.93em，代码块 13px | |

三个项目的共同点是正文 14px 左右、标题克制、H4 之后不再放大。

## 3.2 借鉴了什么

| 来源 | 做法 | 我们怎么用 |
|---|---|---|
| opencode | 标题和正文字号差距小，字重 600 | 采用这个思路，层级比它略拉开，因为 ohbaby 的长回答更依赖标题分段 |
| ZCode | 标题用"基准 + 差值" | A2 采用，压缩摘要等小字号场景自然缩放 |
| dsh | 中文加粗的判断规则 | A6 照搬开合条件和中日韩字符范围 |
| ohbaby 文件预览 | 20/17/15/14 的现成阶梯 | 直接升级成全局规则 |

## 3.3 没有照搬的地方

| 做法 | 为什么不用 |
|---|---|
| opencode 把最后一个元素的边距清零 | ohbaby 的工具行和操作按钮靠这个边距隔开，清零要补一套消息层间距（见 02 的 A4） |
| dsh 在 micromark 里改分隔符算法 | ohbaby 用 `marked`，换不了这一层。我们只在标准规则失败后补一次匹配 |
| dsh 对 `***` 也放宽 | 粗斜体在真实输出里少见，先收窄范围，减少误伤 |
| ZCode 用 `remark-cjk-friendly` | 它属于 remark 体系，`marked` 用不了 |
