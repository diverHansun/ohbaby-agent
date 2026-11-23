# LaTeX 公式：非功能约束

> 前置：[goals-duty.md](goals-duty.md)、[dfd-interface.md](dfd-interface.md)。
>
> 下面的数字来自 2026-11-23 的本机测试，环境是 Chrome、KaTeX 0.19.1、`marked` 15.0.12、Vite 5.4.21。Safari 和 Firefox 还没有测，列在 [test.md](test.md) 的验收项里。

## 1. Quality Priorities（质量优先级）

1. **安全**：模型内容不能在页面里执行或发起外部请求。
2. **不误伤普通文字**：宁可少渲染一个公式，也不要把价格和变量显示成公式。
3. **聊天不受影响**：没有公式时零额外下载，渲染失败不影响消息显示。
4. **可读**：字号协调，宽公式可滚动，复制能拿回源码。
5. **公式覆盖面**：常见写法优先，少见能力以后再加。

## 2. Operational Constraints（运行约束）

### 依赖

- `apps/ohbaby-web` 的运行时依赖新增 `katex`，**精确锁定 `0.19.1`**，不用 `^`。
- `katex` 是 MIT 许可。它依赖的 `commander` 只给命令行工具用，不进入浏览器包。
- 这是本议题单独确认引入的依赖。[2026-10 改版](../redesign-2026-10/07-quality-constraints.md)的“不新增运行时依赖”只约束那次改版。
- 升级 KaTeX 时必须重跑 [test.md](test.md) 的 U 组和 B 组，并确认字体过滤规则仍然有效。

### 体积

| 项目 | 约束或实测 |
|---|---|
| 首屏 JS 增量 | 只含公式语法和挂载代码。和 Mermaid 的首屏代码加起来，gzip 后不超过 15KB |
| 没有公式的会话 | 不下载 KaTeX、样式和字体 |
| 第一次出现公式 | JS 约 76KB、CSS 约 7.5KB（gzip），字体按实际用到的下载 |
| 全部 WOFF2 字体 | 19 个文件，约 250KB，通常只下载其中几个 |
| 构建产物里的字体 | 过滤后约 250KB；不过滤时 WOFF、TTF 一起打包，约 1,048KB |

Vite 配置加一个小插件，构建时只保留 WOFF2：

```ts
function katexWoff2Only(): Plugin {
  return {
    name: "ohbaby-katex-woff2",
    enforce: "pre",
    transform(code, id) {
      if (!/\/katex\/dist\/katex\.min\.css(?:\?|$)/u.test(id.replaceAll("\\", "/")))
        return;
      return {
        code: code.replace(
          /,url\([^)]*\.(?:woff|ttf)\) format\("(?:woff|truetype)"\)/gu,
          "",
        ),
        map: null,
      };
    },
  };
}
```

daemon 的 `contentTypeForPath` 目前会把 `.woff2` 返回成 `application/octet-stream`，这里增加 `font/woff2`。

### 输入限制

| 限制 | 值 | 依据 |
|---|---|---|
| 单个公式源码 | 5,000 字符 | 实测最坏情况约 185ms，其中渲染约 10ms、清洗约 175ms。20,000 字符的长公式会生成约 4MB HTML，清洗要 300ms 以上 |
| 宏展开 | 1,000 次 | 递归宏和指数展开会被拒绝 |
| 尺寸 | `maxSize: 10` | `\rule{100000em}{100000em}` 被限制在很小的范围内 |

### 性能

| 指标 | 结果 |
|---|---|
| 44 个常见公式，单次渲染 | 中位数 0.1ms，P95 0.2ms，最大 0.3ms |
| 200 个公式一次增强（含清洗） | 35ms |
| 输出时结尾有 2,931 字符的公式 | 不缓存每次 18.3ms，缓存后 2.1ms |

KaTeX 在主线程同步运行。按这个速度不需要 Worker，也不需要分帧。

### 误判

用真实的 `marked` 解析 `code-cli/` 下 8 个项目的 11,487 个 Markdown 文件（约 156 万行），规则只产生 3 个行内公式 token，内容都是更新日志里写的字面量 `$…$`。`\(...\)`、`\[...\]` 和行内 `$$...$$` 没有产生误判。

### 安全

- 只增强带本页随机标记的占位。
- `trust: false`，不生成链接和图片，也不接受 HTML 扩展命令。
- 占位 HTML 和 KaTeX 输出都经过 DOMPurify。
- LaTeX 源码只写进 `data-tex`，由浏览器转义，不拼进 HTML。

14 个恶意样例包括 `javascript:` 链接、外部图片、样式注入、递归宏和超深嵌套，都没有产生链接、图片、脚本或外部请求。

### App 适配

App 第一版的窗口直接打开 daemon 地址，显示同一份 ohbaby-web 构建产物，所以公式不需要单独适配。

- Electron 的渲染层是 Chromium，和已测试的 Chrome 同内核。
- KaTeX、样式和字体都在 `/assets/` 下，不依赖 CDN，离线可用。
- 以后改用自定义协议时，协议处理器要给 `.woff2` 返回正确的类型，并按站点根路径提供 `/assets/`。不支持直接用 `file://` 打开页面。
- 如果以后加 CSP，要允许 KaTeX 的行内样式（`style-src 'unsafe-inline'`）和同源字体（`font-src 'self'`）。

### 无障碍和兼容

- KaTeX 同时输出视觉 HTML 和 MathML，读屏软件能读到公式。
- 溢出的独立公式可以用键盘聚焦和滚动，做法和宽表格一致。
- 行内公式过宽时所在段落可以横向滚动，不单独增加 Tab 停留点。
- `:has()` 在 Web 现有的浏览器范围内可用（Chrome、Edge、Safari、Firefox 的当前版本和前一个主要版本）。

## 3. Reliability & Observability（可靠性与可观测性）

- 任何渲染失败都保留源码，不向外抛错，也不影响同一消息里的其他公式。
- 组件卸载或内容变化后，晚到的结果被丢弃。
- 不新增埋点。失败时不写控制台，因为错误信息可能带上消息内容。
- 需要排查时，看元素上的 `data-math-state`，再把 `data-tex` 放进 KaTeX 复现。

## 4. Trade-offs & Deferred Requirements（取舍与暂缓项）

| 取舍或暂缓 | 现在的做法 | 什么时候重新考虑 |
|---|---|---|
| `multline`、`\require` 等 | 显示源码 | 真实回答里经常出现 |
| `\ce{...}` 化学式 | 显示源码 | 用户需要化学内容时加 mhchem |
| 表格公式里的竖线没有转义 | 跟随 GFM，单元格可能错位 | 真实回答里经常出现 |
| `$f$(x)` 这种紧贴写法 | 不渲染 | 真实回答里经常漏渲染 |
| 文件预览里显示公式 | 不做，保留开关 | 用户需要预览 `.md` 里的公式 |
| 公式中有空行时的流式显示 | 完成后修正 | 用户反馈明显闪动 |
| 深色模式 | 不做，颜色继承文字 | ohbaby 引入深色模式 |
