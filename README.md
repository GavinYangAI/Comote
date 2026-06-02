<div align="center">

# Comote

**手机上的 Codex 遥控器 · 本地运行 · 端到端私密**

把你电脑上的 [Codex Desktop](https://openai.com/codex) 接到飞书 / 微信，让你在地铁里、客户那边、半夜的床上，都能继续指挥你的 Codex agent —— 不需要把电脑暴露到公网，不需要租服务器，不需要装一堆中间件。

[English](#english-tldr) · [快速开始](#快速开始) · [常见问题](#faq) · [仓库](https://github.com/GavinYangAI/comote)

</div>

---

## 想象一下这些场景

**中午外出就餐时**，你想起上午那个 bug 的修法，掏出手机在飞书里发：

> `继续上午的 thread，把 RetryPolicy 的 maxAttempts 从 3 改成 5，跑一下测试`

公司里的 Mac 收到，Codex Desktop 直接开干，吃完饭回到工位之前，飞书卡片已经更新："测试通过，要不要 commit？" 你点"批准"。

**晚上躺在床上**，刚关灯，突然想到一个 idea，不想再爬起来开电脑：

> `新建一个 thread，帮我用 ts-node 写个脚本，从 GitHub trending 抓 Rust 项目`

第二天起床，桌面 Comote 里已经有完整的 PR 链接等着你 review。

---

## 为什么用 Comote

| 场景 | 一般做法 | Comote |
|---|---|---|
| 远程使唤本机 Codex | SSH + tmux + 手敲命令 | 飞书发一句话 |
| 在 IM 里审批 Codex 的高危操作 | 没法做 | 卡片点按钮 |
| 不想把电脑暴露公网 | 装 frp / ngrok | 不用，daemon 只听本机 |
| 想用别的 IM | 自己写 bot | 实现一个 100 行的 channel adapter |

> **关于官方 Codex 手机端**：OpenAI 自己出了 ChatGPT/Codex 的手机客户端，但它只服务 ChatGPT 订阅用户 —— 用 API key 跑 Codex CLI / Codex Desktop 的人没法用。Comote 就是给这类用户的：你的 Codex 在你电脑上跑、用你自己的 key，手机端只是个遥控器。

## 特性

- **真·本地优先** —— daemon 只绑 `127.0.0.1`，所有 token 落在 `~/.comote/`，不上传任何服务器
- **强授权模型** —— 没在桌面 UI 里"点确认"的聊天身份，连 `/status` 都得不到回复
- **流式回复** —— Codex 边想边说，飞书卡片实时更新（不是等完整答案再发一坨）
- **审批卡片** —— Codex 想跑 `rm -rf` 或者写文件时，IM 里弹卡片让你点批准 / 拒绝
- **会话恢复** —— 关掉手机过几个小时回来，`/sessions` 继续之前的 thread
- **多频道并行** —— 飞书和微信同时绑，互不打架
- **可扩展** —— 加新 IM 就实现一个 channel adapter；加新 agent 后端就实现一个 connector

## 多语言

Comote 支持全局界面语言切换：中文（默认）、English、日本語、한국어、Français、Español。

- 在 Web 设置页的「语言」下拉切换，**即时生效并持久化**（写入 state.json 的 `settings.locale`）。
- 覆盖所有用户可见文案：飞书 / 微信的聊天回复与卡片、Web 设置页。服务端运行日志（eventLog）保持原文，不随语言切换。
- 也可经 API 读写：`GET /api/settings` 返回 `{ locale, supported }`，`PUT /api/settings { locale }` 切换。

## 快速开始

### 1. 下载安装

到 [Releases](https://github.com/GavinYangAI/comote/releases) 下载最新版：

- macOS：`Comote-x.y.z.dmg`
- Windows：`Comote-x.y.z-setup.exe`

或从源码编译（见[下面](#从源码构建)）。

### 2. 启动并绑定一个 IM

打开 Comote，按提示二选一（也可以都绑）：

- **飞书**：点"绑定飞书" → 用飞书 App 扫码 → 自动建好自建应用 → 完成
- **微信**：点"绑定微信" → 扫描 iLink 登录码 → 完成

### 3. 在 IM 里确认身份

第一次发消息，Comote 会在桌面 UI 弹"待授权"卡片。点"确认"。**只有确认过的身份才能控制 Codex。**

### 4. 开始用

在 IM 里发：

```
/projects        # 看看 Codex 知道哪些项目
/open 1          # 进第一个项目
/sessions        # 看历史 thread
/new 修个小 bug  # 开新 thread
随便打字...      # 直接转给 Codex 当前会话
```

完事。

## 怎么工作的

```text
       手机
         │
  微信 / 飞书 bot
         │
         ▼ 长连接 / 推送
┌──────────────────────────┐
│  Comote daemon (本机)    │
│  ├─ Channel Adapter      │  ← 把平台消息标准化
│  ├─ 授权 / 命令路由      │
│  ├─ Project / Session    │
│  └─ Codex Connector      │  ← 走 app-server JSON-RPC
└────────────┬─────────────┘
             ▼
   Codex Desktop / Codex CLI
```

桌面端用 [Tauri](https://tauri.app/) 包了一层壳，Node daemon 作为 sidecar 启动，只监听本机回环地址。

整个链路里**没有任何一步走公网中转**：手机端的 IM bot 通过腾讯 / 飞书自己的服务推到你的 daemon（飞书是 WebSocket 长连接，微信是 iLink getupdates 轮询），daemon 在 localhost 跟 Codex Desktop 说话。

## 配置

不同 IM 的细节：

- **飞书 / Lark** — 详见 [`src/channels/feishu/README.md`](src/channels/feishu/README.md)
- **微信** — 详见 [`src/channels/wechat/README.md`](src/channels/wechat/README.md)

常用环境变量：

| 变量 | 说明 |
|---|---|
| `PORT` | daemon 监听端口（不设走内置默认值；正常使用不用动） |
| `COMOTE_STATE_PATH` | 持久化状态文件路径（默认 `.comote/state.json`） |
| `COMOTE_LOCAL_API_TOKEN` | 设了之后所有 `/api/*` 调用必须带这个 token |
| `COMOTE_WECHAT_ACCOUNT_ID` | 同机绑多个微信号时区分用（默认 `default`） |

## 命令速查

| 命令 | 作用 |
|---|---|
| `/projects` | 列出 Codex 已知的所有项目 |
| `/open <序号 \| 绝对路径>` | 进入某个项目 |
| `/sessions` | 列出该项目下最近的 thread |
| `/new <标题>` | 新建一个 thread |
| `/status` | 当前绑定身份 / 项目 / 会话 |
| `/approve <code>` | 批准一个待审批的操作 |
| `/deny <code>` | 拒绝一个待审批的操作 |
| 普通文本 | 转给当前 thread 给 Codex |

## FAQ

**Q：数据会上传到任何服务器吗？**

不会。daemon 只绑 `127.0.0.1`，所有授权、token、会话历史都存在本机 `~/.comote/` 下。手机端消息也是 IM 自己的服务器（腾讯 / 飞书）推到你本机，Comote 不经过任何第三方中转。

**Q：可以多人共用一台 daemon 吗？**

可以。每个聊天身份都需要在桌面 UI 里单独"确认"，授权颗粒度是按身份的。但请注意：所有授权身份共享同一台 Codex Desktop，互相之间能看到彼此的 thread 列表。

**Q：微信集成合规吗？**

我们用的是腾讯 iLink 公开的 bot 接口（`ilinkai.weixin.qq.com`），不是逆向、不是桌面 UI 自动化、不绕过任何账号验证。但腾讯的服务条款会变，你需要自己评估当前的合规风险，**作者不为此承担责任**。

**Q：支持其他 IM 吗（Telegram / Discord / Slack）?**

目前内置飞书和微信。新增一个 IM 需要实现一个 `ChannelAdapter` —— 大概 200-400 行代码。欢迎 PR。

**Q：官方不是有 Codex 手机端吗？**

有的，但官方手机端只对 ChatGPT 订阅用户开放，跑在 OpenAI 的云上。如果你是 API 用户（用自己的 API key 在本机跑 Codex CLI / Codex Desktop），官方手机端帮不到你 —— 因为本机的 thread 它根本看不到。Comote 就是补这个空缺的。等哪天官方支持了 API 用户远程控制本机 Codex，我们就退役。

**Q：能跨设备同步吗？**

目前 daemon 是单机的。如果你有多台电脑，建议每台各跑一个 Comote 实例，分别绑不同的 IM 账号区分。

**Q：失联了会怎样？**

- IM 推送服务挂了：你发的消息暂时进不来，恢复后 Comote 会从 cursor 续上。
- Codex Desktop 挂了：daemon 自动重连，期间消息排队。
- daemon 挂了：你发的消息在 IM 服务器侧停留，daemon 起来后会拿到。

## 从源码构建

要求：Node.js ≥ 20，Rust（Tauri 需要），macOS 12+ 或 Windows 10+。

```bash
git clone https://github.com/GavinYangAI/comote.git
cd comote
npm install

# 开发模式（自动重启）
npm run desktop:dev

# 只跑 daemon，不开桌面壳
npm run dev

# 跑测试
npm test
```

打包：

```bash
# macOS（必须在 macOS 上跑）
npm run dist:mac
# 产物：release/mac/Comote-x.y.z.dmg

# Windows（必须在 Windows 上跑 —— Node sidecar + NSIS 都依赖 Windows 工具链）
npm run dist:win
# 产物：release/win/
```

也可以让 GitHub Actions 帮忙（`windows-latest` runner）—— 参考 `.github/workflows/desktop-release.yml`。

## 项目结构

```
src/
  channels/       聊天平台适配器（feishu / wechat）
  connectors/     Codex 后端适配器（codex-desktop / codex-cli）
  core/           授权、命令路由、project/session、持久化、版本检查
  server/         本地 HTTP API + 静态站点
src-tauri/        Tauri 桌面壳（Rust）
public/           设置 UI 的静态资源
scripts/          打包、icon、sidecar 构建脚本
test/             node:test 测试
```

## 贡献

欢迎 PR。提交前请：

```bash
npm test
```

新增 channel / connector 时同时补 README + 测试。

不知道从哪开始？看看 [Issues](https://github.com/GavinYangAI/comote/issues) 上带 `good first issue` 标签的。

## 协议

[MIT License](./LICENSE) © 2026 Gavin Yang

本项目按 MIT 协议提供，**不提供任何形式的担保**。请自行评估 IM 集成的合规风险。

## 关于

- **仓库**：<https://github.com/GavinYangAI/comote>
- **作者**：[@GavinYangAI](https://github.com/GavinYangAI)
- **报 Bug / 提需求**：<https://github.com/GavinYangAI/comote/issues>

Comote 的目标是让"远程使唤本机 Codex"这件事**简单到不值得专门为它租服务器**。如果它帮到了你，欢迎 Star、提 Issue、发 PR。

---

## English TL;DR

**Comote** is a local-first remote companion for [Codex Desktop](https://openai.com/codex). It runs as a small Node.js daemon (packaged as a Tauri desktop app) on your Mac/PC and lets your phone-side WeChat or Feishu (Lark) bot relay messages into Codex — so you can keep nudging your Codex agent from the subway, from a friend's house, from bed, without ever exposing your machine to the public internet.

**Why you might want it:**

- You want to keep an LLM coding agent running on your own machine (where your secrets live) but interact from your phone.
- You don't want to set up SSH tunnels, ngrok, or rent a server.
- You want approval-gated execution: Codex shows you the diff in your chat app, you tap approve.
- You're okay routing through your IM provider (Tencent / Lark) but nothing else.

**Privacy model:** the daemon binds only to `127.0.0.1`. All credentials and history live in `~/.comote/`. The only network hops are: your phone → IM provider (Tencent / Lark) → push to your daemon. No third-party relay.

**Status:** alpha. Channels: WeChat (via iLink), Feishu/Lark (official OpenAPI). Connectors: Codex Desktop (primary), Codex CLI (fallback).

See [Quick Start](#快速开始) above (Chinese), or open an issue if you'd like a fully English doc.
