# 4. 测试与验收标准

> 仓库无项目级 `test-blueprint.md`。沿用 colocated vitest。不引入视觉截图框架，不改 TUI 契约测。

---

## 4.1 测试范围

| 类型 | 覆盖什么 | 不覆盖什么 |
|------|----------|------------|
| App.unit | New session 无 Plus、可点仍建会话；顶栏有环；default 点权限先出卡再 PATCH；暂不零 PATCH；full-access 点回立刻 default | 浅灰好不好看 |
| ContextUsage.unit | null 仍有空环按钮；有 usage 仍开 popover；不编造 composition | 后端 usages 是否总有值 |
| styles.unit | `.ohb-sidebar-new` 无 border；侧栏折叠 transition 仍在；statusbar 44px | 全 CSS 快照 |
| 已有 PermissionModal 测例 | 四键 class 不被本轮改掉 | 重写审批文案 |
| TUI contract | **原样跑** | 不改断言 |
| 手工/浏览器 | 按钮左右完整、hover 整块灰、圆环可见、确认卡英文两键 | 全机型 QA |

## 4.2 关键场景与用例

| ID | 场景 | 类型 | 验证点 | Stage |
|----|------|------|--------|-------|
| T1 | 无 Plus、有方笔 | App.unit | `.ohb-sidebar-new` 文案仍是 `New session`；其中 svg 来自 SquarePen 而不是 Plus（项目轨上的 Plus 保留） | 1 |
| T2 | 仍能建会话 | App.unit | 现有「creates and selects sessions from the sidebar」仍绿 | 1 |
| T3 | 无描边 | styles.unit | `.ohb-sidebar-new` 规则不含实线 border（或 `border: 0` / `none`） | 1 |
| T4 | 折叠不回退 | App.unit + styles.unit | 关闭后 `.ohb-sidebar` 仍在且 inert/不可点；transition 仍在 | 1 回归 improve-2 |
| T5 | 空环常驻 | ContextUsage.unit | `usage === null` 仍有 `.ohb-context-ring-button`；aria 含 unavailable/pending 一类词，不含假百分比 | 2 |
| T6 | 有数据的环 | ContextUsage.unit | 现有 37% / popover 测例仍绿 | 2 |
| T7 | 顶栏挂环 | App.unit | 带 `contextWindowUsages` 的 snapshot 下，`.ohb-statusbar .ohb-context-ring-button` 存在 | 2 |
| T8 | 无 usage 的顶栏 | App.unit | `contextWindowUsages: []` 时顶栏**仍有**空环按钮 | 2 |
| T9 | 顶栏高度 | styles.unit | `.ohb-statusbar` min-height 44px | 2 回归 improve-1 |
| T10 | 升权先确认 | App.unit | default 下点权限图标：**不立刻** `setPermission`；出现确认 dialog / 「Use full access」 | 3 |
| T11 | 确认才 PATCH | App.unit | 点「Use full access」后才 `setPermission({ level: "full-access" })` | 3 |
| T12 | 暂不零请求 | App.unit | 点「Not now」或发 Escape 后 `setPermission` 未被以 full-access 调用；图标仍是 default | 3 |
| T13 | 降级立刻 | App.unit | full-access 快照下点权限图标立刻 `setPermission({ level: "default" })`，无确认卡 | 3 |
| T14 | 审批模态隔离 | App.unit | 现有「styles permission choices by their consequence」四键 class 不变 | 3 回归 |
| T15 | 手工：新建按钮 | 浏览器 | 左右都离开侧栏边；无描线；hover 整块浅灰；图标是方笔不是 + | 1 |
| T16 | 手工：圆环 | 浏览器 | 长会话顶栏看得到环；空数据是空环不是消失；点击仍能开明细 | 2 |
| T17 | 手工：确认卡 | 浏览器 | 英文标题/两键；打开时焦点在「Use full access」；Enter 立即确认；友好短风险说明；无能力大面板 | 3 |
| T18 | TUI | cli contract | 不因本轮变红 | 回归 |
| T19 | 权威文档 | 对照 | components Header/Composer 与 00 一致 | 4 |
| T20 | 发送互斥 | 已有 App.unit | 单槽发送/停止不因确认卡变红 | 回归 |
| T21 | 用户气泡 | App.unit + styles.unit | 无可见角色标签；用户正文使用右侧浅蓝气泡，最大宽度 76%；article 保留 `User message` 可访问名称 | 4 |
| T22 | Agent 正文 | App.unit + styles.unit | 无图标、无名称、无气泡，内容占阅读列宽度 | 4 |
| T23 | 工具默认收起 | tool-card.unit | completed / running / failed 均不自动展示详情 | 5 |
| T24 | 失败摘要静默 | tool-card.unit + App.unit | 仅工具名称使用红色；摘要无 `failed` 和错误文本，详情默认收起 | 5 |
| T25 | 主动排查 | tool-card.unit | 点击后同时展示 Input 与 Output；部分输出和独立错误同时存在时两者均可见 | 5 |
| T26 | 披露箭头 | styles.unit + 浏览器 | 默认隐藏，hover/focus 出现右箭头，展开后持续显示并向下 | 5 |
| T27 | 轻量表面 | styles.unit + 浏览器 | 工具根节点透明、无 border；展开区仅用浅底分组 | 5 |
| T28 | 工具名称语义色 | tool-card.unit + styles.unit | read 金、edit/write 绿、其他蓝；失败覆盖为红，颜色不扩散到摘要与整行 | 5 |
| T29 | 连续工具密度 | styles.unit + 浏览器 | 工具行上下外边距 2px；按钮上下内边距 3px；hover 背景、圆角与左右内边距保持原设计 | 5 |

必须改写的旧合同：

- `ContextUsage.unit.test.tsx`：「does not render an empty ring when usage is unavailable」改为断言空环存在。
- `App.unit.test.tsx`：「cycles permission policy directly without opening a menu」拆成 T10–T13，不再要求点击立刻 PATCH full-access。

## 4.3 集成边界

- **脸 vs 协议**：T10 失败若变成改 PATCH 字段，就走错层了。确认卡只拦 Composer 点击。
- **侧栏动画**：T4 失败多半是修裁切时删掉 inner min-width 或又 `return <></>`。
- **圆环数据**：T8 过了但真实环境仍无环，才是 snapshot 没 usages，记入 05 / 后端候选，不在前端造数。
- **焦点**：手工 T17 打开卡后 Tab 不要掉进输入框把 Enter 变成发消息。

## 4.4 回归清单

- improve-1：箭头 14px、无 `>`、顶栏 44px、侧栏顶 58px。
- improve-2：灰/黄描边、灰手/红盾、composer 800 / stream 720、侧栏推进动画、三色字标、思考三色。
- PermissionModal 四键、Goal 芯片、slash 错误与改队列 hint。
- `fitComposerTextarea` 22×7。

## 4.5 验收标准（发布门）

| 项 | 标准 | 如何验证 |
|----|------|----------|
| 单测 | T1–T14 及相关旧测例绿 | `pnpm exec vitest run apps/ohbaby-web/src/ui/App.unit.test.tsx apps/ohbaby-web/src/ui/ContextUsage.unit.test.tsx apps/ohbaby-web/src/ui/styles.unit.test.ts` |
| TUI 未误伤 | cli contract 不因本轮红 | 现有 TUI 测 |
| 浏览器 | T15–T17 | 本地 web：侧栏按钮、有/无 usage 的 header、点灰手出卡 |
| 文档 | T19 | 对照 components.md |
| 协议 | 无新字段 | diff 不含 `packages/ohbaby-agent` permission/context 算法 |

## 4.6 对抗性审查要点

| 攻击面 | 防御 | 残余风险 |
|--------|------|----------|
| 新建按钮宽度覆盖影响折叠动画 | T4 + 手工开关侧栏 | 特定选择器写错仍可能裁切 |
| 空环被做成 0% Full | T5 禁假百分比 | 产品以后可能想显示 0 / window，需另议 |
| 确认卡做成 PermissionModal | T14 + 新卡选择器 | 视觉抄 slide-up 会让用户以为在批工具 |
| 焦点在输入框时 Enter 误发送 | 打开卡时 trap 焦点 | 不做焦点管理就会中招 |
| 玻璃底上轨道仍看不见 | 手工 T16 | token 微调用眼睛收，不靠单测锁色值 |
