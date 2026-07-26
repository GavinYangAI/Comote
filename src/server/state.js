import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isWithinDir, resolveWithinProject, sanitizeUploadName } from "../core/paths.js";
import { planChangedFileDelivery } from "../core/changed-files-delivery.js";

import { AuthorizationStore } from "../core/authorization.js";
import { CommandRouter } from "../core/commands.js";
import { ProjectStore } from "../core/projects.js";
import { scanLocalProjects as defaultScanLocalProjects } from "../core/local-projects.js";
import { SessionStore } from "../core/sessions.js";
import { CodexDesktopConnector } from "../connectors/codex-desktop/index.js";
import { CodexCliConnector } from "../connectors/codex-cli/index.js";
import feishuPlugin from "../channels/feishu/index.js";
import wechatPlugin from "../channels/wechat/index.js";
import dingtalkPlugin from "../channels/dingtalk/index.js";
import telegramPlugin from "../channels/telegram/index.js";
import { generatePairingCode as generateTelegramPairingCode } from "../channels/telegram/cards.js";
import { createRegistry } from "../channels/registry.js";
import { JsonFileStore, resolveStatePath } from "../core/persistence.js";
import { OutboundQueue } from "../core/outbound-queue.js";
import { EventLog } from "../core/event-log.js";
import { SleepGuard } from "../core/sleep-guard.js";
import { Transcript } from "../core/transcript.js";
import { VersionChecker } from "../core/version-check.js";
import { setLocale as setI18nLocale, DEFAULT_LOCALE, t } from "../core/i18n/index.js";

// Shown on a live card when the Codex Desktop connection drops. The connection
// events are logged with hardcoded Chinese strings throughout routeDesktopEvent
// (they predate i18n); this mirrors that wording so the card matches the log.
const DISCONNECT_NOTICE = "与 Codex Desktop 的连接已断开";

// Workflow B — turn-progress milestones returned to IM. Push channels already
// render a live status card, so milestones default OFF there to avoid two
// sources of truth; wechat has no live card, so it defaults ON. The throttle
// gates are: drop identical consecutive milestones; coalesce within a hard
// interval into one "+N, latest: x" flush; cap distinct deliveries per turn.
// A quiet-watchdog backstops a long stretch with no milestone with one minimal
// heartbeat. All three intervals are injectable for deterministic tests.
const MILESTONE_MIN_INTERVAL_MS = 8_000;
const MILESTONE_MAX_PER_TURN = 6;
const HEARTBEAT_MS = 90_000;
const CONNECTOR_PREFERENCES = new Set(["desktop", "cli"]);

function normalizeConnectorPreference(value) {
  return CONNECTOR_PREFERENCES.has(value) ? value : "desktop";
}

export function createComoteState({
  persisted = {},
  stateStore = null,
  autoStartWeChatRuntime = true,
  autoStartFeishuRuntime = true,
  autoStartDingTalkRuntime = true,
  autoStartTelegramRuntime = true,
  autoStartDelayMs = 5_000,
  desktop: desktopOverride = null,
  currentVersion = null,
  versionChecker = null,
  milestoneOptions = {},
  scanLocalProjects = defaultScanLocalProjects,
} = {}) {
  // Route the persisted value through i18n's validation so a hand-edited or
  // stale state.json can't desync settings.locale from the locale actually served.
  // localeExplicit = the user (or a prior system-detection) has committed a locale.
  // First launch leaves it false so the frontend can follow the OS language.
  const settings = {
    locale: setI18nLocale(persisted?.settings?.locale ?? DEFAULT_LOCALE),
    localeExplicit: Boolean(persisted?.settings?.locale),
    preferredConnector: normalizeConnectorPreference(persisted?.settings?.preferredConnector),
  };

  const authorization = new AuthorizationStore({ identities: persisted.identities ?? [] });
  for (const identity of persisted.detectedIdentities ?? []) {
    authorization.detectIdentity(identity);
  }
  const projects = new ProjectStore();
  const sessions = new SessionStore({ sessions: persisted.sessions ?? [] });
  const eventLog = new EventLog({ entries: persisted.events ?? [] });
  const sleepGuard = new SleepGuard({
    onChange: (on) =>
      eventLog.info(on ? "已开启防休眠（Codex 任务进行中）" : "已关闭防休眠（无进行中的任务）"),
  });
  const transcript = new Transcript({ entries: persisted.transcript ?? [] });
  const desktop = desktopOverride ?? new CodexDesktopConnector();
  const cli = new CodexCliConnector();

  const outboundReplies = new OutboundQueue({
    entries: persisted.outboundReplies ?? [],
    // Shed = the queue is at capacity and dropping its oldest to make room.
    // Deliberately log-only: a shed happens exactly when the queue is FULL, so
    // enqueuing a failure notice here evicts the next-oldest real reply, whose
    // shed enqueues another notice … until every pending reply has been
    // replaced by notices. (Confirmed by review: cap 3 + a 4th message wiped
    // all four real replies.) Terminal delivery failures below still notify.
    onShed: (entry) => {
      eventLog.error("出站队列积压，丢弃最旧的未投递回复", {
        id: entry.id,
        channel: entry.channel,
        attempts: entry.attempts,
      });
    },
    // A reply that exhausted its retries is gone for good; surface that to the
    // user instead of only writing an event-log line (B-11).
    onTerminalFailure: (entry) => {
      eventLog.error("回复投递彻底失败，已停止重试", {
        id: entry.id,
        channel: entry.channel,
        error: entry.lastError,
      });
      notifyDeliveryFailure(entry);
    },
  });

  // Enqueues one SHORT failure notice into the same conversation whose reply was
  // lost (terminal failure). The notice itself is stamped noFailureNotice so its
  // own failure can only ever log — never loop. Keyed on the lost entry's id so
  // retries of this path stay idempotent. Skipped when the queue is full: a
  // notice that evicts a real pending reply (whose shed is log-only) is a net
  // loss, not feedback.
  function notifyDeliveryFailure(entry) {
    if (!entry || entry.noFailureNotice || !entry.channel || !entry.conversationId) {
      return;
    }
    if (!outboundReplies.hasCapacity()) {
      eventLog.warn("队列已满，跳过投递失败通知", { id: entry.id, channel: entry.channel });
      return;
    }
    const source = entry.kind === "media" ? (entry.fileName ?? entry.path ?? "") : (entry.text ?? "");
    const preview = String(source).slice(0, 80);
    outboundReplies.enqueue({
      channel: entry.channel,
      conversationId: entry.conversationId,
      ...(entry.accountId ? { accountId: entry.accountId } : {}),
      kind: "text",
      noFailureNotice: true,
      text: t("state.delivery.failed", { preview }),
      dedupeKey: `deliveryfail:${entry.id}`,
    });
    deliverIfPush(entry.channel);
  }
  const commandRouter = new CommandRouter({
    authorization,
    projects,
    sessions,
    codexDesktop: desktop,
    codexCli: cli,
    outboundQueue: outboundReplies,
    persisted: persisted.router ?? {},
    transcript,
    scanLocalProjects,
    getPreferredConnector: () => settings.preferredConnector,
  });
  const registry = createRegistry([feishuPlugin, wechatPlugin, dingtalkPlugin, telegramPlugin]);

  // Per-channel seed configs (env-var defaults), keyed by plugin id. Normalized
  // through each plugin's normalizeConfig below.
  const channelSeeds = {
    wechat: persisted.channelConfigs?.wechat ?? {
      enabled: true,
      accountId: process.env.COMOTE_WECHAT_ACCOUNT_ID ?? "default",
    },
    feishu: persisted.channelConfigs?.feishu ?? {
      enabled: Boolean(process.env.COMOTE_FEISHU_APP_ID && process.env.COMOTE_FEISHU_APP_SECRET),
      appId: process.env.COMOTE_FEISHU_APP_ID ?? null,
      appSecret: process.env.COMOTE_FEISHU_APP_SECRET ?? null,
      verificationToken: process.env.COMOTE_FEISHU_VERIFICATION_TOKEN ?? null,
      encryptKey: process.env.COMOTE_FEISHU_ENCRYPT_KEY ?? null,
      domain: process.env.COMOTE_FEISHU_DOMAIN ?? "feishu",
    },
    dingtalk: persisted.channelConfigs?.dingtalk ?? {
      enabled: Boolean(process.env.COMOTE_DINGTALK_APP_KEY && process.env.COMOTE_DINGTALK_APP_SECRET),
      appKey: process.env.COMOTE_DINGTALK_APP_KEY ?? null,
      appSecret: process.env.COMOTE_DINGTALK_APP_SECRET ?? null,
      approvalTemplateId: process.env.COMOTE_DINGTALK_APPROVAL_TEMPLATE ?? null,
      statusTemplateId: process.env.COMOTE_DINGTALK_STATUS_TEMPLATE ?? null,
      pickerTemplateId: process.env.COMOTE_DINGTALK_PICKER_TEMPLATE ?? null,
    },
    telegram: persisted.channelConfigs?.telegram ?? {
      enabled: Boolean(process.env.COMOTE_TELEGRAM_BOT_TOKEN),
      botToken: process.env.COMOTE_TELEGRAM_BOT_TOKEN ?? null,
    },
  };

  // The channelStacks map holds the fully-wired {plugin, config, renderer,
  // adapter, runtime, driver} stack per channel. Stacks are built below; the
  // adapter closures and runtime opts are channel-specific (perChannelWiring).
  const channelStacks = new Map();

  // Per-channel ADAPTER options + runtime opts + login closures. The feishu
  // adapter closures reference the feishu RUNTIME, which is created AFTER the
  // adapter; they resolve `stack.runtime` at call time (preserving the old
  // hoisted-`feishuRuntime` closure behavior).
  //
  // perChannelWiring holds the host-side bits the registry can't own: adapter
  // options and login closures that capture host services (commandRouter,
  // outboundReplies, authorization, stateRef.persist). The plugin owns pure
  // construction (driver/adapter/runtime/renderer + config); everything that
  // closes over this server's runtime state lives here, keyed by channel id.
  // Builds a downloadAttachment closure shared by every channel that downloads
  // inbound files (feishu/dingtalk/telegram). The common shape is identical:
  // resolve the sender's current project, sanitize the name, fence the dest path
  // inside the project (DISTINCT error from NO_PROJECT so the adapter can tell a
  // missing-project /open from an unsafe path), then defer the channel-specific
  // driver call to `download({ driver, attachment, destPath })`.
  function makeDownloadAttachment(stack, download) {
    return async ({ attachment, identity }) => {
      const projectPath = commandRouter.currentProjectByIdentity.get(commandRouter.identityKey(identity));
      if (!projectPath) {
        throw new Error("NO_PROJECT");
      }
      const safeName = sanitizeUploadName(attachment.fileName);
      const relativePath = join(".comote", "uploads", safeName);
      const destPath = join(projectPath, relativePath);
      if (!resolveWithinProject(projectPath, destPath)) {
        throw new Error("UNSAFE_ATTACHMENT_PATH");
      }
      await download({ driver: stack.runtime.driver, attachment, destPath });
      return { relativePath };
    };
  }

  const perChannelWiring = {
    wechat: {
      buildAdapterOpts: (stack) => ({
        commandRouter,
        // Source the media-support decision from the plugin's EXPLICIT
        // capabilities.media bit (single source of truth) rather than letting the
        // adapter infer it from a missing downloadAttachment. wechat declares
        // media=0, so its adapter takes the unsupported-attachment path.
        supportsMedia: Boolean(stack.plugin.meta.capabilities?.media),
        onDetectedIdentity: (identity) => authorization.detectIdentity(identity),
        sendReply: async (reply) => {
          outboundReplies.enqueue(reply);
          return { ok: true };
        },
      }),
      buildRuntimeOpts: (stack) => ({
        adapter: stack.adapter,
        outboundQueue: outboundReplies,
        renderer: stack.renderer,
        driver: stack.driver,
        persist: async () => stateRef.persist?.(),
        cursor: persisted.wechatCursor ?? null,
      }),
      // WeChat login lives on the runtime; getLoginStatus reconfigures the
      // driver + persists when the result is storable.
      startLogin(stack) {
        return stack.runtime.startLogin();
      },
      async getLoginStatus(stack, { loginId }) {
        return stack.runtime.getLoginStatus({ loginId }).then(async (result) => {
          if (stack.plugin.shouldStoreLoginResult(result)) {
            stack.config = stack.plugin.normalizeConfig({
              ...stack.config,
              enabled: true,
              accountId: result.accountId,
              token: result.token,
              baseUrl: result.baseUrl,
              linkedUserId: result.userId,
              linkedUserName: result.userName ?? null,
            });
            stack.runtime.configureDriver(stack.plugin.createDriver(stack.config));
            await stateRef.persist?.();
            // Confirm side-effect sunk from the frontend into the backend (C2):
            // start the runtime here so the binding flow no longer needs the
            // frontend to POST /runtime/start on confirm. feishu already does
            // this in its closure below.
            await stack.runtime.start().catch((error) => {
              stack.runtime.lastError = error.message;
            });
          }
          // Spread raw result first (back-compat: preserve raw fields the current
          // frontend still reads), then let the normalized {state,qrUrl,account,message}
          // overwrite. The normalized "failed" vocab is recognized by the frontend
          // poller (transitional until C4 makes the frontend fully normalized-aware).
          return { ...result, ...stack.plugin.normalizeLoginStatus(result) };
        });
      },
    },
    feishu: {
      buildAdapterOpts: (stack) => ({
        commandRouter,
        supportsMedia: Boolean(stack.plugin.meta.capabilities?.media),
        onDetectedIdentity: (identity) => authorization.detectIdentity(identity),
        resolveDisplayName: (openId) => stack.runtime?.driver?.resolveUserName?.(openId) ?? null,
        beginInboundFeedback: (message) => stack.runtime?.beginInboundFeedback(message),
        finishInboundFeedback: (feedback) => stack.runtime?.finishInboundFeedback(feedback),
        singleMessageTurns: true,
        downloadAttachment: makeDownloadAttachment(stack, ({ driver, attachment, destPath }) =>
          driver.downloadMessageResource({
            messageId: attachment.messageId,
            fileKey: attachment.fileKey,
            type: attachment.type === "image" ? "image" : "file",
            destPath,
          }),
        ),
        sendReply: async (reply) => {
          outboundReplies.enqueue(reply);
          return { ok: true };
        },
      }),
      buildRuntimeOpts: (stack) => ({
        adapter: stack.adapter,
        outboundQueue: outboundReplies,
        renderer: stack.renderer,
        driver: stack.driver,
        persist: async () => stateRef.persist?.(),
        eventLog,
      }),
      // Feishu login uses a dedicated registration login driver; getLoginStatus
      // reconfigures the driver + resolves the user name + persists + starts the
      // runtime when the result is storable.
      startLogin(stack, { domain = stack.config.domain } = {}) {
        return stack.plugin.createLoginDriver({ domain }).startLogin({ domain });
      },
      async getLoginStatus(stack, { loginId, domain = stack.config.domain, interval, expireIn }) {
        const result = await stack.plugin.createLoginDriver({ domain }).getLoginStatus({
          loginId,
          domain,
          interval,
          expireIn,
        });
        if (stack.plugin.shouldStoreLoginResult(result)) {
          stack.config = stack.plugin.normalizeConfig({
            ...stack.config,
            enabled: true,
            appId: result.appId,
            appSecret: result.appSecret,
            domain: result.domain ?? domain,
            linkedUserId: result.userId,
          });
          stack.runtime.configureDriver(stack.plugin.createDriver(stack.config));
          let userName = null;
          try {
            userName = (await stack.runtime.driver?.resolveUserName?.(result.userId)) ?? null;
          } catch {
            userName = null;
          }
          stack.config = stack.plugin.normalizeConfig({ ...stack.config, linkedUserName: userName });
          result.userName = userName;
          await stateRef.persist?.();
          await stack.runtime.start().catch((error) => {
            stack.runtime.lastError = error.message;
          });
        }
        // userName was resolved + assigned to result above (before this return),
        // so normalizeLoginStatus sees the resolved account name.
        // Spread raw result first (back-compat: preserve raw fields the current
        // frontend still reads), then let the normalized {state,qrUrl,account,message}
        // overwrite. The normalized "failed" vocab is recognized by the frontend
        // poller (transitional until C4 makes the frontend fully normalized-aware).
        return { ...result, ...stack.plugin.normalizeLoginStatus(result) };
      },
    },
    dingtalk: {
      buildAdapterOpts: (stack) => ({
        commandRouter,
        supportsMedia: Boolean(stack.plugin.meta.capabilities?.media),
        onDetectedIdentity: (identity) => authorization.detectIdentity(identity),
        singleMessageTurns: () => stack.runtime?.liveCardsOperational?.() ?? false,
        downloadAttachment: makeDownloadAttachment(stack, ({ driver, attachment, destPath }) =>
          driver.downloadMessageResource({
            downloadCode: attachment.downloadCode,
            destPath,
          }),
        ),
        sendReply: async (reply) => {
          outboundReplies.enqueue(reply);
          return { ok: true };
        },
      }),
      buildRuntimeOpts: (stack) => ({
        adapter: stack.adapter,
        outboundQueue: outboundReplies,
        renderer: stack.renderer,
        driver: stack.driver,
        persist: async () => stateRef.persist?.(),
        eventLog,
      }),
    },
    telegram: {
      buildAdapterOpts: (stack) => ({
        commandRouter,
        supportsMedia: Boolean(stack.plugin.meta.capabilities?.media),
        onDetectedIdentity: (identity) => authorization.detectIdentity(identity),
        isAuthorized: (identity) => authorization.isAuthorized(identity),
        beginInboundFeedback: (message) => stack.runtime?.beginInboundFeedback(message),
        finishInboundFeedback: (feedback) => stack.runtime?.finishInboundFeedback(feedback),
        singleMessageTurns: true,
        getPairingState: () => ({ pairingCode: stack.config.pairingCode, linkedChatId: stack.config.linkedChatId }),
        onPaired: async ({ chatId, identity, displayName }) => {
          authorization.confirmIdentity(identity);
          stack.config = stack.plugin.normalizeConfig({ ...stack.config, linkedChatId: String(chatId), linkedUserName: displayName ?? null, pairingCode: null });
          await stateRef.persist?.();
        },
        downloadAttachment: makeDownloadAttachment(stack, ({ driver, attachment, destPath }) =>
          driver.downloadAttachment({ downloadCode: attachment.downloadCode, destPath }),
        ),
        sendReply: async (reply) => { outboundReplies.enqueue(reply); return { ok: true }; },
      }),
      buildRuntimeOpts: (stack) => ({
        adapter: stack.adapter,
        outboundQueue: outboundReplies,
        renderer: stack.renderer,
        driver: stack.driver,
        persist: async () => stateRef.persist?.(),
        eventLog,
        ensurePairingCode: async () => {
          if (stack.config.linkedChatId || stack.config.pairingCode) return;
          stack.config = stack.plugin.normalizeConfig({ ...stack.config, pairingCode: generateTelegramPairingCode() });
          await stateRef.persist?.();
        },
      }),
    },
  };

  // Build each channel stack off the registry + plugin factories. The adapter is
  // created before the runtime (its closures reference the stack's runtime at
  // call time), then the runtime is attached to the stack.
  for (const plugin of registry.listChannels()) {
    const id = plugin.meta.id;
    const wiring = perChannelWiring[id];
    if (!wiring) throw new Error(`no host wiring for channel "${id}" — add an entry to perChannelWiring`);
    const stack = {
      plugin,
      config: plugin.normalizeConfig(channelSeeds[id]),
      renderer: plugin.createRenderer(plugin.normalizeConfig(channelSeeds[id])),
      adapter: null,
      runtime: null,
      driver: null,
    };
    stack.adapter = plugin.createAdapter(wiring.buildAdapterOpts(stack));
    stack.driver = plugin.createDriver(stack.config);
    stack.runtime = plugin.createRuntime(wiring.buildRuntimeOpts(stack));
    channelStacks.set(id, stack);
  }

  // routeDesktopEvent + auto-start use these runtimes directly (live thread
  // cards / typing) — keep them as locals so that logic is UNCHANGED.
  const feishuRuntime = channelStacks.get("feishu").runtime;
  const wechatRuntime = channelStacks.get("wechat").runtime;

  // Returns the runtime for a channel IF it supports live status cards (the
  // liveUpdates capability + the open/update/finish/buildStatusCard methods).
  // Drives routeDesktopEvent's live-card path channel-agnostically. feishu and
  // dingtalk qualify; wechat does not. liveCardRuntime("feishu") === feishuRuntime,
  // so every feishu live-card path behaves exactly as it did when hardcoded.
  //
  // B-2: the capability bit is a DECLARATION; a runtime may still be unable to
  // render live cards right now (dingtalk without a configured status template —
  // its openThreadCard silently no-ops). Runtimes may expose
  // liveCardsOperational() to report that; when it returns false the channel is
  // treated as card-less so the milestone/text fallbacks engage instead of a
  // fully silent turn. Runtimes without the method are operational by definition.
  function liveCardRuntime(channel) {
    const stack = channelStacks.get(channel);
    if (!stack) return null;
    if (!stack.plugin.meta.capabilities?.liveUpdates) return null;
    const rt = stack.runtime;
    if (typeof rt.openThreadCard !== "function") return null;
    if (typeof rt.liveCardsOperational === "function" && !rt.liveCardsOperational()) return null;
    return rt;
  }

  // True when a channel DECLARES live cards but its runtime can't render them
  // right now (see liveCardRuntime above). Such a channel would otherwise get no
  // turn feedback at all: milestones are declared off (the card was supposed to
  // cover them) and the live-card path silently no-ops. wechat (liveUpdates=0)
  // is NOT degraded — its milestone flow is the designed path.
  function liveCardDegraded(channel) {
    const stack = channelStacks.get(channel);
    if (!stack?.plugin.meta.capabilities?.liveUpdates) return false;
    return liveCardRuntime(channel) === null;
  }

  // Finishes every open live-card session across all live-card channels with a
  // terminal card. Used when the Codex Desktop connection drops for good (or is
  // lost): otherwise the in-progress card sessions leak in cardSessions and the
  // user's chat shows a card stuck "in progress" forever, since no turnCompleted/
  // error event will ever arrive to finish it.
  function finishAllLiveCards(buildCard) {
    for (const [channel] of channelStacks) {
      const live = liveCardRuntime(channel);
      if (!live) continue;
      const sessions = live.cardSessions;
      if (!sessions || typeof sessions.keys !== "function") continue;
      for (const threadId of [...sessions.keys()]) {
        live.finishThreadCard(threadId, buildCard(live, threadId)).catch(() => {});
      }
    }
  }

  // B-3: live-card channels learn about a dropped connection via the error card
  // below, but a card-less channel (wechat, or a degraded dingtalk) with a turn
  // in flight would go silent FOREVER — no turnCompleted/error will ever arrive.
  // Enqueue one disconnect text per such active turn. milestoneByThread holds an
  // entry for every thread between turnStarted and its turn-ending event, so its
  // keys ARE the active turns; must run BEFORE teardownAllMilestoneState clears it.
  function notifyDisconnectToCardlessThreads() {
    for (const threadId of milestoneByThread.keys()) {
      const binding = commandRouter.getThreadBinding(threadId);
      if (!binding || liveCardRuntime(binding.channel) !== null) continue;
      outboundReplies.enqueue({
        channel: binding.channel,
        conversationId: binding.conversationId,
        ...(binding.accountId ? { accountId: binding.accountId } : {}),
        kind: "text",
        text: t("state.disconnect.reply"),
        dedupeKey: `disconnect:${threadId}:${turnNonce(threadId)}`,
      });
      deliverIfPush(binding.channel);
    }
  }

  // Closes every open live card with a disconnect notice and clears the per-turn
  // bookkeeping. Shared by connectionLost and connectionGaveUp.
  function finishLiveCardsForDisconnect() {
    notifyDisconnectToCardlessThreads();
    finishAllLiveCards((live) =>
      live.buildStatusCard({
        phase: "error",
        text: t("state.error.card", { message: DISCONNECT_NOTICE }),
        done: true,
      }),
    );
    streamTextByThread.clear();
    activityByThread.clear();
    progressByThread.clear();
    changedFilesDeliveredThreads.clear();
    for (const stack of channelStacks.values()) {
      if (stack.plugin.meta.capabilities?.reactions) {
        void stack.runtime.completeAllInboundFeedback?.();
      }
    }
    teardownAllMilestoneState();
  }

  // Per-channel re-drain timer guard, so overlapping deliverIfPush calls don't
  // stack timers. Cleared when its drain runs.
  const pushRedrainTimers = new Map();
  // Floor on the re-drain delay so a tight backoff (or a just-enqueued entry)
  // can't spin the timer. Poll channels (wechat) re-drain via their own loop;
  // push channels have no loop, so a transient send failure (status="retrying")
  // would sit until the next inbound event without this.
  const PUSH_REDRAIN_FLOOR_MS = 1_000;

  // push channels have no poll loop, so a freshly enqueued reply must be drained
  // explicitly. poll channels (wechat) drain via their own loop. Equivalent to the
  // old deliverIfFeishu: feishu is push → drains; wechat is poll → no-op.
  // After draining, if any entries are still pending (a transient send failure
  // flipped them to "retrying"), schedule a single follow-up drain — otherwise a
  // push channel never retries on its own.
  function deliverIfPush(channel) {
    const stack = channelStacks.get(channel);
    if (stack?.plugin.meta.inboundMode !== "push") {
      return;
    }
    stack.runtime
      .deliverQueued()
      .catch((error) => {
        stack.runtime.lastError = error.message;
      })
      .finally(() => {
        schedulePushRedrain(channel);
      });
  }

  // Schedules one re-drain of a push channel if it still has pending (queued or
  // retrying) entries and no re-drain is already pending. The follow-up drain
  // re-arms itself the same way, so retrying entries keep getting re-driven until
  // they deliver or hit maxAttempts (status="failed", no longer pending).
  function schedulePushRedrain(channel) {
    if (pushRedrainTimers.has(channel)) {
      return;
    }
    // Consider ALL pending entries, including retries whose backoff window has
    // not elapsed yet — those are exactly the ones a fixed-interval poll would
    // strand. list({pendingOnly}) hides not-yet-due retries, so use pendingActive.
    const pending = outboundReplies.pendingActive({ channel });
    if (pending.length === 0) {
      return;
    }
    // Arm for when the soonest entry becomes due (queued/never-attempted → now),
    // floored so we never busy-spin.
    const now = Date.now();
    let soonestDue = null;
    for (const entry of pending) {
      const parsed = entry.nextAttemptAt ? Date.parse(entry.nextAttemptAt) : now;
      const dueAt = Number.isNaN(parsed) ? now : parsed;
      if (soonestDue === null || dueAt < soonestDue) {
        soonestDue = dueAt;
      }
    }
    const delay = Math.max(PUSH_REDRAIN_FLOOR_MS, soonestDue - now);
    const timer = setTimeout(() => {
      pushRedrainTimers.delete(channel);
      deliverIfPush(channel);
    }, delay);
    timer.unref?.();
    pushRedrainTimers.set(channel, timer);
  }

  // Build a runtime WRAPPER per channel from its stack. Common methods (getConfig
  // → publicConfig, configure, getStatus, start, stop) are generic; channel-
  // specific methods are exposed conditionally based on the plugin meta.
  function buildRuntimeWrapper(stack) {
    const { plugin } = stack;
    const wiring = perChannelWiring[plugin.meta.id];
    const wrapper = {
      getConfig() {
        return plugin.publicConfig(stack.config);
      },
      async configure(config) {
        const patch = plugin.normalizeSecretPatch ? plugin.normalizeSecretPatch(config) : config;
        stack.config = plugin.normalizeConfig({ ...stack.config, ...patch });
        // Rebuild the renderer so newly-saved template ids (dingtalk) take effect.
        stack.renderer = plugin.createRenderer(stack.config);
        stack.runtime.renderer = stack.renderer;
        const driver = plugin.createDriver(stack.config);
        stack.driver = driver; // keep the stack handle in sync (downloadAttachment / gating)
        stack.runtime.configureDriver(driver);
        // Credentials/token channels have no login flow that starts the runtime;
        // saving valid credentials IS the bind, so start here when configured.
        // (configureDriver only auto-restarts if it was ALREADY running; the first
        // bind has wasRunning=false, so start explicitly.) qr channels are gated
        // out — their runtime starts in the login flow.
        if (plugin.meta.binding !== "qr" && plugin.publicConfig(stack.config).configured && !stack.runtime.running) {
          await stack.runtime.start().catch((error) => {
            stack.runtime.lastError = error.message;
          });
        }
        return this.getConfig();
      },
      getStatus() {
        return stack.runtime.getStatus();
      },
      start() {
        return stack.runtime.start();
      },
      stop() {
        return stack.runtime.stop();
      },
    };
    // Poll-mode channels expose pollOnce (manual drain). __setTestDriver mirrors
    // the push-mode seam below so tests can inject a fake driver symmetrically.
    if (plugin.meta.inboundMode === "poll") {
      wrapper.pollOnce = () => stack.runtime.pollOnce();
      wrapper.__setTestDriver = (testDriver) => stack.runtime.configureDriver(testDriver);
    }
    // Push-mode channels expose inbound webhook + test seam + manual delivery.
    if (plugin.meta.inboundMode === "push") {
      wrapper.handleInbound = (payload) => stack.runtime.handleInbound(payload);
      wrapper.__setTestDriver = (testDriver) => stack.runtime.configureDriver(testDriver);
      wrapper.deliverQueued = () => stack.runtime.deliverQueued();
    }
    // QR-bound channels expose login start/status (with channel-specific
    // side-effects preserved byte-faithfully via perChannelWiring).
    if (plugin.meta.binding === "qr") {
      wrapper.startLogin = (opts) => wiring.startLogin(stack, opts);
      wrapper.getLoginStatus = (opts) => wiring.getLoginStatus(stack, opts);
    }
    return wrapper;
  }

  const runtime = Object.fromEntries(
    [...channelStacks].map(([id, stack]) => [id, buildRuntimeWrapper(stack)]),
  );

  const stateRef = {
    authorization,
    projects,
    sessions,
    commandRouter,
    outboundReplies,
    eventLog,
    transcript,
    getSettings() {
      return { ...settings };
    },
    setLocale(locale) {
      const applied = setI18nLocale(locale);
      settings.locale = applied;
      settings.localeExplicit = true;
      return applied;
    },
    setPreferredConnector(preferredConnector) {
      if (!CONNECTOR_PREFERENCES.has(preferredConnector)) {
        throw new Error("unsupported connector preference");
      }
      settings.preferredConnector = preferredConnector;
      return preferredConnector;
    },
    async persist() {
      if (!stateStore) {
        return;
      }
      // Keep the persisted telegram offset current: the driver advances it in memory
      // as it long-polls, so sync it into config before serialization (channelConfigs
      // carries it, so it round-trips to setOffset on the next boot).
      const telegramStack = channelStacks.get("telegram");
      const liveOffset = telegramStack?.runtime?.driver?.offset;
      if (typeof liveOffset === "number") {
        telegramStack.config.offset = liveOffset;
      }
      await stateStore.save({
        settings,
        identities: authorization.listIdentities(),
        detectedIdentities: authorization.listDetectedIdentities(),
        sessions: sessions.snapshot(),
        outboundReplies: outboundReplies.persistSnapshot(),
        channelConfigs: Object.fromEntries(
          [...channelStacks].map(([id, stack]) => [id, stack.config]),
        ),
        router: commandRouter.snapshot(),
        events: eventLog.snapshot(),
        transcript: transcript.snapshot(),
        wechatCursor: channelStacks.get("wechat").runtime.cursor,
      });
    },
    async discoverProjects() {
      let desktopReached = false;
      try {
        const list = await desktop.listProjects();
        desktopReached = true;
        if (list.length > 0) {
          projects.replaceProjects(list);
          return projects.listProjects();
        }
      } catch {
        // Desktop connector offline — fall through to the local scan below.
      }
      // No desktop projects (offline, or a fresh headless/Linux box): scan the
      // local project root so the desktop UI and IM both have something to show.
      const local = scanLocalProjects();
      if (local.length > 0) {
        projects.replaceProjects(local);
      } else if (desktopReached) {
        // Desktop is authoritative and reports none, and the scan found nothing
        // either — clear any stale list. (When desktop is offline we instead
        // keep the last known set.)
        projects.replaceProjects([]);
      }
      return projects.listProjects();
    },
    channels: Object.fromEntries(
      [...channelStacks].map(([id, stack]) => [id, stack.adapter]),
    ),
    registry,
    runtime,
    connectors: {
      desktop,
      cli,
    },
    currentVersion,
    versionChecker,
    // Graceful shutdown: release the sleep guard (otherwise the spawned
    // `caffeinate` is orphaned and keeps the Mac awake after the daemon exits)
    // and stop every channel runtime + the version poller. Safe to call more than
    // once; each stop() is independently guarded.
    async shutdown() {
      sleepGuard.releaseAll();
      for (const timer of pushRedrainTimers.values()) {
        clearTimeout(timer);
      }
      pushRedrainTimers.clear();
      // Clear any per-thread milestone flush/heartbeat timers (workflow B) so the
      // daemon can exit cleanly without leaked timers holding the event loop.
      teardownAllMilestoneState();
      versionChecker?.stop?.();
      await Promise.allSettled(
        [...channelStacks.values()].map((stack) =>
          Promise.resolve(stack.runtime.stop?.()).catch(() => {}),
        ),
      );
      // Persistence is throttled, so a trailing snapshot may still be queued
      // behind the throttle timer. Flush it before the process exits, otherwise
      // the last state change (incl. the synced telegram offset) is lost.
      await Promise.resolve(stateStore?.flush?.()).catch(() => {});
    },
  };
  // --- Codex Desktop return path: route thread events back to the phone ---
  // threadId -> { count, lastSentAt } for throttled progress updates.
  const progressByThread = new Map();
  // threadId -> latest accumulated streaming text, for Feishu live cards.
  const streamTextByThread = new Map();
  // threadId -> latest tool/file milestones rendered inside the live card.
  // Keep a short tail so platform message limits remain predictable.
  const activityByThread = new Map();
  // Threads whose changed-file delivery already ran this turn. A turn can emit
  // more than one agentMessage; only the FIRST claims the live card and delivers
  // the turn's changed files. Subsequent agentMessages must enqueue their own
  // text but MUST NOT re-run deliverChangedFilesAndFinish — its fresh-millisecond
  // dedupeKey stamp would slip past the outbound queue's dedup and deliver the
  // changed files twice. Cleared on turnStarted and turnCompleted.
  const changedFilesDeliveredThreads = new Set();

  // Workflow B milestone state, keyed by threadId. Each entry tracks the running
  // sequence (dedupeKey source), the per-turn delivery count, the last delivered
  // {kind,label} (consecutive-dedup), the throttle timestamp + a pending coalesce
  // slot ({latest, count, flushTimer}), the heartbeat watchdog timer, and the
  // time of the last delivered milestone (the heartbeat's quiet-clock). Created
  // on turnStarted, torn down on every turn-ending event.
  const milestoneByThread = new Map();
  // Monotonic per-thread turn nonce, SEPARATE from milestoneByThread because it
  // must survive each turn's teardown. Two dedupeKeys fold it in:
  //   • milestones — ms:<thread>:<turn>:<seq>; without the nonce, seq resets to 0
  //     every turn so turn N+1's first milestone collides with turn N's still-
  //     retained key in the outbound queue and gets silently dropped.
  //   • the agent: fallback — when codex omits itemId, agent:<thread> repeats every
  //     turn, so turn N+1's final agentMessage reuses turn N's retained key and is
  //     dropped. agent:<thread>:<turn> keeps them distinct (turnNonce() below).
  // A monotonic counter (not a wall clock) keeps both keys cross-turn unique AND
  // deterministic. Advanced in turnStarted for EVERY channel (push channels use
  // the agent: fallback too, not just milestone channels). Cleared on full
  // teardown only — per-turn teardown must preserve it.
  const turnNonceByThread = new Map();
  // The current turn nonce for a thread, used by the agent: fallback key when
  // itemId is absent. Defaults to 0 for a thread with no turn yet.
  const turnNonce = (threadId) => turnNonceByThread.get(threadId) ?? 0;
  // Milestone/heartbeat persist coalescer. Milestone state is never serialized,
  // so each delivered line used to trigger a full state.json write for nothing —
  // ~7 writes on a chatty turn. Instead, deliveries just SET this flag; the
  // turn-ending teardown flushes a single persist when it's set. The persisted
  // shape (outboundReplies snapshot, etc.) still gets one write per turn, just not
  // one per line.
  let milestonePersistDirty = false;
  const markMilestonePersistDirty = () => {
    milestonePersistDirty = true;
  };
  // The agentMessage dedupeKey. Keyed on the codex itemId when present (so an
  // actual same-item retry still collapses to one delivery); when codex omits it,
  // fall back to <thread>:<turnNonce> instead of bare <thread>. Without the nonce
  // the fallback repeats every turn, so turn N+1's final agentMessage reuses turn
  // N's still-retained key and the outbound queue silently drops it.
  const agentDedupeKey = (event) =>
    `agent:${event.itemId ?? `${event.threadId}:${turnNonce(event.threadId)}`}`;
  const flushMilestonePersist = () => {
    if (!milestonePersistDirty) return;
    milestonePersistDirty = false;
    persistInBackground();
  };
  const msMinInterval = milestoneOptions.minIntervalMs ?? MILESTONE_MIN_INTERVAL_MS;
  const msMaxPerTurn = milestoneOptions.maxPerTurn ?? MILESTONE_MAX_PER_TURN;
  const msHeartbeatMs = milestoneOptions.heartbeatMs ?? HEARTBEAT_MS;

  desktop.onEvent = (event) => {
    try {
      routeDesktopEvent(event);
    } catch (error) {
      eventLog.error("处理 Codex 事件失败", { error: error.message });
    }
  };

  // Fire-and-forget persist that never rejects. persist() touches the disk and
  // can fail (EACCES, ENOSPC, a serialization throw); without a .catch the
  // rejection is unhandled and Node's default handler crashes the daemon. Log
  // and degrade instead — a missed snapshot is recoverable, a dead daemon is not.
  function persistInBackground() {
    Promise.resolve(stateRef.persist?.()).catch((err) =>
      eventLog.error("持久化失败", { error: err?.message ?? String(err) }),
    );
  }

  function routeDesktopEvent(event) {
    if (event.type === "turnStarted") {
      changedFilesDeliveredThreads.delete(event.threadId);
      activityByThread.delete(event.threadId);
      // Advance the per-thread turn nonce for EVERY channel — both the milestone
      // key and the agent: fallback key fold it in, and push channels (milestones
      // off) still rely on the latter. Must precede initMilestoneState, which
      // snapshots the current nonce into the milestone state.
      turnNonceByThread.set(event.threadId, turnNonce(event.threadId) + 1);
      initMilestoneState(event.threadId);
      sleepGuard.acquire(event.threadId);
      const startedBinding = commandRouter.getThreadBinding(event.threadId);
      // Typing indicator, driven by the EXPLICIT capabilities.typing bit (B-8):
      // wechat and telegram declare it and expose runtime.sendTyping (never
      // throws); other channels no-op. Behavior for wechat is unchanged.
      const startedStack = startedBinding ? channelStacks.get(startedBinding.channel) : null;
      if (startedStack?.plugin.meta.capabilities?.reactions) {
        startedStack.runtime.resetInboundFeedback?.(event.threadId);
      }
      if (startedStack?.plugin.meta.capabilities?.typing && typeof startedStack.runtime.sendTyping === "function") {
        startedStack.runtime
          .sendTyping({ conversationId: startedBinding.conversationId })
          .catch(() => {});
      }
      const startedLive = liveCardRuntime(startedBinding?.channel);
      if (startedLive) {
        startedLive
          .openThreadCard({
            threadId: event.threadId,
            conversationId: startedBinding.conversationId,
            card: startedLive.buildStatusCard({ phase: "started", threadId: event.threadId }),
          })
          .catch((error) => {
            startedLive.lastError = error.message;
          });
      } else if (startedBinding && liveCardDegraded(startedBinding.channel)) {
        // B-2: the channel promised a live card but can't render one (dingtalk
        // without a status template). It also has no typing indicator, so send a
        // one-line turn-start text — otherwise the user gets zero feedback until
        // the first milestone. Keyed on the turn nonce: one per turn.
        outboundReplies.enqueue({
          channel: startedBinding.channel,
          conversationId: startedBinding.conversationId,
          ...(startedBinding.accountId ? { accountId: startedBinding.accountId } : {}),
          kind: "text",
          text: t("card.phase.started"),
          dedupeKey: `turnstart:${event.threadId}:${turnNonce(event.threadId)}`,
        });
        deliverIfPush(startedBinding.channel);
      }
      eventLog.info("Codex 开始处理请求", { threadId: event.threadId });
      return;
    }
    if (event.type === "turnCompleted") {
      progressByThread.delete(event.threadId);
      teardownMilestoneState(event.threadId);
      const completedBinding = commandRouter.getThreadBinding(event.threadId);
      const completedStack = completedBinding ? channelStacks.get(completedBinding.channel) : null;
      if (completedStack?.plugin.meta.capabilities?.reactions) {
        void completedStack.runtime.completeInboundFeedback?.(event.threadId);
      }
      const completedLive = liveCardRuntime(completedBinding?.channel);
      if (completedLive && completedLive.hasThreadCard(event.threadId)) {
        // Reached only for the rare turn with NO agentMessage (codex normally
        // emits agentMessage first, which claims the card and runs the B/C split
        // in deliverChangedFilesAndFinish). Here the card just renders all files
        // as buttons — no inline-text split, no dingtalk auto-attach, no tooMany
        // cap. Acceptable for this edge case; files stay reachable via /file.
        const tail = streamTextByThread.get(event.threadId) ?? t("state.completed.fallback");
        completedLive
          .finishThreadCard(
            event.threadId,
            completedLive.buildStatusCard({
              phase: "completed",
              threadId: event.threadId,
              text: tail,
              activities: activityByThread.get(event.threadId) ?? [],
              done: true,
              files: buildChangedFiles(event.threadId, event.changedPaths),
            }),
          )
          .catch(() => {});
      }
      streamTextByThread.delete(event.threadId);
      activityByThread.delete(event.threadId);
      changedFilesDeliveredThreads.delete(event.threadId);
      sleepGuard.release(event.threadId);
      eventLog.info("Codex turn 完成", { threadId: event.threadId });
      return;
    }
    if (event.type === "approvalResolved") {
      const binding = commandRouter.getThreadBinding(event.approval.threadId);
      const stack = binding ? channelStacks.get(binding.channel) : null;
      if (binding && typeof stack?.runtime?.resolveApprovalMessage === "function") {
        outboundReplies.enqueue({
          channel: binding.channel,
          conversationId: binding.conversationId,
          ...(binding.accountId ? { accountId: binding.accountId } : {}),
          kind: "approvalResolved",
          code: event.approval.shortCode,
          approval: event.approval,
          decision: event.decision,
          dedupeKey: `approval-resolved:${event.approval.id}`,
        });
        deliverIfPush(binding.channel);
        persistInBackground();
      }
      const outcome = event.decision === "decline"
        ? "已拒绝"
        : event.decision === "acceptForSession"
          ? "已批准（本次会话）"
          : "已批准";
      eventLog.info(`审批 ${event.approval.shortCode} ${outcome}`, { decision: event.decision });
      return;
    }
    if (event.type === "connectionLost") {
      // Turns cannot complete once the connection is gone — release the
      // sleep guard so the Mac is not held awake indefinitely.
      sleepGuard.releaseAll();
      // Finish any open live cards: no turnCompleted/error will arrive to close
      // them while the connection is down, so otherwise they leak (cardSessions
      // grows unbounded) and the chat shows a perpetual "in progress" card.
      finishLiveCardsForDisconnect();
      eventLog.warn(DISCONNECT_NOTICE);
      return;
    }
    if (event.type === "reconnected") {
      eventLog.info("已重新连接 Codex Desktop");
      return;
    }
    if (event.type === "connectionGaveUp") {
      sleepGuard.releaseAll();
      // Same leak as connectionLost, and now no reconnect is coming at all — close
      // every open live card so none is left hanging.
      finishLiveCardsForDisconnect();
      eventLog.error("多次重连 Codex Desktop 失败，已停止重试，请手动重试连接");
      return;
    }
    if (event.type === "progress") {
      const entry = progressByThread.get(event.threadId) ?? { count: 0, lastSentAt: 0 };
      entry.count += 1;
      const progressBinding = commandRouter.getThreadBinding(event.threadId);
      const progressLive = liveCardRuntime(progressBinding?.channel);
      if (progressLive) {
        progressByThread.set(event.threadId, entry);
        progressLive.updateThreadCard(
          event.threadId,
          progressLive.buildStatusCard({
            phase: "progress",
            threadId: event.threadId,
            steps: entry.count,
            text: streamTextByThread.get(event.threadId) ?? "",
            activities: activityByThread.get(event.threadId) ?? [],
          }),
        );
        return;
      }
      const now = Date.now();
      // Throttle: at most one progress line per thread per 20s.
      if (now - entry.lastSentAt >= 20_000) {
        entry.lastSentAt = now;
        const binding = commandRouter.getThreadBinding(event.threadId);
        if (binding) {
          outboundReplies.enqueue({
            channel: binding.channel,
            conversationId: binding.conversationId,
            ...(binding.accountId ? { accountId: binding.accountId } : {}),
            kind: "text",
            text: t("state.progress.reply", { steps: entry.count }),
            dedupeKey: `progress:${event.threadId}:${now}`,
          });
          deliverIfPush(binding.channel);
        }
      }
      progressByThread.set(event.threadId, entry);
      return;
    }

    if (event.type === "milestone") {
      const binding = commandRouter.getThreadBinding(event.threadId);
      const milestoneLive = liveCardRuntime(binding?.channel);
      if (milestoneLive) {
        const item = { kind: event.kind, label: event.label ?? null, status: event.status ?? null };
        const line = milestoneText(item);
        const activities = activityByThread.get(event.threadId) ?? [];
        if (activities.at(-1) !== line) {
          activities.push(line);
          if (activities.length > 8) activities.shift();
          activityByThread.set(event.threadId, activities);
        }
        const progress = progressByThread.get(event.threadId);
        milestoneLive.updateThreadCard(
          event.threadId,
          milestoneLive.buildStatusCard({
            phase: "progress",
            threadId: event.threadId,
            steps: progress?.count ?? activities.length,
            text: streamTextByThread.get(event.threadId) ?? "",
            activities,
          }),
        );
        return;
      }
      handleMilestone(event);
      return;
    }

    if (event.type === "agentMessageDelta") {
      const binding = commandRouter.getThreadBinding(event.threadId);
      const deltaLive = liveCardRuntime(binding?.channel);
      if (!deltaLive) {
        return;
      }
      streamTextByThread.set(event.threadId, event.text ?? "");
      deltaLive.updateThreadCard(
        event.threadId,
        deltaLive.buildStatusCard({
          phase: "streaming",
          threadId: event.threadId,
          text: event.text ?? "",
          activities: activityByThread.get(event.threadId) ?? [],
        }),
      );
      return;
    }

    if (event.type === "agentMessage") {
      // The full reply is kept in the transcript; any chunking happens later in the wechat renderer.
      transcript.record(event.threadId, "assistant", event.text ?? "");
      eventLog.info("Codex 回复", {
        threadId: event.threadId,
        preview: String(event.text ?? "").slice(0, 120),
      });
      const binding = commandRouter.getThreadBinding(event.threadId);
      if (!binding) {
        eventLog.warn("收到 Codex 输出但找不到对应会话，未转发", { threadId: event.threadId });
        return;
      }
      const msgLive = liveCardRuntime(binding.channel);
      if (msgLive) {
        streamTextByThread.delete(event.threadId);
        if (changedFilesDeliveredThreads.has(event.threadId)) {
          // A prior agentMessage this turn already claimed the card and delivered
          // the turn's changed files. Re-running deliverChangedFilesAndFinish would
          // re-enqueue those files under a fresh-millisecond dedupeKey the queue
          // cannot collapse — a double delivery. Enqueue only this message's text.
          outboundReplies.enqueue({
            channel: binding.channel,
            conversationId: binding.conversationId,
            ...(binding.accountId ? { accountId: binding.accountId } : {}),
            kind: "text",
            text: event.text ?? "",
            dedupeKey: agentDedupeKey(event),
          });
          deliverIfPush(binding.channel);
          persistInBackground();
          return;
        }
        changedFilesDeliveredThreads.add(event.threadId);
        // Claim the live card SYNCHRONOUSLY now, before the async file work below.
        // agentMessage is the live-card completion path; detaching here means a
        // racing turnCompleted sees no card (hasThreadCard=false) and skips, so the
        // turn's files are delivered exactly once (here), never doubled.
        const claimedSession = msgLive.detachThreadCard(event.threadId);
        void deliverChangedFilesAndFinish(msgLive, binding, event, claimedSession).catch((error) => {
          msgLive.lastError = error.message;
        });
        persistInBackground();
        return;
      }
      // Chunking moved to the wechat renderer — enqueue ONE semantic text reply.
      outboundReplies.enqueue({
        channel: binding.channel,
        conversationId: binding.conversationId,
        ...(binding.accountId ? { accountId: binding.accountId } : {}),
        kind: "text",
        text: event.text ?? "",
        dedupeKey: agentDedupeKey(event),
      });
      deliverIfPush(binding.channel);
      persistInBackground();
      return;
    }

    if (event.type === "approval") {
      const binding = commandRouter.getThreadBinding(event.approval.threadId);
      const autoApproved = commandRouter.isAutoModeEnabled(event.approval.threadId);
      eventLog.warn("Codex 请求审批", {
        shortCode: event.approval.shortCode,
        threadId: event.approval.threadId,
        autoApproved,
      });
      if (!binding) {
        eventLog.warn("收到 Codex 输出但找不到对应会话，未转发", {
          threadId: event.approval.threadId,
        });
        return;
      }
      const enqueueApproval = () => {
        outboundReplies.enqueue({
          channel: binding.channel,
          conversationId: binding.conversationId,
          ...(binding.accountId ? { accountId: binding.accountId } : {}),
          kind: "approval",
          code: event.approval.shortCode,
          approval: event.approval,
          autoApproved,
          dedupeKey: `approval:${event.approval.id}`,
        });
        deliverIfPush(binding.channel);
      };
      const approvalLive = liveCardRuntime(binding.channel);
      let delivery;
      if (approvalLive?.hasThreadCard(event.approval.threadId)
        && typeof approvalLive.showThreadApproval === "function") {
        delivery = Promise.resolve(approvalLive.showThreadApproval({
            threadId: event.approval.threadId,
            code: event.approval.shortCode,
            approval: event.approval,
            autoApproved,
          })).then((shown) => {
            if (!shown) enqueueApproval();
          }).catch((error) => {
            approvalLive.lastError = error.message;
            enqueueApproval();
          });
      } else {
        enqueueApproval();
        delivery = Promise.resolve();
      }
      persistInBackground();
      if (autoApproved) {
        void delivery.then(() => desktop.resolveApproval(event.approval.id, "accept"))
          .catch((error) => {
            eventLog.error("Codex 自动审批失败", {
              shortCode: event.approval.shortCode,
              threadId: event.approval.threadId,
              error: error?.message ?? String(error),
            });
          });
      }
      return;
    }

    if (event.type === "error") {
      // A turn can end via error with no following turnCompleted. Release the
      // sleep guard here too, otherwise caffeinate is held awake until the next
      // (successful) turn completes — or indefinitely. Clear the per-turn
      // changed-files marker for the same reason.
      sleepGuard.release(event.threadId);
      changedFilesDeliveredThreads.delete(event.threadId);
      teardownMilestoneState(event.threadId);
      const binding = commandRouter.getThreadBinding(event.threadId);
      const errorStack = binding ? channelStacks.get(binding.channel) : null;
      if (errorStack?.plugin.meta.capabilities?.reactions) {
        void errorStack.runtime.completeInboundFeedback?.(event.threadId);
      }
      const errLive = liveCardRuntime(binding?.channel);
      if (errLive && errLive.hasThreadCard(event.threadId)) {
        errLive
          .finishThreadCard(
            event.threadId,
            errLive.buildStatusCard({
              phase: "error",
              text: t("state.error.card", { message: event.message }),
              activities: activityByThread.get(event.threadId) ?? [],
              done: true,
            }),
          )
          .catch(() => {});
        streamTextByThread.delete(event.threadId);
        activityByThread.delete(event.threadId);
        progressByThread.delete(event.threadId);
        eventLog.error("Codex 错误", { threadId: event.threadId, message: event.message });
        return;
      }
      streamTextByThread.delete(event.threadId);
      activityByThread.delete(event.threadId);
      progressByThread.delete(event.threadId);
      eventLog.error("Codex 错误", { threadId: event.threadId, message: event.message });
      if (!binding) {
        eventLog.warn("收到 Codex 输出但找不到对应会话，未转发", {
          threadId: event.threadId ?? null,
        });
        return;
      }
      outboundReplies.enqueue({
        channel: binding.channel,
        conversationId: binding.conversationId,
        ...(binding.accountId ? { accountId: binding.accountId } : {}),
        kind: "text",
        text: t("state.error.reply", { message: event.message }),
        dedupeKey: `error:${event.threadId ?? ""}:${Date.now()}`,
      });
      deliverIfPush(binding.channel);
      persistInBackground();
      return;
    }
  }

  // Workflow B — milestones --------------------------------------------------

  // Whether a channel wants milestone progress lines. Driven by the EXPLICIT
  // capabilities.milestones bit each plugin declares (single source of truth),
  // not inferred from !liveUpdates. Channels that render a live status card
  // declare milestones=0 to avoid double truth; channels without a live card
  // (wechat) declare milestones=1.
  function milestonesEnabledFor(channel) {
    const stack = channelStacks.get(channel);
    if (!stack) return false;
    if (stack.plugin.meta.capabilities?.milestones) return true;
    // B-2 fallback: a live-card channel whose runtime can't actually render
    // cards right now (dingtalk without a status template) declares
    // milestones=0 only because the card was supposed to cover progress. With
    // the card path inoperable, route it through the milestone text flow — the
    // same degradation wechat uses by design. A dingtalk WITH its template
    // keeps milestones off (liveCardDegraded=false), exactly as before.
    return liveCardDegraded(channel);
  }

  // turnStarted hook: fresh per-turn milestone state with seq=0 and a quiet-
  // watchdog that backstops a long silent stretch with one heartbeat reply. The
  // heartbeat interval is armed ONLY when the bound channel actually wants
  // milestones — on a milestones-off channel (push channels, which render a live
  // card instead) the watchdog could only ever no-op, so spinning a 90s interval
  // every turn is pure waste. The lightweight state + turn nonce are kept for all
  // channels regardless (the agent: fallback key needs the nonce).
  function initMilestoneState(threadId) {
    teardownMilestoneState(threadId);
    const state = {
      turn: turnNonce(threadId), // per-thread turn nonce, folded into the dedupeKey
      seq: 0, // per-turn delivery counter — feeds the dedupeKey AND gates the cap
      last: null, // last delivered {kind,label} for consecutive-dedup
      lastSentAt: 0, // throttle clock
      lastMilestoneAt: Date.now(), // heartbeat quiet-clock
      pending: null, // { latest:{kind,label}, count }
      flushTimer: null,
      heartbeatTimer: null,
      heartbeatSent: false,
    };
    const binding = commandRouter.getThreadBinding(threadId);
    if (binding && milestonesEnabledFor(binding.channel)) {
      state.heartbeatTimer = setInterval(() => runHeartbeat(threadId), msHeartbeatMs);
      state.heartbeatTimer.unref?.();
    }
    milestoneByThread.set(threadId, state);
  }

  // Any turn-ending event: flush a residual pending milestone, clear both timers,
  // and drop the per-thread entry so neither the Map nor the timers leak. The
  // residual flush above may deliver one last milestone (which only marks the
  // persist dirty), so flush the coalesced persist here — at most one full
  // state.json write per turn for the whole milestone/heartbeat path.
  function teardownMilestoneState(threadId) {
    const state = milestoneByThread.get(threadId);
    if (!state) return;
    if (state.flushTimer) {
      clearTimeout(state.flushTimer);
      state.flushTimer = null;
    }
    flushPendingMilestone(threadId, state);
    if (state.heartbeatTimer) {
      clearInterval(state.heartbeatTimer);
      state.heartbeatTimer = null;
    }
    milestoneByThread.delete(threadId);
    flushMilestonePersist();
  }

  function teardownAllMilestoneState() {
    for (const threadId of [...milestoneByThread.keys()]) {
      teardownMilestoneState(threadId);
    }
    // Full teardown (close/shutdown) is the only point the turn nonce resets;
    // per-turn teardown must preserve it so keys stay cross-turn unique.
    turnNonceByThread.clear();
  }

  // Routes one milestone event through the three throttle gates and (when it
  // passes) enqueues a text reply on the bound channel. No-ops when the thread
  // has no milestone state, no binding, the channel has milestones disabled, or
  // the per-turn cap is already hit.
  function handleMilestone(event) {
    const state = milestoneByThread.get(event.threadId);
    if (!state) return;
    const binding = commandRouter.getThreadBinding(event.threadId);
    if (!binding || !milestonesEnabledFor(binding.channel)) return;
    if (state.seq >= msMaxPerTurn) return;

    const item = { kind: event.kind, label: event.label ?? null, status: event.status ?? null };
    // Gate (a): drop a milestone identical to the last one delivered.
    if (state.last && state.last.kind === item.kind && state.last.label === item.label) {
      return;
    }
    const now = Date.now();
    // Gate (b): inside the hard interval, coalesce into a single pending slot
    // (keep only the latest + a count) and arm one flush timer.
    if (now - state.lastSentAt < msMinInterval) {
      state.pending = state.pending
        ? { latest: item, count: state.pending.count + 1 }
        : { latest: item, count: 1 };
      if (!state.flushTimer) {
        const delay = Math.max(0, msMinInterval - (now - state.lastSentAt));
        state.flushTimer = setTimeout(() => {
          state.flushTimer = null;
          flushPendingMilestone(event.threadId, state);
        }, delay);
        state.flushTimer.unref?.();
      }
      return;
    }
    deliverMilestone(event.threadId, state, binding, milestoneText(item), item);
  }

  // Emits the coalesced pending milestone (if any) as one merged line. Called by
  // the flush timer and synchronously on teardown so a residual is never lost.
  function flushPendingMilestone(threadId, state) {
    if (!state.pending) return;
    if (state.seq >= msMaxPerTurn) {
      state.pending = null;
      return;
    }
    const binding = commandRouter.getThreadBinding(threadId);
    if (!binding || !milestonesEnabledFor(binding.channel)) {
      state.pending = null;
      return;
    }
    const { latest, count } = state.pending;
    state.pending = null;
    const text =
      count > 1
        ? t("state.milestone.merged", { count, label: milestoneLabelText(latest) })
        : milestoneText(latest);
    deliverMilestone(threadId, state, binding, text, latest);
  }

  // Enqueues one milestone text reply with an ms:<thread>:<turn>:<seq> dedupeKey
  // (turn is the monotonic per-thread nonce, seq the per-turn counter — together
  // cross-turn unique without a wall-clock stamp; seq also gates the per-turn cap)
  // and resets the throttle/dedup/heartbeat bookkeeping. Deliberately does NOT
  // persist: milestone state isn't serialized, so a per-line full state.json write
  // (up to ~7 per chatty turn) buys nothing. The turn-ending teardown persists
  // once instead (markMilestonePersistDirty / flushMilestonePersist).
  function deliverMilestone(threadId, state, binding, text, item) {
    state.seq += 1;
    state.last = { kind: item.kind, label: item.label };
    state.lastSentAt = Date.now();
    state.lastMilestoneAt = state.lastSentAt;
    state.heartbeatSent = false;
    outboundReplies.enqueue({
      channel: binding.channel,
      conversationId: binding.conversationId,
      ...(binding.accountId ? { accountId: binding.accountId } : {}),
      kind: "text",
      text,
      dedupeKey: `ms:${threadId}:${state.turn}:${state.seq}`,
    });
    deliverIfPush(binding.channel);
    markMilestonePersistDirty();
  }

  // Quiet-watchdog tick: if the turn has been silent (no milestone) longer than
  // the heartbeat window, send ONE minimal "still working" reply. Re-armed on the
  // next milestone (heartbeatSent reset in deliverMilestone). One per quiet
  // stretch, so a stuck-but-alive turn never spams the chat.
  function runHeartbeat(threadId) {
    const state = milestoneByThread.get(threadId);
    if (!state || state.heartbeatSent) return;
    if (Date.now() - state.lastMilestoneAt < msHeartbeatMs) return;
    const binding = commandRouter.getThreadBinding(threadId);
    if (!binding || !milestonesEnabledFor(binding.channel)) return;
    state.heartbeatSent = true;
    const minutes = Math.max(1, Math.round((Date.now() - state.lastMilestoneAt) / 60_000));
    outboundReplies.enqueue({
      channel: binding.channel,
      conversationId: binding.conversationId,
      ...(binding.accountId ? { accountId: binding.accountId } : {}),
      kind: "text",
      text: t("state.heartbeat.quiet", { minutes }),
      dedupeKey: `heartbeat:${threadId}:${state.turn}:${state.seq}`,
    });
    deliverIfPush(binding.channel);
    markMilestonePersistDirty();
  }

  // Renders a milestone item to its localized line. Falls back to the generic
  // "working" line when the connector could not extract a usable label.
  function milestoneText(item) {
    if (!item.label) return t("state.milestone.generic");
    if (item.kind === "command") {
      return item.status === "failed"
        ? t("state.milestone.commandFailed", { label: item.label })
        : t("state.milestone.command", { label: item.label });
    }
    if (item.kind === "file") {
      return t("state.milestone.file", { label: item.label });
    }
    return t("state.milestone.generic");
  }

  // The bare label text used inside the merged "+N, latest: x" line. Degrades to
  // the generic line (sans the ▸ prefix would be odd, so reuse the full line).
  function milestoneLabelText(item) {
    return item.label ?? t("state.milestone.generic");
  }

  // Splits a completed turn's changed files (Task 3) and delivers them: small
  // text inlines + the rest become card buttons (fileButtons channels) or
  // auto-sent attachments. Finishes the live card with the button files. Used
  // fire-and-forget from the agentMessage handler so routeDesktopEvent stays sync.
  async function deliverChangedFilesAndFinish(live, binding, event, claimedSession) {
    const channel = binding.channel;
    const supportsButtons = Boolean(channelStacks.get(channel)?.plugin.meta.capabilities?.fileButtons);
    const plan = await planChangedFileDelivery(
      buildChangedFiles(event.threadId, event.changedPaths),
      { supportsButtons },
    );
    const stamp = Date.now();
    [...plan.inlineReplies, ...plan.attachmentReplies].forEach((reply, i) => {
      outboundReplies.enqueue({
        channel,
        conversationId: binding.conversationId,
        ...(binding.accountId ? { accountId: binding.accountId } : {}),
        ...reply,
        dedupeKey: `changedfiles:${binding.conversationId}:${event.threadId}:${stamp}:${i}`,
      });
    });
    const completedCard = live.buildStatusCard({
      phase: "completed",
      threadId: event.threadId,
      text: event.text ?? "",
      activities: activityByThread.get(event.threadId) ?? [],
      done: true,
      files: plan.buttonFiles,
    });
    // The session was claimed synchronously in the agentMessage branch; send the
    // final card to it. No claimed session means the daemon restarted mid-turn —
    // fall through to the fresh-text fallback below.
    const updated = claimedSession
      ? await live.sendDetachedThreadCard(claimedSession, completedCard)
      : false;
    if (!updated) {
      // No live card (e.g. the daemon restarted mid-turn) — send fresh.
      outboundReplies.enqueue({
        channel,
        conversationId: binding.conversationId,
        ...(binding.accountId ? { accountId: binding.accountId } : {}),
        kind: "text",
        text: event.text ?? "",
        dedupeKey: agentDedupeKey(event),
      });
    }
    deliverIfPush(channel);
  }

  // Maps a turn's absolute changedPaths to the {path, name} entries the
  // completion card renders as 📎 push buttons, keeping only project-internal
  // files (the click handler re-fences authoritatively) and deduping.
  function buildChangedFiles(threadId, changedPaths) {
    if (!Array.isArray(changedPaths) || changedPaths.length === 0) return [];
    const binding = commandRouter.getThreadBinding(threadId);
    const root = binding?.projectPath ?? null;
    const seen = new Set();
    const files = [];
    for (const p of changedPaths) {
      if (root && !isWithinDir(root, p)) continue; // only expose project-internal files
      if (seen.has(p)) continue;
      seen.add(p);
      files.push({ path: p, name: basename(p) || p });
    }
    return files;
  }

  // point-in-time config snapshot, used only for auto-start enabled-gating
  const wechatConfig = channelStacks.get("wechat").config;
  const feishuConfig = channelStacks.get("feishu").config;
  const dingtalkConfig = channelStacks.get("dingtalk").config;
  const telegramConfig = channelStacks.get("telegram").config;
  // Delay saved-channel runtime auto-start so the HTTP daemon binds and answers
  // health checks first; some IM SDK startup paths can be slow or noisy. A delay
  // of 0 (used by tests) still defers to the next tick, which the callers await.
  const deferAutoStart = (fn) => {
    const timer = setTimeout(fn, autoStartDelayMs);
    timer.unref?.();
  };
  if (autoStartWeChatRuntime && wechatConfig.enabled && wechatConfig.token) {
    deferAutoStart(() => {
      wechatRuntime.start();
      eventLog.info("微信运行时已自动启动", { accountId: wechatConfig.accountId });
    });
  }
  if (autoStartFeishuRuntime && feishuConfig.enabled && feishuConfig.appId && feishuConfig.appSecret) {
    deferAutoStart(() => {
      feishuRuntime.start().then(
        () => eventLog.info("飞书运行时已自动启动", { appId: feishuConfig.appId }),
        (error) => {
          feishuRuntime.lastError = error.message;
          eventLog.error("飞书运行时启动失败", { error: error.message });
        },
      );
    });
  }
  if (autoStartDingTalkRuntime && dingtalkConfig.enabled && dingtalkConfig.appKey && dingtalkConfig.appSecret) {
    deferAutoStart(() => {
      channelStacks.get("dingtalk").runtime.start().then(
        () => eventLog.info("钉钉运行时已自动启动", { appKey: dingtalkConfig.appKey }),
        (error) => {
          channelStacks.get("dingtalk").runtime.lastError = error.message;
          eventLog.error("钉钉运行时启动失败", { error: error.message });
        },
      );
    });
  }
  if (autoStartTelegramRuntime && telegramConfig.enabled && telegramConfig.botToken) {
    deferAutoStart(() => {
      channelStacks.get("telegram").runtime.start().then(
        () => eventLog.info("Telegram 运行时已自动启动"),
        (error) => {
          channelStacks.get("telegram").runtime.lastError = error.message;
          eventLog.error("Telegram 运行时自动启动失败", { error: error.message });
        },
      );
    });
  }
  return stateRef;
}

// Default: ~/.comote/state.json, with automatic legacy fallback to the old
// CWD-relative .comote/state.json (resolveStatePath logs when that happens).
// An explicit COMOTE_STATE_PATH still wins (src/server/index.js passes it as
// filePath, and resolveStatePath honors it too).
export async function createPersistentComoteState({
  filePath = resolveStatePath({ env: process.env, logger: console }).path,
} = {}) {
  const stateStore = new JsonFileStore({ filePath });
  const persisted = await stateStore.load();
  const currentVersion = await readPackageVersion();
  let versionChecker = null;
  if (currentVersion && typeof globalThis.fetch === "function") {
    versionChecker = new VersionChecker({
      currentVersion,
      cacheFilePath: join(dirname(filePath), "version-cache.json"),
    });
    await versionChecker.loadCache();
    versionChecker.start();
  }
  return createComoteState({ persisted, stateStore, currentVersion, versionChecker });
}

async function readPackageVersion() {
  try {
    const packageJsonPath = fileURLToPath(new URL("../../package.json", import.meta.url));
    const raw = await readFile(packageJsonPath, "utf8");
    const pkg = JSON.parse(raw);
    return typeof pkg.version === "string" ? pkg.version : null;
  } catch {
    return null;
  }
}
