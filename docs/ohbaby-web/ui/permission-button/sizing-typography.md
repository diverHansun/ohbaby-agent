# Permission Buttons · 尺寸与字号

审批按钮沿用已有专用样式，与 composer 的按钮保持相近尺寸：

- `min-height: 36px`
- `border-radius: 8px`
- `padding: 0 13px`
- `display: inline-flex; align-items: center; justify-content: center; gap: 7px`
- `font-size: 13px; font-weight: 500`
- 字体继承 `IBM Plex Sans`。

各动作的 hover 只轻微加深背景，不位移或放大。disabled 使用全局 `button:disabled { opacity: 0.48 }`；是否禁用由独立 permissionSync 决定，不能沿用 composer.disabled。

`.ohb-permission-actions` 保持 `gap: 8px`。Cancel run 已移除，因此不再要求 Reject 与取消 run 按钮之间的特殊间距；保留的 `.ohb-perm-abort` CSS 不产生可见审批按钮。

多个请求提供 Previous/Next；来源、请求标题和必要操作内容保持简短，不新增授权范围长说明、批量放行数量或二次确认。

验收：字号及尺寸保持现有值，可见动作有 hover；断连和恢复中不可回答，ready 后可选择非首项。
