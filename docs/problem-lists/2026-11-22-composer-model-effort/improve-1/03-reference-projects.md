# 3. 参考项目借鉴

## 3.1 借鉴来源

| 项目 | 路径或来源 | 看了什么 |
|---|---|---|
| Claude Code、Codex、Cursor | 用户 2026-11-22 提供的截图 | 输入框里模型和思考强度的入口 |
| deepseek-harness | `../deepseek-harness/packages/client/ui-model-selection/src/client/ModelSelect.tsx` | 合并按钮、根菜单、二级列表、选完后的焦点 |
| ZCode | `../ZCode/docs/composer-model-thinking.md` | 合并按钮、弹层结构、强度滑杆 |
| kimi-code | `../kimi-code/packages/app-components/src/composer/Composer.vue`（3593–3690 行）、`../kimi-code/packages/app-core/src/lib/modelThinking.ts` | 模型下拉框和强度分段按钮 |

路径都相对 `ohbaby-agent` 仓库根目录。

## 3.2 可借鉴点

| 项目 | 做法 | 和我们的关系 | ohbaby 取舍 |
|---|---|---|---|
| Claude Code、Codex、Cursor | 模型和思考强度放在同一个入口 | 本议题的出发点 | 采用 |
| deepseek-harness | 按钮显示"模型名 + 次要色强度"；根菜单是 Model 和 Effort 两行，每行显示当前值和 `›`，各自点进二级列表；Esc 先退出二级再关闭；选完关菜单，焦点回到按钮；换模型的请求未完成时按钮显示转圈 | 和我们的结构最接近 | 采用按钮文字、Effort 一行的样子、二级列表、Esc 行为和选完关闭。**改动**：根层直接列出模型，不再多一层"Model ›"，因为我们现有的模型菜单已经是根层列表，用户少点一次 |
| deepseek-harness | 强度未确定时保留用户上次选的档位（`retainedEffort`） | 我们的 `useReasoning` 已有同样的概念（`inactive`） | 沿用我们自己的实现，Effort 一行显示"High · inactive" |
| ZCode | 一个按钮显示"模型 + 强度"，强度用次要色；弹层里模型列表下面是 Effort 标题和当前档位 | 按钮文字和我们一致 | 采用按钮文字 |
| kimi-code | 模型按钮显示"· High"，下拉里模型列表下面是 Thinking 分段按钮 | 一个入口 | 只借鉴"一个入口" |

## 3.3 明确不借鉴

| 项目 | 做法 | 不借鉴的原因 |
|---|---|---|
| ZCode | 离散滑杆调强度，带渐变和动画 | 用户已确认不用滑块；实现和维护成本都高 |
| ZCode | 选完模型菜单不关 | 我们选模型要等会话回传才生效，菜单不关会显示旧模型的档位（02 A6） |
| ZCode | 弹层顶部的供应商子菜单 | 我们按提供方分组直接列出，不需要先选供应商 |
| kimi-code | 分段按钮（SegmentedControl） | 属于胶囊样式，和 Web 风格不符 |

## 3.4 对 02 方案的影响

- 02 A2（按钮文字）、A4（Effort 一行）、A5（二级列表和 Esc）、A6（选完关闭）直接来自 deepseek-harness。
- 02 A5 不用滑块、A8 手机上不保留第二个入口，来自对 ZCode 和 kimi-code 的取舍。
