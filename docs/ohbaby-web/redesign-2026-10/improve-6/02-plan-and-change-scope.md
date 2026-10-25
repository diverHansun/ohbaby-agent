# improve-6 · 提示与错误界面

> 2026-10-25 与用户讨论确定。小批次，现状、方案、验收合写在这一篇。路径相对 `apps/ohbaby-web/src/`。

## 现状

- 后端连不上时，同一个原因出现三处提示：中间一条红底横幅显示浏览器原话 `Failed to fetch`（`api/daemon/client-sync.ts` 把 `error.message` 写进 `store.error`，`ui/session/SessionScreen.tsx` 原样显示），顶栏一行橙色小写 `reconnecting`，侧栏 Projects 旁一个 `!`。
- 横幅的 Dismiss 只清操作错误和提交错误，`store.error` 清不掉，点了没反应。
- 空状态下横幅放在居中的那一列里，把图标和问候往下挤。
- 红底横幅也用在不是错误的地方：`Recovering conversation…`、`Submission result is unknown`、`Some thinking could not be saved`，违反 D32“红色只留给错误”。
- 原始技术报错直接给用户看，例如 `Permission subscription binding is missing or invalid`。
- 输入框下方的错误用等宽红字，和其他提示风格不一致。

## 决定

| 编号 | 决定 |
| --- | --- |
| F1 | 提示卡片照 pi-web 的通知做法：白底、细边、柔和阴影、圆角 14px，正文用 `--text-muted`，左侧 7px 圆点表示类型；不用整块彩色底。横幅、右上角通知用同一套样式。 |
| F2 | 三种类型只靠圆点颜色区分：错误用现有 `--danger`；需要留意用 Linear 的薰衣草蓝 `#5e6ad2`（参考 awesome-design-repository 的 `linear.app.md`），不用琥珀色；说明信息用中性灰。 |
| F3 | 连接状态只在顶栏显示：一个小胶囊，圆点加 `Connecting…` / `Reconnecting…` / `Syncing…` / `Offline`；连接中的圆点缓慢呼吸，`Offline` 用红点。连接不正常时不再显示 `store.error` 横幅。 |
| F4 | 显示前把原始报错翻译成人话：网络失败写成 `Can't reach ohbaby. Check that it's still running.`；内部协议错误写成 `Lost sync with ohbaby. Reload the page if this doesn't clear.`，原文打到控制台。其他报错照原样显示。 |
| F5 | 会自己消失的状态类错误（`store.error`）不放 Dismiss；操作失败和提交失败保留 Dismiss，并且点了一定消失。 |
| F6 | 空状态下横幅固定在主区顶部，不占居中那一列；会话中仍在对话区顶部。 |
| F7 | 类型对应：会话恢复中、部分思考未保存是说明；提交结果未知是需要留意；会话不可用、操作失败是错误。 |
| F8 | 输入框下方的行内错误改用界面字体，不再用等宽字体。 |

不在本批：命令结果卡片（`/status` 等的输出）和设置页的字段错误保持现状；侧栏 Projects 旁的重试图标保留，它在重连后仍是有效的重试入口。

## 改动面

- `ui/shared/Banner.tsx`（替换 `ErrorBanner.tsx`）、`ui/shared/error-text.ts`（新）、`ui/shared/shared.css`、`ui/shared/Notice.tsx`。
- `ui/session/SessionScreen.tsx`、`ui/session/SessionBanners.tsx`。
- `ui/shell/MainHeader.tsx`、`ui/shell/shell.css`。
- `ui/composer/composer.css`、`ui/styles/tokens.css`。
- 测试：横幅类名、Dismiss、断连时不出横幅、报错翻译、顶栏胶囊。

## 验收

1. 后端断开：只有顶栏胶囊 `Reconnecting…`，没有红色横幅；恢复后胶囊消失。
2. 三种类型的卡片只有圆点颜色不同，背景都是白色。
3. 操作失败的横幅点 Dismiss 后消失；状态类错误没有 Dismiss。
4. 空状态出现横幅时，图标、问候和输入框位置不动。
5. 网络失败显示人话，不显示 `Failed to fetch`。
6. Web 单元测试和类型检查通过。
