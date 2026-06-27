# Permission Buttons · 尺寸与字号

> 权限弹窗按钮的尺寸、字号、交互态与间距。目标:跟站内其他按钮保持一致,并修掉两个现存缺陷——字号臃肿、无 hover 反馈。

---

## 1. 尺寸

维持现有按钮基准,不为权限按钮单设一档,保证与 composer 的 send/stop 视觉同档:

- `min-height: 36px`
- `border-radius: 8px`
- `padding: 0 13px`
- `display: inline-flex; align-items: center; justify-content: center; gap: 7px`

## 2. 字号(修缺陷)

**问题:** `.ohb-button` / `.ohb-button-primary` 未显式设 `font-size`,通过 `button { font: inherit }` 继承 `body`,而 `body` 也未设 `font-size`,导致按钮按浏览器默认 **16px** 渲染,比周围 11–13px 的 UI 更大、显臃肿。

**规格:**

- `font-size: 13px`(与正文/输入框同档)。
- `font-weight: 500`。
- 字体沿用继承的 `IBM Plex Sans`(标签是自然语言词,**不用等宽字体**)。

## 3. 交互态

- **hover:** 每档背景按 [color-system.md](./color-system.md) 表中的 hover 值轻微加深;无位移、无放大。
- **active:** 可选,沿用 hover 视觉即可,不单独定义。
- **disabled:** 沿用全局 `button:disabled { opacity: 0.48 }`,**不重复定义**。

> 现状是这些按钮**完全没有 hover 反馈**(`.ohb-button` 无任何 `:hover`),点上去"发死";补 hover 是本规格的一部分。

## 4. 防误点间距

`Reject` 与 `Cancel run` 紧邻,后果差别大,需物理拉开:

- `.ohb-permission-actions` 维持 `gap: 8px`。
- 危险按钮(`Cancel run`)额外 `margin-left: 6px`,在颜色差之外再加一道间距,降低"想拒绝却终止整个 run"的误点。
- 纯 CSS 实现,不改 markup、不改按钮顺序。

## 5. Acceptance

- 按钮字号回到 13px,不再继承到 16px。
- 尺寸与 send/stop 同档(`min-height: 36px` 等)。
- 每档有可见 hover;disabled 态由全局规则覆盖,无重复定义。
- `Reject` 与 `Cancel run` 之间存在大于其他按钮间距的额外留白。
