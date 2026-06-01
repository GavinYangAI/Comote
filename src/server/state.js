import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { AuthorizationStore } from "../core/authorization.js";
import { CommandRouter } from "../core/commands.js";
import { ProjectStore } from "../core/projects.js";
import { SessionStore } from "../core/sessions.js";
import { CodexDesktopConnector } from "../connectors/codex-desktop/index.js";
import { CodexCliConnector } from "../connectors/codex-cli/index.js";
import { WeChatChannelAdapter } from "../channels/wechat/adapter.js";
import { FeishuChannelAdapter } from "../channels/feishu/adapter.js";
import { JsonFileStore } from "../core/persistence.js";
import { OutboundQueue } from "../core/outbound-queue.js";
import { WeChatIlinkDriver } from "../channels/wechat/ilink-driver.js";
import { WeChatRuntimeService } from "../channels/wechat/runtime.js";
import { stripMarkdown } from "../channels/wechat/markdown.js";
import { saveInboundAttachment } from "../core/attachment-store.js";
import { FeishuDriver } from "../channels/feishu/driver.js";
import { FeishuRuntimeService } from "../channels/feishu/runtime.js";
import { statusCard, textCard, approvalCard } from "../channels/feishu/cards.js";
import { EventLog } from "../core/event-log.js";
import { SleepGuard } from "../core/sleep-guard.js";
import { Transcript } from "../core/transcript.js";
import { VersionChecker } from "../core/version-check.js";

export function createComoteState({
  persisted = {},
  stateStore = null,
  autoStartWeChatRuntime = true,
  autoStartFeishuRuntime = true,
  desktop: desktopOverride = null,
  currentVersion = null,
  versionChecker = null,
  attachmentsDir = ".comote/attachments",
} = {}) {
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

  const commandRouter = new CommandRouter({
    authorization,
    projects,
    sessions,
    codexDesktop: desktop,
    codexCli: cli,
    persisted: persisted.router ?? {},
    transcript,
  });
  const outboundReplies = new OutboundQueue({ entries: persisted.outboundReplies ?? [] });
  let wechatConfig = normalizeWeChatConfig(persisted.channelConfigs?.wechat ?? {
    enabled: true,
    accountId: process.env.COMOTE_WECHAT_ACCOUNT_ID ?? "default",
  });
  let feishuConfig = normalizeFeishuConfig(persisted.channelConfigs?.feishu ?? {
    enabled: Boolean(process.env.COMOTE_FEISHU_APP_ID && process.env.COMOTE_FEISHU_APP_SECRET),
    appId: process.env.COMOTE_FEISHU_APP_ID ?? null,
    appSecret: process.env.COMOTE_FEISHU_APP_SECRET ?? null,
    verificationToken: process.env.COMOTE_FEISHU_VERIFICATION_TOKEN ?? null,
    encryptKey: process.env.COMOTE_FEISHU_ENCRYPT_KEY ?? null,
    domain: process.env.COMOTE_FEISHU_DOMAIN ?? "feishu",
  });
  const wechat = new WeChatChannelAdapter({
    commandRouter,
    onDetectedIdentity: (identity) => authorization.detectIdentity(identity),
    sendReply: async (reply) => {
      outboundReplies.enqueue(reply);
      return { ok: true };
    },
  });
  const feishu = new FeishuChannelAdapter({
    commandRouter,
    onDetectedIdentity: (identity) => authorization.detectIdentity(identity),
    resolveDisplayName: (openId) => feishuRuntime?.driver?.resolveUserName?.(openId) ?? null,
    downloadAttachment: ({ channel, messageId, conversationId, sender, attachment }) =>
      downloadFeishuAttachment({
        channel,
        messageId,
        conversationId,
        sender,
        attachment,
        driver: feishuRuntime?.driver,
        attachmentsDir,
      }),
    sendReply: async (reply) => {
      outboundReplies.enqueue(reply);
      return { ok: true };
    },
  });
  const wechatRuntime = new WeChatRuntimeService({
    adapter: wechat,
    outboundQueue: outboundReplies,
    driver: createWeChatDriver(wechatConfig),
    persist: async () => stateRef.persist?.(),
    cursor: persisted.wechatCursor ?? null,
  });
  const feishuRuntime = new FeishuRuntimeService({
    adapter: feishu,
    outboundQueue: outboundReplies,
    driver: createFeishuDriver(feishuConfig),
    persist: async () => stateRef.persist?.(),
    eventLog,
  });
  const runtime = {
    wechat: {
      getConfig() {
        return publicWeChatConfig(wechatConfig);
      },
      async configure(config) {
        wechatConfig = normalizeWeChatConfig({ ...wechatConfig, ...config });
        wechatRuntime.configureDriver(createWeChatDriver(wechatConfig));
        return this.getConfig();
      },
      getStatus() {
        return wechatRuntime.getStatus();
      },
      pollOnce() {
        return wechatRuntime.pollOnce();
      },
      start() {
        return wechatRuntime.start();
      },
      stop() {
        return wechatRuntime.stop();
      },
      startLogin() {
        return wechatRuntime.startLogin();
      },
      async getLoginStatus({ loginId }) {
        return wechatRuntime.getLoginStatus({ loginId }).then(async (result) => {
          if (shouldStoreWeChatLoginResult(result)) {
            wechatConfig = normalizeWeChatConfig({
              ...wechatConfig,
              enabled: true,
              accountId: result.accountId,
              token: result.token,
              baseUrl: result.baseUrl,
              linkedUserId: result.userId,
              linkedUserName: result.userName ?? null,
            });
            wechatRuntime.configureDriver(createWeChatDriver(wechatConfig));
            await stateRef.persist?.();
          }
          return result;
        });
      },
    },
    feishu: {
      getConfig() {
        return publicFeishuConfig(feishuConfig);
      },
      async configure(config) {
        feishuConfig = normalizeFeishuConfig({ ...feishuConfig, ...normalizeFeishuSecretPatch(config) });
        feishuRuntime.configureDriver(createFeishuDriver(feishuConfig));
        return this.getConfig();
      },
      getStatus() {
        ensureFeishuRuntimeDriverMatchesConfig();
        return feishuRuntime.getStatus();
      },
      start() {
        ensureFeishuRuntimeDriverMatchesConfig();
        return feishuRuntime.start();
      },
      stop() {
        return feishuRuntime.stop();
      },
      startLogin({ domain = feishuConfig.domain } = {}) {
        return createFeishuLoginDriver({ domain }).startLogin({ domain });
      },
      async getLoginStatus({ loginId, domain = feishuConfig.domain, interval, expireIn }) {
        const result = await createFeishuLoginDriver({ domain }).getLoginStatus({
          loginId,
          domain,
          interval,
          expireIn,
        });
        if (shouldStoreFeishuLoginResult(result)) {
          feishuConfig = normalizeFeishuConfig({
            ...feishuConfig,
            enabled: true,
            appId: result.appId,
            appSecret: result.appSecret,
            domain: result.domain ?? domain,
            linkedUserId: result.userId,
          });
          feishuRuntime.configureDriver(createFeishuDriver(feishuConfig));
          let userName = null;
          try {
            userName = (await feishuRuntime.driver?.resolveUserName?.(result.userId)) ?? null;
          } catch {
            userName = null;
          }
          feishuConfig = normalizeFeishuConfig({ ...feishuConfig, linkedUserName: userName });
          result.userName = userName;
          if (result.userId) {
            authorization.detectIdentity({
              channel: "feishu",
              stableId: result.userId,
              displayName: userName ?? result.userId,
              role: "operator",
            });
          }
          await stateRef.persist?.();
          if (autoStartFeishuRuntime) {
            await feishuRuntime.start().catch((error) => {
              feishuRuntime.lastError = error.message;
            });
          }
        }
        return result;
      },
      handleInbound(payload) {
        return feishuRuntime.handleInbound(payload);
      },
      __setTestDriver(testDriver) {
        feishuRuntime.configureDriver(testDriver);
      },
      deliverQueued() {
        ensureFeishuRuntimeDriverMatchesConfig();
        return feishuRuntime.deliverQueued();
      },
    },
  };

  function ensureFeishuRuntimeDriverMatchesConfig() {
    const shouldHaveDriver = Boolean(feishuConfig.enabled && feishuConfig.appId && feishuConfig.appSecret);
    const currentDriver = feishuRuntime.getStatus().driver;
    const currentAppId = currentDriver?.appId ?? null;
    const currentDomain = currentDriver?.domain ?? "feishu";
    if (!shouldHaveDriver) {
      if (currentDriver) {
        feishuRuntime.configureDriver(null);
      }
      return;
    }
    if (currentAppId === feishuConfig.appId && currentDomain === feishuConfig.domain) {
      return;
    }
    feishuRuntime.configureDriver(createFeishuDriver(feishuConfig));
    eventLog.warn("飞书运行时配置已重新同步", {
      appId: feishuConfig.appId,
      previousAppId: currentAppId,
    });
  }

  const stateRef = {
    authorization,
    projects,
    sessions,
    commandRouter,
    outboundReplies,
    eventLog,
    transcript,
    async persist() {
      if (!stateStore) {
        return;
      }
      await stateStore.save({
        identities: authorization.listIdentities(),
        detectedIdentities: authorization.listDetectedIdentities(),
        sessions: sessions.snapshot(),
        outboundReplies: outboundReplies.snapshot(),
        channelConfigs: {
          wechat: wechatConfig,
          feishu: feishuConfig,
        },
        router: commandRouter.snapshot(),
        events: eventLog.snapshot(),
        transcript: transcript.snapshot(),
        wechatCursor: wechatRuntime.cursor,
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
    channels: {
      wechat,
      feishu,
    },
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
            card: statusCard({ phase: "started", threadId: event.threadId }),
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
        const tail = streamTextByThread.get(event.threadId) ?? "本次任务已结束。";
        feishuRuntime
          .finishThreadCard(
            event.threadId,
            statusCard({ phase: "completed", text: tail, done: true }),
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
          statusCard({
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
            text: `⏳ Codex 还在处理…（已执行 ${entry.count} 步）`,
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
        statusCard({
          phase: "streaming",
          threadId: event.threadId,
          text: event.text ?? "",
        }),
      );
      return;
    }

    if (event.type === "agentMessage") {
      // The full reply is kept in the transcript; the chat gets it chunked.
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
            statusCard({ phase: "completed", text: event.text ?? "", done: true }),
          )
          .then((updated) => {
            if (!updated) {
              // No live card (e.g. the daemon restarted mid-turn) — send fresh.
              outboundReplies.enqueue({
                channel: "feishu",
                conversationId: binding.conversationId,
                card: textCard(event.text ?? ""),
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
      // WeChat does not render Markdown — strip it so the reply reads cleanly.
      const replyText = binding.channel === "wechat" ? stripMarkdown(event.text ?? "") : event.text ?? "";
      const chunks = chunkForChannel(replyText);
      chunks.forEach((chunk, index) => {
        outboundReplies.enqueue({
          channel: binding.channel,
          conversationId: binding.conversationId,
          ...(binding.accountId ? { accountId: binding.accountId } : {}),
          text: chunks.length > 1 ? `(${index + 1}/${chunks.length})\n${chunk}` : chunk,
          dedupeKey: `agent:${event.itemId ?? event.threadId}:${index}`,
        });
      });
      deliverIfFeishu(binding.channel);
      stateRef.persist?.();
      return;
    }

    let binding = null;
    let text = null;
    let dedupeKey = null;
    if (event.type === "approval") {
      binding = commandRouter.getThreadBinding(event.approval.threadId);
      eventLog.warn("Codex 请求审批", {
        shortCode: event.approval.shortCode,
        threadId: event.approval.threadId,
      });
      if (binding?.channel === "feishu") {
        outboundReplies.enqueue({
          channel: "feishu",
          conversationId: binding.conversationId,
          card: approvalCard({
            shortCode: event.approval.shortCode,
            detail: approvalDetail(event.approval),
          }),
          dedupeKey: `approval:${event.approval.id}`,
        });
        deliverIfFeishu("feishu");
        stateRef.persist?.();
        return;
      }
      text = describeApprovalForChat(event.approval);
      dedupeKey = `approval:${event.approval.id}`;
    } else if (event.type === "error") {
      const errorBinding = commandRouter.getThreadBinding(event.threadId);
      if (errorBinding?.channel === "feishu" && feishuRuntime.hasThreadCard(event.threadId)) {
        feishuRuntime
          .finishThreadCard(
            event.threadId,
            statusCard({ phase: "error", text: `Codex 出错：${event.message}`, done: true }),
          )
          .catch(() => {});
        streamTextByThread.delete(event.threadId);
        progressByThread.delete(event.threadId);
        eventLog.error("Codex 错误", { threadId: event.threadId, message: event.message });
        return;
      }
      binding = commandRouter.getThreadBinding(event.threadId);
      text = `❌ Codex 出错：${event.message}`;
      dedupeKey = `error:${event.threadId ?? ""}:${Date.now()}`;
      eventLog.error("Codex 错误", { threadId: event.threadId, message: event.message });
    }

    if (!text) {
      return;
    }
    if (!binding) {
      eventLog.warn("收到 Codex 输出但找不到对应会话，未转发", {
        threadId: event.threadId ?? event.approval?.threadId ?? null,
      });
      return;
    }
    outboundReplies.enqueue({
      channel: binding.channel,
      conversationId: binding.conversationId,
      ...(binding.accountId ? { accountId: binding.accountId } : {}),
      text,
      dedupeKey,
    });
    deliverIfFeishu(binding.channel);
    stateRef.persist?.();
  }

  // WeChat drains via its 2.5s poll loop; Feishu has no poll loop, push now.
  function deliverIfFeishu(channel) {
    if (channel === "feishu") {
      feishuRuntime.deliverQueued().catch((error) => {
        feishuRuntime.lastError = error.message;
      });
    }
  }

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
  return createComoteState({
    persisted,
    stateStore,
    currentVersion,
    versionChecker,
    attachmentsDir: join(dirname(filePath), "attachments"),
  });
}

// Downloads an inbound Feishu image/file and persists it (with a manifest) under
// attachmentsDir via the attachment store. Returns the saved local path, or null
// when no driver is available; throws are left to the adapter (which treats a
// failure as a dropped attachment).
async function downloadFeishuAttachment({ channel, messageId, conversationId, sender, attachment, driver, attachmentsDir }) {
  if (!driver?.downloadResource) {
    return null;
  }
  const type = attachment.kind === "image" ? "image" : "file";
  const { buffer, contentType } = await driver.downloadResource({
    messageId,
    fileKey: attachment.feishuKey,
    type,
  });
  return saveInboundAttachment({
    attachmentsDir,
    channel,
    messageId,
    conversationId,
    sender,
    attachment,
    buffer,
    contentType,
  });
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

// Splits a long Codex reply into chat-sized chunks. The full text is always
// kept in the transcript, so an over-long reply is capped here, not lost.
function chunkForChannel(text, size = 1500, maxChunks = 6) {
  const value = String(text ?? "").trim();
  if (!value) {
    return [];
  }
  const chunks = [];
  for (let index = 0; index < value.length; index += size) {
    chunks.push(value.slice(index, index + size));
  }
  if (chunks.length > maxChunks) {
    const kept = chunks.slice(0, maxChunks);
    kept[maxChunks - 1] += "\n…（输出过长，完整内容见本机 Comote 的对话记录）";
    return kept;
  }
  return chunks;
}

function describeApprovalForChat(approval) {
  const params = approval.params ?? {};
  const lines = [`⚠️ Codex 请求审批 [${approval.shortCode}]`];
  if (Array.isArray(approval.changes) && approval.changes.length > 0) {
    lines.push(summarizeChanges(approval.changes));
  } else {
    const detail = params.command ?? params.reason ?? approval.method;
    const cwd = params.cwd ? `\n目录：${params.cwd}` : "";
    lines.push(`${detail}${cwd}`);
  }
  lines.push(`回复 /approve ${approval.shortCode} 批准，或 /deny ${approval.shortCode} 拒绝。`);
  return lines.join("\n\n");
}

// Markdown body for a Feishu approval card — reuses the diff/command summary.
function approvalDetail(approval) {
  const params = approval.params ?? {};
  if (Array.isArray(approval.changes) && approval.changes.length > 0) {
    return summarizeChanges(approval.changes);
  }
  const detail = params.command ?? params.reason ?? approval.method;
  const cwd = params.cwd ? `\n\n目录：\`${params.cwd}\`` : "";
  return `\`${detail}\`${cwd}`;
}

function summarizeChanges(changes) {
  const rows = changes.slice(0, 10).map((change) => {
    const kind =
      change.kind?.type === "add" ? "新增" : change.kind?.type === "delete" ? "删除" : "修改";
    const { added, removed } = countDiffLines(change.diff);
    const stat = added || removed ? ` (+${added} -${removed})` : "";
    return `  ${kind} ${change.path}${stat}`;
  });
  if (changes.length > 10) {
    rows.push(`  …还有 ${changes.length - 10} 个文件`);
  }
  return [`将修改 ${changes.length} 个文件：`, ...rows].join("\n");
}

function countDiffLines(diff) {
  let added = 0;
  let removed = 0;
  for (const line of String(diff ?? "").split("\n")) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      added += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      removed += 1;
    }
  }
  return { added, removed };
}

function normalizeWeChatConfig(config = {}) {
  return {
    enabled: config.enabled !== false,
    baseUrl: config.baseUrl ?? null,
    token: config.token ?? null,
    accountId: config.accountId ?? "default",
    linkedUserId: config.linkedUserId ?? null,
    linkedUserName: config.linkedUserName ?? null,
  };
}

function publicWeChatConfig(config) {
  return {
    enabled: config.enabled,
    accountId: config.accountId,
    linkedUserId: config.linkedUserId,
    linkedUserName: config.linkedUserName,
    loggedIn: Boolean(config.token),
  };
}

export function shouldStoreWeChatLoginResult(result) {
  const state = result.state?.toString?.().toLowerCase?.() ?? "";
  if (["expired", "cancelled", "canceled", "failed", "error"].includes(state)) {
    return false;
  }
  return Boolean(result.token && result.accountId);
}

function createWeChatDriver(config) {
  if (!config.enabled) {
    return null;
  }
  return new WeChatIlinkDriver({
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
    token: config.token,
    accountId: config.accountId,
  });
}

function normalizeFeishuConfig(config = {}) {
  return {
    enabled: Boolean(config.enabled),
    appId: config.appId ?? null,
    appSecret: config.appSecret ?? null,
    verificationToken: config.verificationToken ?? null,
    encryptKey: config.encryptKey ?? null,
    baseUrl: config.baseUrl ?? null,
    domain: config.domain ?? "feishu",
    linkedUserId: config.linkedUserId ?? null,
    linkedUserName: config.linkedUserName ?? null,
  };
}

function normalizeFeishuSecretPatch(config = {}) {
  const patch = { ...config };
  if (patch.appSecret === "" || patch.appSecret === "********") {
    delete patch.appSecret;
  }
  if (patch.verificationToken === "" || patch.verificationToken === "********") {
    delete patch.verificationToken;
  }
  if (patch.encryptKey === "" || patch.encryptKey === "********") {
    delete patch.encryptKey;
  }
  return patch;
}

function publicFeishuConfig(config) {
  return {
    enabled: config.enabled,
    appId: config.appId,
    hasAppSecret: Boolean(config.appSecret),
    hasVerificationToken: Boolean(config.verificationToken),
    hasEncryptKey: Boolean(config.encryptKey),
    configured: Boolean(config.enabled && config.appId && config.appSecret),
    domain: config.domain,
    linkedUserId: config.linkedUserId,
    linkedUserName: config.linkedUserName,
  };
}

function createFeishuDriver(config) {
  if (!config.enabled || !config.appId || !config.appSecret) {
    return null;
  }
  return new FeishuDriver({
    appId: config.appId,
    appSecret: config.appSecret,
    verificationToken: config.verificationToken,
    encryptKey: config.encryptKey,
    domain: config.domain,
    ...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
  });
}

function createFeishuLoginDriver({ domain = "feishu" } = {}) {
  return new FeishuDriver({
    appId: "comote-registration",
    appSecret: "comote-registration",
    domain,
  });
}

function shouldStoreFeishuLoginResult(result) {
  return Boolean(result?.appId && result?.appSecret);
}
