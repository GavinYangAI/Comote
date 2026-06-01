# Feishu Channel

The Feishu channel uses the same Comote command and authorization model as WeChat.

Current status:

- Normalizes Feishu bot event payloads.
- Uses `open_id` or `user_id` as the stable identity.
- Requires local confirmation before control.
- Renders replies as interactive cards with Markdown rich text.
- Streams each Codex turn into a single live card that updates in place:
  started → progress steps → streaming answer → final result.
- Approvals, task cancellation, and project/session selection are clickable
  card buttons, handled via the `card.action.trigger` callback.
- Provides `FeishuDriver` for QR app registration, tenant token retrieval,
  WebSocket event streaming, and text/card delivery through Feishu OpenAPI.
- Provides a Comote runtime that starts/stops Feishu WebSocket monitoring,
  routes inbound events and card actions through the shared command router,
  and delivers queued replies back to Feishu.
- Stores Feishu app configuration beside the WeChat channel configuration.

Group chats are disabled until a dedicated workflow is designed.

Local HTTP boundary:

```text
GET  /api/channels/feishu/status
GET  /api/channels/feishu/config
PUT  /api/channels/feishu/config
GET  /api/channels/feishu/runtime
POST /api/channels/feishu/runtime/start
POST /api/channels/feishu/runtime/stop
POST /api/channels/feishu/runtime/deliver
POST /api/channels/feishu/login/start
GET  /api/channels/feishu/login/status
POST /api/channels/feishu/inbound
```

To enable Feishu, click "绑定飞书" in the Comote settings UI and scan the QR code with the Feishu mobile app. The QR app-registration flow returns an app id and app secret, stores them locally, and starts the WebSocket runtime automatically.

The `/api/channels/feishu/inbound` webhook path remains for diagnostics and compatibility, but normal Comote operation uses WebSocket, so no public callback URL is required.

## 媒体收发（图片/文件）

- 出站：Codex 改动的文件会出现在完成卡片上的 📎 按钮，点击即发到聊天；也可用 `/file <项目内相对路径>` 主动获取。单文件上限 20MB，超限改发本机路径提示。
- 入站：在飞书发图片/文件，会下载到当前项目的 `.comote/uploads/`，并把相对路径拼进发给 Codex 的消息。发文件前需先 `/open` 一个项目。
- 路径围栏：`/file` 与按钮推送只允许项目目录内的文件；入站文件名会被消毒后存入 `.comote/uploads/`。
- 仅飞书：媒体收发当前仅支持飞书渠道（`/file` 在其他渠道会被拒绝）。
