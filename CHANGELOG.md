# Changelog

All notable changes to Comote are documented here. The desktop-release
workflow extracts the section matching the pushed `vX.Y.Z` tag into the
GitHub Release notes, so keep each version's heading as `## vX.Y.Z`.

本文件记录 Comote 的更新内容。发版流程会按推送的 `vX.Y.Z` tag 自动抽取对应
段落作为 GitHub Release 说明，请保持每个版本标题为 `## vX.Y.Z`。

## v0.6.1

### 🐛 Fixes

- **Codex Desktop workspace labels.** Labeled worktrees now show their Desktop name in the project picker instead of the directory basename, and labeled workspaces are prioritized so they stay within the first page of picker buttons. Thanks @philonis.
- **Stuck outbound replies after a restart.** A restored outbound queue now allocates the next id after the highest existing one instead of `entries.length + 1`. The old logic could reuse a historical id, so delivery marked the old entry and left the real queued reply stuck pending. Thanks @philonis.

### 🐛 修复

- **Codex Desktop 工作区标签。** 带标签的 worktree 现在在项目选择器里显示 Desktop 名称而非目录名，带标签的工作区会优先排序，保证落在选择器第一页按钮内。感谢 @philonis。
- **重启后排队回复卡住。** 恢复的 outbound 队列现在按“现有最大 id + 1”分配新 id，而非 `entries.length + 1`。旧逻辑会复用历史 id，导致投递时标记了旧条目、真正排队的回复一直卡在 pending。感谢 @philonis。

## v0.6.0

### ✨ What's New

- **Run headless on a Linux VPS.** Comote now installs from npm (`npm i -g comote`, Node 22+) and runs as a headless daemon — no GUI or webkit — bridging your IM tools to a locally-installed Codex CLI. The full connector (threads, streaming, exec/applyPatch approvals routed to your IM chat) works on Linux because Comote spawns `codex app-server` itself; there's no separate Codex app to open. Ships a systemd unit template (`deploy/comote.service`) and a "headless VPS" guide. A fail-closed bind guard refuses to start on a non-loopback address without `COMOTE_LOCAL_API_TOKEN`.
- **A `comote` command-line interface.** Configure and operate the daemon entirely from the shell — no browser or SSH tunnel needed: `comote status / channels / config / start / stop / login / identities / confirm / revoke / approve / deny / pairing / logs / doctor`, plus an interactive `comote onboard` first-run wizard. Feishu `login` prints the URL + an ASCII QR right in the terminal.
- **In-chat command hints.** A new sender now gets a short onboarding card on first authorization, mistyped `/commands` get a "try /help" nudge, and `/help` is the single command catalog.

### 🐛 Fixes

- **Windows installer build.** Added a `.gitattributes` that pins LF endings for the `bin/comote.js` shebang and shell/JS scripts. Without it the Windows CI runner checked out the entrypoint with CRLF, producing a `#!/usr/bin/env node\r` shebang that broke the bin test (and would break execution on Unix).

### ✨ 更新内容

- **可在 Linux VPS 上无界面运行。** Comote 现在能从 npm 安装（`npm i -g comote`，需 Node 22+）并作为 headless daemon 运行——无 GUI、无 webkit——把你的 IM 工具桥接到本机安装的 Codex CLI。完整连接器（线程、流式、exec/applyPatch 审批推送到 IM 聊天）在 Linux 上照常工作，因为 Comote 自己拉起 `codex app-server` 子进程，没有需要单独打开的 Codex 应用。附带 systemd 单元模板（`deploy/comote.service`）和无界面 VPS 部署指南。绑定安全守卫：非 loopback 地址未设 `COMOTE_LOCAL_API_TOKEN` 时拒绝启动。
- **`comote` 命令行工具。** 完全在命令行配置和操作 daemon，无需浏览器或 SSH 隧道：`comote status / channels / config / start / stop / login / identities / confirm / revoke / approve / deny / pairing / logs / doctor`，外加交互式 `comote onboard` 首次配置向导。飞书 `login` 会把链接 + ASCII 二维码直接打到终端。
- **聊天内命令提示。** 新用户首次授权时收到简短的上手卡片，误打的 `/命令` 会提示"试试 /help"，`/help` 是唯一命令目录。

### 🐛 修复

- **修复 Windows 安装包构建。** 新增 `.gitattributes`，把 `bin/comote.js` 的 shebang 以及 shell/JS 脚本钉死为 LF 换行。此前 Windows CI runner 会以 CRLF 检出入口文件，shebang 变成 `#!/usr/bin/env node\r`，既挂掉 bin 测试，也会在 Unix 上破坏脚本执行。

## v0.5.2

### ✨ What's New

- **Approve from Feishu chat.** The approval card now includes a `/approve <code>` · `/deny <code>` text fallback, so you can approve or reject right inside Feishu even when the card buttons don't respond — no need to switch to the Comote desktop app. Added an opt-in diagnostic (`COMOTE_FEISHU_WS_DEBUG`) to investigate the button-callback delivery path.
- **Much lighter disk usage.** State writes are now throttled, identical snapshots are skipped, and only recent delivered-reply history is persisted. This shrinks the on-disk state file by ~58% (272 KB → 114 KB) and cuts background disk writes by roughly an order of magnitude — resolving the excessive-write process flag on macOS.

### ✨ 更新内容

- **飞书聊天内即可审批。** 审批卡片新增 `/approve <编号>` · `/deny <编号>` 文本兜底——即使卡片按钮无响应，也能直接在飞书里批准/拒绝，无需切回 Comote 桌面端。同时加入可选诊断开关（`COMOTE_FEISHU_WS_DEBUG`），用于排查按钮回调的投递问题。
- **大幅降低磁盘占用与写入。** 状态写盘改为节流、内容不变则跳过、只保留最近的投递历史。本地状态文件缩小约 58%（272 KB → 114 KB），后台写盘量降低约一个数量级——解决 macOS 标记的“进程写入过多”问题。

## v0.5.1

- **Live Codex progress in IM.** Surface Codex progress and failures to the IM channels and refresh the chat UI live; fix Feishu image sends that returned no response. / 把 Codex 的进度与失败实时反馈到 IM 渠道并即时刷新界面；修复飞书发图无回应的问题。

## v0.5.0

- **Codex reads inbound files.** Tell Codex to actually read inbound non-image files instead of only naming their path. / 让 Codex 真正读取收到的非图片文件内容，而不只是提到文件路径。
