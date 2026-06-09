<div align="center">

# Comote

**A remote control for Codex, in your pocket · Runs locally · End-to-end private**

Connect the [Codex Desktop](https://openai.com/codex) on your computer to Feishu / WeChat / DingTalk / Telegram, so you can keep directing your Codex agent from the subway, from a client's office, from bed at midnight — without exposing your machine to the public internet, renting a server, or installing a pile of middleware.

[中文](./README.md) · [Quick Start](#quick-start) · [FAQ](#faq) · [Repo](https://github.com/GavinYangAI/comote)

</div>

---

## What is Comote

Whether you use Codex to write code or to crunch data, organize documents, run research, and draft — Comote is the same phone remote for all of it. It's built for **anyone running Codex CLI / Codex Desktop locally**, not just programmers.

**Out for lunch**, you remember how to fix that morning's bug. You pull out your phone and message in Feishu:

> `Continue this morning's thread — change RetryPolicy.maxAttempts from 3 to 5 and run the tests`

The Mac at the office receives it, Codex Desktop gets to work, and before you're back at your desk the Feishu card has updated: "Tests pass — want me to commit?" You tap "Approve".

**In a meeting / on your commute**, a batch of chores comes to mind and you'd rather not wait until you're back at the computer:

> `Start a new thread — transcribe that batch of client-interview recordings in downloads and turn them into a timestamped minutes table`

By the time you're done and back at your desk, that tidy minutes table is already waiting for you in the desktop Comote.

### Why Comote

| Scenario | The usual way | Comote |
|---|---|---|
| Remotely drive your local Codex | SSH + tmux + typing commands | Send one message in Feishu |
| Approve Codex's risky operations from your IM | Not possible | Tap a button on a card |
| Avoid exposing your machine to the internet | Set up frp / ngrok | None needed — the daemon only listens locally |
| Use a different IM | Write your own bot | Implement one channel adapter (~200–400 lines) |

### Features

- **Strong authorization model** — a chat identity that hasn't been bound / confirmed won't even get a reply to `/status`
- **Streaming replies** — Codex talks as it thinks, and the IM card updates live (instead of dumping one giant block after it's done)
- **Approval cards** — when Codex wants to run `rm -rf` or write a file, a card pops up in your IM for you to approve / deny
- **Session resume** — put your phone away for a few hours, come back, and `/sessions` continues an earlier thread
- **Multiple channels in parallel** — Feishu, WeChat, DingTalk, and Telegram can all be bound at once without stepping on each other
- **Extensible** — add a new IM by implementing a channel adapter; add a new agent backend by implementing a connector

> **About the official Codex mobile app**: OpenAI ships its own ChatGPT/Codex mobile clients, but they only serve ChatGPT subscribers — people running Codex CLI / Codex Desktop with an API key can't use them, because the app simply can't see your local threads. Comote is for exactly those users: your Codex runs on your computer, on your own key, and the phone is just a remote. The day the official app supports API users remotely controlling local Codex, we'll retire.

## Supported channels

| Channel | How it binds | Status |
|---|---|---|
| **Feishu / Lark** | Scan-to-build self-built app (feishu / lark domain selectable) | ✅ Stable |
| **WeChat** | iLink scan-to-login | ✅ Stable |
| **DingTalk** | AppKey / AppSecret + card templates | 🧪 Experimental |
| **Telegram** | Bot Token + pairing code | 🧪 Experimental |

> 🧪 **Experimental**: implemented and covered by tests, but long-running real-device shakedown is still in progress — expect occasional rough edges. Try it and send feedback.

> **Languages**: the UI supports six languages — 中文 (default), English, 日本語, 한국어, Français, Español. Switch from the "Language" dropdown on the Web settings page; it **takes effect instantly and persists** (written to `settings.locale` in state.json) and covers all user-facing copy — each IM's chat replies and cards, and the Web settings page (server runtime logs in eventLog stay in the original language and don't follow the switch). It's also available over the API: `GET /api/settings` returns `{ locale, supported }`, `PUT /api/settings { locale }` switches.

## Quick Start

### 1. Download and install

**Desktop app** (with GUI) — grab the latest build from [Releases](https://github.com/GavinYangAI/comote/releases):

- macOS: `Comote-x.y.z.dmg`
- Windows: `Comote-x.y.z-setup.exe`

**npm** (command-line, cross-platform, incl. Linux):

```bash
npm i -g comote   # needs Node 22+
```

For Linux / headless servers, see the [deployment notes below](#linux--headless-vps). You can also [build from source](#build-from-source).

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

**Truly local-first: no step in the chain relays through the public internet.** The daemon binds only to `127.0.0.1`; all authorizations, tokens, and session history live locally under `~/.comote/`, nothing is uploaded to any server. The phone-side IM bot pushes to your daemon through each platform's own service (Feishu over a WebSocket long connection, DingTalk over a Stream long connection, WeChat over iLink getupdates polling, Telegram over getUpdates long polling), and the daemon talks to Codex Desktop over localhost.

## Configuration and reference

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

Command cheat sheet:

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

## Linux / headless VPS

<details>
<summary>Want to run Comote on a headless Linux VPS with no monitor and no desktop environment? You can — there's a pure command-line headless daemon that needs no GUI / webkit.</summary>

**What it is** — the full app-server connector (threads, streaming, exec / applyPatch approvals) works exactly the same, because Comote talks to `codex app-server` (a subcommand of the Codex CLI), **not** the Codex Desktop GUI. So no desktop environment is required.

**Prerequisites**

- Install the **Codex CLI** and make sure `codex` is on PATH.
- ⚠️ **Run `codex login` first** — this is the #1 first-run gotcha. On a no-browser VPS, complete login with **device-auth or an API key**. **Without it the app-server won't start, and Comote can't reach Codex.**

**Install**

```bash
npm i -g comote   # needs Node 22+
```

**Run**

Use **systemd** — that's what makes it **start on boot, restart on crash, and keep running across a reboot**. (`comote &` / `nohup comote &` survives an SSH disconnect but **not** a reboot — the process is gone after a restart, so don't use it for a long-lived deployment.)

```bash
# Use the deploy/comote.service template; edit User / paths per its comments
sudo cp deploy/comote.service /etc/systemd/system/comote.service
sudo systemctl daemon-reload
sudo systemctl enable --now comote     # start now + on every boot
systemctl status comote                # check it's active (running)
journalctl -u comote -f                # follow the logs
```

> ⚠️ **Run the daemon as the user that ran `codex login`.** Codex's sign-in lives in that user's `~/.codex`; if systemd runs it as a dedicated `comote` user, log in as that user first (`sudo -u comote codex login`), or the app-server can't read the credentials and won't connect.

Comote **launches `codex app-server` as a child process and connects automatically** on startup — there's no separate Codex app to open or keep running on Linux. For a quick try you can also run `comote` in the foreground (but it stops when you close the terminal / reboot).

**Access the web console**

The daemon binds `127.0.0.1:16208` by default and is **not exposed to the internet**. Reach it over an SSH tunnel:

```bash
ssh -L 16208:localhost:16208 your-vps
# then open http://localhost:16208 in your local browser
```

**Security**

The default loopback bind (`127.0.0.1`) is safe — prefer the SSH tunnel.

If you do set `HOST` to a non-loopback address (e.g. `0.0.0.0`), you **must** also set `COMOTE_LOCAL_API_TOKEN` — otherwise the daemon **refuses to start** (anyone able to reach the address could otherwise approve Codex command execution unauthenticated). Once set, every `/api/*` request must carry the token in the `x-comote-token` header. Even then, prefer the SSH tunnel.

**Approvals**

Codex permission approvals are pushed to your IM chat — approve / deny them there with `/approve <code>` · `/deny <code>` (or the card buttons on channels that support them). Note codex's default workspace-write sandbox **auto-allows** in-workspace edits; only sandbox-escaping actions prompt.

**Updating**

```bash
npm i -g comote@latest   # then restart the service: systemctl restart comote
```

There's no in-app auto-download on Linux — upgrade manually.

**A note** — Comote is certified against a recent codex version. The app-server protocol has changed before, so if something breaks after an upgrade, pin codex back to a known-good version first and then debug.

</details>

## Build from source

Requirements: Node.js ≥ 22, Rust (needed by Tauri), macOS 12+ or Windows 10+.

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

## FAQ

**Q: Does any data get uploaded to a server?**

No — purely local. See [How it works](#how-it-works) above for the chain details.

**Q: Can several people share one daemon?**

Yes. Each chat identity must be bound / confirmed individually — authorization is per-identity. Note, though: all authorized identities share the same Codex Desktop and can see each other's thread lists.

**Q: Is the WeChat integration compliant?**

We use Tencent's public iLink bot interface (`ilinkai.weixin.qq.com`) — not reverse engineering, not desktop UI automation, and it bypasses no account verification. But Tencent's terms of service can change; you need to assess the current compliance risk yourself, and **the author takes no responsibility for it**.

**Q: Which IMs are supported? Can I add others (Discord / Slack)?**

Four are built in today: **Feishu** and **WeChat** (stable), **DingTalk** and **Telegram** (experimental) — see the [Supported channels](#supported-channels) table above. Adding a new IM means implementing a `ChannelAdapter` — roughly 200–400 lines of code; a Discord adapter is already on the roadmap. PRs welcome.

<details>
<summary>More ops-related Q&A (cross-device sync, behavior when the connection drops)</summary>

**Q: Can it sync across devices?**

The daemon is single-machine for now. If you have several computers, run a separate Comote instance on each and bind different IM accounts to tell them apart.

**Q: What happens if the connection drops?**

- IM push service goes down: your messages can't come in for a while; once it recovers, Comote remembers where it last read and picks up from there, backfilling whatever piled up in the meantime.
- Codex Desktop crashes: the daemon reconnects automatically and messages queue in the meantime.
- The daemon goes down: your messages stay on the IM server side and the daemon picks them up once it's back.

</details>

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
