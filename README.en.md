<div align="center">

# Comote

**A remote control for Codex, in your pocket · Runs locally · End-to-end private**

Connect the [Codex Desktop](https://openai.com/codex) on your computer to Feishu / WeChat / DingTalk / Telegram, so you can keep directing your Codex agent from the subway, from a client's office, from bed at midnight — without exposing your machine to the public internet, renting a server, or installing a pile of middleware.

[中文](./README.md) · [Quick Start](#quick-start) · [FAQ](#faq) · [Repo](https://github.com/GavinYangAI/comote)

</div>

---

## Picture these moments

**Out for lunch**, you remember how to fix that morning's bug. You pull out your phone and message in Feishu:

> `Continue this morning's thread — change RetryPolicy.maxAttempts from 3 to 5 and run the tests`

The Mac at the office receives it, Codex Desktop gets to work, and before you're back at your desk the Feishu card has updated: "Tests pass — want me to commit?" You tap "Approve".

**Lying in bed at night**, lights just off, an idea hits and you don't want to get up and open the laptop:

> `Start a new thread — write me a ts-node script that scrapes Rust projects from GitHub trending`

By morning, a full PR link is waiting for your review in the desktop Comote.

---

## Why Comote

| Scenario | The usual way | Comote |
|---|---|---|
| Remotely drive your local Codex | SSH + tmux + typing commands | Send one message in Feishu |
| Approve Codex's risky operations from your IM | Not possible | Tap a button on a card |
| Avoid exposing your machine to the internet | Set up frp / ngrok | None needed — the daemon only listens locally |
| Use a different IM | Write your own bot | Implement one channel adapter (~200–400 lines) |

> **About the official Codex mobile app**: OpenAI ships its own ChatGPT/Codex mobile clients, but they only serve ChatGPT subscribers — people running Codex CLI / Codex Desktop with an API key can't use them. Comote is for exactly those users: your Codex runs on your computer, on your own key, and the phone is just a remote.

## Features

- **Truly local-first** — the daemon binds only to `127.0.0.1`; all tokens live in `~/.comote/`, nothing is uploaded to any server
- **Strong authorization model** — a chat identity that hasn't been bound / confirmed won't even get a reply to `/status`
- **Streaming replies** — Codex talks as it thinks, and the IM card updates live (instead of dumping one giant block after it's done)
- **Approval cards** — when Codex wants to run `rm -rf` or write a file, a card pops up in your IM for you to approve / deny
- **Session resume** — put your phone away for a few hours, come back, and `/sessions` continues an earlier thread
- **Multiple channels in parallel** — Feishu, WeChat, DingTalk, and Telegram can all be bound at once without stepping on each other
- **Extensible** — add a new IM by implementing a channel adapter; add a new agent backend by implementing a connector

## Supported channels

| Channel | How it binds | Status |
|---|---|---|
| **Feishu / Lark** | Scan-to-build self-built app (feishu / lark domain selectable) | ✅ Stable |
| **WeChat** | iLink scan-to-login | ✅ Stable |
| **DingTalk** | AppKey / AppSecret + card templates | 🧪 Experimental |
| **Telegram** | Bot Token + pairing code | 🧪 Experimental |

> 🧪 **Experimental**: implemented and covered by tests, but long-running real-device shakedown is still in progress — expect occasional rough edges. Try it and send feedback.

## Languages

Comote supports a global UI language switch: 中文 (default), English, 日本語, 한국어, Français, Español.

- Switch from the "Language" dropdown on the Web settings page — it **takes effect instantly and persists** (written to `settings.locale` in state.json).
- It covers all user-facing copy: each IM's chat replies and cards, and the Web settings page. Server runtime logs (eventLog) stay in the original language and don't follow the switch.
- It's also available over the API: `GET /api/settings` returns `{ locale, supported }`, `PUT /api/settings { locale }` switches.

## Quick Start

### 1. Download and install

Grab the latest build from [Releases](https://github.com/GavinYangAI/comote/releases):

- macOS: `Comote-x.y.z.dmg`
- Windows: `Comote-x.y.z-setup.exe`

Or build from source (see [below](#build-from-source)).

### 2. Bind an IM

Open Comote and bind a channel from the Web settings page (you can bind several). The four channels fall into two binding styles:

**Scan style (Feishu / WeChat) — confirm the identity on the desktop**

- **Feishu**: click "Bind Feishu" → scan with the Feishu app → it auto-creates the self-built app → done
- **WeChat**: click "Bind WeChat" → scan the iLink login code → done

**Credential / Token style (DingTalk / Telegram, experimental) — fill in config, then bind to a specific chat**

- **Telegram**: create a bot via [@BotFather](https://t.me/BotFather), paste its Bot Token into the settings page → the daemon starts up and receives messages → the settings page shows a **pairing code**; send it to your bot to complete binding (bound to that chat).
- **DingTalk**: create an internal enterprise app on the DingTalk Open Platform, fill in AppKey / AppSecret; if you want cards (approval / status / picker), build the three card templates in the console and paste their template ids into the settings page (omit them and it degrades to plain text) → send the app a message to complete binding.

### 3. Confirm the identity

**Only a bound / confirmed identity can control Codex.**

- Feishu / WeChat: on your first message, Comote pops a "pending authorization" card in the desktop UI — click "Confirm".
- Telegram: sending the pairing code completes the binding; no extra desktop confirmation needed.
- DingTalk: bound as the user who sent the message.

### 4. Start using it

Message your IM:

```
/projects        # see which projects Codex knows about
/open 1          # enter the first project
/sessions        # list past threads
/new fix a bug   # start a new thread
just type...     # forwarded straight to Codex's current session
```

That's it.

## How it works

```text
       Phone
         │
WeChat / Feishu / DingTalk / Telegram bot
         │
         ▼ long connection / push
┌──────────────────────────┐
│  Comote daemon (local)   │
│  ├─ Channel Adapter      │  ← normalizes platform messages
│  ├─ Auth / command route │
│  ├─ Project / Session    │
│  └─ Codex Connector      │  ← speaks app-server JSON-RPC
└────────────┬─────────────┘
             ▼
   Codex Desktop / Codex CLI
```

The desktop side is wrapped with [Tauri](https://tauri.app/); the Node daemon launches as a sidecar and listens only on the loopback address.

**No step in the chain relays through the public internet**: the phone-side IM bot pushes to your daemon through each platform's own service (Feishu over a WebSocket long connection, DingTalk over a Stream long connection, WeChat over iLink getupdates polling, Telegram over getUpdates long polling), and the daemon talks to Codex Desktop over localhost.

## Configuration

Per-IM details:

- **Feishu / Lark** — see [`src/channels/feishu/README.md`](src/channels/feishu/README.md)
- **WeChat** — see [`src/channels/wechat/README.md`](src/channels/wechat/README.md)
- **DingTalk** — config fields: `appKey` / `appSecret` + optional `approvalTemplateId` / `statusTemplateId` / `pickerTemplateId` (card templates; absent → plain-text fallback)
- **Telegram** — config field: `botToken`; after the first connection the settings page shows a `pairingCode` — send it to the bot to finish binding

Common environment variables:

| Variable | What it does |
|---|---|
| `PORT` | daemon listen port (unset → built-in default; you normally don't touch it) |
| `COMOTE_STATE_PATH` | path to the persisted state file (default `.comote/state.json`) |
| `COMOTE_LOCAL_API_TOKEN` | if set, every `/api/*` call must carry this token |
| `COMOTE_WECHAT_ACCOUNT_ID` | distinguishes multiple WeChat accounts bound on one machine (default `default`) |

## Command cheat sheet

| Command | What it does |
|---|---|
| `/projects` | list all projects Codex knows about |
| `/open <index \| absolute path>` | enter a project |
| `/sessions` | list recent threads in that project |
| `/new <title>` | start a new thread |
| `/status` | current bound identity / project / session |
| `/approve <code>` | approve a pending operation |
| `/deny <code>` | deny a pending operation |
| plain text | forwarded to the current thread for Codex |

## FAQ

**Q: Does any data get uploaded to a server?**

No. The daemon binds only to `127.0.0.1`; all authorizations, tokens, and session history live locally under `~/.comote/`. Phone-side messages are pushed to your machine by the IM's own servers (Tencent / Feishu / DingTalk / Telegram) — Comote goes through no third-party relay.

**Q: Can several people share one daemon?**

Yes. Each chat identity must be bound / confirmed individually — authorization is per-identity. Note, though: all authorized identities share the same Codex Desktop and can see each other's thread lists.

**Q: Is the WeChat integration compliant?**

We use Tencent's public iLink bot interface (`ilinkai.weixin.qq.com`) — not reverse engineering, not desktop UI automation, and it bypasses no account verification. But Tencent's terms of service can change; you need to assess the current compliance risk yourself, and **the author takes no responsibility for it**.

**Q: Which IMs are supported? Can I add others (Discord / Slack)?**

Four are built in today: **Feishu** and **WeChat** (stable), **DingTalk** and **Telegram** (experimental). Adding a new IM means implementing a `ChannelAdapter` — roughly 200–400 lines of code; a Discord adapter is already on the roadmap. PRs welcome.

**Q: Isn't there an official Codex mobile app?**

There is, but it's only open to ChatGPT subscribers and runs on OpenAI's cloud. If you're an API user (running Codex CLI / Codex Desktop locally on your own API key), the official app can't help you — it simply can't see your local threads. Comote fills that gap. The day the official app supports API users remotely controlling local Codex, we'll retire.

**Q: Can it sync across devices?**

The daemon is single-machine for now. If you have several computers, run a separate Comote instance on each and bind different IM accounts to tell them apart.

**Q: What happens if the connection drops?**

- IM push service goes down: your messages can't come in for a while; once it recovers, Comote resumes from the cursor.
- Codex Desktop crashes: the daemon reconnects automatically and messages queue in the meantime.
- The daemon goes down: your messages stay on the IM server side and the daemon picks them up once it's back.

## Build from source

Requirements: Node.js ≥ 20, Rust (needed by Tauri), macOS 12+ or Windows 10+.

```bash
git clone https://github.com/GavinYangAI/comote.git
cd comote
npm install

# dev mode (auto-restart)
npm run desktop:dev

# daemon only, no desktop shell
npm run dev

# run tests
npm test
```

Packaging:

```bash
# macOS (must run on macOS)
npm run dist:mac
# output: release/mac/Comote-x.y.z.dmg

# Windows (must run on Windows — Node sidecar + NSIS both need the Windows toolchain)
npm run dist:win
# output: release/win/
```

You can also let GitHub Actions do it (the `windows-latest` runner) — see `.github/workflows/desktop-release.yml`.

## Project layout

```
src/
  channels/       chat-platform adapters (feishu / wechat / dingtalk / telegram)
  connectors/     Codex backend adapters (codex-desktop / codex-cli)
  core/           auth, command routing, project/session, persistence, i18n, version check
  server/         local HTTP API + static site
src-tauri/        Tauri desktop shell (Rust)
public/           static assets for the settings UI
scripts/          packaging, icon, sidecar build scripts
test/             node:test tests
```

## Contributing

PRs welcome. Before submitting:

```bash
npm test
```

When adding a channel / connector, include a README + tests.

Not sure where to start? Look for the `good first issue` label on [Issues](https://github.com/GavinYangAI/comote/issues).

## License

[MIT License](./LICENSE) © 2026 Gavin Yang

This project is provided under the MIT License **with no warranty of any kind**. Assess the compliance risk of IM integrations yourself.

## About

- **Repo**: <https://github.com/GavinYangAI/comote>
- **Author**: [@GavinYangAI](https://github.com/GavinYangAI)
- **Bugs / requests**: <https://github.com/GavinYangAI/comote/issues>

Comote's goal is to make "remotely driving your local Codex" **so simple it isn't worth renting a server for**. If it helps you, a Star, an Issue, or a PR is always welcome.

---

🌐 **中文**: see [README.md](./README.md)
