import { readFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { isWithinDir, resolveWithinProject, sanitizeUploadName } from "../core/paths.js";

import { AuthorizationStore } from "../core/authorization.js";
import { CommandRouter } from "../core/commands.js";
import { ProjectStore } from "../core/projects.js";
import { SessionStore } from "../core/sessions.js";
import { CodexDesktopConnector } from "../connectors/codex-desktop/index.js";
import { CodexCliConnector } from "../connectors/codex-cli/index.js";
import feishuPlugin from "../channels/feishu/index.js";
import wechatPlugin from "../channels/wechat/index.js";
import { createRegistry } from "../channels/registry.js";
import { JsonFileStore } from "../core/persistence.js";
import { OutboundQueue } from "../core/outbound-queue.js";
import { EventLog } from "../core/event-log.js";
import { SleepGuard } from "../core/sleep-guard.js";
import { Transcript } from "../core/transcript.js";
import { VersionChecker } from "../core/version-check.js";
import { setLocale as setI18nLocale, DEFAULT_LOCALE, t } from "../core/i18n/index.js";

export function createComoteState({
  persisted = {},
  stateStore = null,
  autoStartWeChatRuntime = true,
  autoStartFeishuRuntime = true,
  desktop: desktopOverride = null,
  currentVersion = null,
  versionChecker = null,
} = {}) {
  // Route the persisted value through i18n's validation so a hand-edited or
  // stale state.json can't desync settings.locale from the locale actually served.
  const settings = { locale: setI18nLocale(persisted?.settings?.locale ?? DEFAULT_LOCALE) };

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

  const outboundReplies = new OutboundQueue({ entries: persisted.outboundReplies ?? [] });
  const commandRouter = new CommandRouter({
    authorization,
    projects,
    sessions,
    codexDesktop: desktop,
    codexCli: cli,
    outboundQueue: outboundReplies,
    persisted: persisted.router ?? {},
    transcript,
  });
  const registry = createRegistry([feishuPlugin, wechatPlugin]);

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
  const perChannelWiring = {
    wechat: {
      buildAdapterOpts: (_stack) => ({
        commandRouter,
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
        onDetectedIdentity: (identity) => authorization.detectIdentity(identity),
        resolveDisplayName: (openId) => stack.runtime?.driver?.resolveUserName?.(openId) ?? null,
        downloadAttachment: async ({ attachment, identity }) => {
          const projectPath = commandRouter.currentProjectByIdentity.get(commandRouter.identityKey(identity));
          if (!projectPath) {
            throw new Error("NO_PROJECT");
          }
          const { join } = await import("node:path");
          const safeName = sanitizeUploadName(attachment.fileName);
          const destPath = join(projectPath, ".comote", "uploads", safeName);
          // Belt-and-suspenders: even after sanitizing the name, verify the final
          // path stays inside the project. Use a DISTINCT error so an unsafe path is
          // not conflated with the missing-project /open flow — the adapter treats
          // any non-"NO_PROJECT" error as a graceful skip of this attachment.
          if (!resolveWithinProject(projectPath, destPath)) {
            throw new Error("UNSAFE_ATTACHMENT_PATH");
          }
          await stack.runtime.driver.downloadMessageResource({
            messageId: attachment.messageId,
            fileKey: attachment.fileKey,
            type: attachment.type === "image" ? "image" : "file",
            destPath,
          });
          return { relativePath: join(".comote", "uploads", safeName) };
        },
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
      renderer: plugin.createRenderer(),
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
        stack.runtime.configureDriver(plugin.createDriver(stack.config));
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
      return applied;
    },
    async persist() {
      if (!stateStore) {
        return;
      }
      await stateStore.save({
        settings,
        identities: authorization.listIdentities(),
        detectedIdentities: authorization.listDetectedIdentities(),
        sessions: sessions.snapshot(),
        outboundReplies: outboundReplies.snapshot(),
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
      try {
        const list = await desktop.listProjects();
        projects.replaceProjects(list);
      } catch {
        // Desktop connector offline — leave project list as-is (empty on first
        // load, or the previously loaded set if called after connect).
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
  };
  // --- Codex Desktop return path: route thread events back to the phone ---
  // threadId -> { count, lastSentAt } for throttled progress updates.
  const progressByThread = new Map();
  // threadId -> latest accumulated streaming text, for Feishu live cards.
  const streamTextByThread = new Map();
  desktop.onEvent = (event) => {
    try {
      routeDesktopEvent(event);
    } catch (error) {
      eventLog.error("处理 Codex 事件失败", { error: error.message });
    }
  };

  function routeDesktopEvent(event) {
    if (event.type === "turnStarted") {
      sleepGuard.acquire(event.threadId);
      const startedBinding = commandRouter.getThreadBinding(event.threadId);
      if (startedBinding?.channel === "wechat") {
        wechatRuntime
          .sendTyping({ conversationId: startedBinding.conversationId })
          .catch(() => {});
      }
      if (startedBinding?.channel === "feishu") {
        feishuRuntime
          .openThreadCard({
            threadId: event.threadId,
            conversationId: startedBinding.conversationId,
            card: feishuRuntime.buildStatusCard({ phase: "started", threadId: event.threadId }),
          })
          .catch((error) => {
            feishuRuntime.lastError = error.message;
          });
      }
      eventLog.info("Codex 开始处理请求", { threadId: event.threadId });
      return;
    }
    if (event.type === "turnCompleted") {
      progressByThread.delete(event.threadId);
      if (feishuRuntime.hasThreadCard(event.threadId)) {
        const tail = streamTextByThread.get(event.threadId) ?? t("state.completed.fallback");
        feishuRuntime
          .finishThreadCard(
            event.threadId,
            feishuRuntime.buildStatusCard({
              phase: "completed",
              threadId: event.threadId,
              text: tail,
              done: true,
              files: buildChangedFiles(event.threadId, event.changedPaths),
            }),
          )
          .catch(() => {});
      }
      streamTextByThread.delete(event.threadId);
      sleepGuard.release(event.threadId);
      eventLog.info("Codex turn 完成", { threadId: event.threadId });
      return;
    }
    if (event.type === "approvalResolved") {
      eventLog.info(`审批 ${event.approval.shortCode} 已处理`, { decision: event.decision });
      return;
    }
    if (event.type === "connectionLost") {
      // Turns cannot complete once the connection is gone — release the
      // sleep guard so the Mac is not held awake indefinitely.
      sleepGuard.releaseAll();
      eventLog.warn("与 Codex Desktop 的连接断开，正在尝试重连…");
      return;
    }
    if (event.type === "reconnected") {
      eventLog.info("已重新连接 Codex Desktop");
      return;
    }
    if (event.type === "connectionGaveUp") {
      sleepGuard.releaseAll();
      eventLog.error("多次重连 Codex Desktop 失败，已停止重试，请手动重试连接");
      return;
    }
    if (event.type === "progress") {
      const entry = progressByThread.get(event.threadId) ?? { count: 0, lastSentAt: 0 };
      entry.count += 1;
      const progressBinding = commandRouter.getThreadBinding(event.threadId);
      if (progressBinding?.channel === "feishu") {
        progressByThread.set(event.threadId, entry);
        feishuRuntime.updateThreadCard(
          event.threadId,
          feishuRuntime.buildStatusCard({
            phase: "progress",
            threadId: event.threadId,
            steps: entry.count,
            text: streamTextByThread.get(event.threadId) ?? "",
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
          deliverIfFeishu(binding.channel);
        }
      }
      progressByThread.set(event.threadId, entry);
      return;
    }

    if (event.type === "agentMessageDelta") {
      const binding = commandRouter.getThreadBinding(event.threadId);
      if (binding?.channel !== "feishu") {
        return;
      }
      streamTextByThread.set(event.threadId, event.text ?? "");
      feishuRuntime.updateThreadCard(
        event.threadId,
        feishuRuntime.buildStatusCard({
          phase: "streaming",
          threadId: event.threadId,
          text: event.text ?? "",
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
      if (binding.channel === "feishu") {
        streamTextByThread.delete(event.threadId);
        feishuRuntime
          .finishThreadCard(
            event.threadId,
            feishuRuntime.buildStatusCard({
              phase: "completed",
              threadId: event.threadId,
              text: event.text ?? "",
              done: true,
              files: buildChangedFiles(event.threadId, event.changedPaths),
            }),
          )
          .then((updated) => {
            if (!updated) {
              // No live card (e.g. the daemon restarted mid-turn) — send fresh.
              outboundReplies.enqueue({
                channel: "feishu",
                conversationId: binding.conversationId,
                kind: "text",
                text: event.text ?? "",
                dedupeKey: `agent:${event.itemId ?? event.threadId}`,
              });
              deliverIfFeishu("feishu");
            }
          })
          .catch((error) => {
            feishuRuntime.lastError = error.message;
          });
        stateRef.persist?.();
        return;
      }
      // Chunking moved to the wechat renderer — enqueue ONE semantic text reply.
      outboundReplies.enqueue({
        channel: binding.channel,
        conversationId: binding.conversationId,
        ...(binding.accountId ? { accountId: binding.accountId } : {}),
        kind: "text",
        text: event.text ?? "",
        dedupeKey: `agent:${event.itemId ?? event.threadId}`,
      });
      deliverIfFeishu(binding.channel);
      stateRef.persist?.();
      return;
    }

    if (event.type === "approval") {
      const binding = commandRouter.getThreadBinding(event.approval.threadId);
      eventLog.warn("Codex 请求审批", {
        shortCode: event.approval.shortCode,
        threadId: event.approval.threadId,
      });
      if (!binding) {
        eventLog.warn("收到 Codex 输出但找不到对应会话，未转发", {
          threadId: event.approval.threadId,
        });
        return;
      }
      // Both channels enqueue a channel-neutral SEMANTIC approval reply; the
      // renderer turns it into a card (feishu) or text (wechat) at delivery.
      outboundReplies.enqueue({
        channel: binding.channel,
        conversationId: binding.conversationId,
        ...(binding.accountId ? { accountId: binding.accountId } : {}),
        kind: "approval",
        code: event.approval.shortCode,
        approval: event.approval,
        dedupeKey: `approval:${event.approval.id}`,
      });
      deliverIfFeishu(binding.channel);
      stateRef.persist?.();
      return;
    }

    if (event.type === "error") {
      const binding = commandRouter.getThreadBinding(event.threadId);
      if (binding?.channel === "feishu" && feishuRuntime.hasThreadCard(event.threadId)) {
        feishuRuntime
          .finishThreadCard(
            event.threadId,
            feishuRuntime.buildStatusCard({
              phase: "error",
              text: t("state.error.card", { message: event.message }),
              done: true,
            }),
          )
          .catch(() => {});
        streamTextByThread.delete(event.threadId);
        progressByThread.delete(event.threadId);
        eventLog.error("Codex 错误", { threadId: event.threadId, message: event.message });
        return;
      }
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
      deliverIfFeishu(binding.channel);
      stateRef.persist?.();
      return;
    }
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

  // WeChat drains via its 2.5s poll loop; Feishu has no poll loop, push now.
  function deliverIfFeishu(channel) {
    if (channel === "feishu") {
      feishuRuntime.deliverQueued().catch((error) => {
        feishuRuntime.lastError = error.message;
      });
    }
  }

  // point-in-time config snapshot, used only for auto-start enabled-gating
  const wechatConfig = channelStacks.get("wechat").config;
  const feishuConfig = channelStacks.get("feishu").config;
  if (autoStartWeChatRuntime && wechatConfig.enabled && wechatConfig.token) {
    wechatRuntime.start();
    eventLog.info("微信运行时已自动启动", { accountId: wechatConfig.accountId });
  }
  if (autoStartFeishuRuntime && feishuConfig.enabled && feishuConfig.appId && feishuConfig.appSecret) {
    feishuRuntime.start().then(
      () => eventLog.info("飞书运行时已自动启动", { appId: feishuConfig.appId }),
      (error) => {
        feishuRuntime.lastError = error.message;
        eventLog.error("飞书运行时启动失败", { error: error.message });
      },
    );
  }
  return stateRef;
}

export async function createPersistentComoteState({ filePath = ".comote/state.json" } = {}) {
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
