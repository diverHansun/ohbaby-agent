# Thinking 和 Compacting 等待动效

本议题于 2026-11-23 开启并完成，重做 ohbaby Web 对话区的两个等待动效。只改 Web。TUI 继续用文字流光，不在本议题范围内。

## 原来的问题

- Thinking 是水平三个点轮流亮起，能表达“在等”，但没有记忆点。
- Compacting 只是把这三个点转成竖排。两种状态看起来是同一个东西，用户分不清模型在思考还是在压缩上下文。

## 参考项目

| 项目 | 等待时的做法 | 压缩时的做法 |
|---|---|---|
| deepseek-harness | 鲸尾 APNG 加蓝色文字流光 | 走通用命令卡片 |
| OpenCode | 5×5 点阵雷达（1.8s 一圈）加文字流光 | 单独的 Compacting 状态行 |
| ZCode | 渐变文字流光，工作流界面有点状波浪 | 压缩分隔线运行时隐藏图标 |
| Kimi Code | 月相动画 | 盲文字符 spinner |
| Step Code | 默认盲文字符，可配置 | 没有找到专门的压缩动效 |

从这些项目借鉴了两点：等待和压缩用不同的动作区分，文字用流光表达“还在进行”。动画实现参考 OpenCode 的 `spinner-radar.ts`，把位置函数采样成 CSS 关键帧。

## 确认的方案

讨论时比较了 12 个方案，Thinking 和 Compacting 各 6 个。

| 项目 | 决定 |
|---|---|
| Thinking 动效 | T1 三角聚散，并把三个点的轨迹做得更复杂 |
| Compacting 动效 | C6 螺旋吸入 |
| 颜色 | 两者都用品牌三色 |
| 文字 | `Thinking` 和 `Compacting` 都用流光 |
| 速度 | 1× |

### Thinking：一轮 5.2 秒

```text
三角扭转 → 螺旋展开成一排 → 波浪滚动 → 绕中间点公转 → 螺旋收回三角
 0–24%        24–36%         36–62%       62–80%         80–100%
```

### Compacting：一轮 1.9 秒

六个小点从外圈依次螺旋飞向中心，越靠近越小，到中心时淡出。中心的金色圆点轻轻跳动，表示内容正在被收进去。

## 实现

| 文件 | 作用 |
|---|---|
| `apps/ohbaby-web/src/ui/conversation/activity-mark.ts` | 两种动效的轨迹和关键帧生成 |
| `apps/ohbaby-web/src/ui/conversation/ActivityMark.tsx` | 渲染圆点，并把关键帧写入页面一次 |
| `apps/ohbaby-web/src/ui/conversation/ExecutionProgress.tsx` | 把新动效接到 Thinking 和 Compacting 状态 |
| `apps/ohbaby-web/src/ui/session/session.css` | 品牌色、尺寸、文字流光和减少动态效果时的样式 |

几个实现上的取舍：

- 动画只改 `transform` 和 `opacity`，不触发页面重新布局。
- 系统开启“减少动态效果”后，圆点停在一个清楚的静止姿态，文字不再流光。
- 品牌色仍然受样式测试约束，只允许用在字标、Lychee 和这两个等待标记上。
- `Retrying #n` 不加流光，避免重试提示被误读成正常进行中。

## 验证

- 单元测试覆盖循环首尾衔接、圆点不出框、Thinking 轨迹连续、Compacting 只在透明时重生，以及关键帧和静止姿态。
- 在内置浏览器里挂载真实的 `ModelWaiting` 和 `Compacting` 组件，逐阶段检查了 Thinking 的 18 个关键帧和 Compacting 的 12 个关键帧，也看了原始尺寸和放大后的运行画面。
- 浏览器验证用的是假的运行状态，没有发起真实模型请求，也没有触发真实的上下文压缩。
