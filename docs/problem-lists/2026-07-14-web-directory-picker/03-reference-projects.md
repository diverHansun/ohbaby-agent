# 3. 参考项目与取舍

## 3.1 OpenCode 的两种目录选择模式

OpenCode 没有单一的“文件 picker 实现”，而是按运行形态选择：

| 场景 | 策略 | 代码 |
|---|---|---|
| Electron Desktop + local server | Electron 主进程 `dialog.showOpenDialog` | `packages/desktop/src/main/ipc.ts` |
| Web 或连接远程 server | Web 内 `DialogSelectDirectory` + server directory API | `packages/app/src/components/directory-picker.tsx` |

策略函数：

```ts
export function directoryPickerKind(platform: Platform["platform"], server: ServerConnection.Any) {
  if (platform === "desktop" && ServerConnection.local(server)) return "native" as const
  return "server" as const
}
```

## 3.2 Adopt / adapt / reject

| 类别 | OpenCode 做法 | ohbaby 决策 |
|---|---|---|
| Adopt | Web 与 Desktop 按平台能力分流 | `ohbaby serve` 固定采用 Web directory browser |
| Adopt | 目录选择 UI 仅处理导航/选择，真正项目打开交给 server | dialog 只返回路径，复用 `/v1/scopes/open` |
| Adapt | Web 模式的目录树 + server listing | 仅做 roots + 直接子目录，不移植模糊搜索、文件预览或完整 tree virtualization |
| Adapt | 运行形态决定 native capability | ohbaby 非 loopback host 禁用目录浏览，不尝试把 server 文件系统暴露给 LAN |
| Reject | Electron `dialog.showOpenDialog` | 当前项目不是 Electron desktop，不能在 Node daemon 中直接调用 |
| Reject | 全盘 `find` / ripgrep 搜索 | 本批不建立文件索引或递归扫描，避免性能和敏感路径扩大 |
| Reject | PowerShell `BrowseForFolder` | headless daemon 下不可同时保证无控制台和可交互，不作为 fallback |

## 3.3 为什么不使用浏览器原生 API

`window.showDirectoryPicker()` 或 `<input webkitdirectory>` 都不满足本议题：

1. 它们面向浏览器 sandbox，不能可靠返回 daemon 可用的绝对路径；
2. 用户选中的路径在浏览器端只是 handle/文件集合，不是 workspace identity；
3. 它们不能替代 server 对 Git root、可读性和 canonical path 的验证。

因此本批的浏览器只负责显示 daemon 返回的目录元数据，并将用户选择的目录交回 daemon。

## 3.4 可演进方向

若将来引入 Electron Desktop，可新增 desktop-only IPC bridge，像 OpenCode 一样直接使用
`dialog.showOpenDialog`；但它应绕开 Web HTTP 的 directory-browser API，并在选择后调用同一个
`/v1/scopes/open` 语义。当前 Web 方案不能因为未来可能的 desktop 壳而提前引入 Electron 依赖。
