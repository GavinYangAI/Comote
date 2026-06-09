# Changelog

All notable changes to Comote are documented here. The desktop-release
workflow extracts the section matching the pushed `vX.Y.Z` tag into the
GitHub Release notes, so keep each version's heading as `## vX.Y.Z`.

本文件记录 Comote 的更新内容。发版流程会按推送的 `vX.Y.Z` tag 自动抽取对应
段落作为 GitHub Release 说明，请保持每个版本标题为 `## vX.Y.Z`。

## v0.6.2

### ✨ What's New

- **Cold-start project discovery.** On a fresh headless/Linux box with no Codex Desktop, `/projects` now scans your projects folder — `COMOTE_PROJECT_ROOT` if set, otherwise your home directory — so the picker is a real, selectable list instead of a dead end. When nothing is found, the empty state spells out the next step (`/open <absolute path>`) instead of just saying "no projects".

### ✨ 新功能

- **冷启动项目发现。** 在没有 Codex Desktop 的全新 headless/Linux 机器上，`/projects` 现在会扫描你的项目目录（设了 `COMOTE_PROJECT_ROOT` 就用它，否则用 home 目录），让项目选择器变成可点选的真实列表，而不是死路。找不到项目时，空状态会直接给出下一步（`/open <绝对路径>`），不再只是干巴巴一句"还没有项目"。

## v0.6.1

### 🐛 Fixes

- **Codex Desktop workspace labels.** Labeled worktrees show their Desktop name in the project picker, and surface within the first page of buttons. Thanks @philonis.
- **Stuck replies after a restart.** Queued replies no longer get stuck pending after a restart — an id collision in the restored send queue could mark the wrong entry as delivered. Thanks @philonis.

### 🐛 修复

- **Codex Desktop 工作区标签。** 带标签的 worktree 在项目选择器里显示 Desktop 名称，并排到按钮第一页。感谢 @philonis。
- **重启后排队回复卡住。** 修复重启后排队回复一直卡在 pending 的问题——恢复发送队列时的 id 冲突会把投递标记错条目。感谢 @philonis。

## v0.6.0

### ✨ What's New

- **Headless Linux VPS.** Install from npm (`npm i -g comote`, Node 22+) and run as a GUI-free daemon that bridges your IM chats to a local Codex CLI — the full connector (threads, streaming, exec/applyPatch approvals) works headless.
- **systemd + bind guard.** Ships a `deploy/comote.service` unit and a headless-VPS guide; refuses to bind a non-loopback address unless `COMOTE_LOCAL_API_TOKEN` is set.
- **`comote` CLI.** Configure and run the daemon from the shell — status, login, logs, approvals and more (`comote --help`), plus an interactive `comote onboard` wizard.
- **In-chat command hints.** First-time senders get an onboarding card, typos nudge toward `/help`, and `/help` is the single command catalog.

### 🐛 Fixes

- **Windows installer build.** Pinned LF line endings so the Windows CI runner no longer breaks the `comote` entrypoint shebang.

### ✨ 更新内容

- **Linux VPS 无界面运行。** 从 npm 安装（`npm i -g comote`，需 Node 22+），作为无 GUI 的 daemon 把 IM 聊天桥接到本机 Codex CLI——完整连接器（线程、流式、exec/applyPatch 审批）在无界面环境照常工作。
- **systemd 与绑定守卫。** 附带 `deploy/comote.service` 单元和无界面 VPS 指南；未设 `COMOTE_LOCAL_API_TOKEN` 时拒绝绑定非 loopback 地址。
- **`comote` 命令行。** 在终端配置和运行 daemon——status、login、logs、审批等（见 `comote --help`），外加交互式 `comote onboard` 向导。
- **聊天内命令提示。** 新用户首次会收到上手卡片，打错命令会提示 `/help`，`/help` 是唯一命令目录。

### 🐛 修复

- **Windows 安装包构建。** 钉死 LF 换行，Windows CI runner 不再破坏 `comote` 入口的 shebang。

## v0.5.2

### ✨ What's New

- **Approve from Feishu chat.** The approval card now carries a `/approve <code>` · `/deny <code>` text fallback, so you can approve without leaving Feishu when the buttons don't respond. Adds an opt-in `COMOTE_FEISHU_WS_DEBUG` diagnostic for the button-callback path.
- **Lighter disk usage.** Throttled state writes shrink the on-disk state file by ~58% (272 KB → 114 KB) — clearing the excessive-write flag on macOS.

### ✨ 更新内容

- **飞书聊天内审批。** 审批卡片新增 `/approve <编号>` · `/deny <编号>` 文本兜底，按钮无响应时也能不离开飞书完成审批。新增可选诊断开关 `COMOTE_FEISHU_WS_DEBUG`，用于排查按钮回调投递。
- **更轻的磁盘占用。** 状态写盘改为节流，本地状态文件缩小约 58%（272 KB → 114 KB）——解决 macOS 标记的“进程写入过多”。

## v0.5.1

### ✨ What's New

- **Live Codex progress in IM.** Codex progress and failures surface to your IM channels with the chat UI refreshing live.

### 🐛 Fixes

- **Feishu image sends.** Fixed Feishu image sends that returned no response.

### ✨ 更新内容

- **IM 内实时显示 Codex 进度。** Codex 的进度与失败实时反馈到 IM 渠道，界面即时刷新。

### 🐛 修复

- **飞书发图无回应。** 修复飞书发图无回应的问题。

## v0.5.0

### ✨ What's New

- **Codex reads inbound files.** Codex now reads the contents of inbound non-image files instead of only naming their path.

### ✨ 更新内容

- **Codex 读取收到的文件。** Codex 真正读取收到的非图片文件内容，而不只是提到文件路径。
