# 3. 优秀项目借鉴

## 3.1 借鉴来源

| 项目 | 调研范围 | 说明 |
|------|----------|------|
| ChatGPT（Web） | 对话 stick-to-bottom、用户上滚后停止跟滚；Enter+IME | 业界默认交互 |
| Claude.ai | 流式输出跟滚；回底恢复 | 同族产品 |
| Cursor Chat / Composer | 空态引导文案；聚焦后占位消失 | IDE 旁路聊天的占位习惯 |
| 本仓库既有 Web layout | `.ohb-stream` 单滚动容器 | 内部约束优先于外部像素 |

本议题无本地竞品源码树强制对照；以下为**行为级** adopt/adapt/reject，不要求像素级复刻。

## 3.2 可借鉴点

| 项目 | 做法 | 为何相关 | ohbaby 取舍 |
|------|------|----------|-------------|
| ChatGPT | 贴底阅读；上滚暂停自动滚 | 直接对应议题 A | **adopt** 状态机；阈值自定 80px |
| ChatGPT / Claude | 部分产品在 unpin 时显示「Jump to latest」 | 长回复友好 | **reject（本批明确不做）**；后续可选 |
| Claude | 流式时平滑感来自内容增长而非 CSS smooth scroll | 避免每 delta smooth 抖动 | **adopt** 瞬时 `scrollTop` 赋值 |
| Cursor 等 | 空态有引导短句，聚焦即让路 | 对应议题 B | **adapt** 为打字机轮播，而非静态一句 |
| 常见落地页 | 打字机循环多句 CTA | 品牌空态 | **adapt**：只在 composer 空闲未聚焦；running 不用 |
| ChatGPT / 多数 React chat | Enter 发送前检查 `isComposing`（及 229 兜底） | 对应议题 C | **adopt** 守卫；不改非组字 Enter=发送 |

## 3.3 明确不借鉴

| 做法 | 原因 |
|------|------|
| 滚动容器设 `overflow: hidden` 再自制滚动条劫持 wheel | 违反「不阻止滚轮」；可访问性差 |
| 用 `scrollIntoView({ behavior: "smooth" })` 跟每一 token | 流式会排队动画，体感迟滞/打架 |
| 把打字机做在真正的 `placeholder` 属性里靠 JS 改字符串 | 部分浏览器对动态改 placeholder 体验不一致；且难以做光标；overlay 更可控 |
| 复制某产品的完整 onboarding 多步空态 | 范围膨胀；本批只要 composer 引导 |
| 用 `compositionend` 自己再合成 Enter→发送 | 过度设计；标准是组字中忽略快捷键即可 |

## 3.4 对 02 方案的影响

- Phase A 的 stick/unpin/resume 直接来自 ChatGPT/Claude 行为共识。
- Phase A 不做 Jump 按钮，来自 00 边界 + 本节 reject。
- Phase B 用 overlay 打字机而非原生 placeholder 动画，来自本节「不借鉴动态 placeholder 属性」。
- 贴底使用瞬时赋值而非 smooth，来自流式场景的 Claude/ChatGPT 实践共识。
- Phase C 的 `isComposing` / `229` 守卫直接 adopt 业界 chat 输入惯例。
