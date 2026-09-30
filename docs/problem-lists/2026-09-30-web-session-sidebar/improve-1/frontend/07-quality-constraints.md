# 质量约束

## 1. 可访问性

语义 button/menuitem；图标可访问名称；hover 等价 focus-within；可见 focus ring；目标至少 24px。菜单支持 Escape/方向键/Tab，焦点恢复不能触发滚动。正文用可读中性色，不用浅灰 Archive 表达危险。

## 2. 性能

只动画 transform/opacity；不逐帧 setState，不监听全局 mousemove；不让每行无条件循环跑马灯。仅溢出且当前交互行启动动画。无新运行时依赖。

## 3. 兼容

目标现代桌面浏览器，实际验收记录版本。prefers-reduced-motion 下取消位移；WAAPI 不可用时功能直接生效。菜单要处理 resize/滚动；窄视口仍可关闭和选择。

## 4. 隐私

偏好只存 sessionId/置顶时间，不复制标题、消息或 token。不引入埋点/远程同步。
