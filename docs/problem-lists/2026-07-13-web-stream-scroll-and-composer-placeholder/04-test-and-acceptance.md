# 4. 测试与验收标准

## 4.1 测试范围

| 层 | 覆盖什么 | 不覆盖什么 |
|----|----------|------------|
| 纯函数 / 组件 unit | `isNearBottom`、stick 决策、打字机在 fake timers 下的显隐与暂停、`isImeComposing` | 真实浏览器惯性滚轮手感；全系统 IME 矩阵 |
| App unit（jsdom） | session 切换重置 stick；mock 指标下 unpin/resume；旧 placeholder 文案消失；focus 隐藏 overlay；**composing Enter 不发送** | 视觉像素 |
| styles unit | 既有 `.ohb-stream` 滚动契约不回归；可选 typewriter class 存在 | 动画观感 |
| 手工 / Playwright（实施者自选强度） | 真实流式跟滚、滚轮 unpin、打字机观感、reduced-motion、**中文输入法 Enter 上屏** | 全矩阵 E2E 不必为本批新建庞大套件 |

推荐命令（以仓库现有 web 测试入口为准，实施时按 package script 调整）：

```bash
# 示例：聚焦本批相关单测
pnpm --filter ohbaby-web test -- src/ui/streamScroll.unit.test.ts
pnpm --filter ohbaby-web test -- src/ui/TypewriterPlaceholder.unit.test.tsx
pnpm --filter ohbaby-web test -- src/ui/ime.unit.test.ts
pnpm --filter ohbaby-web test -- src/ui/App.unit.test.tsx
pnpm --filter ohbaby-web test -- src/ui/styles.unit.test.ts
```

## 4.2 关键场景与用例

| ID | 场景 | 类型 | 验证点 | 对应 02 Phase |
|----|------|------|--------|---------------|
| S1 | 元素距底 ≤80px | unit | `isNearBottom` → true | A |
| S2 | 元素距底 >80px | unit | `isNearBottom` → false | A |
| S3 | stick=true 时内容高度增加 | unit/App | 调用贴底（scrollTop ≈ scrollHeight） | A |
| S4 | stick=false 时内容高度增加 | unit/App | **不**改写 scrollTop | A |
| S5 | scroll 使离开底部 | App | stick 变为 false | A |
| S6 | scroll 回到底部附近 | App | stick 变为 true | A |
| S7 | 切换 session | App | stick 重置 true 并贴底 | A |
| S8 | 流式同 id 文本变长（模拟 signature/observer） | App | stick=true 时贴底 | A |
| P1 | idle 空未聚焦 | App | 可见 typewriter；无 `Message ohbaby...` | B |
| P2 | focus textarea | App | overlay 消失 | B |
| P3 | 输入一字 | App | overlay 消失 | B |
| P4 | blur 且 draft 清空 | App | overlay 恢复 | B |
| P5 | `isRunning` | App | placeholder `run in progress`；无打字机 | B |
| P6 | disabled | App | `daemon unavailable`；无打字机 | B |
| P7 | `active=false` / reduced-motion | unit | 定时器停或静态首句 | B |
| I1 | `isComposing: true` + Enter | App | **不**调用 `submitPrompt` | C |
| I2 | `keyCode: 229` + Enter | unit/App | 视为组字，不发送 | C |
| I3 | 非组字 Enter | App | 仍发送（回归） | C |
| I4 | slash 打开 + composing Enter | App | 不执行 slash | C |
| R1 | composer dock + stream 滚动布局 | styles | 既有断言仍绿 | A/B |

## 4.3 集成边界

- **Store / eventReducer**：本批不改；可用现有 streaming 单测作为「length 不变内容变」的背景事实，不必重测 reducer。
- **Slash palette**：打开 `/` 时 typewriter 应已因 focus 或输入隐藏；避免叠字。IME 组字中 Enter 不执行 slash。手工点检一次即可。
- **Todo dock / pending queue**：高度变化应走 ResizeObserver 贴底路径（stick 时）。

## 4.4 回归清单

- [ ] 发送消息、停止 run、权限条、slash 命令仍可用（非组字路径）。
- [ ] `.ohb-stream` 仍是对话唯一纵向滚动容器；composer 不停靠错位。
- [ ] 仓库内检索 `Message ohbaby` 应为 0（测试夹具若需旧文案则更新）。
- [ ] 无对 `wheel` 的 `preventDefault`（code review / grep）。
- [ ] 组字 Enter 路径无 `preventDefault`（code review / 单测）。

## 4.5 验收标准（发布门）

| 项 | 标准 | 如何验证 |
|----|------|----------|
| 流式跟滚 | 底部阅读时输出自动可见，无需手滚 | 真实 daemon 开一组长回复；或 Playwright 注入增高 DOM |
| 用户优先 | 上滚后自动滚停止；滚轮始终可用 | 手工：流式中上滚，确认位置稳定 |
| 回底恢复 | 滚回底部后再次跟滚 | 手工 |
| 文案 | 无旧 placeholder；轮播含 `Ask Lychee anything…` 等 00 三句 | 目视 + 单测 |
| 聚焦语义 | focus/输入立即隐藏打字机 | 目视 + 单测 |
| 运动降级 | reduced-motion 无逐字动画 | DevTools 模拟 + 目视 |
| IME Enter | 组字中 Enter 上屏不发送；结束后 Enter 才发送 | 单测 I1–I4 + 中文输入法手工 |
| 自动化 | Phase A/B/C 相关 unit 全绿 | CI / 本地 pnpm test |
| 范围 | 无 daemon/TUI 无关 diff | `git diff` 审查 |

## 4.6 对抗性审查要点

| 攻击面 | 可能故障 | 防御 | 残余风险 |
|--------|----------|------|----------|
| 高频 delta + ResizeObserver | 主线程贴底过于频繁 | rAF 合并；赋值幂等 | 极低端设备仍可能掉帧 |
| 触控板惯性 | 短暂离开底部导致误 unpin | 80px 阈值；回底可恢复 | 阈值需实机体感微调 |
| overlay 抢点击 | 无法聚焦输入 | `pointer-events: none` | 若误加 padding 点击热区需目视 |
| 打字机 setState 在 unmount 后 | 警告 / 泄漏 | `active` 关闭清 timer；unmount cleanup | — |
| smooth CSS 全局化 | 流式抖动 | 跟滚路径强制即时 scrollTop | 若全局加 `scroll-behavior` 需排除 `.ohb-stream` |
| 双文案 | placeholder 与 overlay 同时显示 | idle 时 placeholder 置 `""` | review 必查 |
| 只拦 send 不拦 slash Enter | slash 打开时仍抢 IME | 两条 Enter 路径都守卫 | — |
| 组字时 preventDefault | 候选无法上屏 | composing 分支禁止 preventDefault | 个别 IME 怪异行为需实机 |

## 4.7 实施后建议的最小手工脚本

1. 打开 Web，空闲看 composer 打字机三句循环（首句 `Ask Lychee anything…`）。
2. 点击输入框 → 动效消失；输入再清空失焦 → 动效恢复。
3. 发送长任务 prompt，保持在底部 → 流式内容持续可见。
4. 流式中向上滚 → 位置锁定；再滚到底 → 继续跟。
5. 切换另一个有长历史的 session → 落在底部（或该会话末尾可见）。
6. **中文输入法**：在组字态输入英文候选（如 `hello`）→ Enter → 文字进入框且**不发送**；再按 Enter → 正常发送。
