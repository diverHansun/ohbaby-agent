# 相邻项目的做法

同级 OpenCode 仓库的 `packages/app/src/session/timeline/virtualizer.tsx` 在 `dispatchIntent` 中先检查列表有没有超出视口，再处理向上滚动。对鼠标，它区分按下和松开，以区分拖动与列表自行调整高度。

ohbaby 已有同步暂停、阅读锚点和回到底部的判断。本次借鉴“结合实际滚动范围判断意图”这条规则，在现有消息组件内补足两个判断即可。
