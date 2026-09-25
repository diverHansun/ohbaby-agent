# 四项 P2 收尾：TUI 重试与查询清理

审查基线 `5e84e539`。用户截图指出 `use-permission-sync.ts` 的两个独立问题；本次未调用 Pi。

## 原因与修复

metadata 的 indexPromise 原本在 effect 中只创建一次。bootstrap 失败后虽然重新查询权限基线，却仍使用同一个已失败或过期的 metadata Promise，导致短暂故障也耗尽四次预算，必须手动重试。现在每次尝试重新调用 getSessionIndex，并与该次权限快照一起校验。没有选择 root 时不做多余的 metadata 查询。

Promise.all 的 metadata 分支先失败时，权限快照分支可能仍在执行；原 finally 只清 timeout，不取消 AbortController。现在所有尝试退出都会取消自己的 controller，并仅在它仍是当前 controller 时清空引用。重试开始前旧请求已取消；达到 error/unavailable 时也没有遗留的权限查询。不改变四次累计预算、10秒超时、100/250/500ms退避和 unavailable 禁止自动重新开启的规则。

## RED / GREEN

新增 `packages/ohbaby-cli/src/tui/use-permission-sync.unit.test.tsx` 直接挂载实际 hook，四个用例在旧代码上全部失败：

- metadata 首次失败、下次恢复，旧实现停在 error:4。
- 第一次基线失败、metadata随后更新，旧实现仍用旧空索引，停在 error:0。
- metadata 持续失败且权限查询挂起，旧实现到四次上限仍有未取消的 signal。
- metadata 返回 PERMISSION_UNAVAILABLE，旧实现只尝试一次但挂起查询仍未取消。

修复后四个用例通过。额外断言每次新查询开始前，之前的 signal 均已 aborted；不依赖测试卸载时的最终清理冒充尝试级取消。

- RED：`/tmp/improve1-four-p2-tui-red.log`，4失败。
- hook + TUI app contract：109项通过，`/tmp/improve1-four-p2-tui-green.log`。
- 加强尝试间取消断言后 hook：4项通过，`/tmp/improve1-four-p2-tui-unit.log`。

最终整项检查、独立审查与提交见05及four-p2-independent-review。
