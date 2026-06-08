# Changelog

All notable changes to Comote are documented here. The desktop-release
workflow extracts the section matching the pushed `vX.Y.Z` tag into the
GitHub Release notes, so keep each version's heading as `## vX.Y.Z`.

本文件记录 Comote 的更新内容。发版流程会按推送的 `vX.Y.Z` tag 自动抽取对应
段落作为 GitHub Release 说明，请保持每个版本标题为 `## vX.Y.Z`。

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
