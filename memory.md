# Project Memory

Last updated: 2026-08-17

## Project

- Comote connects local Codex Desktop or CLI sessions to mobile IM channels such as Feishu, WeChat, DingTalk, and Telegram.
- The normal local daemon listens on `127.0.0.1:16208`; isolated development acceptance uses `127.0.0.1:16209` and must not stop the installed service.

## Current state

- Local `main` includes the Feishu global task manager and the task-card current-execution preview.
- The feature was fast-forwarded from `codex/feishu-global-manager-app`; it does not merge or cherry-pick `codex/global-task-monitor`.
- `origin/main` still points to `a99e49c` until the user explicitly requests a push.
- The task-card preview follow-up was developed on `codex/monitor-session-titles` and fast-forwarded into local `main`; each task-status card shows the latest user-visible Codex message directly below the task title, matching the title-plus-preview information shown by the Codex pet.

## Feature model

- `TaskMonitor` aggregates every visible Codex project and task while treating Codex rollout/session data as read-only.
- Project chat uses channel `feishu`; the global manager uses the independent channel `feishu-global-manager`. Each owns its own Feishu App ID/App Secret, QR login session, driver, runtime, inbound identity domain, and outbound queue key.
- `channelConfigs.feishu` stores the project-chat application, while `channelConfigs.feishu-global-manager` stores the manager application. A manager rescan must never overwrite the project-chat config.
- The persisted global-manager binding records its manager-app `appId`, linked manager `open_id`, dashboard/task message IDs, delivery version, timestamps, and errors; credentials remain in the dedicated channel config rather than the binding metadata.
- If the configured Feishu application or linked user changes, the binding becomes stale and delivery stops until the local settings page confirms it again.
- The linked manager's direct chat uses explicit task selectors. Viewing a task does not alter `currentProjectByIdentity` or the default session.
- Global-manager card actions are accepted only from the linked manager. Task paths and capabilities are re-resolved from the monitor by `threadId`; card payload paths are never trusted.
- Approval cards can accept or decline pending Codex approvals across all monitored projects, with text-command fallbacks.
- Terminal task states update their existing task card and also send a new deduplicated Feishu card so `completed`, `failed`, and `interrupted` transitions produce a user-visible notification.
- Codex global management and Codex project chat are independent Feishu applications. Global-manager binding must not authorize a project-chat identity or mutate project selection/session/thread routing state.
- Text management commands use the explicit `/manager ...` namespace and are routed before project attachment handling. Ordinary text and `/projects`, `/task`, `/cancel`, and `/approve` continue to belong to the project application.
- Feishu `open_id` values are scoped to one Feishu App. Persist `linkedUserAppId` with `linkedUserId`; discard legacy or mismatched user IDs before global-manager delivery so changing App credentials cannot cause `99992361 open_id cross app`.
- Feishu QR registration accepts only the current process's active `loginId`, consumes it on a terminal result, and returns `expired` for historical or repeated IDs. This prevents stale browser pollers from replaying an old App-scoped `open_id` after a service restart.
- Feishu app registration's `user_info.open_id` is not usable with the newly created App token. QR confirmation stores only the App credentials; the global manager is bound only after the user sends `/manager bind` to the new bot, using that current-App inbound `open_id` without authorizing the project application.
- After the dedicated manager App is scanned, its first direct message returns a `managerBind` card with a `global_manager_bind` button and `/manager bind` fallback. The button binds from the callback's current-App `open_id`; a stale card cannot replace another active manager, and the project App runtime has no access to this bind action.
- A Feishu WebSocket runtime can report `running` even if the App has no message-event delivery. For a manually supplied or reused App, configure Events & Callbacks for long-connection delivery, subscribe to `im.message.receive_v1`, enable the bot/message permissions, and publish the App. If `/projects` produces no new `/api/identities/candidates` entry, the message never reached Comote; it was not rerouted to the manager App.
- Notification timing can be separated with persisted outbound timestamps: recent completion cards were queued within about 0.3 seconds of the terminal transition and acknowledged by Feishu in about 1 second total. A later visible alert is therefore a Feishu client/conversation notification issue unless these timestamps regress.

## Workspace cautions

- Do not commit `.runtime/` isolated acceptance data.
- Preserve the pre-existing line-ending-only changes in:
  - `src-tauri/permissions/autogenerated/get_keep_daemon_alive.toml`
  - `src-tauri/permissions/autogenerated/open_external.toml`
  - `src-tauri/permissions/autogenerated/set_keep_daemon_alive.toml`
- Do not push `main` unless the user explicitly requests it.

## Verification

- 2026-08-17 dual-app isolation regression: restart restores different project/global App IDs, manager QR replacement leaves project chat unchanged, the dedicated API redacts its secret, and old queued `globalManagerCard` entries migrate away from the project channel.
- Full regression after the dual-app repair: `npm test` ran 985 tests, 983 passed, 2 skipped, 0 failed.
- Isolated HTTP restart acceptance on `127.0.0.1:16209` persisted `cli_accept_project` and `cli_accept_manager` separately, restored both after a process restart, and returned root HTTP 200. The temporary fake state stayed under ignored `.runtime/`.
- Browser acceptance on the restored default state showed the normal Feishu project channel as connected/listening while the global-manager panel was independently unbound/not configured and offered its own scan button.
- 2026-08-17 dual-runtime event replay proved that project `/projects` is delivered only by `feishu`, manager first-contact/bind/dashboard cards are delivered only by `feishu-global-manager`, and manager binding does not add a project authorization. Targeted regression passed 54/54; full `npm test` passed 989 with 2 skipped (991 total).

- Global-manager merge baseline: `npm test` ran 968 tests, 966 passed, 2 skipped, 0 failed.
- Task-card preview follow-up captures live `agentMessageDelta` and rollout `agent_message` text, clears stale content at the start of a new turn, and keeps the global dashboard compact.
- The preview recovery path also retains the latest user-visible assistant message when an active rollout exceeds the normal 512 KiB tail window.
- Follow-up full regression: `npm test` ran 972 tests, 970 passed, 2 skipped, 0 failed.
- Targeted final global-manager, task-monitor, approval-security, outbound-queue, Feishu-renderer, and milestone regression suite: 55 passed.
- `node --check`: all 20 changed or newly added JavaScript files passed.
- `git diff --check`: passed; only the three pre-existing permission files and two edited web assets report Git line-ending conversion warnings.
- Isolated acceptance used `127.0.0.1:16209` with `.runtime/global-manager-acceptance.json`; the temporary listener was stopped afterward and the installed `127.0.0.1:16208` service remained running.
- The settings page and local APIs were first verified without a real Feishu QR confirmation; the linked manager now supports real outbound card acceptance, while interactive approval continuation still requires the linked user to participate in Feishu.
- Completion-notification acceptance resumed task `019fd63a-8488-7a01-a439-b9d3d0139de3` with a no-tools prompt. Its new completion generated one `globalManagerCard` notification addressed by `open_id`; the persisted outbound entry reached `delivered` with `attempts=0` and no error.
