# 渠道抽象（base/）

新增一个渠道 = 写一个插件并注册（见 ../registry.js）。插件导出 `meta` + `createDriver/createAdapter/createRuntime`。

- `dedup.js` — DedupTracker：入站去重（Set + FIFO 驱逐）。
- `messages.js` — 语义出站消息：`REPLY_KINDS`、`routerReplyToSemantic`。renderer 把语义 reply 渲染成各渠道原生形态或按能力降级。`denied`/`ignored` 不投递（保持现状对未确认用户的静默）。
- `runtime.js` — BaseChannelRuntime：push（driver 事件流）/ poll（定时拉取 + DedupTracker）入站；`deliverQueued` 出站（委托 renderer，coalesce 防重发）。
- `adapter.js` — BaseChannelAdapter：通用入站管线（归一→群门→识别身份→附件下载→路由→入队语义 reply）；子类只实现 `normalizeInbound`。

## 渠道插件契约

```
{
  meta: { id, displayName, inboundMode: "push"|"poll", binding: "qr"|"credentials"|"token", capabilities: { cards, media, liveUpdates, typing } },
  createDriver(config), createAdapter({...}), createRuntime({...}),
}
```

> 现状（第一批）：骨架 + 单测，尚未接入飞书/微信。第二批迁移飞书/微信到本抽象并语义化出站；后续批次加通用绑定页与钉钉。
