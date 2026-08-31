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

The global manager uses a second, independent Feishu application under channel
id `feishu-global-manager`. Its config, QR login session, WebSocket runtime,
identity scope, and outbound queue are separate from project chat. The same
generic HTTP boundary is available at
`/api/channels/feishu-global-manager/*`; scanning or updating it must never
replace `/api/channels/feishu/config`.

To enable Feishu, click "绑定飞书" in the Comote settings UI and scan the QR code with the Feishu mobile app. The QR app-registration flow returns an app id and app secret, stores them locally, and starts the WebSocket runtime automatically.

For a manually supplied or reused Feishu app, the developer console must use
long-connection delivery under **Events & Callbacks**, subscribe to
`im.message.receive_v1`, enable the bot/message permissions, and publish the
latest app version. A runtime can report `running` as soon as its WebSocket is
connected even when Feishu has not subscribed that app to message events. In
that case `/projects` never reaches Comote and no candidate identity appears at
`GET /api/identities/candidates`.

After scanning the dedicated global-manager app, open its bot in a direct chat
and send any message. The bot replies with a **Bind global management** card;
its `global_manager_bind` button binds the clicking user in the current app's
open-id scope. `/manager bind` remains the text fallback. The QR registration
open-id is never reused because it belongs to a different application scope.

The `/api/channels/feishu/inbound` webhook path remains for diagnostics and compatibility, but normal Comote operation uses WebSocket, so no public callback URL is required.

## 媒体收发（图片/文件）

- 出站：Codex 改动的文件会出现在完成卡片上的 📎 按钮，点击即发到聊天；也可用 `/file <项目内相对路径>` 主动获取。单文件上限 20MB，超限改发本机路径提示。
- 入站：在飞书发图片/文件，会下载到当前项目的 `.comote/uploads/`，并把相对路径拼进发给 Codex 的消息。发文件前需先 `/open` 一个项目。
- 路径围栏：`/file` 与按钮推送只允许项目目录内的文件；入站文件名会被消毒后存入 `.comote/uploads/`。
- 仅飞书：媒体收发当前仅支持飞书渠道（`/file` 在其他渠道会被拒绝）。
