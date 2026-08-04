<div align="center">

# Comote

**手机上的 Codex 遥控器 · 本地运行 · 无 Comote 自有服务器**

把你电脑上的 [Codex](https://openai.com/codex)（ChatGPT 桌面应用，原 Codex Desktop；或 Codex CLI）接到飞书 / 微信 / 钉钉 / Telegram，让你在地铁里、客户那边、半夜的床上，都能继续指挥你的 Codex agent —— 不需要把电脑暴露到公网，不需要租服务器，不需要装一堆中间件。

[English](./README.en.md) · [快速开始](#快速开始) · [常见问题](#faq) · [仓库](https://github.com/GavinYangAI/comote)

</div>

---

## 什么是 Comote

不管你用 Codex 写代码，还是拿它处理数据、整理文档、做调研和起草 —— Comote 都是同一个手机遥控器。它面向**所有在本机跑 Codex 的人**（不管装的是 ChatGPT 桌面应用还是 Codex CLI），不只是程序员。

**中午外出就餐时**，你想起上午那个 bug 的修法，掏出手机在飞书里发：

> `继续上午的 thread，把 RetryPolicy 的 maxAttempts 从 3 改成 5，跑一下测试`

公司里的 Mac 收到，Codex 直接开干，吃完饭回到工位之前，飞书卡片已经更新："测试通过，要不要 commit？" 你点"批准"。

**开会途中 / 通勤路上**，临时想起一批活儿要处理，不想等回到电脑前：

> `新建 thread：把 downloads 里那批客户访谈录音转成文字，整理成一份带时间戳的纪要表`

等你忙完回到工位，桌面 Comote 里那份整理好的纪要表已经在等你了。

### 为什么用 Comote

| 场景 | 一般做法 | Comote |
|---|---|---|
| 远程使唤本机 Codex | SSH + tmux + 手敲命令 | 飞书发一句话 |
| 在 IM 里审批 Codex 的高危操作 | 没法做 | 卡片点按钮 |
| 不想把电脑暴露公网 | 装 frp / ngrok | 不用，daemon 只听本机 |
| 想用别的 IM | 自己写 bot | 实现一个 channel adapter（约 200-400 行） |

### 特性

- **强授权模型** —— 没绑定 / 没确认过的聊天身份，连 `/status` 都得不到回复
- **流式回复** —— Codex 边想边说，IM 卡片实时更新（而不是等完整答案生成后再一次性发出）
- **审批卡片** —— Codex 想跑 `rm -rf` 或者写文件时，IM 里弹卡片让你点批准 / 拒绝
- **会话恢复** —— 关掉手机过几个小时回来，`/sessions` 继续之前的 thread
- **多频道并行** —— 飞书、微信、钉钉、Telegram 可以同时绑，互不干扰
- **可扩展** —— 加新 IM 就实现一个 channel adapter；加新 agent 后端就实现一个 connector

> **关于官方 Codex 手机端**：OpenAI 自己出了 ChatGPT/Codex 的手机客户端，但它只服务 ChatGPT 订阅用户 —— 用 API key 在本机跑 Codex（CLI 或桌面应用）的人没法用，因为它看不到你本机的 thread。Comote 就是给这类用户的：你的 Codex 在你电脑上跑、用你自己的 key，手机端只是个遥控器。等哪天官方支持了 API 用户远程控制本机 Codex，我们就退役。

## 支持的渠道

| 渠道 | 绑定方式 | 状态 |
|---|---|---|
| **飞书 / Lark** | 扫码自建应用（feishu / lark 域可选） | ✅ 稳定 |
| **微信** | iLink 扫码登录 | ✅ 稳定 |
| **钉钉 / DingTalk** | AppKey / AppSecret + 卡片模板 | 🧪 实验性 |
| **Telegram** | Bot Token + 配对码 | 🧪 实验性 |

> 🧪 **实验性**：功能已实现并有测试覆盖，但真机长期联调还在进行中，可能有边角坑。欢迎试用并反馈。

> **多语言**：界面支持中文（默认）、English、日本語、한국어、Français、Español 六种语言。在 Web 设置页的「语言」下拉切换，**即时生效并持久化**（写入 state.json 的 `settings.locale`）；覆盖所有用户可见文案 —— 各 IM 的聊天回复与卡片、Web 设置页（服务端运行日志 eventLog 保持原文，不随语言切换）。也可经 API 读写：`GET /api/settings` 返回 `{ locale, supported }`，`PUT /api/settings { locale }` 切换。

## 快速开始

### 前置条件

本机得先有 Codex，二选一：

- **ChatGPT 桌面应用**（原 Codex Desktop）—— 从 [openai.com/codex](https://openai.com/codex) 安装，里面捆绑了 codex 二进制；
- **Codex CLI** —— `npm install -g @openai/codex`。

并且已经登录：桌面应用内登录，或跑一次 `codex login`。

Comote 通过 `codex app-server`（stdio JSON-RPC）与 Codex 通信，会自动把它作为子进程拉起 —— **无需保持任何 Codex 窗口打开**。

### 1. 下载安装

**桌面版**（带图形界面）—— 到 [Releases](https://github.com/GavinYangAI/comote/releases) 下载最新版：

- macOS：`Comote-x.y.z.dmg`
- Windows：`Comote-x.y.z-setup.exe`

**npm**（命令行版，跨平台，含 Linux）：

```bash
npm i -g comote   # 需要 Node 22+
```

Linux / 无界面服务器请看[下面](#linux--无界面服务器headless-vps)的部署说明。也可以[从源码编译](#从源码构建)。

### 2. 绑定一个 IM

打开 Comote，在 Web 设置页选一个渠道绑定（也可以都绑）。四种渠道有两类绑定方式：

**扫码类（飞书 / 微信）—— 在桌面确认身份**

- **飞书**：点"绑定飞书" → 用飞书 App 扫码 → 自动建好自建应用 → 完成
- **微信**：点"绑定微信" → 扫描 iLink 登录码 → 完成

**凭证 / Token 类（钉钉 / Telegram，实验性）—— 填配置后绑定到具体聊天**

- **Telegram**：在 [@BotFather](https://t.me/BotFather) 建一个 bot，拿到 Bot Token 填进设置页 → daemon 自动起来接收消息 → 设置页会显示一个**配对码**，把它发给你的 bot，绑定即完成（绑定到这个聊天）。
- **钉钉**：在钉钉开放平台建企业内部应用，填 AppKey / AppSecret；如需卡片（审批 / 状态 / 选择器），在后台建好三个卡片模板并把模板 id 填进设置页（不填则降级为纯文本）→ 给应用发消息完成绑定。

### 3. 确认身份

**只有绑定 / 确认过的身份才能控制 Codex。**

- 飞书 / 微信：第一次发消息，Comote 会在桌面 UI 弹"待授权"卡片，点"确认"。
- Telegram：发出配对码即完成绑定，无需再到桌面确认。
- 钉钉：以发消息的用户身份绑定。

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
微信 / 飞书 / 钉钉 / Telegram bot
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
   codex app-server（ChatGPT 桌面应用捆绑的 codex，或 Codex CLI）
```

桌面端用 [Tauri](https://tauri.app/) 包了一层壳，Node daemon 作为 sidecar 启动，只监听本机回环地址。

**本地优先，诚实版**：Comote 没有自己的服务器，你的消息不经过任何 Comote 自有服务器中转；Codex 调用全部发生在本机（daemon 在本机直接跟 `codex app-server` 子进程说话），daemon 也只绑 `127.0.0.1`，授权、token、会话历史都存在本机（见下面[数据存储位置](#数据存储位置)）。但要说清楚一点：你和 Comote 之间的消息**经由你所选 IM 平台自己的服务器**传输（飞书是 WebSocket 长连接，钉钉是 Stream 长连接，微信是 iLink getupdates 轮询，Telegram 是 getUpdates 长轮询），这段链路受该 IM 平台的隐私政策约束。

## 配置与参考

### Docker 运行

项目根目录已提供 `Dockerfile` 和 `docker-compose.yml`。首次运行先复制环境变量模板并生成一个长随机 token：

```bash
cp .env.example .env
docker compose up -d --build
```

浏览器访问 `http://127.0.0.1:16208/`。Compose 仅把网关发布到宿主机回环地址；网关负责向内部 Comote API 注入 token。容器会挂载宿主机的 `~/.comote`、Codex 的 `auth.json`/`config.toml` 和当前项目目录，分别用于持久化 Comote 状态、复用 Codex 登录状态，以及让容器内 Codex 操作此项目。Codex 的 Linux SQLite 状态保存在独立 Docker volume 中，避免与正在运行的 Windows Codex Desktop 争用同一数据库。

默认基础镜像使用固定 digest 的 DaoCloud Docker Hub 代理，以适配 Docker Hub 访问受限的网络；可在 `.env` 中通过 `NODE_IMAGE` 和 `NGINX_IMAGE` 切换到官方或自建镜像源。

查看状态和日志：

```bash
docker compose ps
docker compose logs -f comote
```

停止服务：

```bash
docker compose down
```

### 配置的三层结构

Comote 的配置分三层，各管各的：

| 层 | 管什么 | 谁来写 | 典型场景 |
|---|---|---|---|
| **环境变量** | 运行时行为：监听地址 / 端口、state 文件位置、codex 路径、API token（见下表） | 你（shell / systemd `Environment=`） | VPS / headless 部署 |
| **state.json** | 渠道配置（appKey、botToken…）、授权身份、设置（如界面语言） | Web UI 与 `comote config` 写入，**不要手改** | 桌面 / 日常使用 |
| **CLI flag** | 单次调用的覆盖（如 `--state-path`、`--json`） | 你（命令行） | 排障、脚本 |

优先级：CLI flag > 环境变量 > 默认值；渠道配置以 state.json 为准（UI 与 `comote config` 是同一份数据的两个入口）。典型分工：**VPS 用环境变量 + `comote config`，桌面用 UI**。

### 数据存储位置

- **CLI / daemon（npm 安装）**：默认 `~/.comote/state.json`（绝对路径）。若新默认路径不存在、而旧版的**当前目录相对** `.comote/state.json` 存在，daemon 会自动沿用旧文件并打一行日志（向后兼容，不搬迁文件）。
- **桌面 App**：state 存在系统应用数据目录 —— macOS `~/Library/Application Support/dev.comote.desktop/state.json`，Windows `%APPDATA%\dev.comote.desktop\state.json`（App 启动 daemon 时通过 `COMOTE_STATE_PATH` 指定）。
- 显式指定永远优先：`COMOTE_STATE_PATH` 环境变量或 `--state-path` flag。
- `comote doctor` 会打印当前解析到的 state 路径**及其来源**（flag / env / legacy / default），拿不准看哪份文件时先跑它。

不同 IM 的细节：

- **飞书 / Lark** — 详见 [`src/channels/feishu/README.md`](src/channels/feishu/README.md)
- **微信** — 详见 [`src/channels/wechat/README.md`](src/channels/wechat/README.md)
- **钉钉 / DingTalk** — 配置项：`appKey` / `appSecret` + 可选的 `approvalTemplateId` / `statusTemplateId` / `pickerTemplateId`（卡片模板，缺省降级纯文本）
- **Telegram** — 配置项：`botToken`；首次连上后设置页显示 `pairingCode`，发给 bot 完成绑定

常用环境变量：

| 变量 | 说明 |
|---|---|
| `HOST` | daemon 监听地址（默认 `127.0.0.1`；改成非 loopback 必须同时设 `COMOTE_LOCAL_API_TOKEN`，否则拒绝启动） |
| `PORT` | daemon 监听端口（不设走内置默认值；正常使用不用动） |
| `COMOTE_STATE_PATH` | 持久化状态文件路径（默认 `~/.comote/state.json`；桌面 App 会把它指到应用数据目录，见上面[数据存储位置](#数据存储位置)） |
| `COMOTE_CODEX_PATH` | 显式指定 codex 可执行文件的完整路径，优先级最高（用于自定义安装位置） |
| `COMOTE_LOCAL_API_TOKEN` | 设了之后所有 `/api/*` 调用必须带这个 token |
| `COMOTE_WECHAT_ACCOUNT_ID` | 同机绑多个微信号时区分用（默认 `default`） |

命令速查：

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

## 排障与日志位置

出问题先跑这两条：

```bash
comote doctor        # 预检：state 文件（含路径来源）、绑定安全、codex 二进制 / 登录、daemon、连接器、日志位置
comote logs          # daemon 内存事件日志（daemon 活着才有；--limit N 可调）
```

日志分两处：

- **daemon 事件日志**：内存 ring buffer，`comote logs` 读取（也在 Web 设置页的"运行日志"面板）。daemon 挂了就没了 —— 这时看下面的文件日志。
- **桌面 App 启动日志（文件，只在桌面 App 模式下产生）**：
  - macOS：`~/Library/Application Support/dev.comote.desktop/comote-launch.log`
  - Windows：`%APPDATA%\dev.comote.desktop\` 下的 `comote-launch.log`、`comote-node.stdout.log`、`comote-node.stderr.log`
  - 用 `comote logs --file` 直接看文件尾部（默认 200 行，`--lines N` 可调），不需要 daemon 在线。npm/CLI 方式运行时这些文件不存在，属正常。

想升级：`comote update` 只做检查并打印升级方式（npm 安装 → `npm install -g comote@latest`，任何平台；桌面 App → 下载链接），不会自动执行升级。

## Linux / 无界面服务器（headless VPS）

<details>
<summary>想把 Comote 跑在一台没有显示器、没有桌面环境的 Linux VPS 上？可以 —— 有一个纯命令行的 headless daemon，不依赖任何 GUI / webkit。</summary>

**它是什么** —— 完整的 app-server connector（threads、流式回复、exec / applyPatch 审批）照常工作，因为 Comote 是跟 `codex app-server`（codex 的一个子命令）说话，**不是**跟任何图形界面（如 ChatGPT 桌面应用）说话。所以没有桌面环境也完全没问题。

**前置条件**

- 装好 **Codex CLI**，并确保 `codex` 在 PATH 上。
- ⚠️ **先跑 `codex login`** —— 这是第一次部署最容易踩的坑。没有显示器、没浏览器的 VPS 上，用 **device-auth（设备码登录）或 API key** 完成登录。**没登录过，app-server 起不来，Comote 也就连不上 Codex。**

**安装**

```bash
npm i -g comote   # 需要 Node 22+
```

**运行**

推荐用 **systemd**——这样它会**开机自启、崩溃自动重启、系统重启后照常在后台跑**。（`comote &` 或 `nohup comote &` 能扛住 SSH 断开，但**扛不住系统重启**，重启后进程就没了——所以别用它做长期部署。）

```bash
# 参考 deploy/comote.service 模板，按注释改好 User / 路径
sudo cp deploy/comote.service /etc/systemd/system/comote.service
sudo systemctl daemon-reload
sudo systemctl enable --now comote     # 立即启动 + 开机自启
systemctl status comote                # 看是否 active (running)
journalctl -u comote -f                # 跟日志
```

> ⚠️ **daemon 必须用跑过 `codex login` 的那个用户来运行。** codex 的登录态在该用户的 `~/.codex` 下；如果 systemd 用一个专用 `comote` 用户跑，就得先用那个用户登录（`sudo -u comote codex login`），否则 app-server 读不到认证、连不上 Codex。

Comote 会**自己把 `codex app-server` 作为子进程启动并自动连接**——Linux 上**没有**需要你单独"打开"或常驻的 Codex 应用。快速试用也可以直接前台跑 `comote`（但关掉终端 / 重启就停了）。

**访问 Web 控制台**

daemon 默认绑 `127.0.0.1:16208`，**不对公网暴露**。通过 SSH 隧道访问：

```bash
ssh -L 16208:localhost:16208 your-vps
# 然后在本地浏览器打开 http://localhost:16208
```

**安全**

默认的 loopback 绑定（`127.0.0.1`）是安全的，建议就用 SSH 隧道。

如果你确实要把 `HOST` 设成非 loopback 地址（比如 `0.0.0.0`），你**必须**同时设置 `COMOTE_LOCAL_API_TOKEN` —— 否则 daemon 会**拒绝启动**（任何能连到这个地址的人否则就能无认证地批准 Codex 执行命令）。设了之后，所有 `/api/*` 请求都要带 `x-comote-token` 头。即便如此，仍然优先用 SSH 隧道。

**审批**

Codex 的权限审批会推送到你的 IM 聊天里，在那边用 `/approve <code>` · `/deny <code>` 处理（支持卡片的渠道也可以直接点按钮）。注意 codex 默认的 workspace-write 沙箱会**自动放行**工作区内的改动，只有要逃逸沙箱的操作才会弹审批。

**更新**

```bash
npm i -g comote@latest   # 然后重启服务：systemctl restart comote
```

Linux 上没有应用内自动下载更新，手动升级即可。

**一点说明** —— Comote 是针对某个较新的 codex 版本验证（certified）过的。app-server 协议历史上变过，如果升级后出问题，先把 codex 钉（pin）回一个已知可用的版本再排查。

</details>

## 从源码构建

要求：Node.js ≥ 22，Rust（Tauri 需要），macOS 12+ 或 Windows 10+。

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

## FAQ

**Q：数据会上传到任何服务器吗？**

不会上传到 Comote 的服务器 —— Comote 根本没有自有服务器，Codex 调用也全部发生在本机。但你和 Comote 之间的**消息本身走的是你所选 IM 平台的通道**（飞书 / 微信 / 钉钉 / Telegram 各自的服务器），受该平台隐私政策约束。链路细节见上面[怎么工作的](#怎么工作的)。

**Q：可以多人共用一台 daemon 吗？**

可以。每个聊天身份都需要单独绑定 / 确认，授权颗粒度是按身份的。但请注意：所有授权身份共享同一个本机 Codex，互相之间能看到彼此的 thread 列表。

**Q：微信集成合规吗？**

我们用的是腾讯 iLink 公开的 bot 接口（`ilinkai.weixin.qq.com`），不是逆向、不是桌面 UI 自动化、不绕过任何账号验证。但腾讯的服务条款会变，你需要自己评估当前的合规风险，**作者不为此承担责任**。

**Q：支持哪些 IM？还能加别的吗（Discord / Slack）？**

目前内置四个：**飞书**和**微信**（稳定），**钉钉**和**Telegram**（实验性），见上面[支持的渠道](#支持的渠道)表。新增一个 IM 只需实现一个 `ChannelAdapter`（约 200-400 行），Discord 的适配已在规划中。欢迎 PR。

<details>
<summary>更多运维相关问答（跨设备同步、失联行为）</summary>

**Q：能跨设备同步吗？**

目前 daemon 是单机的。如果你有多台电脑，建议每台各跑一个 Comote 实例，分别绑不同的 IM 账号区分。

**Q：失联了会怎样？**

- IM 推送服务挂了：你发的消息暂时进不来，恢复后 Comote 会记着上次读到的位置接着拉，把这期间积压的消息补回来。
- Codex（app-server 子进程）挂了：daemon 自动重连，期间消息排队。
- daemon 挂了：你发的消息在 IM 服务器侧停留，daemon 起来后会拿到。

</details>

## 项目结构

```
src/
  channels/       聊天平台适配器（feishu / wechat / dingtalk / telegram）
  connectors/     Codex 后端适配器（codex-desktop / codex-cli）
  core/           授权、命令路由、project/session、持久化、i18n、版本检查
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

🌐 **English**: see [README.en.md](./README.en.md)
