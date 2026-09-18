# 4. 测试与验收标准

> 仓库无项目级 `test-blueprint.md`。沿用 `docs/ohbaby-web/test.md`：colocated vitest。本议题不引入像素截图回归；须启动本地 Web 做浏览器端到端检查。不改 TUI 契约测（它们必须继续绿）。

---

## 4.1 测试范围

| 类型 | 覆盖什么 | 不覆盖什么 |
|------|----------|------------|
| styles.unit | 工具箭头 14px + 不可收缩；summary `flex: 1`；无 `.ohb-prompt`；statusbar 44px；sidebar-header 仍 58px；textarea `padding: 0`；composer-input 不是 stretch | 像素截图 |
| App.unit | composer 内无 `.ohb-prompt`；打字机显隐仍成立；1–7 行高度用例仍绿 | 视觉「正中」的分数 |
| tool-card.unit | 仍渲染 `.ohb-tool-panel` 与展开 `pre`；chevron svg 存在 | jsdom 里 flex 是否挤扁 |
| TUI contract | **原样跑** | 不改断言 |
| 本地浏览器 E2E | 可重复数据下，长/短摘要箭头一样大且能展开；单行字在框中；多行钮右下；顶栏变矮、侧栏顶没变；窄屏可用 | 全机型 QA、像素截图基准、真实模型服务 |

## 4.2 关键场景与用例

| ID | 场景 | 类型 | 验证点 | 对应 02 Stage |
|----|------|------|--------|----------------|
| T1 | 工具箭头几何 | styles.unit | `.ohb-tool-chevron`（或实施时的稳定选择器）规则含 `width: 14px`、`height: 14px`，且含 `flex: none` 或 `flex-shrink: 0` | 1 |
| T2 | 摘要让位 | styles.unit | `.ohb-tool-summary` 含 `flex: 1` 与 `min-width: 0` | 1 |
| T3 | 工具卡行为回归 | tool-card.unit | 短失败仍自动展开；标题不暴露 call id；仍有 `.ohb-tool-panel` | 1 回归 |
| T4 | 无 prompt 符 | App.unit + styles.unit | 主会话与空项目页的 `.ohb-composer-input` 都没有 `.ohb-prompt`；CSS **没有**选择器恰好为 `.ohb-prompt` 的规则块。断言不得写成「全文不出现 `ohb-prompt`」——`.ohb-prompt-queue` 必须仍在 | 1 |
| T5 | 7 行盒模型未毁 | 已有 App.unit + styles.unit | textarea 高度函数仍 24 / 72 / 168；CSS 仍 `line-height: 24px`、`padding: 0`、`max-height: 168px` | 1 回归 |
| T6 | 输入行对齐契约 | styles.unit | `.ohb-composer-input` **不是** `align-items: stretch`；`.ohb-composer-text` 含 `min-height: 32px` | 1 |
| T7 | 顶栏变矮 | styles.unit | `.ohb-statusbar` 含 `min-height: 44px`，规则里的垂直 padding 为 8px 量级，不是 14px | 1 |
| T8 | 侧栏顶未动 | styles.unit | `.ohb-sidebar-header` 仍含 `min-height: 58px` | 1 |
| T9 | 打字机仍只在空闲空框未聚焦 | 已有 App.unit | 不因删 `>` 而常驻或消失错 | 1 回归 |
| T10 | 长摘要 vs 短摘要（手工） | 浏览器 | 同一屏里 subagent 长 prompt 与较短 web_search，右侧三角视觉同大，约 14px | 1 |
| T11 | 单行居中（手工） | 浏览器 | idle 打字机、running 的 `run in progress`、输入一字后的正文，都在圆角框垂直中线附近，不再贴底；左侧没有 `>` | 1 |
| T12 | 多行贴底（手工） | 浏览器 | 打到 3 行以上，纸飞机/停止圆钮贴输入框右下，思考芯片贴钮左侧 | 1 |
| T13 | 顶栏 vs 侧栏（手工） | 浏览器 | 会话顶栏明显矮一截；左侧项目名那条高度看起来没变；两边底边**可以不齐** | 1 |
| T14 | 窄屏顶栏 | 浏览器 720px 以下 | 状态/模型名仍可换行；垂直空白不要回到 14px 档 | 1 |
| T15 | TUI | cli contract | 不因本轮变红 | 回归 |
| T16 | 权威文档 | 对照 | `components.md` 无「`>` 提示符」；写明顶栏约 44px、不与侧栏对齐、工具箭头 14px；`test.md` density 行已补 | 2 |
| T17 | overlay / 权限钮 | 已有 styles.unit | 圆钮 32px 仍在；`.ohb-button-primary` 仍非 50% | 1 回归 |
| T18 | 本地 Web 端到端 | 真实浏览器 + 可重复数据 | 页面可打开；工具卡长/短摘要、折叠交互、输入空态/正文/多行、顶栏及窄屏布局均核验；保留检查地址供用户复查 | 1 |

改现有测试时：不要再假设 DOM 里存在 `.ohb-prompt` 或文本节点 `>`。用户消息正文里的 `>` 与输入框装饰符不是一回事，断言必须打在 `.ohb-composer-input .ohb-prompt`。

## 4.3 集成边界

- **几何 vs 数据**：T1–T2 失败说明 flex 没锁死；不要去改 `pairToolParts`。
- **高度算法**：T5 失败说明有人动了 textarea padding 或 24/7 常量。先撤 chrome 改动里误伤的盒模型，不要「顺便」重写 `fitComposerTextarea`。
- **左右顶栏**：T8 失败就是越界改了侧栏。按 00 还原。
- **TUI**：Web 去 `>` 不得改 cli prompt。

## 4.4 回归清单

- density：圆钮无字、1–7 行、思考芯片在框内、状态纯字、工具名无内层胶囊、外层白卡还在。
- send-stop：单槽互斥、running 空草稿 Stop、running 有草稿入队、改队列纸飞机保存原条目。
- Enter 发送、Shift+Enter 换行、IME、slash palette 不被输入行裁切。
- 工具 pairing、短失败自动展开一次。
- Goal 芯片、权限模态、mode/policy。
- TUI Esc 提示原句。

## 4.5 验收标准（发布门）

| 项 | 标准 | 如何验证 |
|----|------|----------|
| 箭头统一 | 所有 ToolPanel 折叠箭头 14px，长摘要不缩小 | T1、T2、T10 |
| 无 `>` | 输入框左侧没有提示符 | T4、T11 |
| 单行居中 | 占位和输入不贴底、不贴顶 | T6、T11 |
| 多行贴底 | 圆钮右下 | T12 |
| 7 行仍成立 | 空 1 行、满 7 行内滚 | T5 |
| 顶栏变矮 | 会话栏约 44px | T7、T13 |
| 侧栏未对齐改动 | 侧栏顶仍 58px | T8、T13 |
| overlay 未被连坐 | 扁主按钮仍在 | T17 |
| TUI | 零功能 diff | T15 + diff 审查 |
| 权威文档 | components/test 与 00 一致 | T16 |
| 浏览器 E2E | 本地 Web 页面完成 T10–T14、T18 的实际检查 | 浏览器记录 + 用户复查 |

建议命令（实施会话按仓库脚本调整）：

```bash
pnpm exec vitest run apps/ohbaby-web/src/ui/App.unit.test.tsx \
  apps/ohbaby-web/src/ui/styles.unit.test.ts \
  apps/ohbaby-web/src/ui/tool-card.unit.test.tsx

pnpm exec vitest run packages/ohbaby-cli/src/tui/app.contract.test.tsx
pnpm typecheck
```

1–7 行高度断言目前写在 `App.unit.test.tsx`（`fits the composer textarea to one through seven visual lines`），没有单独的 `composerTextarea.unit.test.ts`。不要为了本轮去新建那份文件。

## 4.6 对抗性审查要点

| 攻击面 | 最可能怎么坏 | 防御 | 残余风险 |
|--------|----------------|------|----------|
| SVG 仍被挤 | 只改了 `size={14}`，flex 项仍可缩 | T1 锁 CSS 宽高和 shrink | 以后有人把 chevron 包进会 shrink 的 span |
| 7 行漂移 | 用 textarea padding 做视觉居中 | T5；02 禁止 | 改字号时两处常量仍要一起动（既有风险） |
| 多行钮居中 | 图省事把输入行改成 `center`/`stretch` | T6；02 保留 flex-end | 极高输入框里钮贴底，有人会再提「钮也居中」——那是另一题 |
| 侧栏被顺手改 | 「顶部分割线不齐看着像 bug」 | T8 + 00 明文 | 用户以后若改口，另开议题 |
| 窄屏抵消变矮 | 只改了桌面 padding | T7 看规则；T14 看 720px | 换行后栏变高是允许的 |
| 文档仍教 `>` | 只改了 CSS，忘了 components.md | T16 | density 历史文档仍写贴顶，实施者可能读错批次——README/00 已指向本轮覆盖 |
| 误删队列样式 | 用字符串「ohb-prompt」做负向匹配，把 `.ohb-prompt-queue` 一起干掉 | T4 要求精确选择器 | 队列 UI 回归见既有 App.unit |

对应 01 高风险：箭头只改属性不改 CSS、textarea padding 破坏 7 行、误改侧栏。T1/T5/T8 分别接住。
