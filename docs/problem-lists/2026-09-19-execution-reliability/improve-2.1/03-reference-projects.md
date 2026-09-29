# 3. 本地参考项目与取舍

> 2026-09-27 只读调查当前本地 checkout，不声称对应上游最新版本。路径均相对仓库根的同级目录；这些项目不是构建依赖。

| 项目 / 代码锚点 | 实际做法 | 本轮取舍 |
| --- | --- | --- |
| `../opencode/packages/app/src/pages/session/composer/session-composer-region.tsx:11`、`session-composer-state.ts:28`、相邻 test | 功能目录聚合区域、状态协调、纯选择规则和测试 | 采纳功能内聚与独立状态边界；不照搬 Solid context 链 |
| `../opencode/packages/app/src/pages/session/timeline/` | 消息时间线内部按投影、测量、行等职责组织 | 借鉴展示与投影分离；不预先引入虚拟列表/复杂时间线框架 |
| `../oh-my-pi/packages/collab-web/src/app.tsx:122` | 页面组合 Header/Transcript/Agents/Composer/Banners | 借鉴根装配与局部界面状态；其业务范围较小，不用 219 行作为 App 硬指标 |
| `../oh-my-pi/packages/collab-web/src/lib/client.ts:1`、`lib/use-guest.ts:5` | client 拥有 socket/snapshot，React 仅订阅 | 保留 ohbaby 已有 client/store/useSyncExternalStore，不另造 GuestClient |
| `../oh-my-pi/packages/collab-web/src/tool-render/ToolView.tsx:13`、`types.ts:37` | 小数据接口与宿主能力，实际服务 Web 和 HTML export | 借鉴有限能力接口；ohbaby 目前无同等双消费者，不照搬 renderer registry/plugin 系统 |

opencode 的 `pages/session.tsx` 仍约 2391 行，有目录不等于低耦合。oh-my-pi 的小 IME hook 留在 Composer 文件内，说明独立文件必须有职责依据；其集中 test 目录也不是迁走本仓库 colocated 测试的理由。本地 `pi/packages` 未发现可用于本次参考的 Web UI 包，不凭印象引用。

这些参考支持 [02](02-optimization-plan-and-change-scope.md) 的功能内聚、单一状态源与有限接口；具体落点见 [Web 模块 02](../../../ohbaby-web/improve-3/02-change-spec.md)。
