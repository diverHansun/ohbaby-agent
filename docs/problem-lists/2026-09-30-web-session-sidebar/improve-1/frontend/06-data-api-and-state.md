# 数据与状态

## 1. API 映射

UC-01 沿用 sessionIndex/selectSession；UC-02/03 无网络；UC-04 沿用 runtime.archiveSession(sessionId)，成功与否返回侧栏。无新 API 字段。

## 2. 映射与排序

输入 UiSessionIndexEntry，派生 pinnedAt；不修改输入或 updatedAt。有 pin 优先，pin 时间降序；同时间按 ID。单页新 pin 时间取 max(Date.now(), 当前最大值+1)，保证快速/同毫秒操作后置顶最前。普通组沿用 updatedAt 降序/ID。

## 3. 客户端持久化

key = `ohbaby.web.session-pins.v1:` + JSON.stringify([规范化服务 origin, selectedDirectory])。localStorage 自身按网页 origin 隔离；runtime 可提供 serverUrl（空值按当前 origin），不包含 token/clientId。项目用 workspace 的规范路径，不自行猜测大小写/符号链接。
value = `{sessionId: finite positive pinnedAt}`；仅接受普通 JSON 对象、丢弃不合法项，安全处理 __proto__ 等键；读写都捕获异常。内存状态使存储不可用时页面仍可操作。
写前重新读取最新该 scope，合并本页待保存的单项修改，再执行 pin/unpin；读取失败则暂缓写入以免覆盖未知记录；storage 事件更新另一标签页。同一 scope 严格并发最后写入胜，非分布式同步。按 scope 保留本页内存快照；写失败后后续操作基于未保存快照，旧存储读值/事件不覆盖它，恢复写成功后再正常同步。项目切换重置局部交互 hook，但保留偏好内存快照，异步归档只修改发起 scope；不按空/暂缺列表做清理。

## 4. 错误映射

存储读写失败 → 当前页继续 + [04](04-interaction-and-states.md) 保存提示；损坏 JSON → 空偏好，后续写可恢复。归档失败 → 现有 ErrorBanner、保留 pin。取消确认不发请求。

## 5. 验收数据

临时开发 harness 复用真实 Sidebar/Row/Menu 和样式：项目 A/B、短/长中文/英文、30 条列表、空态、禁用、归档成功/失败/延迟。数据和页面只作验收，不写入生产路由，不操作用户真实归档。浏览器验证真实 localStorage 刷新/标签页及 reduced motion。
