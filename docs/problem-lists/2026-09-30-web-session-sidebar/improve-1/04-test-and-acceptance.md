# 测试与验收契约

沿用仓库 Vitest/jsdom、TypeScript、ESLint；未发现独立 test-blueprint，按已有脚本组织。不写纯文案镜像测试。

| ID | 场景 | 层级 | Stage |
|---|---|---|---|
| A1 | 后 pin 最前，同毫秒仍稳定；更新时间变化不移动 pin | 单元 | 1 |
| A2 | 服务/项目隔离、重新挂载恢复、损坏数据/拒绝读写、安全键名 | 单元/组件 | 1 |
| A3 | storage 外部更新；加载空索引不清 pin | 组件 | 1 |
| A4 | …/右键菜单等价，不选择；pin/unpin 和直接实心 pin 不选择 | 组件/浏览器 | 2 |
| A5 | 归档取消/失败保留 pin，成功清理发起项目，既有确认不变 | 组件/集成 | 2 |
| A6 | Escape、箭头/Home/End、Tab、外点关闭、菜单边缘不裁切 | 组件/浏览器 | 2 |
| A7 | 当前聊天不变、scrollTop 不变、移动动画可见且短 | 浏览器 | 3 |
| A8 | 长标题延迟后滚动、短标题不动；菜单/重排暂停；reduced motion | 浏览器 | 3 |
| A9 | 清爽默认态、左侧实心 pin、紧凑两项菜单、无 tooltip 挡字 | 截图/视觉 | 3 |

运行：`pnpm exec vitest run apps/ohbaby-web/src/ui/session/*.unit.test.ts* apps/ohbaby-web/src/ui/App.unit.test.tsx`（shell glob 以实际新增文件为准）；`pnpm --filter ohbaby-web typecheck`；ESLint/Prettier 检查改动文件；`pnpm --filter ohbaby-web build`。

浏览器使用真实 SessionSidebar 组件及受控测试数据，不操作用户历史归档。浏览器负责验证实际布局/动画，jsdom 不假装证明像素结果。验收场景与 [frontend/08](frontend/08-test-and-acceptance.md) 对齐。

最可能失败点：异步归档跨项目、滚动锚定、聚焦导致跳屏、隐藏菜单仍可点、损坏存储覆盖其他项目。测试与审查优先覆盖这些，不追求覆盖率数字。

存储降级追加：连续 setItem 失败时 Pin A → Pin B 两者均保留，项目 A→B→A 返回仍保留当前页未保存偏好；恢复写入时一并持久化。
