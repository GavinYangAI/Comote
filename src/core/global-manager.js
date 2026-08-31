import {
  globalManagerApprovalCard,
  globalManagerDashboardCard,
  globalManagerTaskCard,
  globalManagerTestCard,
} from "../channels/feishu/global-manager-cards.js";
import { t } from "./i18n/index.js";

const DEFAULT_MANAGER_CHANNEL = "feishu-global-manager";
const ACTIVE_STATES = new Set(["running", "waiting"]);
const TERMINAL_NOTIFICATION_STATES = new Set(["completed", "failed", "interrupted"]);

export class GlobalManager {
  constructor({
    taskMonitor,
    desktop,
    transcript = null,
    getFeishuConfig,
    getFeishuRuntime,
    outboundQueue = null,
    deliverFeishuQueue = null,
    channelId = DEFAULT_MANAGER_CHANNEL,
    persisted = {},
    logger = console,
    now = Date.now,
    dashboardIntervalMs = 1500,
    taskIntervalMs = 900,
  }) {
    this.taskMonitor = taskMonitor;
    this.desktop = desktop;
    this.transcript = transcript;
    this.getFeishuConfig = getFeishuConfig;
    this.getFeishuRuntime = getFeishuRuntime;
    this.outboundQueue = outboundQueue;
    this.deliverFeishuQueue = deliverFeishuQueue;
    this.channelId = channelId;
    this.logger = logger;
    this.now = now;
    this.dashboardIntervalMs = dashboardIntervalMs;
    this.taskIntervalMs = taskIntervalMs;
    this.persistHandler = null;
    this.dashboardTimer = null;
    this.taskTimers = new Map();
    this.unsubscribeMonitor = null;
    this.binding = normalizeBinding(persisted, this.channelId);
  }

  setPersistHandler(handler) {
    this.persistHandler = handler;
  }

  start() {
    if (this.unsubscribeMonitor || !this.taskMonitor?.subscribe) return;
    this.unsubscribeMonitor = this.taskMonitor.subscribe((event) => {
      if (event?.type !== "task") return;
      this.scheduleDashboard();
      this.scheduleTask(event.task);
      if (
        event.notify
        && event.task?.attention
        && TERMINAL_NOTIFICATION_STATES.has(event.task.state)
      ) {
        void this.sendTaskNotification(event.task);
      }
    });
    if (this.isReady()) this.scheduleDashboard(0);
  }

  stop() {
    this.unsubscribeMonitor?.();
    this.unsubscribeMonitor = null;
    if (this.dashboardTimer) clearTimeout(this.dashboardTimer);
    this.dashboardTimer = null;
    for (const timer of this.taskTimers.values()) clearTimeout(timer);
    this.taskTimers.clear();
  }

  persistSnapshot() {
    return {
      enabled: this.binding.enabled,
      channelId: this.channelId,
      appId: this.binding.appId,
      managerOpenId: this.binding.managerOpenId,
      managerName: this.binding.managerName,
      dashboardMessageId: this.binding.dashboardMessageId,
      taskCards: { ...this.binding.taskCards },
      approvalCards: { ...this.binding.approvalCards },
      lastDeliveredVersion: this.binding.lastDeliveredVersion,
      updatedAt: this.binding.updatedAt,
      lastError: this.binding.lastError,
    };
  }

  publicSnapshot() {
    const config = this.getFeishuConfig?.() ?? {};
    const runtime = this.getFeishuRuntime?.();
    const status = this.status();
    return {
      status,
      enabled: status !== "unbound",
      channelId: this.channelId,
      appId: this.binding.appId,
      manager: this.binding.managerOpenId
        ? { stableId: this.binding.managerOpenId, displayName: this.binding.managerName ?? this.binding.managerOpenId }
        : null,
      configuredAppId: config.appId ?? null,
      configured: Boolean(config.enabled && config.appId && config.appSecret),
      domain: config.domain ?? "feishu",
      runtime: runtime?.getStatus?.().state ?? "not_configured",
      updatedAt: this.binding.updatedAt,
      lastError: this.binding.lastError ?? null,
    };
  }

  status() {
    if (!this.binding.enabled) return "unbound";
    const config = this.getFeishuConfig?.() ?? {};
    if (!config.appId || config.appId !== this.binding.appId || !this.binding.managerOpenId) {
      return "stale";
    }
    const runtimeState = this.getFeishuRuntime?.()?.getStatus?.().state;
    if (runtimeState !== "running") return "offline";
    return this.binding.lastError ? "degraded" : "ready";
  }

  isReady() {
    return ["ready", "degraded"].includes(this.status());
  }

  isManagerIdentity(identity) {
    return Boolean(
      this.binding.enabled
      && identity?.channel === this.channelId
      && identity.stableId === this.binding.managerOpenId
      && this.status() !== "stale",
    );
  }

  async bindCurrentFeishu() {
    const config = this.getFeishuConfig?.() ?? {};
    if (
      !config.linkedUserId
      || config.linkedUserAppId !== config.appId
      || config.linkedUserSource !== "inbound"
    ) {
      throw new Error(t("globalManager.error.bindFromChat"));
    }
    return this.bindIdentity({
      channel: this.channelId,
      stableId: config.linkedUserId,
      displayName: config.linkedUserName ?? config.linkedUserId,
    });
  }

  async bindIdentity(identity) {
    const config = this.getFeishuConfig?.() ?? {};
    const runtime = this.getFeishuRuntime?.();
    if (
      !config.enabled
      || !config.appId
      || !config.appSecret
      || identity?.channel !== this.channelId
      || !identity?.stableId
    ) {
      throw new Error(t("globalManager.error.feishuNotBound"));
    }
    if (!runtime?.driver?.sendCard) {
      throw new Error(t("globalManager.error.runtimeUnavailable"));
    }
    if (runtime.getStatus?.().state !== "running") {
      await runtime.start?.();
    }
    const snapshot = this.taskMonitor?.snapshot?.() ?? {};
    let sent;
    try {
      sent = await runtime.driver.sendCard({
        receiveId: identity.stableId,
        receiveIdType: "open_id",
        card: globalManagerDashboardCard(snapshot),
      });
    } catch (error) {
      if (isCrossAppOpenIdError(error)) {
        throw new Error(t("globalManager.error.crossAppOpenId"));
      }
      throw error;
    }
    if (!sent?.messageId) throw new Error(t("globalManager.error.testFailed"));
    this.binding = normalizeBinding({
      enabled: true,
      appId: config.appId,
      managerOpenId: identity.stableId,
      managerName: identity.displayName ?? identity.stableId,
      dashboardMessageId: sent.messageId,
      taskCards: {},
      approvalCards: {},
      lastDeliveredVersion: snapshot.version ?? 0,
      updatedAt: new Date(this.now()).toISOString(),
      lastError: null,
    }, this.channelId);
    await this.persist();
    this.scheduleDashboard(0);
    return this.publicSnapshot();
  }

  async sendTest() {
    if (!this.isReady()) throw new Error(t("globalManager.error.notReady"));
    const runtime = this.getFeishuRuntime();
    const sent = await runtime.driver.sendCard({
      receiveId: this.binding.managerOpenId,
      receiveIdType: "open_id",
      card: globalManagerTestCard(),
    });
    this.binding.lastError = null;
    this.binding.updatedAt = new Date(this.now()).toISOString();
    await this.persist();
    return { ok: true, messageId: sent?.messageId ?? null };
  }

  async unbind() {
    this.stopTimers();
    this.outboundQueue?.removeWhere?.((entry) => entry.kind === "globalManagerCard");
    this.binding = normalizeBinding({}, this.channelId);
    await this.persist();
    return this.publicSnapshot();
  }

  async handleMessage(message) {
    const text = String(message.text ?? "").trim();
    const [namespace = "", command = "", ...restParts] = text.split(/\s+/);
    if (namespace !== "/manager") return null;
    const rest = restParts.join(" ").trim();
    try {
      if (command === "bind") {
        if (this.binding.enabled && this.status() !== "stale" && !this.isManagerIdentity(message.identity)) {
          throw new Error(t("globalManager.error.alreadyBound"));
        }
        await this.bindIdentity(message.identity);
        return { kind: "text", text: t("globalManager.command.bound") };
      }
      if (!this.isManagerIdentity(message.identity)) {
        if (!this.binding.enabled || this.status() === "stale") {
          return { kind: "managerBind" };
        }
        return { kind: "error", text: t("globalManager.error.alreadyBound") };
      }
      if (!command || command === "tasks" || command === "help") {
        return { kind: "text", text: this.tasksText() };
      }
      if (command === "task") return { kind: "text", text: this.taskText(rest) };
      if (command === "send" || command === "continue") {
        const [selector, ...messageParts] = rest.split(/\s+/);
        return { kind: "text", text: await this.sendToTask(selector, messageParts.join(" ").trim()) };
      }
      if (command === "cancel") return { kind: "text", text: await this.cancelTask(rest) };
      if (command === "approve") return { kind: "text", text: await this.resolveApproval(rest, "accept") };
      if (command === "deny") return { kind: "text", text: await this.resolveApproval(rest, "decline") };
      return { kind: "error", text: t("globalManager.command.unknown", { command }) };
    } catch (error) {
      return { kind: "error", text: error.message };
    }
  }

  handleUnnamespacedMessage(message) {
    if (this.isManagerIdentity(message?.identity)) {
      return { kind: "text", text: this.tasksText() };
    }
    if (!this.binding.enabled || this.status() === "stale") {
      return { kind: "managerBind" };
    }
    return { kind: "error", text: t("globalManager.error.alreadyBound") };
  }

  tasksText() {
    const snapshot = this.taskMonitor?.snapshot?.() ?? { tasks: [], counts: {} };
    if (snapshot.tasks.length === 0) return t("globalManager.command.empty");
    const lines = snapshot.tasks.slice(0, 20).map((task, index) =>
      `${index + 1}. [${task.state}] ${task.project?.name ?? "-"} · ${task.title}`,
    );
    return [
      t("globalManager.command.summary", {
        running: snapshot.counts?.running ?? 0,
        waiting: snapshot.counts?.waiting ?? 0,
        attention: snapshot.counts?.attention ?? 0,
      }),
      lines.join("\n"),
      t("globalManager.command.help"),
    ].join("\n\n");
  }

  taskText(selector) {
    const task = this.resolveTask(selector);
    this.taskMonitor?.markSeen?.(task.id);
    return [
      `${task.project?.name ?? "-"} · ${task.title}`,
      `${t("globalManager.card.state")}: ${task.state}`,
      `threadId: ${task.id}`,
      task.project?.path ? `cwd: ${task.project.path}` : null,
      t("globalManager.card.taskHint", { id: task.id }),
    ].filter(Boolean).join("\n");
  }

  async sendToTask(selector, text) {
    if (!text) throw new Error(t("globalManager.error.messageRequired"));
    const task = this.resolveTask(selector);
    if (!task.project?.path) throw new Error(t("globalManager.error.projectMissing"));
    if (ACTIVE_STATES.has(task.state)) throw new Error(t("globalManager.error.taskBusy"));
    await this.desktop.resumeThread({ threadId: task.id, cwd: task.project.path });
    this.transcript?.record?.(task.id, "user", text);
    await this.desktop.startTurn({ threadId: task.id, cwd: task.project.path, text });
    return t("globalManager.command.sent", { id: task.id });
  }

  async cancelTask(selector) {
    const task = this.resolveTask(selector);
    if (!task.capabilities?.cancel) throw new Error(t("globalManager.error.cannotCancel"));
    await this.desktop.cancelTurn({ threadId: task.id });
    return t("globalManager.command.cancelled", { id: task.id });
  }

  async resolveApproval(selector, decision, { expectedThreadId = null } = {}) {
    if (!selector) throw new Error(t("globalManager.error.approvalRequired"));
    if (!new Set(["accept", "decline"]).has(decision)) {
      throw new Error(t("globalManager.error.approvalDecision"));
    }
    const pending = this.desktop.listPendingApprovals?.() ?? [];
    const approval = pending.find((item) => item.shortCode === selector || item.id === selector);
    if (!approval) throw new Error(t("globalManager.error.approvalMissing", { code: selector }));
    if (expectedThreadId && approval.threadId !== expectedThreadId) {
      throw new Error(t("globalManager.error.approvalTaskMismatch"));
    }
    const task = this.taskMonitor?.getTask?.(approval.threadId);
    if (!task || !ACTIVE_STATES.has(task.state)) {
      throw new Error(t("globalManager.error.approvalTaskEnded"));
    }
    await this.desktop.resolveApproval(approval.id ?? approval.shortCode, decision);
    return decision === "accept"
      ? t("cmd.approve.accepted", { selector })
      : t("cmd.deny.rejected", { selector });
  }

  async handleCardAction(action) {
    const kind = action?.value?.kind;
    if (!kind?.startsWith("global_manager_")) return null;
    if (kind === "global_manager_bind") {
      if (!action.openId) {
        return { toast: { type: "error", content: t("feishu.toast.notAuthorized") } };
      }
      const identity = {
        channel: this.channelId,
        stableId: action.openId,
        displayName: action.openId,
      };
      if (this.binding.enabled && this.status() !== "stale") {
        if (!this.isManagerIdentity(identity)) {
          return { toast: { type: "error", content: t("globalManager.error.alreadyBound") } };
        }
        return { toast: { type: "success", content: t("globalManager.command.bound") } };
      }
      try {
        await this.bindIdentity(identity);
        return { toast: { type: "success", content: t("globalManager.command.bound") } };
      } catch (error) {
        return { toast: { type: "error", content: error.message } };
      }
    }
    if (!action.openId || action.openId !== this.binding.managerOpenId || !this.isReady()) {
      return { toast: { type: "error", content: t("feishu.toast.notAuthorized") } };
    }
    try {
      if (kind === "global_manager_cancel") {
        await this.cancelTask(action.value.threadId);
        return { toast: { type: "info", content: t("feishu.toast.cancelRequested") } };
      }
      if (kind === "global_manager_approval") {
        await this.resolveApproval(action.value.code, action.value.decision, {
          expectedThreadId: action.value.threadId,
        });
        if (action.messageId) {
          const accepted = action.value.decision === "accept";
          await this.getFeishuRuntime().driver.updateCard({
            messageId: action.messageId,
            card: {
              config: { wide_screen_mode: true },
              header: {
                title: { tag: "plain_text", content: accepted ? t("card.approval.accepted", { code: action.value.code }) : t("card.approval.rejected", { code: action.value.code }) },
                template: accepted ? "green" : "grey",
              },
              elements: [{ tag: "markdown", content: accepted ? t("card.approval.acceptedBody") : t("card.approval.rejectedBody") }],
            },
          }).catch(() => {});
        }
        return { toast: { type: "success", content: action.value.decision === "accept" ? t("feishu.toast.approved") : t("feishu.toast.rejected") } };
      }
    } catch (error) {
      return { toast: { type: "error", content: error.message } };
    }
    return {};
  }

  handleDesktopEvent(event) {
    if (!this.isReady()) return;
    if (event?.type === "approval" && event.approval) {
      void this.sendApproval(event.approval);
    }
  }

  resolveTask(selector) {
    const value = String(selector ?? "").trim();
    if (!value) throw new Error(t("globalManager.error.taskRequired"));
    const tasks = this.taskMonitor?.snapshot?.().tasks ?? [];
    const byIndex = /^\d+$/.test(value) ? tasks[Number(value) - 1] : null;
    if (byIndex) return byIndex;
    const exact = tasks.find((task) => task.id === value);
    if (exact) return exact;
    const prefix = tasks.filter((task) => task.id.startsWith(value));
    if (prefix.length === 1) return prefix[0];
    throw new Error(t("globalManager.error.taskMissing", { selector: value }));
  }

  scheduleDashboard(delay = this.dashboardIntervalMs) {
    if (!this.isReady() || this.dashboardTimer) return;
    this.dashboardTimer = setTimeout(() => {
      this.dashboardTimer = null;
      void this.flushDashboard();
    }, delay);
    this.dashboardTimer.unref?.();
  }

  scheduleTask(task, delay = this.taskIntervalMs) {
    if (!this.isReady() || !task?.id || this.taskTimers.has(task.id)) return;
    const timer = setTimeout(() => {
      this.taskTimers.delete(task.id);
      void this.flushTask(task.id);
    }, delay);
    timer.unref?.();
    this.taskTimers.set(task.id, timer);
  }

  async flushDashboard() {
    if (!this.isReady()) return false;
    const snapshot = this.taskMonitor.snapshot();
    if (this.canQueueCards()) {
      this.enqueueCard({
        cardType: "dashboard",
        entityId: "dashboard",
        card: globalManagerDashboardCard(snapshot),
        messageId: this.binding.dashboardMessageId,
        deliveryVersion: snapshot.version ?? 0,
        dedupeKey: `global-manager:dashboard:${snapshot.version ?? 0}`,
      });
      this.deliverFeishuQueue();
      return true;
    }
    const runtime = this.getFeishuRuntime();
    try {
      if (this.binding.dashboardMessageId) {
        await runtime.driver.updateCard({ messageId: this.binding.dashboardMessageId, card: globalManagerDashboardCard(snapshot) });
      } else {
        const sent = await runtime.driver.sendCard({ receiveId: this.binding.managerOpenId, receiveIdType: "open_id", card: globalManagerDashboardCard(snapshot) });
        this.binding.dashboardMessageId = sent.messageId ?? null;
      }
      this.binding.lastDeliveredVersion = snapshot.version ?? this.binding.lastDeliveredVersion;
      this.binding.updatedAt = new Date(this.now()).toISOString();
      this.binding.lastError = null;
      await this.persist();
      return true;
    } catch (error) {
      return this.recreateDashboard(snapshot, error);
    }
  }

  async recreateDashboard(snapshot, originalError) {
    try {
      const sent = await this.getFeishuRuntime().driver.sendCard({ receiveId: this.binding.managerOpenId, receiveIdType: "open_id", card: globalManagerDashboardCard(snapshot) });
      this.binding.dashboardMessageId = sent.messageId ?? null;
      this.binding.lastError = null;
      await this.persist();
      return true;
    } catch (error) {
      await this.recordError(error?.message ?? originalError?.message ?? String(error));
      return false;
    }
  }

  async flushTask(threadId) {
    if (!this.isReady()) return false;
    const task = this.taskMonitor.getTask?.(threadId);
    if (!task) {
      delete this.binding.taskCards[threadId];
      await this.persist();
      return false;
    }
    const runtime = this.getFeishuRuntime();
    const existing = this.binding.taskCards[threadId];
    if (this.canQueueCards()) {
      this.enqueueCard({
        cardType: "task",
        entityId: threadId,
        card: globalManagerTaskCard(task),
        messageId: existing?.messageId ?? null,
        dedupeKey: `global-manager:task:${threadId}:${task.state}:${task.updatedAt ?? ""}`,
      });
      this.deliverFeishuQueue();
      return true;
    }
    try {
      if (existing?.messageId) {
        await runtime.driver.updateCard({ messageId: existing.messageId, card: globalManagerTaskCard(task) });
      } else {
        const sent = await runtime.driver.sendCard({ receiveId: this.binding.managerOpenId, receiveIdType: "open_id", card: globalManagerTaskCard(task) });
        this.binding.taskCards[threadId] = { messageId: sent.messageId ?? null, updatedAt: new Date(this.now()).toISOString() };
      }
      this.binding.lastError = null;
      await this.persist();
      return true;
    } catch (error) {
      delete this.binding.taskCards[threadId];
      try {
        const sent = await runtime.driver.sendCard({ receiveId: this.binding.managerOpenId, receiveIdType: "open_id", card: globalManagerTaskCard(task) });
        this.binding.taskCards[threadId] = { messageId: sent.messageId ?? null, updatedAt: new Date(this.now()).toISOString() };
        await this.persist();
        return true;
      } catch (sendError) {
        await this.recordError(sendError.message ?? error.message);
        return false;
      }
    }
  }

  async sendTaskNotification(task) {
    if (!this.isReady() || !task?.id || !TERMINAL_NOTIFICATION_STATES.has(task.state)) {
      return false;
    }
    const card = globalManagerTaskCard(task);
    const occurrence = task.completedAt ?? task.updatedAt ?? new Date(this.now()).toISOString();
    if (this.canQueueCards()) {
      this.enqueueCard({
        cardType: "notification",
        entityId: task.id,
        card,
        dedupeKey: `global-manager:notification:${task.id}:${task.state}:${occurrence}`,
      });
      this.deliverFeishuQueue();
      return true;
    }
    try {
      await this.getFeishuRuntime().driver.sendCard({
        receiveId: this.binding.managerOpenId,
        receiveIdType: "open_id",
        card,
      });
      this.binding.lastError = null;
      this.binding.updatedAt = new Date(this.now()).toISOString();
      await this.persist();
      return true;
    } catch (error) {
      await this.recordError(error.message);
      return false;
    }
  }

  async sendApproval(approval) {
    try {
      const existing = this.binding.approvalCards[approval.id];
      if (this.canQueueCards()) {
        this.binding.approvalCards[approval.id] = {
          messageId: existing?.messageId ?? null,
          shortCode: approval.shortCode,
          threadId: approval.threadId,
        };
        this.enqueueCard({
          cardType: "approval",
          entityId: approval.id,
          card: globalManagerApprovalCard(approval),
          messageId: existing?.messageId ?? null,
          dedupeKey: `global-manager:approval:${approval.id}`,
        });
        this.deliverFeishuQueue();
        return;
      }
      const driver = this.getFeishuRuntime().driver;
      let messageId = existing?.messageId ?? null;
      if (messageId) {
        try {
          await driver.updateCard({ messageId, card: globalManagerApprovalCard(approval) });
        } catch {
          messageId = null;
        }
      }
      if (!messageId) {
        const sent = await driver.sendCard({
          receiveId: this.binding.managerOpenId,
          receiveIdType: "open_id",
          card: globalManagerApprovalCard(approval),
        });
        messageId = sent.messageId ?? null;
      }
      this.binding.approvalCards[approval.id] = {
        messageId,
        shortCode: approval.shortCode,
        threadId: approval.threadId,
      };
      await this.persist();
    } catch (error) {
      await this.recordError(error.message);
    }
  }

  async recordError(message) {
    this.binding.lastError = message;
    this.binding.updatedAt = new Date(this.now()).toISOString();
    this.logger.warn?.(`[global-manager] ${message}`);
    await this.persist();
  }

  canQueueCards() {
    return Boolean(this.outboundQueue?.enqueue && this.deliverFeishuQueue);
  }

  enqueueCard({ cardType, entityId, card, messageId = null, deliveryVersion = null, dedupeKey }) {
    return this.outboundQueue.enqueue({
      channel: this.channelId,
      conversationId: this.binding.managerOpenId,
      receiveIdType: "open_id",
      kind: "globalManagerCard",
      globalManagerCardType: cardType,
      globalManagerEntityId: entityId,
      globalManagerDeliveryVersion: deliveryVersion,
      messageId,
      card,
      dedupeKey,
    });
  }

  handleQueuedCardDelivered(reply, result = {}) {
    if (!this.binding.enabled || reply.conversationId !== this.binding.managerOpenId) return;
    const messageId = result.messageId ?? reply.messageId ?? null;
    const at = new Date(this.now()).toISOString();
    if (reply.globalManagerCardType === "dashboard") {
      this.binding.dashboardMessageId = messageId;
      this.binding.lastDeliveredVersion = Number(
        reply.globalManagerDeliveryVersion ?? this.binding.lastDeliveredVersion,
      );
    } else if (reply.globalManagerCardType === "task") {
      this.binding.taskCards[reply.globalManagerEntityId] = { messageId, updatedAt: at };
    } else if (reply.globalManagerCardType === "approval") {
      const existing = this.binding.approvalCards[reply.globalManagerEntityId] ?? {};
      this.binding.approvalCards[reply.globalManagerEntityId] = { ...existing, messageId };
    }
    this.binding.updatedAt = at;
    this.binding.lastError = null;
  }

  canDeliverQueuedCard(reply) {
    return Boolean(
      this.isReady()
      && reply?.conversationId === this.binding.managerOpenId
      && reply?.receiveIdType === "open_id",
    );
  }

  handleQueuedCardFailure(reply, error) {
    if (!this.binding.enabled || reply.conversationId !== this.binding.managerOpenId) return;
    this.binding.lastError = error?.message ?? String(error);
    this.binding.updatedAt = new Date(this.now()).toISOString();
  }

  stopTimers() {
    if (this.dashboardTimer) clearTimeout(this.dashboardTimer);
    this.dashboardTimer = null;
    for (const timer of this.taskTimers.values()) clearTimeout(timer);
    this.taskTimers.clear();
  }

  async persist() {
    await Promise.resolve(this.persistHandler?.()).catch((error) => {
      this.logger.warn?.(`[global-manager] persist failed: ${error.message}`);
    });
  }
}

function normalizeBinding(raw = {}, channelId = DEFAULT_MANAGER_CHANNEL) {
  return {
    enabled: Boolean(raw.enabled),
    channelId,
    appId: raw.appId ?? null,
    managerOpenId: raw.managerOpenId ?? null,
    managerName: raw.managerName ?? null,
    dashboardMessageId: raw.dashboardMessageId ?? null,
    taskCards: raw.taskCards && typeof raw.taskCards === "object" ? { ...raw.taskCards } : {},
    approvalCards: raw.approvalCards && typeof raw.approvalCards === "object" ? { ...raw.approvalCards } : {},
    lastDeliveredVersion: Number(raw.lastDeliveredVersion ?? 0),
    updatedAt: raw.updatedAt ?? null,
    lastError: raw.lastError ?? null,
  };
}

function isCrossAppOpenIdError(error) {
  const message = String(error?.message ?? error ?? "");
  return message.includes("99992361") || /open_id\s+cross\s+app/i.test(message);
}
