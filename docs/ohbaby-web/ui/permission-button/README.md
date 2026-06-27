# ohbaby-web · Permission Buttons UI

> 权限弹窗(`PermissionModal`)4 个动作按钮的样式与配色优化规格。只动 `apps/ohbaby-web`,**不改权限模型**:选项数量、标签、顺序、`intent`、`permission-projection.ts` 全部不动。事实源仍是 `packages/ohbaby-agent/src/adapters/app-events/permission-projection.ts` 产出的 `choices`。

本规格拆成三份主题文档:

- [color-system.md](./color-system.md) — 4 档后果配色与 token 来源、hover、危险色 alpha 旋钮。
- [sizing-typography.md](./sizing-typography.md) — 按钮尺寸、字号字重、hover/disabled、防误点间距。
- [implementation.md](./implementation.md) — className helper、专用类隔离决策、intent→class 映射、改动点、测试计划。

---

## 1. 现状与模型

权限请求在 `toUiPermissionRequest()` 里产出 `choices`,最多 4 个,映射到 **3 个 intent + 1 个修饰**:

| 选项 | `id` | `intent` | 后果 |
| --- | --- | --- | --- |
| Allow once | `allow_once` | `allow` | 批准这一次调用,易失 |
| Always allow | `allow_always` | `allow` | 批准 **+ 记住该 pattern**(仅当 pattern 可记忆时出现) |
| Reject | `reject` | `deny` | 拒绝这次调用,**run 继续**,模型拿到拒绝结果可改道 |
| Cancel run | `cancel` | `abort` | 拒绝 **+ 终止整个 run** |

**模型判断:合理。** 四个选项各自对应一个真实且不同的用户意图(批准 / 批准并记住 / 只挡这一次 / 全部停下)。本规格不改模型,只解决呈现问题。

## 2. 当前呈现的三个问题

1. **两个并列主按钮。** `App.tsx` 用 `choice.intent === "allow" ? "ohb-button-primary" : "ohb-button"` 给 className,导致 `allow_once` 与 `allow_always` 都被涂成同样的实心蓝,两个"主按钮"争夺视线,看不出温和默认项。`allow_always` 后果更重(永久改变后续行为),却喊得一样响。
2. **Reject 与 Cancel 视觉相同。** 两者都落到中性白色 `ohb-button`,无法区分"只挡一次"和"杀掉整个 run",存在误点风险。
3. **颜色不承载语义。** 只有 allow 是蓝色,两个负面动作没有任何警示/危险语言,缺少后果层级。

## 3. 范围

**做:**

- 权限弹窗 4 个按钮的配色、尺寸、字号、hover、防误点间距。
- `App.tsx` 中决定 className 的小 helper + `styles.css` 中一组**权限弹窗专用**类。
- 给新样式补 `expectCssRule` 断言。

**不做:**

- 不改权限模型(选项数 / 标签 / 顺序 / `intent` / `permission-projection.ts`)。
- 不改 `.ohb-button` / `.ohb-button-primary`(send/stop 等共用按钮不受影响)。
- 不改 TUI(`packages/ohbaby-cli`)的 `permission-dialog.tsx`。
- 不引入设计 token 变量体系,沿用现有内联 hex 写法。

## 4. 视觉层级(目标)

读起来从左到右:**实心蓝(走)→ 浅蓝(走但安静)→ 淡琥珀(警示)→ 描边红(危险)**。

- 唯一的实心高对比按钮是 `Allow once`(默认动作锚点)。
- 其余 3 个均为浅色/描边,各自承载一档后果。
- `Cancel run` 额外与 `Reject` 拉开间距,物理上防误点。

## 5. Acceptance(总览)

- 4 个按钮呈现 4 种可区分的视觉处理;同屏只有 1 个实心主按钮。
- `Reject` 与 `Cancel run` 颜色明显不同,且二者之间有额外间距。
- 字号回到 13px 量级,不再继承到浏览器默认 16px。
- 每档有 hover 反馈;disabled 沿用全局 `opacity:0.48`。
- 改动严格局限在权限弹窗,send/stop/composer 等按钮像素级不变。
- 现有单测不变红;`styles.unit.test.ts` 新增对 4 个类的断言。
- 权限模型零改动:`permission-projection.unit.test.ts` 与 TUI 契约测试不受影响。

详见三份主题文档。
