# 渠道抽象（base/）

新增一个渠道 = 写一个插件并注册（见 ../registry.js）。插件导出 `meta` + `createDriver/createAdapter/createRuntime`。

- `dedup.js` — DedupTracker：入站去重（Set + FIFO 驱逐）。
- `messages.js` — 语义出站消息：`REPLY_KINDS`、`routerReplyToSemantic`。renderer 把语义 reply 渲染成各渠道原生形态或按能力降级。`denied`/`ignored` 不投递（保持现状对未确认用户的静默）。
- `runtime.js` — BaseChannelRuntime：push（driver 事件流）/ poll（定时拉取 + DedupTracker）入站；`deliverQueued` 出站（委托 renderer，coalesce 防重发）。`pollOnce` 把 `fetchUpdates` 包在 try/catch 里，出错时先调 `_handleFetchError(error)`（默认 no-op）再 rethrow——子类借此在 auth 失效时置位 needsRelogin 并 stop()，无需复制整段 pollOnce。

> Driver 事件流契约：driver MUST 暴露 `startEventStream({ onEvent, onAction, onError })`。**交互动作（卡片按钮、inline-keyboard 回调）的钩子在抽象层叫 `onAction`。** 现有飞书 driver 目前叫 `onCardAction`——第二批迁移必须把它改名为 `onAction`（或在飞书插件里做适配），否则按钮会静默失效。

> 出站不是严格的“单路径”：队列排空的发送走 `deliverQueued` → renderer；但**实时更新卡片**（飞书 open/update/finish 话题卡片的生命周期，由 Codex desktop 事件驱动、就地节流编辑）是**渠道专属的 runtime 能力，活在 renderer 旁边、而非队列/renderer 路径内**。renderer 负责一次性的语义发送（text/approval/picker/media + 非实时的 status 降级）；有状态的实时卡片留作 channel-runtime 方法，由 `routeDesktopEvent` 直接调用。
- `adapter.js` — BaseChannelAdapter：通用入站管线（归一→群门→识别身份→附件下载→路由→入队语义 reply）；子类只实现 `normalizeInbound`。

## 渠道插件契约

```
{
  meta: { id, displayName, inboundMode: "push"|"poll", binding: "qr"|"credentials"|"token", capabilities: { cards, media, liveUpdates, typing } },
  createDriver(config), createAdapter({...}), createRuntime({...}),
}
```

> 现状（第一批）：骨架 + 单测，尚未接入飞书/微信。第二批迁移飞书/微信到本抽象并语义化出站；后续批次加通用绑定页与钉钉。

## 第二批迁移须知 (batch-2 migration notes)

1. **Driver 钩子名 `onAction`**：交互动作（卡片按钮 / inline-keyboard 回调）的 driver 钩子叫 `onAction`。飞书 driver 现叫 `onCardAction`，迁移时必须改名 `onAction`（或在插件层适配），否则按钮静默失效。
2. **wechat 的 `_handleFetchError` 覆写**：微信迁移时覆写 `_handleFetchError`，在 auth error 上置 `needsRelogin = true`、设友好 `lastError` 文案、`stop()` 停掉 poll 循环（沿用现有 `src/channels/wechat/runtime.js` 行为）。不要复制整段 `pollOnce`。
3. **实时卡片活在 renderer 旁边**：飞书 open/update/finish 话题卡片这类有状态、就地节流编辑的实时卡片，是 channel-runtime 方法，由 `routeDesktopEvent` 直接调用——不要塞进 renderer 或队列路径。
4. **飞书 renderer 负责卡片构建**：飞书 renderer 拥有 `textCard` / `pickerCard` / `statusCard` 的构建（一次性语义发送 + 非实时 status 降级）。
5. **`needsRelogin` 是子类状态**：`needsRelogin` 由 channel 子类持有，通过覆写 `getStatus()` 暴露给上层（base 的 `getStatus` 不含该字段）。
