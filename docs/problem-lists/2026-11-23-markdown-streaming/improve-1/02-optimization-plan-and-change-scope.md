# 2. 优化方案与改动面

> 本文交给实施会话。规划会话不写代码。路径都相对 `apps/ohbaby-web/src/ui/`，另有说明的除外。
>
> 前置：[统一排版](../../2026-11-23-markdown-typography/improve-1/02-optimization-plan-and-change-scope.md)必须完成，[表格](../../2026-11-23-markdown-tables/improve-1/02-optimization-plan-and-change-scope.md)建议先完成。

## 2.1 方案总览

输出过程中用新的 `StreamingMarkdown` 组件。它把文本分成"已定型"和"结尾"两部分：已定型的 DOM 只追加、不重写；结尾每次替换。输出结束后仍切回 `MarkdownBlock` 全量渲染一次。

```
新文本到达
   │
   ▼
只解析上次定型位置之后的文字
   │
   ├── 除最后两块外 ──▶ 转 HTML、清洗 ──▶ 追加到 DOM，以后不再碰
   │
   └── 最后两块 ─▶ 补全半截标记 ─▶ 转 HTML、清洗 ─▶ 替换上一次的结尾
```

## 2.2 设计决策表

| 决策项 | 选择 | 理由 | 放弃的选项 | 代价 |
|---|---|---|---|---|
| D1 文件划分 | `shared/markdown-renderer.ts` 放 `Marked` 实例和 `renderMarkdown`；`shared/markdown-stream.ts` 放增量和补全逻辑；组件留在 `shared/MarkdownBlock.tsx` | 增量逻辑是纯函数，好测；两边共用同一个 `Marked` 配置 | 全写进 `MarkdownBlock.tsx`：解析和 UI 混在一起 | 多两个文件 |
| D2 冻结范围 | 保留最后两个非空白顶层块，前面的冻结 | 新文字最多改写最后一块，多留一块做余量（dsh 同样取 2） | 只留一块：边界判断要更细，容错更低 | 结尾略多解析一块 |
| D3 冻结校验 | 只有 `src.startsWith(各 token.raw 拼接)` 成立才冻结 | 防止 token 的 `raw` 和原文对不上时切错位置 | 直接累加长度：解析器归一化文本时会错位 | `marked` 不为链接定义生成 token，所以遇到定义后校验一直失败，之后全部退回重算结尾。实测 P95 为 5.62ms，可以接受 |
| D4 DOM 更新 | `.ohb-markdown` 下保持扁平，用 `insertAdjacentHTML` 追加，记录已冻结节点数 | 和最终 DOM 结构一样，排版选择器都能用；已冻结内容的文字选区不会丢 | 每块包一个 React 组件：多一层 DOM，`> :first-child` 和相邻标题规则失效 | 组件里有一小段命令式 DOM 操作 |
| D5 更新时机 | 在 `useLayoutEffect` 里同步更新 | 自动滚动紧随其后（见 01 §1.5） | 用 `requestAnimationFrame` 合并：滚动会比内容早一拍 | 每次文本变化都更新，实测 P95 为 0.4ms |
| D6 清洗 | 冻结片段和结尾片段分别经过 `DOMPurify`，清洗后才写入 | 不存在未清洗的 HTML 进入 DOM | 拼起来再清洗：又变成全量成本 | 跨块的原始 HTML 在输出中可能显示不完整，完成后恢复 |
| D7 未闭合代码块 | 不特殊处理，留在结尾随文本重算 | `marked` 本来就把它当成代码块；6 万字符时单次更新 P95 只有 2.3ms | dsh 的第二冻结边界：多一套逻辑，当前数据不需要 | 超长代码块的成本随长度增长 |
| D8 半截标记 | 只看结尾最后一行，补全 `**` 和反引号；标记后面还没内容时先隐藏 | 这两种最常见，闪动最明显 | opencode 的完整补全（251 行）：覆盖链接、数学等，当前不需要 | 跨行的粗体和其他语法仍短暂显示原文 |
| D9 代码里不补全 | 结尾块是代码、HTML，或块内有未闭合的代码围栏时不补全 | 代码内容必须原样显示 | 无 | 无 |
| D10 非追加更新 | 新文本不以旧文本开头时清空状态和 DOM，从头渲染 | `content` 可能整段替换 | 假定只追加：内容会错乱 | 重置那一次是全量成本 |
| D11 完成切换 | 继续切回 `MarkdownBlock` | 全量结果是权威版本，修正跨块的引用式链接和原始 HTML | 只靠增量结果：这些内容没有兜底 | 切换时文字选区会丢，和现在一样 |
| D12 阅读位置 | 读者停在消息中段时，额外记录第一个可见顶层块的序号和偏移，恢复时按这个块对齐；找不到块就退回按消息行恢复 | 同一条消息上方变高时，读者正在看的内容不动。完成切换、Mermaid 和公式都用得上 | 只记消息行：上方变高多少，阅读内容就偏移多少 | 阅读位置多两个字段 |

## 2.3 关键算法

下面的原型已在 `marked` 15.0.12 上验证：8 种分块大小下最终结果都等于全量渲染；230 个文本前缀里代码块内容没有被补全逻辑改动。

```ts
export function createMarkdownStream() {
  let previous = "";
  let frozenEnd = 0;
  return {
    update(text: string) {
      const reset = !text.startsWith(previous);
      if (reset) frozenEnd = 0;
      previous = text;

      const source = text.slice(frozenEnd);
      const tokens = markdown.lexer(source);
      const blocks = tokens.flatMap((t, i) => (t.type === "space" ? [] : [i]));
      const keepFrom = blocks.length > 2 ? blocks.at(-2)! : 0;

      let frozenHtml = "";
      let tailTokens = tokens;
      let tailSource = source;
      if (keepFrom > 0) {
        const frozen = tokens.slice(0, keepFrom);
        const raw = frozen.map((t) => t.raw).join("");
        if (source.startsWith(raw)) {
          frozenHtml = DOMPurify.sanitize(markdown.parser(frozen));
          frozenEnd += raw.length;
          tailTokens = tokens.slice(keepFrom);
          tailSource = source.slice(raw.length);
        }
      }
      const healed = closeOpenMarkers(tailSource, tailTokens);
      const tailHtml = DOMPurify.sanitize(
        healed === tailSource
          ? markdown.parser(tailTokens)
          : markdown.parse(healed, { async: false }),
      );
      return { reset, frozenHtml, tailHtml };
    },
  };
}
```

半截标记只处理最后一行：

```ts
const OPEN_NEXT = /[\p{L}\p{N}`“‘「『（(\[]/u;
const WORD_BEFORE = /[\p{Script=Latin}\p{N}]/u;

function closeLine(line: string): string {
  let bold = -1, tick = 0, tickAt = -1, skip = false;
  for (let i = 0; i < line.length; ) {
    const c = line[i];
    if (c === "\\") { i += 2; continue; }
    if (c === "`") {
      let n = 1;
      while (line[i + n] === "`") n++;
      if (!tick) { tick = n; tickAt = i; }
      else if (tick === n) { tick = 0; tickAt = -1; }
      i += n;
      continue;
    }
    if (!tick && c === "*" && line[i + 1] === "*" && line[i + 2] !== "*" && line[i - 1] !== "*") {
      if (bold >= 0) bold = -1;
      else if (skip) skip = false;
      else {
        const prev = lastChar(line.slice(0, i));
        const next = firstChar(line.slice(i + 2));
        if ((next === "" || OPEN_NEXT.test(next)) && !WORD_BEFORE.test(prev)) bold = i;
        else skip = true; // 2**31、src/**/*.ts：这一对不是粗体
      }
      i += 2;
      continue;
    }
    i++;
  }
  let out = line;
  if (tick) out = tickAt + tick === line.length ? line.slice(0, tickAt) : line + "`".repeat(tick);
  if (bold >= 0) {
    if (bold + 2 >= out.trimEnd().length) return out.slice(0, bold);
    return out.trimEnd().replace(/(?<!\*)\*$/u, "") + "**";
  }
  if (!tick && /(?:^|[^*\\])\*$/u.test(out)) return out.slice(0, -1);
  return out;
}
```

`closeOpenMarkers(source, tokens)` 先按 D9 判断，再对 `source` 的最后一行调用 `closeLine`。`lastChar`、`firstChar` 和统一排版议题的中文加粗共用，它们只取字符串两端，18,000 字符的长行从 96.8ms 降到 0.6ms。

## 2.4 分阶段实施

### Stage 1：抽出渲染配置

- 目标：行为不变，为增量逻辑准备好共用的 `Marked` 实例。
- 改动：新建 `shared/markdown-renderer.ts`，把 `Marked` 配置、复制按钮字符串、中文加粗分词和 `renderMarkdown` 移过去，导出 `markdown`、`renderMarkdown`、`COPY_TOKEN`、`firstChar`、`lastChar`；`shared/MarkdownBlock.tsx` 和测试更新引用。
- 完成定义：现有 Web 单测全部通过。

### Stage 2：增量逻辑

- 目标：纯函数通过 04 的 U 组用例。
- 改动：新建 `shared/markdown-stream.ts` 和 `shared/markdown-stream.unit.test.ts`。
- 完成定义：U 组通过。

### Stage 3：接入消息

- 目标：输出过程中按 Markdown 显示。
- 改动：
  - `shared/MarkdownBlock.tsx`：新增 `StreamingMarkdown`，用 `useLayoutEffect` 更新 DOM，复制按钮沿用 `onCodeCopy`。
  - `conversation/MessageRow.tsx`：输出中渲染 `StreamingMarkdown`。
  - `conversation/messages.css`：删除只剩 `.ohb-streaming-text` 的 `overflow-wrap` 规则，再从另外两处选择器里删掉它，保留 `.ohb-tool-panel pre` 等规则。
  - 按新结构更新受影响的测试断言。
- 完成定义：04 的 B-1 到 B-8 和 P 组通过。

### Stage 4：块级阅读位置

- 目标：读者停在长回答中段时，同一条消息上方变高或变矮，正在读的内容不动。这一步是 Mermaid 和公式的前置。
- 改动：`conversation/ConversationStream.tsx` 按下面的原型修改。另外两处写 `messageId` 和 `offset` 的地方（委托锚点、折叠回退）要同时清空两个新字段。
- 原型结果：上方变高时偏移从 200px 降到 0，变矮时从 -40px 降到 0，下方变化不受影响。

```ts
export interface ConversationReadingPosition {
  top: number;
  sticky: boolean;
  messageId?: string;
  offset?: number;
  blockIndex?: number;
  blockOffset?: number;
}

const readingBlocks = (row: HTMLElement) =>
  row.querySelectorAll<HTMLElement>(".ohb-markdown > *");

// captureReadingRow 找到消息行之后：
position.blockIndex = undefined;
position.blockOffset = undefined;
if (rect.top < top) {
  const blocks = [...readingBlocks(node)];
  const index = blocks.findIndex((b) => b.getBoundingClientRect().bottom > top);
  if (index >= 0) {
    position.blockIndex = index;
    position.blockOffset = blocks[index].getBoundingClientRect().top - top;
  }
}

// restoreReadingRow 拿到可见的消息行之后：
const block =
  position.blockIndex === undefined ? undefined : readingBlocks(row)[position.blockIndex];
const targetTop = (block ?? row).getBoundingClientRect().top;
const offset = block ? position.blockOffset : position.offset;
element.scrollTop += targetTop - element.getBoundingClientRect().top - (offset ?? 0);
```

- 完成定义：04 的 B-9、B-10 通过，现有滚动相关单测通过。

### Stage 5：同步设计文档

- `docs/ohbaby-web/redesign-2026-10/05-components.md`：补充 `StreamingMarkdown` 的职责和"完成后切回 `MarkdownBlock`"。
- 完成定义：文档和代码一致。

## 2.5 兼容与迁移

没有接口和数据变化。复制消息用的仍是原文，不受补全影响。

## 2.6 风险与回滚

| 风险 | 应对 |
|---|---|
| 增量结果和最终结果不一致 | 完成后全量重渲染，用户最后看到的一定是权威版本 |
| 补全把普通文本临时显示成粗体 | 用 2.3 的开合判断挡住路径和乘方，04 的 U-5 逐前缀检查 |
| 半截 HTML 影响页面 | 每个片段独立清洗，浏览器独立解析 |
| 输出过程中代码块的 Copy 按钮被替换 | 只影响正在写的结尾块，写完冻结后恢复正常 |
| 同一段里有大量未闭合的 `**` | `marked` 的耗时按平方增长：1,000 个约 136ms，3,000 个约 1.2 秒。这段停在结尾时每次更新都要重算，现在只在完成时卡一次。本轮不加保护，真实输出里出现卡顿时再给结尾块设上限 |

出问题时把 `MessageRow.tsx` 改回 `<pre>` 就能回退，其他文件不影响现有行为。

## 2.7 与其他议题的关系

表格和排版的 CSS 在输出过程中自动生效。[Mermaid](../../../ohbaby-web/markdown-mermaid/goals-duty.md) 在整条消息完成前都显示代码，完成后才由 `MarkdownBlock` 启动绘图，`StreamingMarkdown` 不需要知道 Mermaid。[LaTeX 公式](../../../ohbaby-web/markdown-math/goals-duty.md)会在这里的增量逻辑上打开 `math` 选项，写完一个公式就显示。两者都使用 Stage 1 导出的 `COPY_TOKEN`，并依赖 Stage 4 的块级阅读位置。

## 2.8 留到以后

- 半截链接和斜体的补全，看真实使用中是否明显再说。
- 超长未闭合代码块的第二冻结边界。只有实测卡顿时才做。
- 结尾块里未闭合 `**` 的数量上限。只有实测卡顿时才做。
