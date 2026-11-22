# 4. 测试与验收

## 4.1 测试范围

| 类型 | 覆盖什么 |
|---|---|
| 单测 / 集成测试（Vitest + jsdom） | 按钮文字、菜单结构、Effort 二级、选择后保存、各种思考状态、手机"更多"菜单 |
| 浏览器走查 | 桌面宽度和 375px 手机宽度下的布局、键盘操作、深浅色 |
| 不测 | 后端和 SDK（本轮不改）、`useReasoning` 的内部逻辑（不改，已有测试覆盖） |

## 4.2 关键场景与用例

| ID | 场景 | 类型 | 验证点 | 对应 02 |
|---|---|---|---|---|
| A-1 | 支持思考的模型 | 单测 | 按钮显示"模型名 强度"，强度元素用次要色样式类，首字母大写 | A2，Stage 1 |
| A-2 | 不支持思考的模型（`hidden`） | 单测 | 按钮只显示模型名；菜单里没有 Effort 一行 | A2、A4 |
| A-3 | 识别中、未知 | 单测 | 按钮只显示模型名；Effort 一行显示"Detecting…"或"Unknown"，不能点，`title` 是原因；有保留档位时显示"High · inactive" | A2、A4 |
| A-4 | 进入 Effort 二级并选择 | 单测 | 点 Effort 进入二级，当前档位打勾；选另一档后调用 `updateSessionReasoning`（草稿时调用 `onReasoningChange`），菜单关闭，焦点回到按钮，按钮上的强度更新 | A5、A6 |
| A-5 | 二级里按 Esc 或点"‹ Effort" | 单测 | 回到根层，不关闭菜单；根层再按 Esc 才关闭 | A5 |
| A-6 | 换模型后强度联动 | 集成 | 选一个强度档位不同的模型后菜单关闭；再次打开时 Effort 显示新模型的档位；原档位新模型不支持时回落到默认值（沿用 `App.unit.test.tsx` 现有断言） | A6 |
| A-7 | 长模型列表 | 集成 | 9 个及以上模型时出现筛选框；输入筛选词后 Effort 一行和"Manage models…"仍然显示；列表滚动时 Effort 一行不动 | A4 |
| A-8 | 保存强度失败 | 单测 | Effort 一行下出现错误文字（`role="alert"`），按钮上的强度文字变成 danger 样式 | A7 |
| A-9 | 手机宽度（< 640px） | 单测 + 浏览器 | "更多"菜单里只有 Full access，没有 Reasoning Effort；合并按钮显示强度；375px 宽度下底部一行不换行，模型名截断、强度完整 | A3、A8 |
| A-10 | 键盘 | 浏览器 | Tab 到按钮 → Enter 打开 → 方向键到 Effort → Enter 进入二级 → 方向键选择 → Enter 确认，全程不用鼠标 | A5、A9 |

## 4.3 集成边界

- `ModelMenu` ↔ `useReasoning`：只通过 `ReasoningState` 交互，测试里可以直接构造四种状态。
- `ModelMenu` ↔ `shared/Menu.tsx`：二级菜单和筛选能力用现有实现，不改 `Menu`。
- 前端 ↔ 后端：`updateSessionReasoning`、`getCurrentModel` 的调用方式不变，测试里继续用现有的假客户端。

## 4.4 回归清单

| 不能坏的行为 | 怎么查 |
|---|---|
| 选模型：挂起、回传后打勾、失败恢复原文字并报错 | `composer/model-refresh.integration.test.tsx` 现有用例全部通过 |
| 思考强度按会话保存，换会话后显示各自的值 | `App.unit.test.tsx` 现有思考强度用例（约 5980–6180 行）改成菜单操作后仍然通过，断言内容不删 |
| 换模型后清掉不支持的强度，不会在换回来时复活 | 同上 |
| 默认模型的 `default` 标记、"Manage models…" 入口 | `model-refresh.integration.test.tsx` |
| 手机 Full access 开关仍弹出确认对话框 | `App.unit.test.tsx` 里"更多"菜单相关用例 |
| 消息区的思考内容样式（`conversation/messages.css` 的 `ohb-reasoning-*`） | 浏览器里看一条带思考内容的消息 |

## 4.5 验收标准

| 项 | 标准 | 怎么验证 |
|---|---|---|
| 功能 | A-1 到 A-10 全部通过 | 单测 + 浏览器走查记录 |
| 构建 | 类型检查、lint、格式检查、单测通过 | `pnpm typecheck`、`pnpm lint`、`pnpm format:check`、`pnpm test:unit`、`pnpm test:integration` |
| 代码清理 | `ReasoningControl.tsx` 已删除；`controls.css` 里没有只给它用的样式；`ComposerMoreMenu` 没有 `reasoning` 参数 | 搜索 `ReasoningControl`、`ohb-reasoning-control`、`ohb-reasoning-status` 在 `apps/ohbaby-web/src` 下无结果 |
| 设计文档 | `docs/ohbaby-web/redesign-2026-10/` 的 README、03、04、05 已按 02 Stage 2 更新 | 在这几篇里搜"思考强度"和 `ReasoningControl`，没有和代码矛盾的描述 |
| 视觉 | 桌面和 375px 下截图，按钮里强度是次要灰色，没有胶囊、卡片样式 | 浏览器截图附在 05 |

## 4.6 对抗性审查要点

| 攻击面 | 可能出的问题 | 防御 | 残余风险 |
|---|---|---|---|
| 换模型的挂起期 | 请求已返回但会话还没回传时打开菜单，Effort 显示旧模型的档位，用户选了一个新模型不支持的值 | 选完关闭（A6）；`useReasoning` 收到新能力后会清掉不支持的值 | 极短的窗口内仍可能选到旧档位，但会被自动清掉，不会发错请求 |
| 筛选框 | Effort 一行被筛选逻辑隐藏，或者被当成模型行选中 | `data-menu-filter="false"`；A-7 验证 | 无 |
| 窄屏 | 模型名很长时按钮挤掉发送按钮 | A3 截断模型名；A-9 在 375px 验证 | 超长强度名（不常见）可能让按钮偏宽 |
| 焦点 | 二级菜单关闭后焦点丢失，键盘用户迷路 | 选完焦点回到按钮（A6）；A-10 验证 | 无 |
| 测试改写 | 改写 `App.unit.test.tsx` 时顺手删了断言 | 4.4 要求断言内容不删，验收时对比改写前后的断言数量 | 依赖评审细心 |
