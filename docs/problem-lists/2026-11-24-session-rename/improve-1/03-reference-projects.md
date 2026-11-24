# 3. 参考项目借鉴

> 路径相对 `code-cli/opencode/`。

## 3.1 opencode

| 方面 | 做法 | 位置 | 本议题怎么用 |
|---|---|---|---|
| 后端接口 | `PATCH /api/session/:sessionID` 带 `title` | `packages/app/e2e/utils/mock-api.ts` 约 511 行 | 同样用 PATCH，路径按本项目的习惯写成 `/v1/sessions/:id/title` |
| 改名方法 | 单独的 `Session.rename(sessionID, { title })`，发 `SessionEvent.Renamed` | `packages/core/src/session/session.ts` 约 65 行 | 同样单独加 `SessionManager.rename`（02 B2），事件复用现有的 `SessionEvent.Updated` |
| 自动标题不覆盖手动改名 | 生成标题后先比对当前标题和起名前看到的标题，不一样就放弃；写入时再按事件序号做一次检查 | `packages/core/src/session/title.ts` 约 152 行 | 本项目已有同样的两道检查（01 §1.2），不用新写 |
| 界面入口 | 会话菜单里的 `Rename`，行内编辑，保存带超时 | `packages/app/src/home/sessions/view.tsx` 约 140–180 行；e2e `mobile-session.spec.ts` 约 416 行 | 同样是菜单 + 行内编辑；另外加了双击（00 C3） |
| 排序 | 改名会刷新 `time.updated`，列表下次重读时会话会挪位置（`controller.tsx` 约 357 行的注释） | `packages/app/src/home/sessions/controller.tsx` | **不照搬**。用户选定改名不挪位置（00 C2） |

## 3.2 和参考项目的差异

唯一刻意不同的是排序：opencode 把改名当成一次更新，本项目把它当成整理操作，和置顶一样不影响"最近活动"的排序。其余做法一致。
