# 3. 参考项目借鉴

> 参考项目都在 `code-cli/` 下，结论来自 2026-11-23 读到的源码。

## 3.1 三个项目的做法

| 项目 | 增量方式 | 半截标记 | 完成后 | 来源 |
|---|---|---|---|---|
| deepseek-harness（dsh） | 冻结除最后两块外的内容，未闭合代码块再加一道边界 | 未发现补全逻辑 | 全量解析一次 | `packages/client/ui-primitives/src/markdown/incremental.ts` |
| opencode | 自研 `patchmark` 增量解析，Worker 做代码高亮 | 完整补全（251 行） | 切换到完成态投影 | `packages/session-ui/src/components/markdown-stream.ts`、`packages/patchmark/src/heal.ts` |
| ZCode | Streamdown 组件 | `parseIncompleteMarkdown` | Streamdown 处理 | `packages/ui/src/components/ai-elements/message.tsx` |

## 3.2 借鉴了什么

| 来源 | 做法 | 我们怎么用 |
|---|---|---|
| dsh | 保留最后两个块不冻结 | D2 直接采用 |
| dsh | 用解析器自己的位置决定切分点 | D3 用 `token.raw` 实现，并加一道校验 |
| dsh | 跨块引用靠完成后的全量解析修复 | D11 采用 |
| opencode、ZCode | 补全半截标记，隐藏后面还没内容的标记 | D8 采用思路，只做 `**` 和反引号 |

## 3.3 没有照搬的地方

| 做法 | 为什么不用 |
|---|---|
| dsh 换成直接渲染 AST 的 React 渲染器 | ohbaby 的 `marked` 加 `DOMPurify` 链路够用，换掉是一次大重构 |
| dsh 的未闭合代码块第二边界 | 6 万字符未闭合代码块 P95 只有 2.3ms，当前不需要 |
| opencode 自研解析器和 Worker | 单次更新已经不到 1ms，没有需要它们解决的问题 |
| opencode 的完整补全 | 251 行要覆盖数学、链接等，我们只处理最常见的两种 |
| Streamdown | ZCode 的代码注释记录过它引发的 React #185 生产错误，也要换掉现有渲染链路 |
