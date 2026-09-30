# 前端架构

## 1. 技术边界

React 19、TypeScript、Lucide、现有 CSS/Vite。无新依赖、无通用状态/动画框架。

## 2. 渲染

沿用 CSR，不新增路由和服务端渲染。

## 3. 模块

SessionScreen → SessionSidebar → SessionRow / SessionActionsMenu。偏好模块独立于 DOM，hook 连接 storage 与 React。菜单通过 portal 挂到 body，避免侧栏 overflow/backdrop-filter 裁切。

## 4. 状态归属

服务端会话索引仍归现有 store；pin 属浏览器偏好；菜单/hover/动画属侧栏和行的短期状态。项目 scope 变化重建局部交互状态，不能短暂显示上一个项目的 pin/menu。

## 5. 层级

只抽取职责明确的行/菜单；不把 hover 状态上提全局，不为两项动作建菜单注册系统。

## 6. 错误

归档失败由 SessionScreen 的 runAction 显示现有错误；偏好读写异常在列表附近显示简短说明，列表继续使用内存状态。存储不包含标题正文或凭证。
