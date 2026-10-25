# improve-5 · 输入框与空状态细节打磨

> 2026-10-25 与用户讨论确定。小批次，现状、方案、验收合写在这一篇。路径相对 `apps/ohbaby-web/src/`。

## 现状

- 输入框提示文字由 `ui/composer/Composer.tsx` 的 `composerPlaceholder` 决定：草稿 `Ask anything...`，会话 `Reply...`，运行中 `Steer now or queue a follow-up...`，重连中 `Draft while reconnecting…`。`Reply...` 读起来生硬，也没告诉用户能做什么。
- 空状态（`ui/session/DraftHero.tsx`）只有 Lychee 图标和项目选择器，没有进场动画。
- 输入卡片 `:focus-within` 的边框颜色和默认状态一样，获得焦点时看不出变化。
- 发送按钮从禁用切到可用是瞬间变色，按下也没有反馈。

## 决定

| 编号 | 决定 |
| --- | --- |
| E1 | 提示文字只说明功能，不写拟人化或“AI 腔”的话。草稿 `Describe a task, or type / for commands`，会话 `Follow up, or type / for commands`；运行中和重连中两句不变。`DraftFallback` 没有斜杠命令，用 `Describe a task`。参考 pi-web、opencode：提示文字顺带教用户用 `/`。 |
| E2 | 不做提示文字轮播或打字机效果。原生 placeholder 不能做动画，要模拟就得在 textarea 上叠一层文字，不值得。 |
| E3 | 图标下方加一行按时段变化的问候：早上 `Good morning`，下午 `Good afternoon`，晚上 `Good evening`，深夜（23 点到 5 点）`Working late?`。文字自己写，不使用 TUI 的 `working-phrases.ts`；品牌文案先不做。 |
| E4 | 空状态进场：图标、问候和输入卡片依次淡入并轻微上移，总时长约 0.4 秒，只播一次。动画结束后不保留 `transform`，避免影响卡片里的弹出菜单定位。 |
| E5 | 输入卡片获得焦点时边框加深，并加一圈很淡的外圈，过渡沿用 `--duration-fast`。 |
| E6 | 发送按钮只做轻量优化：背景色和颜色过渡，按下时缩小到 0.92。不加颜色、光效或弹跳。 |
| E7 | Thinking 指示器不改。 |

所有动画都受 `base.css` 里已有的 `prefers-reduced-motion` 规则约束，用户开启“减少动态效果”后直接显示最终状态。

## 改动面

- `ui/composer/Composer.tsx`：`composerPlaceholder` 换文案。
- `ui/session/DraftHero.tsx`：增加问候行和 `greetingFor(hour)`。
- `ui/session/DraftFallback.tsx`：提示文字。
- `ui/session/session.css`：问候样式、进场动画。
- `ui/composer/composer.css`：焦点样式、发送按钮过渡。
- `ui/styles/tokens.css`：新增 `--border-focus`、`--ring-soft`。
- 测试：`ui/App.unit.test.tsx` 的提示文字断言，`DraftHero` 问候时段的单元测试。
- `03-ui-layout-and-style.md` 中提示文字一条同步更新。

## 验收

1. 新对话显示 `Describe a task, or type / for commands`，已有会话显示 `Follow up, or type / for commands`，运行中显示原来的引导句。
2. 空状态出现按时段变化的问候；进场动画只播一次，开启减少动态效果后没有位移。
3. 点进输入框，边框和外圈有可见变化；离开后恢复。
4. 输入文字后发送按钮平滑变成可用；按下有缩小反馈；手机宽度下点击区域仍是 44px。
5. 斜杠命令面板、模型菜单在空状态和会话中位置正常。
6. Web 单元测试和类型检查通过。
