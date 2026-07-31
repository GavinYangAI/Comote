# Changelog

All notable changes to Comote are documented here. The desktop-release
workflow extracts the section matching the pushed `vX.Y.Z` tag into the
GitHub Release notes, so keep each version's heading as `## vX.Y.Z`.

本文件记录 Comote 的更新内容。发版流程会按推送的 `vX.Y.Z` tag 自动抽取对应
段落作为 GitHub Release 说明，请保持每个版本标题为 `## vX.Y.Z`。

## v0.7.2

### What's New

- **Updated application branding.** The Web interface and startup screen now use the project's new icon.

### 新功能

- **更新应用图标。** Web 界面和启动页现在使用项目中的新 Icon。

## v0.7.1

### 🐛 Fixes

- **Windows launch failures are now diagnosable.** When the bundled Node service never comes up, the daemon's own crash output (a failed import, an error before it starts listening, a port conflict) was written to a separate `comote-node.stderr.log` — but the failure screen only pointed at `comote-launch.log`, so the file users sent never contained the real reason. That stderr tail is now folded into `comote-launch.log`, and the sidecar log paths are recorded at startup. One file to send, and it explains the failure.

### 🐛 修复

- **Windows 启动失败现在可诊断了。** 内置 Node 服务起不来时，daemon 自身的崩溃输出（依赖加载失败、监听前抛异常、端口冲突等）原本被写到单独的 `comote-node.stderr.log`，而失败页只指向 `comote-launch.log`，导致用户发来的日志里根本没有真实原因。现在这份 stderr 的尾部会并入 `comote-launch.log`，并在启动时记录 sidecar 日志路径。只需发一个文件，且它能说明失败原因。

## v0.7.0

### ✨ What's New

- **Works with the new Codex.** Codex Desktop became the ChatGPT desktop app and moved its bundled `codex` binary; Comote now finds codex across ChatGPT.app, the legacy Codex.app, Homebrew, nvm and Volta installs — and a GUI-launched Comote no longer trips over the minimal system PATH. Set `COMOTE_CODEX_PATH` to pin a specific binary.
- **Conversations panel, grown up.** Pick any project from a dropdown (projects are now merged from Codex workspaces *and* conversation history), page through long thread lists with "load more", and expand a real Codex thread to see its history pulled straight from Codex instead of "no local record".
- **Diagnostics that tell the truth.** Connection failures show the real reason and the detected codex path (in the app banner, `/status`, and `comote doctor`, which now checks the codex binary and login). A first connect that fails retries quietly every 30s, and codex's stderr is captured for post-mortems.
- **Channel feedback everywhere.** DingTalk without a card template falls back to text progress instead of silence; WeChat-style channels are told when Codex disconnects mid-task; delivery failures send a short notice; Telegram gets a bot command menu, formatted (HTML) replies with a plain-text safety net, typing indicators, and long replies split safely at line/code-point boundaries on every channel.
- **CLI quality of life.** `comote update` reports your version and the right upgrade path for how you installed (npm vs desktop); `comote logs --file` reads the desktop launch log without the daemon; the state file lives at `~/.comote/state.json` (legacy locations still honored) and doctor shows where everything is.

### 🐛 Fixes

- **Security.** IM approval buttons and `/approve` now verify the resolver owns the task's thread; sidecar output is scrubbed of credentials (Feishu access keys, bot tokens) before it reaches the launch log; four dependency advisories cleared.
- Each user's active session is now tracked per identity — one person's `/use` no longer redirects another person's messages.
- Telegram replies over 4096 characters are chunked instead of silently dropped; `/tail` shows real thread history; `/sessions` says so when Codex is unreachable instead of showing an empty cached list.
- A full outbound queue no longer lets failure notices cascade over real replies; long threads (1000+ messages) keep refreshing.

### ✨ 新功能

- **适配新版 Codex。** Codex 桌面版已并入 ChatGPT 桌面应用，捆绑的 `codex` 二进制换了位置；Comote 现在会依次探测 ChatGPT.app、旧版 Codex.app、Homebrew、nvm、Volta 安装，从 Finder 启动也不再被系统最小 PATH 卡住。可用 `COMOTE_CODEX_PATH` 指定特定二进制。
- **对话面板升级。** 项目下拉可选（项目列表合并了 Codex 工作区与历史对话两个来源）、长列表支持"加载更多"分页、展开真实 Codex 会话可直接读取 Codex 侧历史，不再显示"暂无本地记录"。
- **诊断说真话。** 连接失败会显示真实原因和检测到的 codex 路径（应用横幅、`/status`、`comote doctor` 三处一致；doctor 新增 codex 二进制与登录检查）。首次连接失败后每 30 秒静默重试，codex 的 stderr 也会被捕获用于排障。
- **渠道反馈全面补齐。** 钉钉未配卡片模板时降级为文本进度而非全程沉默；微信等渠道在任务中途 Codex 断连时会收到通知；投递彻底失败会给一条简短提示；Telegram 新增命令菜单、HTML 排版（解析失败自动回退纯文本）、输入中指示，各渠道长回复均按行/码点安全分片。
- **CLI 易用性。** `comote update` 按安装方式（npm/桌面版）给出正确升级路径；`comote logs --file` 无需 daemon 直读桌面启动日志；状态文件统一到 `~/.comote/state.json`（兼容旧位置），doctor 会显示各路径来源。

### 🐛 修复

- **安全。** IM 审批按钮与 `/approve` 现在校验操作者是否为任务发起人；sidecar 输出写入启动日志前会脱敏凭据（飞书 access key、bot token 等）；清零 4 个依赖漏洞。
- 当前会话指针按用户隔离——一个人 `/use` 切换会话不再劫持另一个人的消息。
- Telegram 超过 4096 字符的回复改为分片发送而非静默丢失；`/tail` 显示真实会话历史；`/sessions` 在 Codex 未连接时明确说明，而不是展示一份空的本地缓存。
- 出站队列满载时失败通知不再级联吞掉真实回复；超长会话（1000+ 条消息）持续刷新不中断。

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
