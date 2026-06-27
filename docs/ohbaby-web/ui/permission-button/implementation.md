# Permission Buttons · 实现与测试

> 如何把 [color-system.md](./color-system.md) 与 [sizing-typography.md](./sizing-typography.md) 的规格落到代码。核心是一个有意识的隔离决策:**新建权限弹窗专用类,不复用 `.ohb-button`**。

---

## 1. 专用类隔离决策

`.ohb-button` / `.ohb-button-primary` 同时被 composer 的 send/stop 等按钮共用。若直接改它们,会波及无关按钮。因此新建一组**仅用于权限弹窗**的类,把改动严格关在 `PermissionModal` 内:

- 基类:`.ohb-perm-btn` — 承载共享布局(`min-height` / `radius` / `padding` / `font-size` / `font-weight` / inline-flex 居中)。
- 修饰类(各承载一档配色 + hover):
  - `.ohb-perm-allow-primary`
  - `.ohb-perm-allow-secondary`
  - `.ohb-perm-deny`
  - `.ohb-perm-abort`(额外 `margin-left: 6px`)

## 2. className 映射

`App.tsx` 中 `PermissionModal` 渲染每个 `choice` 时,由一个纯函数决定 class:

```ts
function permissionButtonClass(choice: UiPermissionChoice): string {
  const base = "ohb-perm-btn";
  if (choice.id === "allow_always") return `${base} ohb-perm-allow-secondary`;
  if (choice.intent === "allow") return `${base} ohb-perm-allow-primary`;
  if (choice.intent === "abort") return `${base} ohb-perm-abort`;
  return `${base} ohb-perm-deny`;
}
```

替换现有 `App.tsx` 中 `className={choice.intent === "allow" ? "ohb-button-primary" : "ohb-button"}` 一处。

判定顺序覆盖所有现存 `choices` 形态:

| 选项 | `id` | `intent` | class |
| --- | --- | --- | --- |
| Allow once | `allow_once` | `allow` | `ohb-perm-allow-primary` |
| Always allow | `allow_always` | `allow` | `ohb-perm-allow-secondary` |
| Reject | `reject` | `deny` | `ohb-perm-deny` |
| Cancel run | `cancel` | `abort` | `ohb-perm-abort` |
| (通用)Allow | `allow` | `allow` | `ohb-perm-allow-primary` |
| (通用)Deny | `deny` | `deny` | `ohb-perm-deny` |

> 关键:`allow_always` 先于通用 `allow` 判定,确保"记住"变体落到次级而非主按钮;`deny` 为兜底分支,任何非 allow/abort 的 intent 都归入警示档。

## 3. 改动点清单

- `apps/ohbaby-web/src/ui/App.tsx`
  - 新增 `permissionButtonClass()` helper。
  - 替换 `PermissionModal` 中按钮的 `className` 表达式为 `permissionButtonClass(choice)`。
- `apps/ohbaby-web/src/ui/styles.css`
  - 新增 `.ohb-perm-btn` 基类与 4 个修饰类(配色见 color-system,尺寸/字号见 sizing-typography)。
  - 各修饰类的 `:hover`。
  - `.ohb-perm-abort { margin-left: 6px }`。
- 不动 `.ohb-button` / `.ohb-button-primary`、不动 markup 结构、不动按钮顺序。

## 4. 测试计划

- `apps/ohbaby-web/src/ui/styles.unit.test.ts`(沿用现成 `expectCssRule`):
  - `.ohb-perm-btn`:断言 `min-height: 36px`、`font-size: 13px`。
  - 4 个修饰类:断言各自 `background` / `border-color` / `color`。
  - `.ohb-perm-abort`:断言 `margin-left: 6px`。
- `apps/ohbaby-web/src/ui/App.unit.test.tsx`(可选,推荐):
  - 用 4 个 `choices` 渲染 `PermissionModal`,断言每个按钮挂到预期修饰类。
- 不新增/不改动权限模型测试:`permission-projection.unit.test.ts`、TUI 契约测试均不受影响。

## 5. Acceptance

- `App.tsx` 仅改 className 决策(+ 一个 helper),无行为/模型变化。
- 4 个按钮分别挂到 4 个修饰类,映射符合上表。
- 新样式只命中权限弹窗;send/stop/composer 按钮像素级不变。
- 现有测试全绿;`styles.unit.test.ts` 新增断言全部通过。
